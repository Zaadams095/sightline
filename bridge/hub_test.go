package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/zachadams/sightline/bridge/backend"
)

// ---- fake backend ----

type fakeBackend struct {
	id      string
	cams    []string
	events  []backend.Event
	liveURL string

	mu    sync.Mutex
	calls []string
}

func (f *fakeBackend) record(s string) {
	f.mu.Lock()
	f.calls = append(f.calls, s)
	f.mu.Unlock()
}

func (f *fakeBackend) has(cam string) bool {
	for _, c := range f.cams {
		if c == cam {
			return true
		}
	}
	return false
}

func (f *fakeBackend) ID() string    { return f.id }
func (f *fakeBackend) Kind() string  { return "fake" }
func (f *fakeBackend) Label() string { return "Fake NVR" }
func (f *fakeBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Snapshots: true, Events: true, Recordings: true, Clips: true, PTZ: true}
}
func (f *fakeBackend) Cameras(context.Context) ([]backend.Camera, error) {
	var out []backend.Camera
	for _, c := range f.cams {
		out = append(out, backend.Camera{ID: c, Name: strings.ToUpper(c), Enabled: true, PTZ: true, Aspect: 16.0 / 9})
	}
	return out, nil
}
func (f *fakeBackend) Snapshot(_ context.Context, cam string, _ int) ([]byte, string, error) {
	if !f.has(cam) {
		return nil, "", backend.ErrNotFound
	}
	return []byte("jpeg:" + cam), "image/jpeg", nil
}
func (f *fakeBackend) Live(_ context.Context, cam, _ string) (backend.LiveSource, error) {
	return backend.LiveSource{Kind: backend.LiveMSE, URL: f.liveURL + "?src=" + cam}, nil
}
func (f *fakeBackend) Events(_ context.Context, q backend.EventQuery) ([]backend.Event, error) {
	f.record(fmt.Sprintf("events %v %.0f-%.0f", q.Cameras, q.After, q.Before))
	var out []backend.Event
	for _, e := range f.events {
		if (len(q.Cameras) == 0 || contains(q.Cameras, e.Camera)) && e.Start >= q.After && (q.Before == 0 || e.Start <= q.Before) {
			out = append(out, e)
		}
	}
	return out, nil
}
func (f *fakeBackend) Event(_ context.Context, id string) (backend.Event, error) {
	for _, e := range f.events {
		if e.ID == id {
			return e, nil
		}
	}
	return backend.Event{}, backend.ErrNotFound
}
func (f *fakeBackend) EventThumbnail(_ context.Context, id string) ([]byte, string, error) {
	return []byte("thumb:" + id), "image/webp", nil
}
func (f *fakeBackend) Segments(_ context.Context, cam string, after, before float64) ([]backend.Segment, error) {
	f.record(fmt.Sprintf("segments %s %.0f-%.0f", cam, after, before))
	return []backend.Segment{{Start: 0, End: 10000}}, nil
}

func fakeResp(req string, ct, body string) *http.Response {
	r, _ := http.NewRequest(http.MethodGet, "http://fake/"+req, nil)
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {ct}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

func (f *fakeBackend) VOD(_ context.Context, cam string, start, end int64, file string, _ http.Header) (*http.Response, error) {
	f.record(fmt.Sprintf("vod %s %d-%d %s", cam, start, end, file))
	switch file {
	case "":
		return fakeResp("master.m3u8", "application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex-v1.m3u8\n"), nil
	case "index-v1.m3u8":
		return fakeResp(file, "application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-MAP:URI=\"init-v1.mp4\"\n#EXTINF:10,\nseg-1-v1.m4s\n#EXT-X-ENDLIST\n"), nil
	}
	return fakeResp(file, "video/mp4", "media:"+file), nil
}
func (f *fakeBackend) Clip(_ context.Context, cam string, start, end int64, _ http.Header) (*http.Response, error) {
	f.record(fmt.Sprintf("clip %s %d-%d", cam, start, end))
	return fakeResp("clip.mp4", "video/mp4", "mp4"), nil
}
func (f *fakeBackend) PTZInfo(context.Context, string) (backend.PTZInfo, error) {
	return backend.PTZInfo{CanMove: true, Presets: []string{}}, nil
}
func (f *fakeBackend) PTZ(_ context.Context, cam, action string) error {
	f.record("ptz " + cam + " " + action)
	return nil
}
func (f *fakeBackend) Health(context.Context) (backend.Health, error) { return backend.Health{}, nil }
func (f *fakeBackend) Watch(context.Context, backend.Sink) error      { return backend.ErrUnsupported }

// ---- harness ----

type testHub struct {
	h       *hub
	srv     *httptest.Server
	primary *fakeBackend
	push    *fakePusher
	tokens  map[string]string // role -> token
	grants  map[string]string // role -> grant id
}

func newTestHub(t *testing.T) *testHub {
	t.Helper()
	dir := t.TempDir()
	s, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := &fakePusher{}
	e := newEngine(s, p)
	h, err := newHub(config{dataDir: dir, hubName: "Test Home", listen: ":8086"}, s, e, p)
	if err != nil {
		t.Fatal(err)
	}
	primary := &fakeBackend{id: "frigate", cams: []string{"front", "back"}, events: []backend.Event{
		{ID: "e1", Camera: "front", Start: 1000, Severity: "alert", Objects: []string{"person"}},
		{ID: "e2", Camera: "back", Start: 5000, Severity: "alert", Objects: []string{"car"}},
		{ID: "e3", Camera: "front", Start: 9000, Severity: "detection", Objects: []string{"dog"}},
	}}
	other := &fakeBackend{id: "nvr", cams: []string{"garage"}}
	h.systems = []*system{
		{cfg: backend.Config{ID: "frigate", Kind: "fake"}, b: primary, primary: true},
		{cfg: backend.Config{ID: "nvr", Kind: "fake"}, b: other},
	}
	th := &testHub{h: h, primary: primary, push: p, tokens: map[string]string{}, grants: map[string]string{}}
	th.srv = httptest.NewServer(h.handler(nil))
	t.Cleanup(th.srv.Close)

	// Owner via pairing; guests via grants + redeem, exactly as the app does it.
	code := h.pairing.current()
	if len(code) != 6 {
		t.Fatalf("first-run pairing code = %q", code)
	}
	var paired tokenResponse
	th.call(t, "", "POST", "/v1/pair", map[string]string{"code": code, "deviceName": "Zach's iPhone"}, 200, &paired)
	th.tokens[roleOwner], th.grants[roleOwner] = paired.Token, paired.Grant.ID

	exp := time.Now().Add(time.Hour).Unix()
	for role, body := range map[string]map[string]any{
		roleFull:      {"name": "Partner", "role": "full"},
		roleHousehold: {"name": "Kid", "role": "household", "cameras": []string{"front"}},
		roleTemporary: {"name": "Sitter", "role": "temporary", "cameras": []string{"front", "back"}, "recordings": map[string]int64{"from": 4000, "to": 8000}, "expiresAt": exp},
		roleLive:      {"name": "Neighbor", "role": "live", "cameras": []string{"front"}},
	} {
		var created struct {
			Grant  grantView  `json:"grant"`
			Invite inviteView `json:"invite"`
		}
		th.call(t, paired.Token, "POST", "/v1/grants", body, 201, &created)
		var red tokenResponse
		th.call(t, "", "POST", "/v1/redeem", map[string]string{"code": strings.ToLower(created.Invite.Code)}, 200, &red)
		th.tokens[role], th.grants[role] = red.Token, created.Grant.ID
	}
	return th
}

func (th *testHub) do(t *testing.T, token, method, path string, body any) *http.Response {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, th.srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func (th *testHub) call(t *testing.T, token, method, path string, body any, want int, out any) {
	t.Helper()
	resp := th.do(t, token, method, path, body)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: HTTP %d, want %d: %s", method, path, resp.StatusCode, want, b)
	}
	if out != nil {
		if err := json.Unmarshal(b, out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, b)
		}
	}
}

// ---- grant enforcement: every role × every route ----

func TestGrantEnforcementTable(t *testing.T) {
	th := newTestHub(t)
	roles := []string{roleOwner, roleFull, roleHousehold, roleTemporary, roleLive}
	dev := map[string]any{"pushToken": "ExponentPushToken[x]", "systemId": "hub-1", "defaultRule": map[string]any{"enabled": true}}

	type tc struct {
		method, path string
		body         any
		want         map[string]int // role -> status
	}
	all := func(code int) map[string]int {
		return map[string]int{roleOwner: code, roleFull: code, roleHousehold: code, roleTemporary: code, roleLive: code}
	}
	cases := []tc{
		{"GET", "/v1/info", nil, all(200)},
		{"GET", "/v1/cameras", nil, all(200)},
		{"GET", "/v1/cameras/front/snapshot.jpg", nil, all(200)},
		{"GET", "/v1/cameras/back/snapshot.jpg", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 404, roleTemporary: 200, roleLive: 404}},
		{"GET", "/v1/cameras/nvr~garage/snapshot.jpg", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 404, roleTemporary: 404, roleLive: 404}},
		{"GET", "/v1/cameras/nope/snapshot.jpg", nil, all(404)},
		{"GET", "/v1/events", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/events/e1/thumbnail.jpg", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/events/e2/thumbnail.jpg", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 404, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/recordings/front/segments?after=0&before=10000", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/recordings/back/segments?after=0&before=10000", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 404, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/recordings/front/vod.m3u8?start=1000&end=2000", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/recordings/front/vod.m3u8?start=3000&end=5000", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/recordings/front/vod/1000/2000/seg-1-v1.m4s", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/recordings/front/vod/4000/5000/seg-1-v1.m4s", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/recordings/front/vod/3000/5000/seg-1-v1.m4s", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/recordings/front/clip.mp4?start=9000&end=9500", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"GET", "/v1/recordings/front/clip.mp4?start=7000&end=7500", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 200, roleLive: 403}},
		{"GET", "/v1/cameras/front/ptz", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 200, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/cameras/front/ptz", map[string]string{"action": "STOP"}, map[string]int{roleOwner: 204, roleFull: 204, roleHousehold: 204, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/cameras/back/ptz", map[string]string{"action": "STOP"}, map[string]int{roleOwner: 204, roleFull: 204, roleHousehold: 404, roleTemporary: 403, roleLive: 403}},
		{"PUT", "/v1/devices/dev-ROLE", dev, map[string]int{roleOwner: 204, roleFull: 204, roleHousehold: 204, roleTemporary: 204, roleLive: 403}},
		{"DELETE", "/v1/devices/dev-ROLE", nil, map[string]int{roleOwner: 204, roleFull: 204, roleHousehold: 204, roleTemporary: 204, roleLive: 403}},
		{"GET", "/v1/grants", nil, map[string]int{roleOwner: 200, roleFull: 200, roleHousehold: 403, roleTemporary: 403, roleLive: 403}},
		{"POST", "/v1/grants", map[string]any{"name": "X", "role": "live", "cameras": []string{"front"}}, map[string]int{roleOwner: 201, roleFull: 201, roleHousehold: 403, roleTemporary: 403, roleLive: 403}},
	}
	for _, c := range cases {
		for _, role := range roles {
			path := strings.ReplaceAll(c.path, "ROLE", role)
			resp := th.do(t, th.tokens[role], c.method, path, c.body)
			resp.Body.Close()
			if want := c.want[role]; resp.StatusCode != want {
				t.Errorf("%-9s %s %s: HTTP %d, want %d", role, c.method, path, resp.StatusCode, want)
			}
		}
		// No token at all: always 401 (except public info).
		resp := th.do(t, "", c.method, c.path, c.body)
		resp.Body.Close()
		if c.path != "/v1/info" && resp.StatusCode != 401 {
			t.Errorf("no token %s %s: HTTP %d, want 401", c.method, c.path, resp.StatusCode)
		}
	}
}

func TestCameraFilteringAndClamping(t *testing.T) {
	th := newTestHub(t)
	count := func(role, path string) int {
		var out []map[string]any
		th.call(t, th.tokens[role], "GET", path, nil, 200, &out)
		return len(out)
	}
	for role, want := range map[string]int{roleOwner: 3, roleFull: 3, roleHousehold: 1, roleTemporary: 2, roleLive: 1} {
		if got := count(role, "/v1/cameras"); got != want {
			t.Errorf("%s sees %d cameras, want %d", role, got, want)
		}
	}
	// Events: household = front only; temporary = only what started inside 4000–8000.
	for role, want := range map[string]int{roleOwner: 3, roleHousehold: 2, roleTemporary: 1} {
		if got := count(role, "/v1/events?after=1&before=20000"); got != want {
			t.Errorf("%s sees %d events, want %d", role, got, want)
		}
	}
	// Asking for a camera outside the grant yields nothing rather than leaking.
	if got := count(roleHousehold, "/v1/events?cameras=back"); got != 0 {
		t.Errorf("household got %d events for back", got)
	}
	// Segments are clamped to the window.
	var segs []backend.Segment
	th.call(t, th.tokens[roleTemporary], "GET", "/v1/recordings/front/segments?after=0&before=10000", nil, 200, &segs)
	if len(segs) != 1 || segs[0].Start != 4000 || segs[0].End != 8000 {
		t.Errorf("temporary segments = %+v", segs)
	}
	// Second system's cameras carry its prefix.
	var cams []cameraView
	th.call(t, th.tokens[roleOwner], "GET", "/v1/cameras", nil, 200, &cams)
	if cams[2].ID != "nvr~garage" || cams[2].System != "nvr" {
		t.Errorf("cameras = %+v", cams)
	}
	// Event thumbnail URLs carry ?token= when the caller used one (image views can't send headers).
	var evs []eventView
	th.call(t, "", "GET", "/v1/events?token="+th.tokens[roleOwner], nil, 200, &evs)
	if !strings.HasSuffix(evs[0].Thumbnail, "?token="+th.tokens[roleOwner]) || evs[0].ID != "e3" {
		t.Errorf("event = %+v", evs[0])
	}
}

func TestVODIsClampedAndRewritten(t *testing.T) {
	th := newTestHub(t)
	tok := th.tokens[roleTemporary]
	resp := th.do(t, "", "GET", "/v1/recordings/front/vod.m3u8?start=3000&end=5000&token="+tok, nil)
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "vod/4000/5000/index-v1.m3u8?token="+tok) {
		t.Fatalf("master playlist:\n%s", b)
	}
	// Follow the playlist the way AVPlayer would (relative URLs).
	resp = th.do(t, "", "GET", "/v1/recordings/front/vod/4000/5000/index-v1.m3u8?token="+tok, nil)
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), `URI="init-v1.mp4?token=`+tok+`"`) || !strings.Contains(string(b), "\nseg-1-v1.m4s?token="+tok) {
		t.Fatalf("media playlist:\n%s", b)
	}
	resp = th.do(t, "", "GET", "/v1/recordings/front/vod/4000/5000/seg-1-v1.m4s?token="+tok, nil)
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "media:seg-1-v1.m4s" {
		t.Fatalf("segment = %q", b)
	}
	// Path traversal in the file name never reaches the backend.
	resp = th.do(t, tok, "GET", "/v1/recordings/front/vod/4000/5000/..%2f..%2fapi%2fconfig", nil)
	resp.Body.Close()
	for _, c := range th.primary.calls {
		if strings.Contains(c, "..") {
			t.Fatalf("traversal reached backend: %s", c)
		}
	}
}

func TestRewritePlaylist(t *testing.T) {
	in := "#EXTM3U\r\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI=\"init-v1-a1.mp4\"\n#EXTINF:10.000,\nseg-1-v1-a1.m4s\n#EXTINF:4.5,\nhttp://frigate:5000/vod/x/seg-2-v1-a1.m4s?foo=1\n/etc/passwd\n#EXT-X-ENDLIST\n"
	got := rewritePlaylist(in, "vod/1/2/", "?token=t")
	want := "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI=\"vod/1/2/init-v1-a1.mp4?token=t\"\n#EXTINF:10.000,\nvod/1/2/seg-1-v1-a1.m4s?token=t\n#EXTINF:4.5,\nvod/1/2/seg-2-v1-a1.m4s?token=t\nvod/1/2/passwd?token=t\n#EXT-X-ENDLIST\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestTokensAreHashedAtRest(t *testing.T) {
	th := newTestHub(t)
	b, err := os.ReadFile(filepath.Join(th.h.cfg.dataDir, "grants.json"))
	if err != nil {
		t.Fatal(err)
	}
	for role, tok := range th.tokens {
		if !strings.HasPrefix(tok, "slh_") || len(tok) < 40 {
			t.Errorf("%s token %q looks weak", role, tok)
		}
		if bytes.Contains(b, []byte(tok)) {
			t.Errorf("%s token stored in clear text", role)
		}
		if !bytes.Contains(b, []byte(hashSecret(tok))) {
			t.Errorf("%s token hash missing", role)
		}
	}
}

func TestPairingFlow(t *testing.T) {
	th := newTestHub(t)
	// The first code was used; there is no code until someone asks for one.
	if c := th.h.pairing.current(); c != "" {
		t.Fatalf("code still active after pairing: %s", c)
	}
	th.call(t, "", "POST", "/v1/pair", map[string]string{"code": "000000"}, 401, nil)

	// Rate limit: 5 wrong codes per minute per address, then 429 even for the right one.
	code := th.h.pairing.renew()
	wrong := "123456"
	if wrong == code {
		wrong = "654321"
	}
	for i := 0; i < 4; i++ { // one failure above already counted
		th.call(t, "", "POST", "/v1/pair", map[string]string{"code": wrong}, 401, nil)
	}
	th.call(t, "", "POST", "/v1/pair", map[string]string{"code": code}, 429, nil)
	th.h.pairLimit = newLimiter(5, time.Minute, 20, 10*time.Minute)

	var out tokenResponse
	th.call(t, "", "POST", "/v1/pair", map[string]string{"code": code}, 200, &out)
	if out.Grant.Role != roleOwner || out.Hub.Name != "Test Home" {
		t.Errorf("pair response = %+v", out)
	}
	th.call(t, "", "POST", "/v1/pair", map[string]string{"code": code}, 401, nil) // one-time

	// Pairing is refused over the public link.
	rh := httptest.NewServer(th.h.remoteHandler(th.h.lanHandler))
	defer rh.Close()
	resp, _ := http.Post(rh.URL+"/v1/pair", "application/json", strings.NewReader(`{"code":"1"}`))
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("remote pair: HTTP %d", resp.StatusCode)
	}
	// …and so is the setup page and the legacy API.
	for _, p := range []string{"/", "/health", "/snapshot/front"} {
		resp, _ := http.Get(rh.URL + p)
		resp.Body.Close()
		if resp.StatusCode != 404 {
			t.Errorf("remote GET %s: HTTP %d", p, resp.StatusCode)
		}
	}
	// The API itself works remotely.
	req, _ := http.NewRequest("GET", rh.URL+"/v1/cameras", nil)
	req.Header.Set("Authorization", "Bearer "+out.Token)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("remote cameras: HTTP %d", resp.StatusCode)
	}
}

func TestRedeemIsOneTime(t *testing.T) {
	th := newTestHub(t)
	var created struct {
		Grant  grantView  `json:"grant"`
		Invite inviteView `json:"invite"`
	}
	th.call(t, th.tokens[roleOwner], "POST", "/v1/grants", map[string]any{"name": "Grandma", "role": "household"}, 201, &created)
	if !strings.HasPrefix(created.Invite.Link, "sightline://invite?") || !strings.Contains(created.Invite.Link, "code="+created.Invite.Code) {
		t.Errorf("invite link = %s", created.Invite.Link)
	}
	if !strings.HasPrefix(created.Invite.QR, "data:image/png;base64,") {
		t.Error("invite QR missing")
	}
	if strings.Contains(created.Invite.Link, "slh_") {
		t.Error("invite link must not carry a long-lived token")
	}
	th.call(t, "", "POST", "/v1/redeem", map[string]string{"code": created.Invite.Code}, 200, nil)
	th.call(t, "", "POST", "/v1/redeem", map[string]string{"code": created.Invite.Code}, 401, nil)

	// Re-invite (second phone) issues a new code for the same grant.
	var again struct {
		Invite inviteView `json:"invite"`
	}
	th.call(t, th.tokens[roleOwner], "POST", "/v1/grants/"+created.Grant.ID+"/invite", nil, 200, &again)
	var red tokenResponse
	th.call(t, "", "POST", "/v1/redeem", map[string]string{"code": again.Invite.Code}, 200, &red)
	if red.Grant.ID != created.Grant.ID || red.Grant.Devices != 2 {
		t.Errorf("redeemed = %+v", red.Grant)
	}
}

func TestExpiredAndRevoked(t *testing.T) {
	th := newTestHub(t)
	tok := th.tokens[roleTemporary]
	th.call(t, tok, "GET", "/v1/cameras", nil, 200, nil)

	th.h.grants.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	var e map[string]string
	th.call(t, tok, "GET", "/v1/cameras", nil, 401, &e)
	if e["error"] != "expired" {
		t.Errorf("expired error = %v", e)
	}
	th.h.grants.now = time.Now

	// Revoking: 401 "revoked" on every route, including websockets via ?token=.
	th.call(t, th.tokens[roleOwner], "DELETE", "/v1/grants/"+th.grants[roleHousehold], nil, 204, nil)
	th.call(t, th.tokens[roleHousehold], "GET", "/v1/cameras", nil, 401, &e)
	if e["error"] != "revoked" {
		t.Errorf("revoked error = %v", e)
	}
	th.call(t, "", "GET", "/v1/cameras/front/snapshot.jpg?token="+th.tokens[roleHousehold], nil, 401, nil)

	// Revoked grants disappear from the list; full access can't remove the owner.
	var list []grantView
	th.call(t, th.tokens[roleOwner], "GET", "/v1/grants", nil, 200, &list)
	for _, g := range list {
		if g.ID == th.grants[roleHousehold] {
			t.Error("revoked grant still listed")
		}
	}
	th.call(t, th.tokens[roleFull], "DELETE", "/v1/grants/"+th.grants[roleOwner], nil, 403, nil)
	th.call(t, th.tokens[roleFull], "DELETE", "/v1/grants/"+th.grants[roleLive], nil, 204, nil)

	// Survives a restart: hashes and tombstones are on disk.
	g2, err := openGrants(th.h.cfg.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g2.authenticate(th.tokens[roleLive]); err != errRevoked {
		t.Errorf("after reload: %v", err)
	}
	if _, err := g2.authenticate(th.tokens[roleOwner]); err != nil {
		t.Errorf("owner after reload: %v", err)
	}
}

func TestValidateGrant(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	known := []string{"front", "back"}
	exp := now.Unix() + 3600
	past := now.Unix() - 1
	all := cameraSet{All: true}
	one := cameraSet{IDs: []string{"front"}}
	bad := cameraSet{IDs: []string{"pool"}}
	none := recWindow{Mode: "none"}
	for _, c := range []struct {
		name string
		req  grantRequest
		ok   bool
		rec  string
	}{
		{"full forces everything", grantRequest{Name: "A", Role: "full", Cameras: &one, Recordings: &none}, true, "all"},
		{"household default all", grantRequest{Name: "A", Role: "household", Cameras: &one}, true, "all"},
		{"temporary needs end", grantRequest{Name: "A", Role: "temporary"}, false, ""},
		{"temporary default window", grantRequest{Name: "A", Role: "temporary", ExpiresAt: &exp}, true, "window"},
		{"live never recordings", grantRequest{Name: "A", Role: "live", Recordings: &recWindow{Mode: "all"}}, true, "none"},
		{"owner role not grantable", grantRequest{Name: "A", Role: "owner"}, false, ""},
		{"unknown camera", grantRequest{Name: "A", Role: "household", Cameras: &bad}, false, ""},
		{"no name", grantRequest{Role: "household", Cameras: &all}, false, ""},
		{"past expiry", grantRequest{Name: "A", Role: "household", ExpiresAt: &past}, false, ""},
	} {
		g, err := validateGrant(c.req, known, now)
		if (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
			continue
		}
		if c.ok && g.Recordings.Mode != c.rec {
			t.Errorf("%s: recordings = %+v", c.name, g.Recordings)
		}
	}
	// JSON shapes.
	var w recWindow
	if err := json.Unmarshal([]byte(`{"from":5,"to":2}`), &w); err == nil {
		t.Error("from > to accepted")
	}
	b, _ := json.Marshal(grantView{Cameras: one, Recordings: recWindow{Mode: "window", From: 1, To: 2}})
	if !strings.Contains(string(b), `"cameras":["front"]`) || !strings.Contains(string(b), `"recordings":{"from":1,"to":2}`) || !strings.Contains(string(b), `"expiresAt":null`) {
		t.Errorf("grant JSON = %s", b)
	}
}

func TestGrantAwareAlerts(t *testing.T) {
	th := newTestHub(t)
	dev := func(id string) map[string]any {
		return map[string]any{"pushToken": "ExponentPushToken[" + id + "]", "systemId": "hub", "defaultRule": map[string]any{"enabled": true}, "thumbKey": "0123456789abcdef-" + id}
	}
	th.call(t, th.tokens[roleOwner], "PUT", "/v1/devices/owner", dev("owner"), 204, nil)
	th.call(t, th.tokens[roleHousehold], "PUT", "/v1/devices/kid", dev("kid"), 204, nil)
	// A guest can't take over someone else's registration.
	th.call(t, th.tokens[roleHousehold], "PUT", "/v1/devices/owner", dev("x"), 403, nil)
	th.call(t, th.tokens[roleTemporary], "DELETE", "/v1/devices/kid", nil, 403, nil)

	th.h.engine.OnEvent(backend.Event{ID: "a", Camera: "front", Severity: "alert"})
	th.h.engine.OnEvent(backend.Event{ID: "b", Camera: "back", Severity: "alert"})
	got := map[string][]string{}
	for _, m := range th.push.sent {
		got[m.To] = append(got[m.To], m.Data["cameraId"])
	}
	if len(got["ExponentPushToken[owner]"]) != 2 || len(got["ExponentPushToken[kid]"]) != 1 || got["ExponentPushToken[kid]"][0] != "front" {
		t.Fatalf("alerts = %v", got)
	}
	// The notification extension's LAN snapshot works with the phone's thumbnail key, and only
	// for cameras the grant covers.
	if !th.h.deviceKeyAllows("0123456789abcdef-kid", "front") || th.h.deviceKeyAllows("0123456789abcdef-kid", "back") {
		t.Error("device key scope wrong")
	}

	// Revoking removes the phone from alerts entirely.
	th.call(t, th.tokens[roleOwner], "DELETE", "/v1/grants/"+th.grants[roleHousehold], nil, 204, nil)
	if _, ok := th.h.store.get("kid"); ok {
		t.Error("revoked guest's device still registered")
	}
}

func TestLiveWebSocketProxy(t *testing.T) {
	// Upstream speaking go2rtc's MSE protocol.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var m wsMessage
		if ws.ReadJSON(&m) != nil || m.Type != "mse" {
			return
		}
		_ = ws.WriteJSON(wsMessage{Type: "mse", Value: "video/mp4; codecs=\"avc1.640029\" src=" + r.URL.Query().Get("src")})
		_ = ws.WriteMessage(websocket.BinaryMessage, []byte{0, 0, 0, 1, 'f', 't', 'y', 'p'})
		_, _, _ = ws.ReadMessage()
	}))
	defer upstream.Close()
	th := newTestHub(t)
	th.primary.liveURL = "ws" + strings.TrimPrefix(upstream.URL, "http") + "/live/mse/api/ws"

	wsURL := "ws" + strings.TrimPrefix(th.srv.URL, "http") + "/v1/cameras/front/live?token=" + th.tokens[roleLive]
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.WriteJSON(wsMessage{Type: "mse", Value: "avc1.640029"})
	var m wsMessage
	if err := c.ReadJSON(&m); err != nil || m.Type != "mse" || !strings.HasSuffix(m.Value, "src=front") {
		t.Fatalf("mse reply = %+v, %v", m, err)
	}
	mt, b, err := c.ReadMessage()
	if err != nil || mt != websocket.BinaryMessage || string(b[4:]) != "ftyp" {
		t.Fatalf("binary = %v %q %v", mt, b, err)
	}

	// A camera outside the grant is 404 before any upgrade.
	_, resp, err := websocket.DefaultDialer.Dial(strings.Replace(wsURL, "/front/", "/back/", 1), nil)
	if err == nil || resp == nil || resp.StatusCode != 404 {
		t.Errorf("back camera live: %v %v", err, resp)
	}
}

func TestSetupPageGuards(t *testing.T) {
	th := newTestHub(t)
	get := func(host string) int {
		req, _ := http.NewRequest("GET", th.srv.URL+"/", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for host, want := range map[string]int{"192.168.1.20:8086": 200, "hub.local": 200, "homeassistant": 200, "evil.example.com": 421} {
		if got := get(host); got != want {
			t.Errorf("Host %s: HTTP %d, want %d", host, got, want)
		}
	}
	// Cross-site form posts are refused.
	req, _ := http.NewRequest("POST", th.srv.URL+"/setup/remote/enable", strings.NewReader(""))
	req.Header.Set("Origin", "http://evil.example.com")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("cross-site post: HTTP %d", resp.StatusCode)
	}

	// The page renders the systems and the shared-access list.
	resp, _ = http.Get(th.srv.URL + "/")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, s := range []string{"Sitter", "Live only", "Fake NVR", "Zach&#39;s iPhone"} {
		if !strings.Contains(string(b), s) {
			t.Errorf("setup page missing %q", s)
		}
	}

	// Within 15 minutes of start, "Pair another phone" shows a QR code with the deep link.
	req, _ = http.NewRequest("POST", th.srv.URL+"/setup/pair", nil)
	req.Header.Set("Origin", th.srv.URL)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, _ = client.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 303 || th.h.pairing.current() == "" {
		t.Fatalf("pair another phone: HTTP %d", resp.StatusCode)
	}
	resp, _ = http.Get(th.srv.URL + "/")
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "data:image/png;base64,") || !strings.Contains(string(b), th.h.pairing.current()) {
		t.Error("pairing QR/code not shown")
	}
	// After the window, the page refuses to make codes when someone is paired.
	th.h.startedAt = time.Now().Add(-time.Hour)
	resp, _ = client.Do(req)
	loc := resp.Header.Get("Location")
	resp.Body.Close()
	if !strings.Contains(loc, "err=1") {
		t.Errorf("pair after window: %s", loc)
	}
}

func TestInviteLink(t *testing.T) {
	l := inviteLink("invite", "ABCDE-FGHJK", "Home", "http://192.168.1.2:8086", "https://hub.tail.ts.net")
	if l != "sightline://invite?code=ABCDE-FGHJK&lan=http%3A%2F%2F192.168.1.2%3A8086&name=Home&url=https%3A%2F%2Fhub.tail.ts.net" {
		t.Errorf("invite = %s", l)
	}
	p := inviteLink("hub", "123456", "Home", "http://192.168.1.2:8086", "")
	if p != "sightline://hub?code=123456&name=Home&url=http%3A%2F%2F192.168.1.2%3A8086" {
		t.Errorf("pair = %s", p)
	}
	if normalizeInvite("abcde-fghjk") != "ABCDEFGHJK" {
		t.Error("normalize")
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := newLimiter(2, time.Minute, 3, 10*time.Minute)
	l.now = func() time.Time { return now }
	l.fail("a")
	l.fail("a")
	if !l.blocked("a") || l.blocked("b") {
		t.Fatal("per-client limit")
	}
	l.fail("b")
	if !l.blocked("c") {
		t.Fatal("global limit")
	}
	now = now.Add(11 * time.Minute)
	if l.blocked("a") || l.blocked("c") {
		t.Fatal("limits should reset")
	}
}
