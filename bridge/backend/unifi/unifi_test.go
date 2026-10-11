package unifi

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const bootstrapJSON = `{
  "lastUpdateId": "upd-1",
  "nvr": {"name": "UDM", "ports": {"rtsp": 7447, "rtsps": 7441},
          "systemInfo": {"storage": {"size": 2000000000000, "used": 1500000000000, "available": 500000000000}}},
  "cameras": [
    {"id": "aaa111", "name": "Front Door", "type": "UVC G4 Doorbell Pro", "isConnected": true, "isAdopted": true,
     "channels": [
       {"id": 0, "enabled": true, "isRtspEnabled": true, "rtspAlias": "mainAlias", "width": 1600, "height": 1200},
       {"id": 2, "enabled": true, "isRtspEnabled": true, "rtspAlias": "lowAlias", "width": 640, "height": 480},
       {"id": 3, "enabled": true, "isRtspEnabled": true, "rtspAlias": "pkgAlias"}],
     "featureFlags": {"isDoorbell": true, "hasSmartDetect": true, "smartDetectTypes": ["person", "package", "vehicle"],
                      "isPtz": null, "hasPackageCamera": true},
     "recordingSettings": {"mode": "detections", "prePaddingSecs": 3, "postPaddingSecs": 5}},
    {"id": "bbb222", "name": "Yard PTZ", "state": "DISCONNECTED", "isConnected": false,
     "channels": [{"id": 0, "isRtspEnabled": false, "rtspAlias": null, "width": 1920, "height": 1080}],
     "featureFlags": {"isPtz": true, "zoom": {"steps": {"min": 0, "max": 1000}}},
     "recordingSettings": {"mode": "always"}, "stats": {"video": {"recordingStart": 1000000}}},
    {"id": "ccc333", "name": "Neighbor's", "isAdopted": true, "isAdoptedByOther": true, "channels": []}
  ]
}`

const eventsJSON = `[
  {"id": "e1", "type": "smartDetectZone", "start": 1700000000000, "end": 1700000010000, "camera": "aaa111",
   "smartDetectTypes": ["person", "face"],
   "metadata": {"detectedThumbnails": [{"type": "face", "group": {"matchedName": "Zach"}}], "licensePlate": null}},
  {"id": "e2", "type": "ring", "start": 1700000100000, "end": null, "camera": "aaa111"},
  {"id": "e3", "type": "motion", "start": 1700000050000, "end": 1700000060000, "camera": "bbb222"},
  {"id": "e4", "type": "disconnect", "start": 1700000070000, "camera": "bbb222"},
  {"id": "e5", "type": "smartDetectLine", "start": 1700000200000, "end": 1700000202000, "cameraId": "aaa111",
   "smartDetectTypes": ["licensePlate"], "metadata": {"licensePlate": {"name": "ABC123"}}}
]`

// fakeConsole answers like a UniFi OS console running Protect.
type fakeConsole struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	logins     int
	token      string // valid session cookie
	csrf       string // CSRF token writes must carry
	rotateNext string // sent as X-Updated-CSRF-Token on the next GET
	password   string
	loginBody  string
	requests   []string
	writes     []string
	rangeSeen  string
	packets    [][]byte // sent on the updates websocket
	wsQuery    string
}

func newFakeConsole(t *testing.T) *fakeConsole {
	f := &fakeConsole{t: t, password: "secret"}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeConsole) backend(t *testing.T, pass string) *Protect {
	p, err := New(backend.Config{ID: "unifi", Kind: kind, URL: f.srv.URL + "/", Username: "local", Password: pass})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (f *fakeConsole) expireSession() {
	f.mu.Lock()
	f.token = "expired-elsewhere"
	f.mu.Unlock()
}

func (f *fakeConsole) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
	if r.URL.Path == "/api/auth/login" {
		b, _ := io.ReadAll(r.Body)
		f.loginBody = string(b)
		var in loginBody
		_ = json.Unmarshal(b, &in)
		switch {
		case in.Password == "mfa":
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"code":"MFA_AUTH_REQUIRED","message":"2FA token required"}`)
			return
		case in.Username != "local" || in.Password != f.password:
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"code":"AUTHENTICATION_FAILED_INVALID_CREDENTIALS"}`)
			return
		}
		f.logins++
		f.token = fmt.Sprintf("tok%d", f.logins)
		f.csrf = fmt.Sprintf("csrf%d", f.logins)
		http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: f.token, Path: "/", Secure: true, HttpOnly: true})
		w.Header().Set("X-CSRF-Token", f.csrf)
		io.WriteString(w, `{"unique_id":"u1"}`)
		return
	}
	if c, err := r.Cookie("TOKEN"); err != nil || c.Value != f.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet {
		if r.Header.Get("X-CSRF-Token") != f.csrf {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		b, _ := io.ReadAll(r.Body)
		f.writes = append(f.writes, r.Method+" "+r.URL.Path+" "+string(b))
	} else if f.rotateNext != "" {
		f.csrf, f.rotateNext = f.rotateNext, ""
		w.Header().Set("X-Updated-CSRF-Token", f.csrf)
	}
	switch p := r.URL.Path; {
	case p == "/proxy/protect/api/bootstrap":
		io.WriteString(w, bootstrapJSON)
	case p == "/proxy/protect/api/events":
		io.WriteString(w, eventsJSON)
	case p == "/proxy/protect/api/events/e2":
		io.WriteString(w, `{"id":"e2","type":"ring","start":1700000100000,"camera":"aaa111"}`)
	case p == "/proxy/protect/api/events/e1/thumbnail" || p == "/proxy/protect/api/cameras/aaa111/snapshot":
		w.Header().Set("Content-Type", "image/jpeg")
		io.WriteString(w, "jpeg")
	case p == "/proxy/protect/api/cameras/bbb222/ptz/preset":
		io.WriteString(w, `[{"name":"Gate","slot":1},{"name":"","slot":0}]`)
	case p == "/proxy/protect/api/cameras/bbb222/ptz/position":
		io.WriteString(w, `{"steps":{"pan":0,"tilt":0,"zoom":500}}`)
	case p == "/proxy/protect/api/video/export":
		f.rangeSeen = r.Header.Get("Range")
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusPartialContent)
		io.WriteString(w, "mp4")
	case p == "/proxy/protect/ws/updates":
		f.wsQuery = r.URL.RawQuery
		pkts := f.packets
		f.mu.Unlock()
		up := websocket.Upgrader{}
		conn, err := up.Upgrade(w, r, nil)
		f.mu.Lock()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			for _, b := range pkts {
				if conn.WriteMessage(websocket.BinaryMessage, b) != nil {
					return
				}
			}
			_, _, _ = conn.ReadMessage() // hold open until the client leaves
		}()
	case strings.HasPrefix(p, "/proxy/protect/api/"):
		if r.Method != http.MethodGet {
			io.WriteString(w, `{}`)
			return
		}
		http.NotFound(w, r)
	default:
		http.NotFound(w, r)
	}
}

func TestLoginCSRFAndRetry(t *testing.T) {
	f := newFakeConsole(t)
	p := f.backend(t, "secret")
	ctx := context.Background()

	if _, err := p.Cameras(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.loginBody, `"username":"local"`) || !strings.Contains(f.loginBody, `"rememberMe":true`) {
		t.Errorf("login body = %s", f.loginBody)
	}

	// Expired session: 401 → sign in again and retry once.
	f.expireSession()
	if _, err := p.Cameras(ctx); err != nil {
		t.Fatalf("after expiry: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("logins = %d, want 2", f.logins)
	}

	// CSRF rotation: the token from X-Updated-CSRF-Token is used on the next write.
	f.mu.Lock()
	f.rotateNext = "rotated"
	f.mu.Unlock()
	if _, err := p.Cameras(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.PTZ(ctx, "bbb222", "MOVE_LEFT"); err != nil {
		t.Fatalf("PTZ after rotation: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("rotation caused a sign-in (logins = %d)", f.logins)
	}

	// A write refused for its CSRF token (403): sign in again and retry once.
	f.mu.Lock()
	f.csrf = "changed-elsewhere"
	f.mu.Unlock()
	if err := p.PTZ(ctx, "bbb222", "preset_Gate"); err != nil {
		t.Fatalf("PTZ after 403: %v", err)
	}
	if f.logins != 3 {
		t.Errorf("logins = %d, want 3", f.logins)
	}
	writes := strings.Join(f.writes, "\n")
	for _, want := range []string{
		`POST /proxy/protect/api/cameras/bbb222/move {"payload":{"panPos":-1000,"panSpeed":10,"scale":0,"tiltPos":0,"tiltSpeed":10},"type":"relative"}`,
		"POST /proxy/protect/api/cameras/bbb222/ptz/goto/1 ",
	} {
		if !strings.Contains(writes, want) {
			t.Errorf("missing write %q in\n%s", want, writes)
		}
	}
	if err := p.PTZ(ctx, "bbb222", "ZOOM_IN"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(f.writes, "\n"), `{"payload":{"zoomPos":600,"zoomSpeed":100},"type":"zoom"}`) {
		t.Errorf("zoom write missing: %v", f.writes)
	}
	if err := p.PTZ(ctx, "aaa111", "MOVE_LEFT"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("doorbell PTZ = %v", err)
	}
}

func TestProbeErrors(t *testing.T) {
	f := newFakeConsole(t)
	ctx := context.Background()
	if err := f.backend(t, "secret").Probe(ctx); err != nil {
		t.Fatalf("good probe: %v", err)
	}
	err := f.backend(t, "nope").Probe(ctx)
	if err == nil || !errors.Is(err, httpx.ErrAuth) || !strings.Contains(err.Error(), "not your Ubiquiti cloud account") {
		t.Errorf("wrong password: %v", err)
	}
	if httpx.Unreachable(err) {
		t.Error("a wrong password must not make the setup page try another port")
	}
	if err := f.backend(t, "mfa").Probe(ctx); err == nil || !strings.Contains(err.Error(), "two-step verification") {
		t.Errorf("mfa: %v", err)
	}
	other := httptest.NewTLSServer(http.NotFoundHandler())
	defer other.Close()
	p, _ := New(backend.Config{URL: other.URL, Username: "a", Password: "b"})
	if err := p.Probe(ctx); err == nil || !strings.Contains(err.Error(), "doesn't look like a UniFi console") {
		t.Errorf("not a console: %v", err)
	}
	if _, err := New(backend.Config{URL: ""}); err == nil {
		t.Error("empty address accepted")
	}
}

func TestBootstrapCamerasLiveHealth(t *testing.T) {
	f := newFakeConsole(t)
	p := f.backend(t, "secret")
	ctx := context.Background()

	cams, err := p.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cams) != 2 {
		t.Fatalf("cameras = %+v (the one adopted by another console must be hidden)", cams)
	}
	door, yard := cams[0], cams[1]
	if door.ID != "aaa111" || door.Name != "Front Door" || door.PTZ || door.Aspect < 1.33 || door.Aspect > 1.34 {
		t.Errorf("doorbell = %+v", door)
	}
	if got := strings.Join(door.Objects, ","); got != "motion,person,package,vehicle,doorbell" {
		t.Errorf("doorbell objects = %s", got)
	}
	if !yard.PTZ || yard.Aspect < 1.77 {
		t.Errorf("yard = %+v", yard)
	}

	live, err := p.Live(ctx, "aaa111", "main")
	if err != nil || live.Kind != backend.LiveRTSP || live.URL != "rtspx://127.0.0.1:7441/mainAlias" {
		t.Errorf("live main = %+v, %v", live, err)
	}
	sub, _ := p.Live(ctx, "aaa111", "sub")
	if sub.URL != "rtspx://127.0.0.1:7441/lowAlias" {
		t.Errorf("live sub = %+v (package lens must never be chosen)", sub)
	}
	// RTSP off: the Hub tries to turn it on, then explains plainly.
	if _, err := p.Live(ctx, "bbb222", ""); err == nil || !strings.Contains(err.Error(), "RTSP stream turned on") {
		t.Errorf("rtsp off: %v", err)
	}
	if _, err := p.Live(ctx, "ccc333", ""); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("other console's camera: %v", err)
	}

	h, err := p.Health(ctx)
	if err != nil || len(h.Offline) != 1 || h.Offline[0] != "bbb222" {
		t.Errorf("health = %+v, %v", h, err)
	}
	if len(h.Storage) != 1 || h.Storage[0].UsedPct != 75 || h.Storage[0].FreeGB != 500 {
		t.Errorf("storage = %+v", h.Storage)
	}

	info, err := p.PTZInfo(ctx, "bbb222")
	if err != nil || !info.CanMove || strings.Join(info.Presets, ",") != "Home,Preset 1,Gate" {
		t.Errorf("ptz info = %+v, %v", info, err)
	}
	if info, _ := p.PTZInfo(ctx, "aaa111"); info.CanMove || info.CanZoom || info.Presets == nil {
		t.Errorf("doorbell ptz info = %+v", info)
	}

	img, ct, err := p.Snapshot(ctx, "aaa111", 360)
	if err != nil || string(img) != "jpeg" || ct != "image/jpeg" {
		t.Errorf("snapshot = %q %q %v", img, ct, err)
	}
	if !strings.Contains(strings.Join(f.requests, "\n"), "/cameras/aaa111/snapshot?force=true&h=360") {
		t.Errorf("snapshot request missing:\n%s", strings.Join(f.requests, "\n"))
	}
	if _, _, err := p.Snapshot(ctx, "../bootstrap", 0); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("bad id: %v", err)
	}
}

func TestEvents(t *testing.T) {
	f := newFakeConsole(t)
	p := f.backend(t, "secret")
	ctx := context.Background()

	evs, err := p.Events(ctx, backend.EventQuery{After: 1699999000, Before: 1700001000})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 4 {
		t.Fatalf("events = %+v", evs)
	}
	if evs[0].ID != "e5" || evs[1].ID != "e2" || evs[3].ID != "e1" {
		t.Errorf("order: %s %s %s", evs[0].ID, evs[1].ID, evs[3].ID)
	}
	plate, ring, e1 := evs[0], evs[1], evs[3]
	if ring.Objects[0] != "doorbell" || ring.Severity != "alert" || ring.End != nil || ring.Start != 1700000100 {
		t.Errorf("ring = %+v", ring)
	}
	if strings.Join(e1.Objects, ",") != "person" || e1.SubLabels[0] != "Zach" || e1.End == nil || *e1.End != 1700000010 {
		t.Errorf("smart = %+v", e1)
	}
	if plate.Camera != "aaa111" || plate.Objects[0] != "vehicle" || plate.SubLabels[0] != "ABC123" {
		t.Errorf("plate = %+v", plate)
	}
	q := f.requests[len(f.requests)-1]
	for _, want := range []string{"start=1699999000000", "end=1700001000000", "types=ring", "types=smartDetectLine", "orderDirection=DESC"} {
		if !strings.Contains(q, want) {
			t.Errorf("events query %s lacks %s", q, want)
		}
	}

	only, _ := p.Events(ctx, backend.EventQuery{Cameras: []string{"bbb222"}, Before: 1700001000})
	if len(only) != 1 || only[0].Severity != "detection" {
		t.Errorf("camera filter = %+v", only)
	}
	alerts, _ := p.Events(ctx, backend.EventQuery{Severity: "alert", Limit: 2, Before: 1700001000})
	if len(alerts) != 2 || alerts[0].ID != "e5" {
		t.Errorf("severity+limit = %+v", alerts)
	}

	e, err := p.Event(ctx, "e2")
	if err != nil || e.Objects[0] != "doorbell" {
		t.Errorf("event = %+v, %v", e, err)
	}
	if _, err := p.Event(ctx, "missing"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("missing event: %v", err)
	}
	if img, _, err := p.EventThumbnail(ctx, "e1"); err != nil || string(img) != "jpeg" {
		t.Errorf("thumbnail = %q %v", img, err)
	}

	// Detection-mode camera: spans from events with the camera's padding (3 s before, 5 after);
	// the ring still in progress runs to now and swallows e5.
	p.now = func() time.Time { return time.Unix(1700000300, 0) }
	segs, err := p.Segments(ctx, "aaa111", 1699999000, 1700001000)
	if err != nil {
		t.Fatal(err)
	}
	want := []backend.Segment{{Start: 1699999997, End: 1700000015}, {Start: 1700000097, End: 1700000300}}
	if len(segs) != 2 || segs[0] != want[0] || segs[1] != want[1] {
		t.Errorf("segments = %+v", segs)
	}
	// Always-recording camera: one span from the oldest recording kept.
	segs, _ = p.Segments(ctx, "bbb222", 0, 1700001000)
	if len(segs) != 1 || segs[0].Start != 1000 || segs[0].End != 1700000300 {
		t.Errorf("always segments = %+v", segs)
	}
}

func TestPlaybackAndClip(t *testing.T) {
	f := newFakeConsole(t)
	p := f.backend(t, "secret")
	ctx := context.Background()
	p.now = func() time.Time { return time.Unix(1700005000, 0) }

	pb, err := p.Playback(ctx, "aaa111", 1700000000, 1700003600)
	if err != nil {
		t.Fatal(err)
	}
	if pb.Live != nil || pb.File == nil || pb.StartTime != 1700000000 || pb.EndTime != 1700000600 {
		t.Fatalf("playback = %+v", pb)
	}
	resp, err := pb.File(ctx, http.Header{"Range": {"bytes=0-99"}})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || string(body) != "mp4" || f.rangeSeen != "bytes=0-99" {
		t.Errorf("file = %d %q range %q", resp.StatusCode, body, f.rangeSeen)
	}
	if last := f.requests[len(f.requests)-1]; !strings.Contains(last, "/video/export?camera=aaa111&start=1700000000000&end=1700000600000&channel=0") {
		t.Errorf("export request = %s", last)
	}

	// Near now: the window ends at now.
	pb, _ = p.Playback(ctx, "aaa111", 1700004900, 1700006000)
	if pb.EndTime != 1700005000 {
		t.Errorf("end time near now = %v", pb.EndTime)
	}
	if _, err := p.Playback(ctx, "aaa111", 1700006000, 1700007000); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("future window: %v", err)
	}

	// The session expiring between requests is handled for media too.
	f.expireSession()
	resp, err = p.Clip(ctx, "aaa111", 1700000000, 1700000030, http.Header{})
	if err != nil || resp.StatusCode >= 400 {
		t.Fatalf("clip = %v, %v", resp, err)
	}
	resp.Body.Close()
	if _, err := p.VOD(ctx, "aaa111", 1, 2, "", nil); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("VOD = %v", err)
	}
}

// frame builds one update-packet frame.
func frame(t *testing.T, typ byte, payload []byte, deflate bool) []byte {
	t.Helper()
	if deflate {
		var buf bytes.Buffer
		zw := zlib.NewWriter(&buf)
		zw.Write(payload)
		zw.Close()
		payload = buf.Bytes()
	}
	h := make([]byte, 8, 8+len(payload))
	h[0], h[1] = typ, formatJSON
	if deflate {
		h[2] = 1
	}
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

func packet(t *testing.T, action, id, data string, deflate bool) []byte {
	a := fmt.Sprintf(`{"action":%q,"newUpdateId":"n-%s","modelKey":"event","id":%q}`, action, id, id)
	return append(frame(t, 1, []byte(a), deflate), frame(t, 2, []byte(data), deflate)...)
}

func TestDecodePacket(t *testing.T) {
	for _, deflate := range []bool{false, true} {
		b := packet(t, "add", "e9", `{"id":"e9","type":"ring","start":1700000000000,"camera":"aaa111"}`, deflate)
		pkt, err := decodePacket(b)
		if err != nil {
			t.Fatalf("deflate=%v: %v", deflate, err)
		}
		if pkt.Action.Action != "add" || pkt.Action.ModelKey != "event" || pkt.Action.NewUpdateID != "n-e9" || pkt.DataFormat != formatJSON ||
			!strings.Contains(string(pkt.Data), `"type":"ring"`) {
			t.Errorf("deflate=%v: packet = %+v %s", deflate, pkt.Action, pkt.Data)
		}
	}
	good := packet(t, "add", "x", `{}`, false)
	if _, err := decodePacket(good[:5]); err == nil {
		t.Error("short packet accepted")
	}
	if _, err := decodePacket(good[:len(good)-1]); err == nil {
		t.Error("truncated packet accepted")
	}
	bad := frame(t, 1, []byte("not zlib"), false)
	bad[2] = 1
	if _, err := decodePacket(bad); err == nil {
		t.Error("bad deflate accepted")
	}
}

type recSink struct {
	mu  sync.Mutex
	evs []backend.Event
	got chan struct{}
}

func (s *recSink) OnEvent(e backend.Event) {
	s.mu.Lock()
	s.evs = append(s.evs, e)
	s.mu.Unlock()
	s.got <- struct{}{}
}
func (s *recSink) OnPosition(string, float64, float64) {}

func TestWatch(t *testing.T) {
	f := newFakeConsole(t)
	f.packets = [][]byte{
		packet(t, "update", "camera-noise", `{"isConnected":true}`, false), // modelKey event but unknown id: ignored
		packet(t, "add", "e10", `{"id":"e10","type":"smartDetectZone","start":1700000000000,"camera":"aaa111","smartDetectTypes":["person"]}`, true),
		packet(t, "update", "e10", `{"end":1700000009000,"smartDetectTypes":["person","vehicle"]}`, false),
		packet(t, "add", "e11", `{"id":"e11","type":"ring","start":1700000020000,"camera":"aaa111"}`, true),
		packet(t, "add", "e12", `{"id":"e12","type":"motion","start":1700000030000,"camera":"bbb222"}`, false),
	}
	p := f.backend(t, "secret")
	ctx, cancel := context.WithCancel(context.Background())
	sink := &recSink{got: make(chan struct{}, 10)}
	done := make(chan error, 1)
	go func() { done <- p.Watch(ctx, sink) }()
	for i := 0; i < 4; i++ {
		select {
		case <-sink.got:
		case <-time.After(5 * time.Second):
			t.Fatalf("got %d events: %+v", i, sink.evs)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Watch = %v", err)
	}
	if f.wsQuery != "lastUpdateId=upd-1" {
		t.Errorf("ws query = %q", f.wsQuery)
	}
	e := sink.evs
	if e[0].ID != "e10" || e[0].End != nil || e[0].Severity != "alert" || e[0].Camera != "aaa111" {
		t.Errorf("add = %+v", e[0])
	}
	if e[1].ID != "e10" || e[1].End == nil || *e[1].End != 1700000009 || strings.Join(e[1].Objects, ",") != "person,vehicle" {
		t.Errorf("update = %+v", e[1])
	}
	if e[2].Objects[0] != "doorbell" || e[3].Objects[0] != "motion" || e[3].Severity != "detection" {
		t.Errorf("ring/motion = %+v %+v", e[2], e[3])
	}
}
