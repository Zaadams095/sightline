package reolink

import (
	"context"
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

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// fakeDevice answers like a Reolink NVR (or a single doorbell camera) on /cgi-bin/api.cgi.
// Its clock runs at UTC+2.
type fakeDevice struct {
	mu         sync.Mutex
	nvr        bool
	pass       string
	logins     int
	tokenN     int
	valid      map[string]bool
	calls      []string
	params     map[string][]json.RawMessage
	rtspEnable int
	ch3Online  bool
	// Detection state for Watch.
	noGetEvents bool
	events      map[int]string // GetEvents value per channel (JSON)
	md          map[int]int
	ai          map[int]string
	media       []string // "cmd source start range"
}

var plus2 = time.FixedZone("+2", 2*3600)

func newFake(t *testing.T, nvr bool) (*fakeDevice, *Reolink) {
	t.Helper()
	d := &fakeDevice{nvr: nvr, pass: "secret", valid: map[string]bool{}, params: map[string][]json.RawMessage{},
		events: map[int]string{}, md: map[int]int{}, ai: map[int]string{}}
	srv := httptest.NewServer(d)
	t.Cleanup(srv.Close)
	r := New(backend.Config{ID: "reo", Kind: "reolink", URL: srv.URL, Username: "admin", Password: "secret"})
	r.local = time.UTC // never equal to the device's +2, so the fixed zone is used
	r.pollEvery = time.Millisecond
	return d, r
}

func (d *fakeDevice) count(cmd string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for _, c := range d.calls {
		if c == cmd {
			n++
		}
	}
	return n
}

func (d *fakeDevice) lastParam(cmd string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.params[cmd]
	if len(p) == 0 {
		return ""
	}
	return string(p[len(p)-1])
}

func errItem(cmd string, rsp int, detail string) map[string]any {
	return map[string]any{"cmd": cmd, "code": 1, "error": map[string]any{"rspCode": rsp, "detail": detail}}
}

func (d *fakeDevice) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/cgi-bin/api.cgi" {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	d.mu.Lock()
	defer d.mu.Unlock()
	w.Header().Set("Content-Type", "text/html")
	if r.Method == http.MethodGet {
		if !d.valid[q.Get("token")] {
			json.NewEncoder(w).Encode([]any{errItem(q.Get("cmd"), -6, "please login first")})
			return
		}
		switch q.Get("cmd") {
		case "Snap":
			w.Header().Set("Content-Type", "image/jpeg")
			fmt.Fprintf(w, "jpeg ch%s %s", q.Get("channel"), q.Get("snapType"))
		case "Download", "Playback":
			d.media = append(d.media, strings.Join([]string{q.Get("cmd"), q.Get("source"), q.Get("start"), r.Header.Get("Range")}, " "))
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Range", "bytes 0-3/100")
			w.WriteHeader(http.StatusPartialContent)
			io.WriteString(w, "mp4!")
		}
		return
	}
	var cmds []struct {
		Cmd   string          `json:"cmd"`
		Param json.RawMessage `json:"param"`
	}
	if err := json.NewDecoder(r.Body).Decode(&cmds); err != nil {
		http.Error(w, "bad", 400)
		return
	}
	if q.Get("cmd") == "Login" {
		d.logins++
		var p struct {
			User struct{ UserName, Password string }
		}
		json.Unmarshal(cmds[0].Param, &p)
		if p.User.Password != d.pass {
			json.NewEncoder(w).Encode([]any{errItem("Login", -7, "login failed")})
			return
		}
		d.tokenN++
		tok := fmt.Sprintf("tok%d", d.tokenN)
		d.valid[tok] = true
		json.NewEncoder(w).Encode([]any{map[string]any{"cmd": "Login", "code": 0, "value": map[string]any{"Token": map[string]any{"leaseTime": 3600, "name": tok}}}})
		return
	}
	if !d.valid[q.Get("token")] {
		var out []any
		for _, c := range cmds {
			out = append(out, errItem(c.Cmd, -6, "please login first"))
		}
		json.NewEncoder(w).Encode(out)
		return
	}
	var out []any
	for _, c := range cmds {
		d.calls = append(d.calls, c.Cmd)
		d.params[c.Cmd] = append(d.params[c.Cmd], c.Param)
		var p struct {
			Channel int `json:"channel"`
		}
		json.Unmarshal(c.Param, &p)
		val, ok := d.answer(c.Cmd, p.Channel, c.Param)
		if !ok {
			out = append(out, errItem(c.Cmd, -9, "not support"))
			continue
		}
		out = append(out, map[string]any{"cmd": c.Cmd, "code": 0, "value": json.RawMessage(val)})
	}
	json.NewEncoder(w).Encode(out)
}

const searchFiles = `{"SearchResult":{"channel":0,"File":[
 {"StartTime":{"year":2025,"mon":2,"day":19,"hour":11,"min":11,"sec":46},"EndTime":{"year":2025,"mon":2,"day":19,"hour":11,"min":12,"sec":38},
  "name":"Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4","size":2221692},
 {"StartTime":{"year":2025,"mon":2,"day":19,"hour":10,"min":0,"sec":0},"EndTime":{"year":2025,"mon":2,"day":19,"hour":10,"min":5,"sec":0},
  "name":"Mp4Record/2025-02-19/RecM01_20250219_100000_100500_6D28808_1A468F9.mp4","size":"113246208"},
 {"StartTime":{"year":2025,"mon":2,"day":19,"hour":10,"min":5,"sec":1},"EndTime":{"year":2025,"mon":2,"day":19,"hour":10,"min":10,"sec":0},"size":"113246208"}
]}}`

func (d *fakeDevice) answer(cmd string, ch int, param json.RawMessage) (string, bool) {
	switch cmd {
	case "GetDevInfo":
		if d.nvr {
			return `{"DevInfo":{"type":"NVR","exactType":"NVR","channelNum":4,"name":"Home NVR","model":"RLN8-410"}}`, true
		}
		return `{"DevInfo":{"type":"IPC","exactType":"IPC","channelNum":1,"name":"Front","model":"Reolink Video Doorbell PoE"}}`, true
	case "GetChannelstatus":
		return fmt.Sprintf(`{"count":4,"status":[
			{"channel":1,"name":"Driveway","online":1,"typeInfo":"RLC-811A"},
			{"channel":0,"name":"Front Door","online":1,"typeInfo":"Reolink Video Doorbell PoE"},
			{"channel":2,"name":"","online":0,"typeInfo":""},
			{"channel":3,"name":"Garage","online":%d,"typeInfo":"RLC-510A"}]}`, map[bool]int{true: 1}[d.ch3Online]), true
	case "GetAbility":
		return `{"Ability":{"abilityChn":[{"ptzType":{"ver":0},"floodLight":{"ver":1},"supportAudioAlarm":{"ver":1}},{"ptzType":{"ver":2},"ptzPreset":{"ver":1}},{},{}]}}`, true
	case "GetNetPort":
		return fmt.Sprintf(`{"NetPort":{"httpPort":80,"httpsPort":443,"onvifEnable":0,"rtspEnable":%d,"rtspPort":8554}}`, d.rtspEnable), true
	case "SetNetPort":
		d.rtspEnable = 1
		d.valid = map[string]bool{} // changing ports ends every session
		return `{"rspCode":200}`, true
	case "GetTime":
		n := time.Now().In(plus2)
		return fmt.Sprintf(`{"Time":{"year":%d,"mon":%d,"day":%d,"hour":%d,"min":%d,"sec":%d}}`, n.Year(), n.Month(), n.Day(), n.Hour(), n.Minute(), n.Second()), true
	case "GetEnc":
		return `{"Enc":{"mainStream":{"vType":"h265","width":2560,"height":1440},"subStream":{"vType":"h264","width":640,"height":360}}}`, true
	case "GetRtspUrl":
		if ch == 1 {
			return `{"rtspUrl":{"channel":1,"mainStream":"rtsp://10.0.0.2:554/Preview_02_main","subStream":"rtsp://10.0.0.2:554/Preview_02_sub"}}`, true
		}
		return "", false
	case "Search":
		return searchFiles, true
	case "NvrDownload":
		return `{"fileList":[{"fileName":"01_small.mp4","fileSize":"10"},{"fileName":"01_big.mp4","fileSize":"5000"}]}`, true
	case "GetPtzPreset":
		return `{"PtzPreset":[{"enable":1,"id":0,"name":"Gate"},{"enable":0,"id":1,"name":"pos1"},{"enable":1,"id":2,"name":"Garage"}]}`, true
	case "PtzCtrl", "Logout", "SetWhiteLed", "AudioAlarmPlay":
		return `{"rspCode":200}`, true
	case "GetHddInfo":
		return `{"HddInfo":[{"capacity":1907729,"format":1,"mount":1,"number":1,"size":476932,"storageType":1}]}`, true
	case "GetEvents":
		if d.noGetEvents {
			return "", false
		}
		if v, ok := d.events[ch]; ok {
			return v, true
		}
		return `{"channel":0,"ai":{"people":{"alarm_state":0,"support":1}},"md":{"alarm_state":0,"support":1},"visitor":{"alarm_state":0,"support":1}}`, true
	case "GetMdState":
		return fmt.Sprintf(`{"state":%d}`, d.md[ch]), true
	case "GetAiState":
		if v, ok := d.ai[ch]; ok {
			return v, true
		}
		return `{"channel":0,"people":{"alarm_state":0,"support":1}}`, true
	}
	return "", false
}

func TestLoginOnceAndReloginSingleFlight(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	if _, err := r.Cameras(ctx); err != nil {
		t.Fatal(err)
	}
	if d.logins != 1 {
		t.Fatalf("logins = %d, want 1", d.logins)
	}
	// The device reboots: every token is gone. A burst of requests signs in once.
	d.mu.Lock()
	d.valid = map[string]bool{}
	d.mu.Unlock()
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.c.one(ctx, cmd("GetHddInfo", nil))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if d.logins != 2 {
		t.Fatalf("logins after expiry = %d, want 2 (one shared sign-in)", d.logins)
	}
}

func TestProbePlainErrors(t *testing.T) {
	d, r := newFake(t, false)
	ctx := context.Background()
	if err := r.Probe(ctx); err != nil {
		t.Fatalf("probe: %v", err)
	}
	d.mu.Lock()
	d.pass = "other"
	d.mu.Unlock()
	err := r.Probe(ctx)
	if err == nil || !errors.Is(err, httpx.ErrAuth) || err.Error() != "the username or password is wrong" {
		t.Fatalf("wrong password: %v", err)
	}
	notReolink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html>router login</html>")
	}))
	defer notReolink.Close()
	err = New(backend.Config{URL: notReolink.URL, Password: "x"}).Probe(ctx)
	if err == nil || !strings.Contains(err.Error(), "doesn't look like a Reolink device") || httpx.Unreachable(err) {
		t.Fatalf("not reolink: %v", err)
	}
	if _, ok := backend.Lookup("reolink"); !ok {
		t.Fatal("not registered")
	}
}

func TestChannels(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	cams, err := r.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, c := range cams {
		got = append(got, fmt.Sprintf("%s:%s:%v:%v", c.ID, c.Name, c.PTZ, contains(c.Objects, "doorbell")))
	}
	// Channel 2 is an empty slot; 3 is offline but has a camera model, so it's kept.
	want := "0:Front Door:false:true 1:Driveway:true:false 3:Garage:false:false"
	if strings.Join(got, " ") != want {
		t.Fatalf("cameras = %v, want %s", got, want)
	}
	if a := cams[0].Aspect; a < 1.77 || a > 1.78 {
		t.Fatalf("aspect = %v", a)
	}
	h, err := r.Health(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Offline) != 1 || h.Offline[0] != "3" {
		t.Fatalf("offline = %v", h.Offline)
	}
	if len(h.Storage) != 1 || h.Storage[0].UsedPct != 75 || h.Storage[0].FreeGB != 465.8 {
		t.Fatalf("storage = %+v", h.Storage)
	}
	_ = d

	// A single camera is channel 0, a doorbell from its model.
	_, cam := newFake(t, false)
	cs, err := cam.Cameras(ctx)
	if err != nil || len(cs) != 1 || cs[0].ID != "0" || cs[0].Name != "Front" || !contains(cs[0].Objects, "doorbell") {
		t.Fatalf("camera = %+v %v", cs, err)
	}
}

func TestSnapshotAndLive(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	b, ct, err := r.Snapshot(ctx, "1", 360)
	if err != nil || ct != "image/jpeg" || string(b) != "jpeg ch1 sub" {
		t.Fatalf("snapshot = %q %q %v", b, ct, err)
	}
	if _, _, err := r.Snapshot(ctx, "2", 0); !errors.Is(err, backend.ErrNotFound) {
		t.Fatalf("empty slot snapshot: %v", err)
	}

	// RTSP is off: it's turned on once (other port settings kept) and the session renewed.
	live, err := r.Live(ctx, "1", "main")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(live.URL, ":8554/Preview_02_main") || !strings.HasPrefix(live.URL, "rtsp://admin:secret@127.0.0.1") {
		t.Fatalf("live = %s", live.URL)
	}
	if p := d.lastParam("SetNetPort"); !strings.Contains(p, `"rtspEnable":1`) || !strings.Contains(p, `"httpsPort":443`) || !strings.Contains(p, `"onvifEnable":0`) {
		t.Fatalf("SetNetPort = %s", p)
	}
	live, err = r.Live(ctx, "0", "sub")
	if err != nil || !strings.HasSuffix(live.URL, "/h264Preview_01_sub") {
		t.Fatalf("live sub = %v %v", live, err)
	}
	if n := d.count("SetNetPort"); n != 1 {
		t.Fatalf("SetNetPort sent %d times", n)
	}
	// The next request signs in again after the port change ended the session.
	if _, _, err := r.Snapshot(ctx, "0", 0); err != nil {
		t.Fatal(err)
	}
}

func TestEventsAndSegments(t *testing.T) {
	_, r := newFake(t, true)
	ctx := context.Background()
	at := func(h, m, s int) float64 { return float64(time.Date(2025, 2, 19, h, m, s, 0, plus2).Unix()) }
	after, before := at(9, 0, 0), at(12, 0, 0)

	segs, err := r.Segments(ctx, "0", after, before)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 || segs[0].Start != at(10, 0, 0) || segs[0].End != at(10, 10, 0) || segs[1].Start != at(11, 11, 46) {
		t.Fatalf("segments = %+v", segs)
	}

	evs, err := r.Events(ctx, backend.EventQuery{Cameras: []string{"0"}, After: after, Before: before})
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 {
		t.Fatalf("events = %+v", evs)
	}
	person, motion := evs[0], evs[1] // newest first
	if person.ID != fmt.Sprintf("0-%d", int64(at(11, 11, 46))) || person.Severity != "alert" || !contains(person.Objects, "person") ||
		person.End == nil || *person.End != at(11, 12, 38) {
		t.Fatalf("person event = %+v", person)
	}
	if motion.Severity != "detection" || len(motion.Objects) != 0 {
		t.Fatalf("motion event = %+v", motion)
	}
	only, _ := r.Events(ctx, backend.EventQuery{Cameras: []string{"0"}, After: after, Before: before, Severity: "alert"})
	if len(only) != 1 {
		t.Fatalf("alerts only = %+v", only)
	}
	e, err := r.Event(ctx, person.ID)
	if err != nil || e.Start != person.Start {
		t.Fatalf("event by id = %+v %v", e, err)
	}
	if _, err := r.Event(ctx, "0-123"); !errors.Is(err, backend.ErrNotFound) {
		t.Fatalf("missing event: %v", err)
	}
	if _, _, err := r.EventThumbnail(ctx, person.ID); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatalf("thumbnail: %v", err)
	}
}

func TestPlaybackWindow(t *testing.T) {
	ctx := context.Background()
	at := func(h, m, s int) float64 { return float64(time.Date(2025, 2, 19, h, m, s, 0, plus2).Unix()) }

	// Camera: Playback command with the file's name; Range passed through.
	d, r := newFake(t, false)
	pb, err := r.Playback(ctx, "0", at(11, 12, 0), at(11, 20, 0))
	if err != nil {
		t.Fatal(err)
	}
	if pb.StartTime != at(11, 11, 46) || pb.EndTime != at(11, 12, 38) || pb.File == nil || pb.Live != nil {
		t.Fatalf("playback = %+v", pb)
	}
	resp, err := pb.File(ctx, http.Header{"Range": {"bytes=0-3"}})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent || string(body) != "mp4!" {
		t.Fatalf("file = %d %q", resp.StatusCode, body)
	}
	want := "Playback Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4 20250219111146 bytes=0-3"
	if d.media[0] != want {
		t.Fatalf("media request = %q", d.media[0])
	}
	// Token expired between requests: the file is fetched again after one sign-in.
	d.mu.Lock()
	d.valid = map[string]bool{}
	d.mu.Unlock()
	resp, err = pb.File(ctx, http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	// Nothing recorded then.
	if _, err := r.Playback(ctx, "0", at(13, 0, 0), at(13, 5, 0)); !errors.Is(err, backend.ErrNotFound) {
		t.Fatalf("no recording: %v", err)
	}

	// NVR, file without a name: prepared with NvrDownload, streamed with Download.
	d2, nvr := newFake(t, true)
	pb, err = nvr.Playback(ctx, "0", at(10, 6, 0), at(10, 8, 0))
	if err != nil {
		t.Fatal(err)
	}
	if pb.StartTime != at(10, 5, 1) || pb.EndTime != at(10, 10, 0) {
		t.Fatalf("nvr playback window = %v..%v", pb.StartTime, pb.EndTime)
	}
	if p := d2.lastParam("NvrDownload"); !strings.Contains(p, `"hour":10,"min":5,"sec":1`) {
		t.Fatalf("NvrDownload = %s", p)
	}
	resp, err = pb.File(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !strings.HasPrefix(d2.media[0], "Download 01_big.mp4 20250219100501") {
		t.Fatalf("nvr media = %q", d2.media[0])
	}
}

func TestPTZ(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	info, err := r.PTZInfo(ctx, "1")
	if err != nil {
		t.Fatal(err)
	}
	if !info.CanMove || !info.CanZoom || strings.Join(info.Presets, ",") != "Gate,Garage" {
		t.Fatalf("ptz info = %+v", info)
	}
	if info, _ := r.PTZInfo(ctx, "0"); info.CanMove || info.CanZoom || len(info.Presets) != 0 {
		t.Fatalf("fixed camera = %+v", info)
	}
	if err := r.PTZ(ctx, "1", "MOVE_LEFT"); err != nil {
		t.Fatal(err)
	}
	if p := d.lastParam("PtzCtrl"); p != `{"channel":1,"op":"Left","speed":32}` {
		t.Fatalf("move = %s", p)
	}
	if err := r.PTZ(ctx, "1", "STOP"); err != nil || d.lastParam("PtzCtrl") != `{"channel":1,"op":"Stop"}` {
		t.Fatalf("stop = %s %v", d.lastParam("PtzCtrl"), err)
	}
	if err := r.PTZ(ctx, "1", "preset_Garage"); err != nil || d.lastParam("PtzCtrl") != `{"channel":1,"id":2,"op":"ToPos","speed":32}` {
		t.Fatalf("preset = %s %v", d.lastParam("PtzCtrl"), err)
	}
	if err := r.PTZ(ctx, "1", "preset_Nope"); !errors.Is(err, backend.ErrNotFound) {
		t.Fatalf("missing preset: %v", err)
	}
	if err := r.PTZ(ctx, "1", "DANCE"); err == nil {
		t.Fatal("unknown action accepted")
	}
}

func TestDeterAndTalk(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	if info, err := r.DeterInfo(ctx, "0"); err != nil || !info.Light || !info.Siren {
		t.Fatalf("doorbell deter = %+v %v", info, err)
	}
	if info, _ := r.DeterInfo(ctx, "1"); info.Light || info.Siren {
		t.Fatalf("plain camera deter = %+v", info)
	}
	if err := r.Deter(ctx, "0", backend.DeterLightOn); err != nil || d.lastParam("SetWhiteLed") != `{"WhiteLed":{"channel":0,"state":1}}` {
		t.Fatalf("light on = %s %v", d.lastParam("SetWhiteLed"), err)
	}
	if err := r.Deter(ctx, "0", backend.DeterLightOff); err != nil || d.lastParam("SetWhiteLed") != `{"WhiteLed":{"channel":0,"state":0}}` {
		t.Fatalf("light off = %s %v", d.lastParam("SetWhiteLed"), err)
	}
	if err := r.Deter(ctx, "0", backend.DeterSiren); err != nil || d.lastParam("AudioAlarmPlay") != `{"alarm_mode":"times","channel":0,"times":1}` {
		t.Fatalf("siren = %s %v", d.lastParam("AudioAlarmPlay"), err)
	}
	if err := r.Deter(ctx, "1", backend.DeterSiren); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatalf("siren without one: %v", err)
	}
	tt, err := r.Talk(ctx, "1")
	if err != nil || tt.Kind != "rtsp" || !strings.HasPrefix(tt.URL, "rtsp://") {
		t.Fatalf("talk = %+v %v", tt, err)
	}
}

type sinkRec struct {
	mu  sync.Mutex
	evs []backend.Event
}

func (s *sinkRec) OnEvent(e backend.Event) {
	s.mu.Lock()
	s.evs = append(s.evs, e)
	s.mu.Unlock()
}
func (s *sinkRec) OnPosition(string, float64, float64) {}

func evState(people, vehicle, md, visitor, pkg int) string {
	return fmt.Sprintf(`{"channel":0,"ai":{"people":{"alarm_state":%d,"support":1},"vehicle":{"alarm_state":%d,"support":1},"dog_cat":{"alarm_state":0,"support":1},"package":{"alarm_state":%d,"support":1}},"md":{"alarm_state":%d,"support":1},"visitor":{"alarm_state":%d,"support":1}}`,
		people, vehicle, pkg, md, visitor)
}

func TestWatchEdges(t *testing.T) {
	d, r := newFake(t, true)
	ctx := context.Background()
	w := r.newWatcher()
	sink := &sinkRec{}
	clock := time.Unix(1_700_000_000, 0)
	w.now = func() time.Time { clock = clock.Add(2 * time.Second); return clock }
	step := func(v string) {
		t.Helper()
		d.mu.Lock()
		d.events[0] = v
		d.mu.Unlock()
		if err := w.poll(ctx, sink); err != nil {
			t.Fatal(err)
		}
	}
	step(evState(0, 0, 0, 0, 0)) // idle: nothing
	step(evState(0, 0, 1, 0, 0)) // motion starts
	step(evState(1, 0, 1, 0, 0)) // a person appears: same event, updated
	step(evState(1, 0, 1, 1, 0)) // someone rings: its own event
	step(evState(1, 0, 1, 1, 0)) // unchanged: nothing
	step(evState(0, 0, 0, 0, 0)) // all over: both end
	step(evState(0, 0, 0, 0, 1)) // a package

	var got []string
	for _, e := range sink.evs {
		end := "open"
		if e.End != nil {
			end = "ended"
		}
		got = append(got, fmt.Sprintf("%s|%s|%s|%s", e.ID, strings.Join(e.Objects, "+"), e.Severity, end))
	}
	t0 := int64(1_700_000_000_000)
	want := []string{
		fmt.Sprintf("0-%d-a||detection|open", t0+4000),
		fmt.Sprintf("0-%d-a|person|alert|open", t0+4000),
		fmt.Sprintf("0-%d-ring|doorbell|alert|open", t0+8000),
		fmt.Sprintf("0-%d-a|person|alert|ended", t0+4000),
		fmt.Sprintf("0-%d-ring|doorbell|alert|ended", t0+8000),
		fmt.Sprintf("0-%d-pkg|package|alert|open", t0+14000),
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("events:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	ended := sink.evs[3]
	if ended.Start != float64(t0+4000)/1000 || *ended.End != float64(t0+12000)/1000 {
		t.Fatalf("ended = %v..%v", ended.Start, *ended.End)
	}
	// A notification tapped later finds the live event.
	e, err := r.Event(ctx, ended.ID)
	if err != nil || e.End == nil {
		t.Fatalf("event by id = %+v %v", e, err)
	}
}

func TestWatchFallsBackToMdAi(t *testing.T) {
	d, r := newFake(t, false)
	d.noGetEvents = true
	sink := &sinkRec{}
	ctx, cancel := context.WithCancel(context.Background())
	d.md[0] = 1
	d.ai[0] = `{"channel":0,"people":{"alarm_state":0,"support":1},"dog_cat":{"alarm_state":1,"support":1}}`
	done := make(chan error, 1)
	go func() { done <- r.Watch(ctx, sink) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		sink.mu.Lock()
		n := len(sink.evs)
		sink.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no event")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	e := sink.evs[0]
	if e.Camera != "0" || strings.Join(e.Objects, ",") != "animal" || e.Severity != "alert" {
		t.Fatalf("event = %+v", e)
	}
	if d.count("GetEvents") == 0 || d.count("GetMdState") == 0 {
		t.Fatal("expected GetEvents to be tried, then GetMdState")
	}
}

func TestParsing(t *testing.T) {
	tr := parseVodName("Mp4Record/2020-12-22/RecM01_20201222_075939_080140_6D28808_1A468F9.mp4")
	if tr == nil || !tr.Motion || tr.Person {
		t.Fatalf("motion file = %+v", tr)
	}
	tr = parseVodName("Mp4Record/2025-02-19/RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4")
	if tr == nil || !tr.Person || !tr.Motion || tr.Vehicle {
		t.Fatalf("person file = %+v", tr)
	}
	if parseVodName("/mnt/sda/123-Cam/Mp4Record/2024-08-27/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4") == nil {
		t.Fatal("hub name")
	}
	if parseVodName("2023-04-17 01-59-57.mp4") != nil || parseVodName("no-extension") != nil {
		t.Fatal("non-flag names")
	}

	// Device clock: offset from its current wall time, rounded to 15 minutes.
	now := time.Date(2024, 7, 1, 10, 0, 0, 0, time.UTC)
	loc := deviceZone(wall{Year: 2024, Mon: 7, Day: 1, Hour: 12, Min: 0, Sec: 7}, now, time.UTC)
	if _, off := now.In(loc).Zone(); off != 7200 {
		t.Fatalf("offset = %d", off)
	}
	if deviceZone(wall{Year: 2024, Mon: 7, Day: 1, Hour: 10}, now, time.UTC) != time.UTC {
		t.Fatal("same offset should use the Hub's zone")
	}
	chunks := dayChunks(float64(time.Date(2024, 7, 1, 22, 0, 0, 0, plus2).Unix()), float64(time.Date(2024, 7, 3, 1, 30, 0, 0, plus2).Unix()), plus2, 8)
	if len(chunks) != 3 || chunks[0][0].Day() != 3 || chunks[0][0].Hour() != 0 || chunks[2][0].Hour() != 22 || chunks[2][1].Hour() != 23 || chunks[2][1].Second() != 59 {
		t.Fatalf("chunks = %v", chunks)
	}

	c := &fileCache{After: 100, Before: 200, At: 200, Files: []vodFile{{Start: 150, End: 160}}}
	if c.covers(50, 200) || !c.covers(155, 300) || !c.covers(110, 190) {
		t.Fatal("cache coverage")
	}
	if commandError(&item{Cmd: "Login", Code: 1, Error: &struct {
		Detail  string `json:"detail"`
		RspCode num    `json:"rspCode"`
	}{Detail: "max session", RspCode: -5}}).Error()[:13] != "too many apps" {
		t.Fatal("max session message")
	}
}
