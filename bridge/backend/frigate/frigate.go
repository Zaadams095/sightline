// Package frigate is the Hub backend for Frigate NVR (0.14+). It talks to Frigate's internal,
// unauthenticated port (http://frigate:5000 on a compose network) and its MQTT event topics.
package frigate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

type Frigate struct {
	cfg    backend.Config
	base   string
	client *http.Client
	// media has no overall timeout: VOD segments and clips can take a while.
	media *http.Client

	mu       sync.Mutex
	conf     *Config
	confTime time.Time
}

func New(cfg backend.Config) *Frigate {
	if cfg.TopicPrefix == "" {
		cfg.TopicPrefix = "frigate"
	}
	return &Frigate{
		cfg:    cfg,
		base:   strings.TrimRight(cfg.URL, "/"),
		client: &http.Client{Timeout: 10 * time.Second},
		media:  &http.Client{},
	}
}

func init() {
	backend.Register(backend.Descriptor{
		Kind:        "frigate",
		Label:       "Frigate",
		Description: "Frigate NVR, version 0.14 or newer.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Frigate address", Hint: "192.168.1.10:5000",
				Help: "Use Frigate's internal port 5000 (not the 8971 login page)."},
			{Key: backend.FieldMQTTURL, Label: "MQTT broker address", Hint: "192.168.1.10:1883", Optional: true,
				Section: "Instant alerts (optional)", Scheme: "tcp", DefaultPort: 1883,
				Help: "The broker Frigate sends its events to. Without it, alerts can't be instant."},
			{Key: backend.FieldMQTTUser, Label: "MQTT username", Optional: true, Section: "Instant alerts (optional)"},
			{Key: backend.FieldMQTTPassword, Label: "MQTT password", Optional: true, Section: "Instant alerts (optional)"},
		},
		DefaultPorts: []int{5000},
		New:          func(c backend.Config) (backend.Backend, error) { return New(c), nil },
		Probe:        func(ctx context.Context, c backend.Config) error { return New(c).Probe(ctx) },
	})
}

func (f *Frigate) ID() string    { return f.cfg.ID }
func (f *Frigate) Kind() string  { return "frigate" }
func (f *Frigate) Label() string { return "Frigate" }

func (f *Frigate) Capabilities() backend.Capabilities {
	return backend.Capabilities{
		Snapshots: true, Events: true, Recordings: true, Clips: true, PTZ: true,
		Alerts: f.cfg.MQTTURL != "",
	}
}

var safeName = regexp.MustCompile(`^[A-Za-z0-9_.\-]+$`)

func checkName(s string) error {
	if !safeName.MatchString(s) || strings.Contains(s, "..") {
		return backend.ErrNotFound
	}
	return nil
}

func (f *Frigate) do(ctx context.Context, c *http.Client, path string, hdr http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.base+path, nil)
	if err != nil {
		return nil, err
	}
	for _, k := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := hdr.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	return c.Do(req)
}

func (f *Frigate) getJSON(ctx context.Context, path string, out any) error {
	resp, err := f.do(ctx, f.client, path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return backend.ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("frigate %s: HTTP %d", strings.SplitN(path, "?", 2)[0], resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out)
}

func (f *Frigate) getBytes(ctx context.Context, path string) ([]byte, string, error) {
	resp, err := f.do(ctx, f.client, path, nil)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", backend.ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("frigate: HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return b, resp.Header.Get("Content-Type"), err
}

// config is cached briefly; it changes rarely and every camera route needs it.
func (f *Frigate) config(ctx context.Context) (*Config, error) {
	f.mu.Lock()
	if f.conf != nil && time.Since(f.confTime) < 30*time.Second {
		c := f.conf
		f.mu.Unlock()
		return c, nil
	}
	f.mu.Unlock()
	var c Config
	if err := f.getJSON(ctx, "/api/config", &c); err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.conf, f.confTime = &c, time.Now()
	f.mu.Unlock()
	return &c, nil
}

func (f *Frigate) Cameras(ctx context.Context) ([]backend.Camera, error) {
	cfg, err := f.config(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(cfg.Cameras))
	for id := range cfg.Cameras {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := cfg.Cameras[ids[i]].UI.Order, cfg.Cameras[ids[j]].UI.Order
		if a != b {
			return a < b
		}
		return ids[i] < ids[j]
	})
	out := make([]backend.Camera, 0, len(ids))
	for _, id := range ids {
		c := cfg.Cameras[id]
		name := c.FriendlyName
		if name == "" {
			name = titleCase(id)
		}
		zones := make([]string, 0, len(c.Zones))
		for z := range c.Zones {
			zones = append(zones, z)
		}
		sort.Strings(zones)
		objects := c.Objects.Track
		if len(objects) == 0 {
			objects = []string{"person"}
		}
		aspect := 16.0 / 9
		if c.Detect.Width > 0 && c.Detect.Height > 0 {
			aspect = float64(c.Detect.Width) / float64(c.Detect.Height)
		}
		out = append(out, backend.Camera{
			ID: id, Name: name, Enabled: c.Enabled == nil || *c.Enabled, PTZ: c.ONVIF.Host != "",
			Aspect: aspect, Zones: zones, Objects: objects,
			DetectWidth: c.Detect.Width, DetectHeight: c.Detect.Height,
		})
	}
	return out, nil
}

func (f *Frigate) Snapshot(ctx context.Context, camera string, height int) ([]byte, string, error) {
	if err := checkName(camera); err != nil {
		return nil, "", err
	}
	q := url.Values{"quality": {"85"}}
	if height > 0 {
		q.Set("height", fmt.Sprint(height))
	}
	b, _, err := f.getBytes(ctx, "/api/"+camera+"/latest.jpg?"+q.Encode())
	return b, "image/jpeg", err
}

// streamName is the go2rtc stream for a camera: the first live.streams entry (the last one
// for the sub stream), else the camera name.
func (f *Frigate) streamName(ctx context.Context, camera, quality string) (string, error) {
	cfg, err := f.config(ctx)
	if err != nil {
		return "", err
	}
	c, ok := cfg.Cameras[camera]
	if !ok {
		return "", backend.ErrNotFound
	}
	if len(c.Live.Streams) == 0 {
		return camera, nil
	}
	// Same choice as the app: the first entry is main, the last is sub.
	streams := c.Live.Streams
	if quality == "sub" && len(streams) > 1 {
		return streams[len(streams)-1].Name, nil
	}
	return streams[0].Name, nil
}

func (f *Frigate) Live(ctx context.Context, camera, quality string) (backend.LiveSource, error) {
	src, err := f.streamName(ctx, camera, quality)
	if err != nil {
		return backend.LiveSource{}, err
	}
	ws := "ws" + strings.TrimPrefix(f.base, "http")
	return backend.LiveSource{Kind: backend.LiveMSE, URL: ws + "/live/mse/api/ws?src=" + url.QueryEscape(src)}, nil
}

func (f *Frigate) Events(ctx context.Context, q backend.EventQuery) ([]backend.Event, error) {
	v := url.Values{}
	if len(q.Cameras) > 0 {
		v.Set("cameras", strings.Join(q.Cameras, ","))
	}
	if q.After > 0 {
		v.Set("after", fmt.Sprintf("%.3f", q.After))
	}
	before := q.Before
	if before <= 0 {
		before = float64(time.Now().Unix() + 60)
	}
	v.Set("before", fmt.Sprintf("%.3f", before))
	if q.Severity != "" {
		v.Set("severity", q.Severity)
	}
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	v.Set("limit", fmt.Sprint(limit))
	var items []Review
	if err := f.getJSON(ctx, "/api/review?"+v.Encode(), &items); err != nil {
		return nil, err
	}
	out := make([]backend.Event, 0, len(items))
	for _, r := range items {
		out = append(out, r.Event())
	}
	return out, nil
}

func (f *Frigate) review(ctx context.Context, id string) (Review, error) {
	if err := checkName(id); err != nil {
		return Review{}, err
	}
	var r Review
	err := f.getJSON(ctx, "/api/review/"+id, &r)
	if err == nil && r.ID == "" {
		err = backend.ErrNotFound
	}
	return r, err
}

func (f *Frigate) Event(ctx context.Context, id string) (backend.Event, error) {
	r, err := f.review(ctx, id)
	if err != nil {
		return backend.Event{}, err
	}
	return r.Event(), nil
}

func (f *Frigate) EventThumbnail(ctx context.Context, id string) ([]byte, string, error) {
	r, err := f.review(ctx, id)
	if err != nil {
		return nil, "", err
	}
	path := strings.TrimPrefix(r.ThumbPath, "/media/frigate")
	if path == "" || strings.Contains(path, "..") || !strings.HasPrefix(path, "/clips/") {
		return nil, "", backend.ErrNotFound
	}
	b, ct, err := f.getBytes(ctx, path)
	if ct == "" {
		ct = "image/webp"
	}
	return b, ct, err
}

func (f *Frigate) Segments(ctx context.Context, camera string, after, before float64) ([]backend.Segment, error) {
	if err := checkName(camera); err != nil {
		return nil, err
	}
	var recs []struct {
		Start float64 `json:"start_time"`
		End   float64 `json:"end_time"`
	}
	// Always pass both bounds: Frigate's defaults are stale.
	path := fmt.Sprintf("/api/%s/recordings?after=%d&before=%d", camera, int64(after), int64(before+0.999))
	if err := f.getJSON(ctx, path, &recs); err != nil {
		return nil, err
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Start < recs[j].Start })
	// Merge back-to-back ~10 s files. Keep the tolerance tiny: spans also map wall time to
	// VOD player time, where gaps are removed.
	var spans []backend.Segment
	for _, r := range recs {
		if n := len(spans); n > 0 && r.Start-spans[n-1].End <= 0.5 {
			spans[n-1].End = max(spans[n-1].End, r.End)
			continue
		}
		spans = append(spans, backend.Segment{Start: r.Start, End: r.End})
	}
	return spans, nil
}

func (f *Frigate) VOD(ctx context.Context, camera string, start, end int64, file string, hdr http.Header) (*http.Response, error) {
	if err := checkName(camera); err != nil {
		return nil, err
	}
	if file == "" {
		file = "master.m3u8"
	}
	if err := checkName(file); err != nil {
		return nil, err
	}
	return f.do(ctx, f.media, fmt.Sprintf("/vod/%s/start/%d/end/%d/%s", camera, start, end, file), hdr)
}

func (f *Frigate) Clip(ctx context.Context, camera string, start, end int64, hdr http.Header) (*http.Response, error) {
	if err := checkName(camera); err != nil {
		return nil, err
	}
	return f.do(ctx, f.media, fmt.Sprintf("/api/%s/start/%d/end/%d/clip.mp4", camera, start, end), hdr)
}

func (f *Frigate) PTZInfo(ctx context.Context, camera string) (backend.PTZInfo, error) {
	if err := checkName(camera); err != nil {
		return backend.PTZInfo{}, err
	}
	var info struct {
		Features []string `json:"features"`
		Presets  []string `json:"presets"`
	}
	if err := f.getJSON(ctx, "/api/"+camera+"/ptz/info", &info); err != nil {
		return backend.PTZInfo{}, err
	}
	has := func(s ...string) bool {
		for _, x := range info.Features {
			for _, y := range s {
				if x == y {
					return true
				}
			}
		}
		return false
	}
	presets := info.Presets
	if presets == nil {
		presets = []string{}
	}
	return backend.PTZInfo{CanMove: has("pt", "pt-r"), CanZoom: has("zoom", "zoom-r"), Presets: presets}, nil
}

var ptzActions = map[string]bool{
	"MOVE_UP": true, "MOVE_DOWN": true, "MOVE_LEFT": true, "MOVE_RIGHT": true,
	"ZOOM_IN": true, "ZOOM_OUT": true, "FOCUS_IN": true, "FOCUS_OUT": true, "STOP": true,
}

// PTZ is WebSocket-only in Frigate: connect to /ws and publish to "<cam>/ptz".
func (f *Frigate) PTZ(ctx context.Context, camera, action string) error {
	if err := checkName(camera); err != nil {
		return err
	}
	if !ptzActions[action] && !(strings.HasPrefix(action, "preset_") && len(action) < 128) {
		return fmt.Errorf("unknown PTZ action")
	}
	d := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := d.DialContext(ctx, "ws"+strings.TrimPrefix(f.base, "http")+"/ws", nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]any{"topic": "onConnect", "message": "", "retain": false}); err != nil {
		return err
	}
	if err := conn.WriteJSON(map[string]any{"topic": camera + "/ptz", "payload": action, "retain": false}); err != nil {
		return err
	}
	// Give Frigate a moment to read the frame before closing.
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	return nil
}

func (f *Frigate) Health(ctx context.Context) (backend.Health, error) {
	var stats Stats
	if err := f.getJSON(ctx, "/api/stats", &stats); err != nil {
		return backend.Health{}, err
	}
	var cfg Config
	if err := f.getJSON(ctx, "/api/config", &cfg); err != nil {
		return backend.Health{}, err
	}
	return HealthFrom(stats, cfg), nil
}

// Watch subscribes to frigate/reviews (alerts) and frigate/events (object positions for masks).
func (f *Frigate) Watch(ctx context.Context, sink backend.Sink) error {
	if f.cfg.MQTTURL == "" {
		return backend.ErrUnsupported
	}
	prefix := f.cfg.TopicPrefix
	opts := mqtt.NewClientOptions().
		AddBroker(f.cfg.MQTTURL).
		SetClientID("sightline-hub-" + f.cfg.ID).
		SetUsername(f.cfg.MQTTUser).
		SetPassword(f.cfg.MQTTPassword).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetOnConnectHandler(func(c mqtt.Client) {
			log.Printf("%s: connected to MQTT, subscribing to %s/reviews", f.cfg.ID, prefix)
			c.Subscribe(prefix+"/events", 0, func(_ mqtt.Client, m mqtt.Message) {
				if id, x, y, ok := ParseObjectMessage(m.Payload()); ok {
					sink.OnPosition(id, x, y)
				}
			})
			c.Subscribe(prefix+"/reviews", 0, func(_ mqtt.Client, m mqtt.Message) {
				msg, ok, err := ParseReviewMessage(m.Payload())
				if err != nil {
					log.Printf("%s: bad review message: %v", f.cfg.ID, err)
				}
				if ok {
					sink.OnEvent(msg.After.Event())
				}
			})
		}).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Printf("%s: MQTT connection lost: %v", f.cfg.ID, err)
		})
	client := mqtt.NewClient(opts)
	client.Connect() // retries in the background
	<-ctx.Done()
	client.Disconnect(250)
	return nil
}

// Probe checks that Frigate answers (used by the setup page before saving).
func (f *Frigate) Probe(ctx context.Context) error {
	resp, err := f.do(ctx, f.client, "/api/version", nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("that address answered, but it doesn't look like Frigate's internal port (usually 5000)")
	}
	return nil
}
