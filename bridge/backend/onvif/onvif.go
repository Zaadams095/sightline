// Package onvif is the Hub backend for any ONVIF (Profile S/T) camera or recorder: live video
// from GetStreamUri, snapshots, PTZ, and Instant Alerts from the device's PullPoint event
// subscription. It is a port of the app's reviewed adapter (app/src/systems/onvif.ts and
// onvif-soap.ts).
//
// Recordings (Profile G) aren't offered: ONVIF replay needs an RTSP session with an absolute
// Range and the onvif-replay Require header, which the Hub's restreamer doesn't send, and few
// cameras implement it the same way. Events history isn't offered either: ONVIF only reports
// what happens while subscribed.
package onvif

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const (
	kind       = "onvif"
	label      = "Other network camera (ONVIF)"
	devicePath = "/onvif/device_service"
	ptzSpeed   = 0.5
	// rediscover re-reads the camera's profiles this often (recorders gain channels).
	rediscover = 10 * time.Minute
)

func init() {
	backend.Register(backend.Descriptor{
		Kind:        kind,
		Label:       label,
		Description: "Most IP cameras and recorders from any brand, through the ONVIF standard. Turn ONVIF on in the camera's settings first.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Camera address", Hint: "192.168.1.70",
				Help: "The camera's IP address. If it uses a special ONVIF port, add it (like 192.168.1.70:2020)."},
			{Key: backend.FieldUsername, Label: "Username", Default: "admin"},
			{Key: backend.FieldPassword, Label: "Password",
				Help: "The camera's login. Some cameras need a separate ONVIF user, added in the camera's settings."},
		},
		// Port 80 for most brands, then Reolink (8000), TP-Link Tapo (2020) and many others (8899).
		DefaultPorts: []int{80, 8000, 2020, 8899, 8080},
		Order:        100,
		New:          func(c backend.Config) (backend.Backend, error) { return New(c) },
		Probe: func(ctx context.Context, c backend.Config) error {
			o, err := New(c)
			if err != nil {
				return err
			}
			return o.Probe(ctx)
		},
	})
}

// Onvif is one ONVIF device (a camera, or a recorder exposing several channels).
type Onvif struct {
	cfg  backend.Config
	base *url.URL
	http *httpx.Client
	// events has a longer timeout: PullMessages waits on the camera for news.
	events *httpx.Client
	soap   *soapClient

	loadMu sync.Mutex // serializes discovery

	mu      sync.Mutex
	st      *state
	streams map[string]string // profile token → RTSP URL with login
	nodes   []ptzNode
	presets map[string][]preset // PTZ profile token → presets
	noPull  bool                // the camera refused a PullPoint subscription
}

type state struct {
	at        time.Time
	device    string
	media     string
	media2    bool
	ptz       string // "" when the device has no PTZ service
	events    string // "" when the device has no event service
	name      string
	cameras   []onvifCamera
	snapshots map[string]string // camera ID → absolute snapshot URL
}

// New builds the backend; it doesn't touch the network.
func New(cfg backend.Config) (*Onvif, error) {
	raw := strings.TrimSpace(cfg.URL)
	if raw == "" {
		return nil, errors.New("type the camera's address (like 192.168.1.70)")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return nil, fmt.Errorf("%q doesn't look like a camera address (try something like 192.168.1.70)", cfg.URL)
	}
	u.Path, u.RawQuery, u.Fragment, u.User = "", "", "", nil
	return &Onvif{
		cfg:     cfg,
		base:    u,
		http:    httpx.New(u.String(), cfg.Username, cfg.Password),
		events:  httpx.New(u.String(), cfg.Username, cfg.Password, httpx.WithTimeout(pullTimeout+20*time.Second)),
		soap:    &soapClient{user: cfg.Username, pass: cfg.Password},
		streams: map[string]string{},
		presets: map[string][]preset{},
	}, nil
}

func (o *Onvif) ID() string    { return o.cfg.ID }
func (o *Onvif) Kind() string  { return kind }
func (o *Onvif) Label() string { return label }

// Capabilities reflect what discovery found (optimistic until the device has been reached).
func (o *Onvif) Capabilities() backend.Capabilities {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.st == nil {
		return backend.Capabilities{Snapshots: true, Alerts: true, Talk: true}
	}
	ptz := false
	if o.st.ptz != "" {
		for _, c := range o.st.cameras {
			ptz = ptz || c.PTZ != nil
		}
	}
	return backend.Capabilities{
		Snapshots: len(o.st.snapshots) > 0,
		PTZ:       ptz,
		Alerts:    o.st.events != "" && !o.noPull,
		Talk:      true,
	}
}

// Talk: ONVIF Profile T cameras take audio on the RTSP backchannel of their stream. Whether
// this one does is only known by asking it (the Hub probes before offering it).
func (o *Onvif) Talk(ctx context.Context, camera string) (backend.TalkTarget, error) {
	live, err := o.Live(ctx, camera, "main")
	if err != nil {
		return backend.TalkTarget{}, err
	}
	return backend.TalkTarget{Kind: "rtsp", URL: live.URL}, nil
}

func (o *Onvif) call(ctx context.Context, path, body string) (*node, error) {
	return o.soap.call(ctx, o.http, path, body, callOpts{})
}

// Probe checks the address speaks ONVIF and the login works, in plain words.
func (o *Onvif) Probe(ctx context.Context) error {
	st, err := o.discover(ctx)
	if err != nil {
		return err
	}
	o.mu.Lock()
	o.st = st
	o.mu.Unlock()
	return nil
}

// load returns the discovered device, discovering it once (and again after a failure).
func (o *Onvif) load(ctx context.Context) (*state, error) {
	o.mu.Lock()
	st := o.st
	o.mu.Unlock()
	if st != nil {
		return st, nil
	}
	return o.refresh(ctx, nil)
}

// refresh rediscovers unless someone else already replaced old.
func (o *Onvif) refresh(ctx context.Context, old *state) (*state, error) {
	o.loadMu.Lock()
	defer o.loadMu.Unlock()
	o.mu.Lock()
	if o.st != nil && o.st != old {
		st := o.st
		o.mu.Unlock()
		return st, nil
	}
	o.mu.Unlock()
	st, err := o.discover(ctx)
	if err != nil {
		return nil, err
	}
	o.mu.Lock()
	o.st = st
	o.streams = map[string]string{}
	o.presets = map[string][]preset{}
	o.nodes = nil
	o.mu.Unlock()
	return st, nil
}

// syncClock reads the camera's clock (no login needed): WS-Security logins fail when the
// clocks differ by more than a few seconds, so requests are time-stamped by the camera's clock.
func (o *Onvif) syncClock(ctx context.Context) error {
	doc, err := o.soap.call(ctx, o.http, devicePath, reqGetSystemDateAndTime, callOpts{noAuth: true})
	if err != nil {
		return err
	}
	if t, ok := parseSystemTime(doc); ok {
		o.soap.setSkew(time.Until(t))
	}
	return nil
}

func (o *Onvif) discover(ctx context.Context) (*state, error) {
	// 1. Camera clock. Network trouble and "not ONVIF" end here; a fault (some cameras want a
	//    login even for this) doesn't.
	if err := o.syncClock(ctx); err != nil && !isFaultOrAuth(err) {
		return nil, err
	}

	// 2. Where the media/PTZ/event services live. Newer cameras answer GetServices, older
	//    ones only GetCapabilities. Only the XAddrs' paths are used.
	var addrs serviceAddrs
	doc, err := o.call(ctx, devicePath, reqGetServices)
	switch {
	case err == nil:
		addrs = parseServices(doc)
	case !errors.Is(err, errFault):
		return nil, err
	}
	if addrs.Media == "" && addrs.Media2 == "" {
		doc, err := o.call(ctx, devicePath, reqGetCapabilities)
		switch {
		case err == nil:
			c := parseCapabilities(doc)
			addrs.Device = firstNonEmpty(addrs.Device, c.Device)
			addrs.Media = c.Media
			addrs.PTZ = firstNonEmpty(addrs.PTZ, c.PTZ)
			addrs.Events = firstNonEmpty(addrs.Events, c.Events)
		case !errors.Is(err, errFault):
			return nil, err
		}
	}
	st := &state{at: time.Now(), device: xaddrPath(addrs.Device, devicePath)}

	// 3. Name (also a call that always needs the login).
	if doc, err := o.call(ctx, st.device, reqGetDeviceInformation); err == nil {
		st.name = parseDeviceName(doc)
	} else if errors.Is(err, httpx.ErrAuth) {
		return nil, err
	}

	// 4. Video profiles: one camera per video source (lens or recorder channel).
	st.media2 = addrs.Media == "" && addrs.Media2 != ""
	if st.media2 {
		st.media = xaddrPath(addrs.Media2, "/onvif/media2_service")
	} else {
		st.media = xaddrPath(addrs.Media, "/onvif/media_service")
	}
	doc, err = o.call(ctx, st.media, reqGetProfiles(st.media2))
	if err != nil {
		return nil, err
	}
	st.cameras = camerasFromProfiles(parseProfiles(doc))
	if len(st.cameras) == 0 {
		return nil, errors.New("the camera has no video streams set up. Check its video settings")
	}
	if addrs.PTZ != "" {
		st.ptz = xaddrPath(addrs.PTZ, "/onvif/ptz_service")
	}
	if addrs.Events != "" {
		st.events = xaddrPath(addrs.Events, "/onvif/event_service")
	}

	// 5. Snapshot links (optional).
	st.snapshots = map[string]string{}
	var wg sync.WaitGroup
	var smu sync.Mutex
	for _, c := range st.cameras {
		wg.Go(func() {
			sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			doc, err := o.call(sctx, st.media, reqGetSnapshotURI(c.Main.Token, st.media2))
			if err != nil {
				return
			}
			if u := snapshotURL(parseURI(doc), o.base); u != "" {
				smu.Lock()
				st.snapshots[c.ID] = u
				smu.Unlock()
			}
		})
	}
	wg.Wait()
	return st, nil
}

func isFaultOrAuth(err error) bool {
	return errors.Is(err, errFault) || errors.Is(err, httpx.ErrAuth)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (o *Onvif) camera(ctx context.Context, id string) (*state, onvifCamera, error) {
	st, err := o.load(ctx)
	if err != nil {
		return nil, onvifCamera{}, err
	}
	for _, c := range st.cameras {
		if c.ID == id {
			return st, c, nil
		}
	}
	return nil, onvifCamera{}, backend.ErrNotFound
}

func (o *Onvif) Cameras(ctx context.Context) ([]backend.Camera, error) {
	st, err := o.load(ctx)
	if err == nil && time.Since(st.at) > rediscover {
		st, err = o.refresh(ctx, st)
	}
	if err != nil {
		return nil, err
	}
	base := strings.TrimSpace(o.cfg.Name)
	if base == "" {
		base = st.name
	}
	if base == "" {
		base = "Camera"
	}
	out := make([]backend.Camera, 0, len(st.cameras))
	for i, c := range st.cameras {
		name := base
		if len(st.cameras) > 1 {
			name = fmt.Sprintf("%s %d", base, i+1)
		}
		aspect := 16.0 / 9
		if c.Main.Width > 0 && c.Main.Height > 0 {
			aspect = float64(c.Main.Width) / float64(c.Main.Height)
		}
		out = append(out, backend.Camera{
			ID: c.ID, Name: name, Enabled: true, Aspect: aspect,
			PTZ: st.ptz != "" && c.PTZ != nil,
		})
	}
	return out, nil
}

func (o *Onvif) Snapshot(ctx context.Context, camera string, _ int) ([]byte, string, error) {
	st, c, err := o.camera(ctx, camera)
	if err != nil {
		return nil, "", err
	}
	u := st.snapshots[c.ID]
	if u == "" {
		return nil, "", backend.ErrUnsupported
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := o.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer))
	if err != nil {
		return nil, "", err
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "application/octet-stream") {
		ct = "image/jpeg"
	}
	return body, ct, nil
}

func (o *Onvif) Live(ctx context.Context, camera, quality string) (backend.LiveSource, error) {
	st, c, err := o.camera(ctx, camera)
	if err != nil {
		return backend.LiveSource{}, err
	}
	p := c.Main
	if quality == "sub" {
		p = c.Sub
	}
	o.mu.Lock()
	cached := o.streams[p.Token]
	o.mu.Unlock()
	if cached != "" {
		return backend.LiveSource{Kind: backend.LiveRTSP, URL: cached}, nil
	}
	doc, err := o.call(ctx, st.media, reqGetStreamURI(p.Token, st.media2))
	if err != nil {
		return backend.LiveSource{}, err
	}
	uri := parseURI(doc)
	if uri == "" {
		return backend.LiveSource{}, errors.New("the camera didn't give a video link")
	}
	u := streamURL(uri, o.base.Hostname(), o.cfg.Username, o.cfg.Password)
	o.mu.Lock()
	o.streams[p.Token] = u
	o.mu.Unlock()
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: u}, nil
}

func (o *Onvif) PTZInfo(ctx context.Context, camera string) (backend.PTZInfo, error) {
	st, c, err := o.camera(ctx, camera)
	if err != nil {
		return backend.PTZInfo{}, err
	}
	if st.ptz == "" || c.PTZ == nil {
		return backend.PTZInfo{Presets: []string{}}, nil
	}
	// Remember the nodes only once the camera has listed them; a failure is retried next time.
	o.mu.Lock()
	nodes := o.nodes
	o.mu.Unlock()
	if nodes == nil {
		if doc, err := o.call(ctx, st.ptz, reqGetNodes); err == nil {
			nodes = parsePTZNodes(doc)
			o.mu.Lock()
			o.nodes = nodes
			o.mu.Unlock()
		}
	}
	info := backend.PTZInfo{CanMove: true, Presets: []string{}}
	var node *ptzNode
	for i := range nodes {
		if nodes[i].Token == c.PTZ.PTZNode {
			node = &nodes[i]
		}
	}
	if node == nil && len(nodes) > 0 {
		node = &nodes[0]
	}
	if node != nil {
		info.CanMove, info.CanZoom = node.CanMove, node.CanZoom
	}
	if list, err := o.loadPresets(ctx, st.ptz, c.PTZ.Token); err == nil {
		for _, p := range list {
			info.Presets = append(info.Presets, p.Name)
		}
	}
	return info, nil
}

func (o *Onvif) loadPresets(ctx context.Context, ptzPath, profile string) ([]preset, error) {
	doc, err := o.call(ctx, ptzPath, reqGetPresets(profile))
	if err != nil {
		return nil, err
	}
	// The app shows names; keep the first preset of each name.
	var unique []preset
	seen := map[string]bool{}
	for _, p := range parsePresets(doc) {
		if !seen[p.Name] {
			seen[p.Name] = true
			unique = append(unique, p)
		}
	}
	o.mu.Lock()
	o.presets[profile] = unique
	o.mu.Unlock()
	return unique, nil
}

func (o *Onvif) PTZ(ctx context.Context, camera, action string) error {
	st, c, err := o.camera(ctx, camera)
	if err != nil {
		return err
	}
	if st.ptz == "" || c.PTZ == nil {
		return backend.ErrUnsupported
	}
	profile := c.PTZ.Token
	if name, ok := strings.CutPrefix(action, "preset_"); ok {
		o.mu.Lock()
		list, cached := o.presets[profile]
		o.mu.Unlock()
		if !cached {
			if list, err = o.loadPresets(ctx, st.ptz, profile); err != nil {
				return unsupported(err)
			}
		}
		for _, p := range list {
			if p.Name == name || p.Token == name {
				_, err := o.call(ctx, st.ptz, reqGotoPreset(profile, p.Token))
				return unsupported(err)
			}
		}
		return fmt.Errorf("%w: the camera has no preset called %q", backend.ErrNotFound, name)
	}
	var req string
	switch action {
	case "MOVE_UP":
		req = reqContinuousMove(profile, 0, ptzSpeed, 0)
	case "MOVE_DOWN":
		req = reqContinuousMove(profile, 0, -ptzSpeed, 0)
	case "MOVE_LEFT":
		req = reqContinuousMove(profile, -ptzSpeed, 0, 0)
	case "MOVE_RIGHT":
		req = reqContinuousMove(profile, ptzSpeed, 0, 0)
	case "ZOOM_IN":
		req = reqContinuousMove(profile, 0, 0, ptzSpeed)
	case "ZOOM_OUT":
		req = reqContinuousMove(profile, 0, 0, -ptzSpeed)
	case "STOP":
		req = reqStop(profile)
	default:
		return fmt.Errorf("%w: unknown camera movement %q", backend.ErrUnsupported, action)
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = o.call(cctx, st.ptz, req)
	return unsupported(err)
}

// Health checks the camera still answers (its clock needs no login, and re-reading it keeps
// WS-Security timestamps right if the camera's clock drifts).
func (o *Onvif) Health(ctx context.Context) (backend.Health, error) {
	if err := o.syncClock(ctx); err != nil && !isFaultOrAuth(err) {
		return backend.Health{}, err
	}
	return backend.Health{}, nil
}

// ---- not offered by ONVIF here (see the package comment) ----

func (o *Onvif) Events(context.Context, backend.EventQuery) ([]backend.Event, error) {
	return nil, backend.ErrUnsupported
}

func (o *Onvif) Event(context.Context, string) (backend.Event, error) {
	return backend.Event{}, backend.ErrUnsupported
}

func (o *Onvif) EventThumbnail(context.Context, string) ([]byte, string, error) {
	return nil, "", backend.ErrUnsupported
}

func (o *Onvif) Segments(context.Context, string, float64, float64) ([]backend.Segment, error) {
	return nil, backend.ErrUnsupported
}

func (o *Onvif) VOD(context.Context, string, int64, int64, string, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

func (o *Onvif) Clip(context.Context, string, int64, int64, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}
