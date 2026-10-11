package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// hub holds the wrapped systems, grants, pairing state and remote access.
type hub struct {
	cfg     config
	store   *store
	engine  *engine
	pusher  pusher
	grants  *grantStore
	pairing *pairing
	remote  remoteAccess

	pairLimit   *limiter
	redeemLimit *limiter
	startedAt   time.Time
	// lanHandler serves everything on the LAN port; the Funnel listener wraps it.
	lanHandler http.Handler

	settingsMu sync.Mutex
	settings   hubSettings

	playbacks playbackCache
	talks     talkProbeCache

	mu      sync.RWMutex
	systems []*system
	ctx     context.Context
}

// system is one running backend.
type system struct {
	cfg     backend.Config
	b       backend.Backend
	primary bool
	cancel  context.CancelFunc

	statusMu  sync.Mutex
	status    string // plain-language status for the setup page
	checkedAt time.Time
}

// hubSettings persist choices made on the setup page (settings.json).
type hubSettings struct {
	Name          string           `json:"name,omitempty"`
	RemoteEnabled bool             `json:"remoteEnabled"`
	Systems       []backend.Config `json:"systems"`
}

func newHub(cfg config, s *store, e *engine, p pusher) (*hub, error) {
	g, err := openGrants(cfg.dataDir)
	if err != nil {
		return nil, err
	}
	h := &hub{
		cfg: cfg, store: s, engine: e, pusher: p, grants: g,
		pairLimit:   newLimiter(5, time.Minute, 20, 10*time.Minute),
		redeemLimit: newLimiter(10, time.Minute, 60, 10*time.Minute),
		startedAt:   time.Now(),
	}
	if b, err := os.ReadFile(h.settingsPath()); err == nil {
		if err := json.Unmarshal(b, &h.settings); err != nil {
			return nil, fmt.Errorf("settings.json: %w", err)
		}
	}
	h.pairing = newPairing(!g.hasOwner())
	h.remote = newRemote(h)
	e.snapshot = h.alertSnapshot
	e.allow = h.allowAlert
	return h, nil
}

func (h *hub) settingsPath() string { return filepath.Join(h.cfg.dataDir, "settings.json") }

func (h *hub) saveSettings(mut func(*hubSettings)) error {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	mut(&h.settings)
	b, err := json.MarshalIndent(h.settings, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(h.settingsPath(), b)
}

func (h *hub) name() string {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	if h.settings.Name != "" {
		return h.settings.Name
	}
	return h.cfg.hubName
}

func (h *hub) remoteWanted() bool {
	h.settingsMu.Lock()
	defer h.settingsMu.Unlock()
	return h.cfg.remote && h.settings.RemoteEnabled
}

func (h *hub) start(ctx context.Context) {
	h.ctx = ctx
	h.reloadSystems()
	if code := h.pairing.current(); code != "" {
		log.Printf("Pairing code: %s (also shown on the setup page)", code)
	}
	if h.remoteWanted() {
		h.remote.enable()
	}
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.grants.flush()
			}
		}
	}()
}

func (h *hub) shutdown() {
	h.grants.flush()
	h.remote.disable(false)
}

// systemConfigs lists the configured systems: the one from the environment first.
func (h *hub) systemConfigs() []backend.Config {
	var out []backend.Config
	if h.cfg.frigateURL != "" {
		out = append(out, backend.Config{
			ID: "frigate", Kind: "frigate", Name: "Frigate", URL: h.cfg.frigateURL,
			MQTTURL: h.cfg.mqttURL, MQTTUser: h.cfg.mqttUser, MQTTPassword: h.cfg.mqttPass,
			TopicPrefix: h.cfg.topicPrefix, FromEnv: true,
		})
	}
	h.settingsMu.Lock()
	out = append(out, h.settings.Systems...)
	h.settingsMu.Unlock()
	return out
}

// newBackend creates a backend for a config through the brand registry (brands.go).
func newBackend(c backend.Config) (backend.Backend, error) {
	return backend.New(c)
}

// reloadSystems (re)starts every backend's event stream and health monitor.
func (h *hub) reloadSystems() {
	h.mu.Lock()
	old := h.systems
	h.systems = nil
	for i, c := range h.systemConfigs() {
		b, err := newBackend(c)
		if err != nil {
			log.Printf("system %s: %v", c.ID, err)
			continue
		}
		s := &system{cfg: c, b: b, primary: i == 0}
		h.systems = append(h.systems, s)
	}
	cur := append([]*system(nil), h.systems...)
	h.mu.Unlock()

	for _, s := range old {
		if s.cancel != nil {
			s.cancel()
		}
	}
	for _, s := range cur {
		ctx, cancel := context.WithCancel(h.ctx)
		s.cancel = cancel
		go func() {
			if err := s.b.Watch(ctx, &systemSink{h: h, s: s}); err != nil && !errors.Is(err, backend.ErrUnsupported) {
				log.Printf("%s events: %v", s.cfg.ID, err)
			}
		}()
		hm := newBackendHealthMonitor(s.b, h.store, h.pusher)
		hm.cameraID = func(native string) string { return s.publicID(native) }
		hm.allow = h.allowHealth
		go hm.run(ctx, time.Minute)
	}
}

// Public camera and event IDs: the first system's IDs are used as-is (so existing alert rules
// keep working); other systems' IDs are prefixed with "<systemID>~".
const idSep = "~"

func (s *system) publicID(native string) string {
	if s.primary {
		return native
	}
	return s.cfg.ID + idSep + native
}

// resolve maps a public camera/event ID to its system and native ID.
func (h *hub) resolve(public string) (*system, string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if pre, native, ok := strings.Cut(public, idSep); ok {
		for _, s := range h.systems {
			if !s.primary && s.cfg.ID == pre {
				return s, native, true
			}
		}
		return nil, "", false
	}
	for _, s := range h.systems {
		if s.primary {
			return s, public, true
		}
	}
	return nil, "", false
}

func (h *hub) systemList() []*system {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return append([]*system(nil), h.systems...)
}

func (s *system) setStatus(err error, cameras int) {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	s.checkedAt = time.Now()
	if err != nil {
		s.status = "Can't reach it: " + httpx.Explain(err).Error()
		return
	}
	s.status = fmt.Sprintf("Connected · %d camera%s", cameras, plural(cameras))
}

func (s *system) getStatus() (string, bool) {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	return s.status, strings.HasPrefix(s.status, "Connected")
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// systemSink maps a backend's native IDs to public ones before alerts see them.
type systemSink struct {
	h *hub
	s *system
}

func (k *systemSink) OnEvent(e backend.Event) {
	e.ID = k.s.publicID(e.ID)
	e.Camera = k.s.publicID(e.Camera)
	dets := make([]string, len(e.Detections))
	for i, d := range e.Detections {
		dets[i] = k.s.publicID(d)
	}
	e.Detections = dets
	k.h.engine.OnEvent(e)
}

func (k *systemSink) OnPosition(id string, x, y float64) {
	k.h.engine.OnPosition(k.s.publicID(id), x, y)
}

// alertSnapshot fetches a frame for push thumbnails and the legacy /snapshot route.
func (h *hub) alertSnapshot(ctx context.Context, camera string, height int) ([]byte, error) {
	s, native, ok := h.resolve(camera)
	if !ok {
		return nil, backend.ErrNotFound
	}
	b, _, err := s.b.Snapshot(ctx, native, height)
	return b, err
}

// allowAlert limits Instant Alerts to what a phone's grant can see right now.
func (h *hub) allowAlert(d device, camera string) bool {
	if d.GrantID == "" {
		return true
	}
	g := h.grants.get(d.GrantID)
	return g != nil && g.active(time.Now()) && g.canPush() && g.Cameras.has(camera)
}

// allowHealth: camera problems go to anyone who can see the camera; system-wide problems
// (storage, system down) only to the owner and full/household access.
func (h *hub) allowHealth(d device, camera string) bool {
	if !h.allowAlert(d, camera) {
		return false
	}
	if camera != "" || d.GrantID == "" {
		return true
	}
	g := h.grants.get(d.GrantID)
	return g != nil && (g.Role == roleOwner || g.Role == roleFull || g.Role == roleHousehold)
}

// deviceKeyAllows authenticates the notification extension's snapshot request by the per-phone
// thumbnail key it already holds.
func (h *hub) deviceKeyAllows(key, camera string) bool {
	if len(key) < 16 {
		return false
	}
	for _, d := range h.store.all() {
		if d.ThumbKey != "" && subtle.ConstantTimeCompare([]byte(d.ThumbKey), []byte(key)) == 1 {
			return h.allowAlert(d, camera)
		}
	}
	return false
}

// lanURL is the address phones on the home network use. r (optional) is a request that
// reached the Hub directly, whose Host header is the best evidence of a reachable address.
func (h *hub) lanURL(r *http.Request) string {
	if h.cfg.hubURL != "" {
		return h.cfg.hubURL
	}
	if r != nil && !isIngress(r) && r.Host != "" && !isRemote(r) {
		host := r.Host
		if hn, _, err := net.SplitHostPort(host); err == nil {
			host = hn
		}
		if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
			return "http://" + r.Host
		}
	}
	port := "8086"
	if _, p, err := net.SplitHostPort(h.cfg.listen); err == nil && p != "" {
		port = p
	}
	return "http://" + net.JoinHostPort(outboundIP(), port)
}

// outboundIP is the address of the interface used for the default route (no packets sent).
func outboundIP() string {
	c, err := net.Dial("udp", "192.0.2.1:9")
	if err != nil {
		return "127.0.0.1"
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).IP.String()
}

// remoteURL is the public Funnel URL ("" when remote access isn't running).
func (h *hub) remoteURL() string {
	st := h.remote.status()
	if st.State == "running" {
		return st.URL
	}
	return ""
}
