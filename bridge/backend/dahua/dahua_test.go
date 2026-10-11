package dahua

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	_ "time/tzdata" // America/Denver on any test machine

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

func crlf(lines ...string) string { return strings.Join(lines, "\r\n") + "\r\n" }

func utc(y int, mo time.Month, d, h, mi, s int) float64 {
	return float64(time.Date(y, mo, d, h, mi, s, 0, time.UTC).Unix())
}

func TestKVAndChannels(t *testing.T) {
	kv := parseKV(crlf("table.ChannelTitle[0].Name=Front Door", "items[0]. Channel =1", "junk", "result=OK=yes"))
	if kv["table.ChannelTitle[0].Name"] != "Front Door" || kv["items[0].Channel"] != "1" || kv["result"] != "OK=yes" {
		t.Fatalf("kv = %v", kv)
	}
	if !isErrorBody("Error\r\nBad Request!\r\n") || isErrorBody("OK\r\n") || isErrorBody("Errors=0") {
		t.Fatal("isErrorBody")
	}
	titles := parseKV(crlf("table.ChannelTitle[0].Name=Driveway", "table.ChannelTitle[1].Name=", "table.ChannelTitle[2].Name=Back Yard"))
	remote := parseKV(crlf(
		"table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_0.Enable=true",
		"table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_1.Enable=false"))
	got := fmt.Sprint(parseChannels(titles, remote))
	if want := "[{1 Driveway true} {2 Camera 2 false} {3 Back Yard true}]"; got != want {
		t.Fatalf("channels = %s, want %s", got, want)
	}
	if _, err := parseChannelID("01"); !errors.Is(err, backend.ErrNotFound) {
		t.Fatal("channel IDs must be canonical")
	}
}

func TestClockFixedOffset(t *testing.T) {
	// Device shows 21:02:32 when UTC is 03:02:30 next day → UTC−6, 2 s fast; the Hub is on UTC.
	now := time.Date(2026, 10, 11, 3, 2, 30, 0, time.UTC)
	c, err := measureClock("result=2026-10-10 21:02:32\r\n", now, time.UTC)
	if err != nil || c.offset != -6*3600+2 || c.loc != nil {
		t.Fatalf("clock = %+v, %v", c, err)
	}
	ts, _ := c.fromDevice("2026-10-10 20:00:00")
	if ts != utc(2026, 10, 11, 2, 0, 0)-2 || c.deviceTime(ts) != "2026-10-10 20:00:00" || c.playbackTime(ts) != "2026_10_10_20_00_00" {
		t.Fatalf("round trip: %v %s", ts, c.deviceTime(ts))
	}
	if ts, _ := (clock{}).fromDevice("2011-7-3 9:02:32"); ts != utc(2011, 7, 3, 9, 2, 32) {
		t.Fatal("unpadded dates")
	}
	if _, err := measureClock("Error\r\n", now); err == nil {
		t.Fatal("want error")
	}
}

func TestClockDST(t *testing.T) {
	denver, err := time.LoadLocation("America/Denver")
	if err != nil {
		t.Fatal(err)
	}
	// October (MDT, UTC−6), device 2 s fast, Hub in Denver.
	now := time.Date(2026, 10, 11, 3, 2, 30, 0, time.UTC)
	c, _ := measureClock("result=2026-10-10 21:02:32", now, denver)
	if c.loc != denver || c.drift != 2 {
		t.Fatalf("clock = %+v", c)
	}
	// A January recording (MST, UTC−7) keeps its hour.
	if ts, _ := c.fromDevice("2026-01-15 12:00:00"); ts != utc(2026, 1, 15, 19, 0, 0)-2 {
		t.Fatalf("january = %v", ts)
	}
	if s := c.playbackTime(utc(2026, 1, 15, 19, 0, 0) - 2); s != "2026_01_15_12_00_00" {
		t.Fatalf("playback time = %s", s)
	}
	// Device on UTC+2 while the Hub is in Denver: fixed offset.
	c, _ = measureClock("result=2026-10-10 14:00:00", time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC), denver)
	if c.loc != nil || c.offset != 7200 {
		t.Fatalf("other zone = %+v", c)
	}
	// Across the November DST change the local day is 25 hours long.
	r := dayRanges(utc(2026, 11, 1, 0, 0, 0), utc(2026, 11, 2, 7, 0, 0), clock{loc: denver}, 62)
	if r[0][1]-r[0][0] != 25*3600 {
		t.Fatalf("dst day = %v", r[0])
	}
}

func TestDayRanges(t *testing.T) {
	at := func(d, h, m int) float64 { return utc(2026, 10, d, h, m, 0) }
	c := clock{offset: -6 * 3600}
	got := dayRanges(at(8, 3, 0), at(10, 15, 30), c, 62)
	want := [][2]float64{{at(10, 6, 0), at(10, 15, 30)}, {at(9, 6, 0), at(10, 6, 0)}, {at(8, 6, 0), at(9, 6, 0)}, {at(8, 3, 0), at(8, 6, 0)}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("days = %v", got)
	}
	if got := dayRanges(at(9, 6, 0), at(10, 6, 0), c, 62); len(got) != 1 {
		t.Fatalf("midnight = %v", got)
	}
	if got := dayRanges(at(10, 6, 0), at(10, 6, 0), c, 62); len(got) != 0 {
		t.Fatal("empty")
	}
}

var findNext = crlf(
	"found=4",
	"items[0].Channel=1",
	"items[0].EndTime=2026-10-10 12:30:00",
	"items[0].Events[0]=VideoMotion",
	"items[0].Events[1]=SmartMotionHuman",
	"items[0].FilePath=/mnt/dvr/mmc0p2_0/2026-10-10/1/dav/12/12.00.00-12.30.00[M][0@0][0].dav",
	"items[0].Flags[0]=Event",
	"items[0].StartTime=2026-10-10 12:00:00",
	"items[0].Type=dav",
	"items[0].VideoStream=Main",
	"items[1].Channel=1",
	"items[1].EndTime=2026-10-10 13:00:00",
	"items[1].Flags[0]=Timing",
	"items[1].StartTime=2026-10-10 12:30:01",
	"items[1].Type=dav",
	"items[2].Channel=1",
	"items[2].EndTime=2026-10-10 12:10:05",
	"items[2].Events[0]=SmartMotionHuman",
	"items[2].FilePath=/mnt/dvr/mmc0p2_0/2026-10-10/1/jpg/12/10/04[M][0@0][0].jpg",
	"items[2].StartTime=2026-10-10 12:10:04",
	"items[2].Type=jpg",
	"items[3].Channel=1",
	"items[3].EndTime=2026-10-11 00:20:00",
	"items[3].Events[0]=VideoMotion",
	"items[3].StartTime=2026-10-10 23:50:00",
	"items[3].Type=dav",
)

func TestFileSearchParsing(t *testing.T) {
	q := findFileQuery(findCond{Object: "1", Channel: 2, Start: "2026-10-10 00:00:00", End: "2026-10-11 00:00:00",
		Types: videoTypes, Flags: []string{"Event"}, VideoStream: "Main"})
	want := "action=findFile&object=1&condition.Channel=2&condition.StartTime=2026-10-10%2000:00:00&condition.EndTime=2026-10-11%2000:00:00" +
		"&condition.Types[0]=dav&condition.Types[1]=mp4&condition.Flag[0]=Event&condition.VideoStream=Main"
	if q != want {
		t.Fatalf("query =\n%s\nwant\n%s", q, want)
	}
	if parseFinderID("result=2086170840\r\n") != "2086170840" || parseFinderID("Error\r\n") != "" {
		t.Fatal("finder id")
	}
	found, files := parseFindNext(findNext)
	if found != 4 || len(files) != 4 || files[0].Channel != 2 || fmt.Sprint(files[0].Events) != "[VideoMotion SmartMotionHuman]" || files[2].Type != "jpg" {
		t.Fatalf("files = %+v", files)
	}
	segs := filesToSegments(files, clock{}, 2)
	if fmt.Sprint(segs) != fmt.Sprint([]backend.Segment{
		{Start: utc(2026, 10, 10, 12, 0, 0), End: utc(2026, 10, 10, 13, 0, 0)},
		{Start: utc(2026, 10, 10, 23, 50, 0), End: utc(2026, 10, 11, 0, 20, 0)},
	}) {
		t.Fatalf("segments = %v", segs)
	}
	evs := filesToEvents(files, clock{})
	if len(evs) != 2 || evs[0].Severity != "detection" || fmt.Sprint(evs[0].Objects) != "[motion]" {
		t.Fatalf("events = %+v", evs)
	}
	if e := evs[1]; e.ID != fmt.Sprintf("2@%d", int64(utc(2026, 10, 10, 12, 0, 0))) || e.Camera != "2" || e.Severity != "alert" || fmt.Sprint(e.Objects) != "[person]" {
		t.Fatalf("person event = %+v", e)
	}
	if o, s, _ := classifyCodes([]string{"CrossLineDetection"}); fmt.Sprint(o) != "[motion]" || s != "alert" {
		t.Fatal("tripwire is an alert")
	}
	if _, _, ok := classifyCodes([]string{"Timing"}); ok {
		t.Fatal("timing isn't an event")
	}
}

func TestPTZAndHealthParsing(t *testing.T) {
	ps := parsePresets(parseKV(crlf("presets[0].Index=1", "presets[0].Name=Gate", "presets[1].Index=2", "presets[1].Name=Gate", "presets[2].Index=5", "presets[2].Name=")))
	if fmt.Sprint(ps) != "[{1 Gate} {2 Gate (2)} {5 Preset 5}]" {
		t.Fatalf("presets = %v", ps)
	}
	if mv, zm := parsePTZCaps(parseKV(crlf("caps.Pan=true", "caps.Tile=true", "caps.Zoom=false"))); !mv || zm {
		t.Fatal("caps")
	}
	if fmt.Sprint(parseEventChannels("channels[0]=0\r\nchannels[1]=3\r\n")) != "[1 4]" || parseEventChannels("Error\r\n") != nil {
		t.Fatal("video loss")
	}
	disks := parseStorage(parseKV(crlf(
		"list.info[0].Detail[0].Path=/dev/sda1",
		"list.info[0].Detail[0].TotalBytes=2000000000000.000000",
		"list.info[0].Detail[0].UsedBytes=1500000000000.000000")))
	if fmt.Sprint(disks) != "[{/dev/sda1 75 500 }]" {
		t.Fatalf("disks = %v", disks)
	}
}

func TestURLs(t *testing.T) {
	live := rtspURL("192.168.1.108", 554, "admin", "p@ss#1:x", livePath(3, "sub"))
	if live != "rtsp://admin:p%40ss%231%3Ax@192.168.1.108:554/cam/realmonitor?channel=3&subtype=1" {
		t.Fatalf("live = %s", live)
	}
	start := utc(2026, 10, 10, 18, 30, 5)
	if p := playbackPath(1, start, start+600, clock{offset: -6 * 3600}); p != "/cam/playback?channel=1&starttime=2026_10_10_12_30_05&endtime=2026_10_10_12_40_05" {
		t.Fatalf("playback = %s", p)
	}
	if p := fileURLPath("/mnt/dvr/a b/04[M][0@0][0].jpg"); p != "/cgi-bin/RPC_Loadfile/mnt/dvr/a%20b/04[M][0@0][0].jpg" {
		t.Fatalf("file = %s", p)
	}
}

// ---- live event stream ----

const streamBody = "--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nHeartbeat\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\nContent-Length: 37\r\n\r\nCode=VideoMotion;action=Start;index=1\r\n\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\nContent-Length:200\r\n\r\nCode=CrossRegionDetection;action=Start;index=1;data={\n" +
	"   \"Action\" : \"Appear\",\n   \"Object\" : { \"ObjectType\" : \"Human\", \"ObjectID\" : 12 }\n}\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=NewFile;action=Pulse;index=1;data={ \"File\" : \"/a.dav\" }\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=_DoTalkAction_;action=Pulse;index=0;data={\"Action\":\"Invite\"}\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=DoorBell;action=Pulse;index=0\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=VideoMotion;action=Stop;index=1\r\n" +
	"--myboundary\r\nContent-Type: text/plain\r\n\r\nCode=CrossRegionDetection;action=Stop;index=1;data={}\r\n"

func TestReadEvents(t *testing.T) {
	var got []rawEvent
	if err := readEvents(strings.NewReader(streamBody), boundaryOf("multipart/x-mixed-replace; boundary=myboundary"), func(e rawEvent) { got = append(got, e) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 7 {
		t.Fatalf("events = %+v", got)
	}
	if got[1].Code != "CrossRegionDetection" || got[1].Index != 1 || fmt.Sprint(dataObjects(got[1].Data)) != "[person]" {
		t.Fatalf("ivs = %+v", got[1])
	}
	if boundaryOf("") != "myboundary" || boundaryOf("multipart/x-mixed-replace; boundary=--abc") != "abc" {
		t.Fatal("boundary")
	}
}

func TestTracker(t *testing.T) {
	now := time.Unix(1_760_000_000, 0)
	tr := newTracker(func() time.Time { return now })
	var out []backend.Event
	feed := func() {
		out = nil
		_ = readEvents(strings.NewReader(streamBody), "myboundary", func(e rawEvent) {
			out = append(out, tr.handle(e)...)
			now = now.Add(time.Second)
		})
	}
	feed()
	// motion → upgraded to a person alert (same ID) → ring (own ID, once) → end.
	if len(out) != 4 {
		t.Fatalf("out = %+v", out)
	}
	ep := out[0].ID
	if out[0].Camera != "2" || out[0].Severity != "detection" || fmt.Sprint(out[0].Objects) != "[motion]" || out[0].End != nil {
		t.Fatalf("motion = %+v", out[0])
	}
	if out[1].ID != ep || out[1].Severity != "alert" || fmt.Sprint(out[1].Objects) != "[person]" {
		t.Fatalf("person = %+v", out[1])
	}
	if out[2].Camera != "1" || !strings.HasSuffix(out[2].ID, "-ring") || fmt.Sprint(out[2].Objects) != "[doorbell]" {
		t.Fatalf("ring = %+v", out[2])
	}
	if out[3].ID != ep || out[3].End == nil {
		t.Fatalf("end = %+v", out[3])
	}
	if e, ok := tr.lookup(ep); !ok || e.End == nil {
		t.Fatal("lookup")
	}
	if _, _, err := parseEventID(out[2].ID); err != nil {
		t.Fatal(err)
	}
}

// ---- fake device ----

type fakeDahua struct {
	mu    sync.Mutex
	paths []string
	srv   *httptest.Server
}

func (f *fakeDahua) seen(sub string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, p := range f.paths {
		if strings.Contains(p, sub) {
			out = append(out, p)
		}
	}
	return out
}

// newFake answers like an NVR whose clock is on UTC−6, behind Digest auth.
func newFake(t *testing.T, stream func(w http.ResponseWriter, r *http.Request)) (*fakeDahua, *Dahua) {
	f := &fakeDahua{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), `Digest username="admin"`) {
			w.Header().Set("WWW-Authenticate", `Digest realm="Login to 4L0C", qop="auth", nonce="abc", opaque="x"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.RawQuery+" "+r.URL.Path)
		f.mu.Unlock()
		q := r.URL.Query()
		switch r.URL.Path {
		case "/cgi-bin/magicBox.cgi":
			io.WriteString(w, "type=NVR4108HS-4KS2\r\n")
		case "/cgi-bin/configManager.cgi":
			switch q.Get("name") {
			case "ChannelTitle":
				io.WriteString(w, crlf("table.ChannelTitle[0].Name=Driveway", "table.ChannelTitle[1].Name=PTZ Yard", "table.ChannelTitle[2].Name=Empty"))
			case "RemoteDevice":
				io.WriteString(w, crlf("table.RemoteDevice.uuid:System_CONFIG_NETCAMERA_INFO_2.Enable=false"))
			case "RTSP":
				io.WriteString(w, crlf("table.RTSP.Enable=true", "table.RTSP.Port=5554"))
			default:
				io.WriteString(w, "Error\r\n")
			}
		case "/cgi-bin/global.cgi":
			io.WriteString(w, "result=2026-10-10 18:00:00\r\n") // = d.now() on UTC−6
		case "/cgi-bin/ptz.cgi":
			switch q.Get("action") {
			case "getCurrentProtocolCaps":
				if q.Get("channel") == "2" {
					io.WriteString(w, crlf("caps.Pan=true", "caps.Tile=true", "caps.Zoom=true"))
				} else {
					io.WriteString(w, "Error\r\n")
				}
			case "getPresets":
				io.WriteString(w, crlf("presets[0].Index=3", "presets[0].Name=Gate"))
			default:
				io.WriteString(w, "OK\r\n")
			}
		case "/cgi-bin/snapshot.cgi":
			w.Header().Set("Content-Type", "image/jpeg")
			io.WriteString(w, "jpeg-"+q.Get("channel"))
		case "/cgi-bin/mediaFileFind.cgi":
			switch q.Get("action") {
			case "factory.create":
				io.WriteString(w, "result=777\r\n")
			case "findFile":
				io.WriteString(w, "OK\r\n")
			case "findNextFile":
				// Answer with jpg files for a jpg search, video files otherwise (the
				// condition was sent with findFile).
				last := ""
				for _, p := range f.seen("action=findFile&") {
					last = p
				}
				if strings.Contains(last, "Types[0]=jpg") {
					io.WriteString(w, crlf("found=1", "items[0].Channel=1", "items[0].StartTime=2026-10-10 12:10:04",
						"items[0].EndTime=2026-10-10 12:10:05", "items[0].Type=jpg", "items[0].Events[0]=SmartMotionHuman",
						"items[0].FilePath=/mnt/dvr/1/jpg/04[M][0@0][0].jpg"))
					return
				}
				io.WriteString(w, findNext)
			default:
				io.WriteString(w, "OK\r\n")
			}
		case "/cgi-bin/RPC_Loadfile/mnt/dvr/1/jpg/04[M][0@0][0].jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			io.WriteString(w, "thumb")
		case "/cgi-bin/eventManager.cgi":
			if q.Get("action") == "attach" && stream != nil {
				stream(w, r)
				return
			}
			io.WriteString(w, "channels[0]=2\r\nchannels[1]=0\r\n")
		case "/cgi-bin/storageDevice.cgi":
			io.WriteString(w, crlf("list.info[0].Detail[0].Path=/dev/sda1", "list.info[0].Detail[0].TotalBytes=1000000000000", "list.info[0].Detail[0].UsedBytes=900000000000"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)
	d, err := New(backend.Config{ID: "nvr", Kind: "dahua", URL: f.srv.URL, Username: "admin", Password: "p@ss"})
	if err != nil {
		t.Fatal(err)
	}
	d.loc = time.UTC // the Hub is on UTC, the device on UTC−6: fixed offset
	d.now = func() time.Time { return time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC) }
	return f, d
}

func TestBackend(t *testing.T) {
	f, d := newFake(t, nil)
	ctx := context.Background()

	if err := d.Probe(ctx); err != nil {
		t.Fatal(err)
	}
	cams, err := d.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cams) != 3 || cams[0].ID != "1" || cams[0].PTZ || !cams[1].PTZ || cams[1].Name != "PTZ Yard" || cams[2].Enabled {
		t.Fatalf("cameras = %+v", cams)
	}
	if !d.Capabilities().PTZ || d.Capabilities().Clips || !d.Capabilities().Alerts {
		t.Fatalf("caps = %+v", d.Capabilities())
	}
	if b, ct, err := d.Snapshot(ctx, "2", 0); err != nil || string(b) != "jpeg-2" || ct != "image/jpeg" {
		t.Fatalf("snapshot = %q %q %v", b, ct, err)
	}
	if _, _, err := d.Snapshot(ctx, "../x", 0); !errors.Is(err, backend.ErrNotFound) {
		t.Fatal("bad camera id")
	}
	host := strings.TrimPrefix(f.srv.URL, "http://")
	host = host[:strings.LastIndex(host, ":")]
	live, err := d.Live(ctx, "2", "sub")
	if err != nil || live.Kind != backend.LiveRTSP || live.URL != "rtsp://admin:p%40ss@"+host+":5554/cam/realmonitor?channel=2&subtype=1" {
		t.Fatalf("live = %+v %v", live, err)
	}

	// Recordings: device times are UTC−6, so 12:00 on the device is 18:00 UTC.
	start := utc(2026, 10, 10, 18, 0, 0)
	pb, err := d.Playback(ctx, "1", start-600, start+600)
	if err != nil {
		t.Fatal(err)
	}
	if pb.Live == nil || pb.StartTime != start ||
		!strings.HasSuffix(pb.Live.URL, "/cam/playback?channel=1&starttime=2026_10_10_12_00_00&endtime=2026_10_10_12_10_00") {
		t.Fatalf("playback = %+v %+v", pb, pb.Live)
	}
	segs, err := d.Segments(ctx, "1", utc(2026, 10, 10, 6, 0, 0), utc(2026, 10, 11, 6, 0, 0))
	if err != nil || len(segs) != 2 || segs[0].Start != start {
		t.Fatalf("segments = %v %v", segs, err)
	}
	if n := len(f.seen("action=close&object=777")); n == 0 || n != len(f.seen("action=destroy&object=777")) {
		t.Fatal("finders must be closed and destroyed")
	}

	evs, err := d.Events(ctx, backend.EventQuery{Cameras: []string{"1"}, After: utc(2026, 10, 10, 6, 0, 0), Before: utc(2026, 10, 11, 6, 0, 0)})
	if err != nil || len(evs) != 2 || evs[1].Start != start || evs[1].Severity != "alert" {
		t.Fatalf("events = %+v %v", evs, err)
	}
	finds := f.seen("action=findFile&")
	if !strings.Contains(finds[len(finds)-1], "condition.Flag[0]=Event&condition.VideoStream=Main") ||
		!strings.Contains(finds[len(finds)-1], "condition.StartTime=2026-10-10%2000:00:00") {
		t.Fatalf("event search = %s", finds[len(finds)-1])
	}
	alerts, _ := d.Events(ctx, backend.EventQuery{Cameras: []string{"1"}, Severity: "alert", After: utc(2026, 10, 10, 6, 0, 0), Before: utc(2026, 10, 11, 6, 0, 0)})
	if len(alerts) != 1 {
		t.Fatalf("alerts = %+v", alerts)
	}
	ev, err := d.Event(ctx, evs[1].ID)
	if err != nil || ev.ID != evs[1].ID || ev.Severity != "alert" {
		t.Fatalf("event = %+v %v", ev, err)
	}
	// A live alert's ID inside a recording resolves to it.
	if ev, err := d.Event(ctx, fmt.Sprintf("2@%d", int64(start)+300)); err != nil || ev.Start != start {
		t.Fatalf("alert event = %+v %v", ev, err)
	}
	if b, _, err := d.EventThumbnail(ctx, evs[1].ID); err != nil || string(b) != "thumb" {
		t.Fatalf("thumbnail = %q %v", b, err)
	}

	info, err := d.PTZInfo(ctx, "2")
	if err != nil || !info.CanMove || !info.CanZoom || fmt.Sprint(info.Presets) != "[Gate]" {
		t.Fatalf("ptz info = %+v %v", info, err)
	}
	for _, a := range []string{"MOVE_LEFT", "STOP", "preset_Gate"} {
		if err := d.PTZ(ctx, "2", a); err != nil {
			t.Fatal(a, err)
		}
	}
	ptz := f.seen("/cgi-bin/ptz.cgi")
	want := []string{
		"action=start&channel=2&code=Left&arg1=0&arg2=4&arg3=0",
		"action=stop&channel=2&code=Left&arg1=0&arg2=0&arg3=0",
		"action=start&channel=2&code=GotoPreset&arg1=0&arg2=3&arg3=0",
	}
	for i, w := range want {
		if !strings.HasPrefix(ptz[len(ptz)-3+i], w) {
			t.Fatalf("ptz call %d = %s, want %s", i, ptz[len(ptz)-3+i], w)
		}
	}
	if err := d.PTZ(ctx, "2", "preset_Nope"); !errors.Is(err, backend.ErrNotFound) {
		t.Fatal("missing preset")
	}

	h, err := d.Health(ctx)
	if err != nil || fmt.Sprint(h.Offline) != "[1]" || len(h.Storage) != 1 || h.Storage[0].UsedPct != 90 {
		t.Fatalf("health = %+v %v", h, err) // channel 3 (index 2) is an empty slot
	}
	if _, err := d.VOD(ctx, "1", 0, 1, "", nil); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatal("vod")
	}
}

func TestProbeErrors(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	d, _ := New(backend.Config{URL: srv.URL, Username: "admin", Password: "x"})
	if err := d.Probe(context.Background()); !errors.Is(err, errNotDahua) {
		t.Fatalf("404: %v", err)
	}

	locked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, "Error: account locked")
	}))
	defer locked.Close()
	d, _ = New(backend.Config{URL: locked.URL})
	err := d.Probe(context.Background())
	if !errors.Is(err, httpx.ErrAuth) || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("locked: %v", err)
	}

	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "<html>hi</html>") }))
	defer other.Close()
	d, _ = New(backend.Config{URL: other.URL})
	if err := d.Probe(context.Background()); !errors.Is(err, errNotDahua) {
		t.Fatalf("html: %v", err)
	}
	if _, err := New(backend.Config{URL: "::nope"}); err == nil {
		t.Fatal("bad address")
	}
	if d, ok := backend.Lookup("dahua"); !ok || len(d.DefaultPorts) != 2 || len(d.Fields) != 3 {
		t.Fatal("not registered")
	}
}

type sink struct {
	mu  sync.Mutex
	evs []backend.Event
}

func (s *sink) OnEvent(e backend.Event) {
	s.mu.Lock()
	s.evs = append(s.evs, e)
	s.mu.Unlock()
}
func (s *sink) OnPosition(string, float64, float64) {}

func (s *sink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.evs)
}

func TestWatch(t *testing.T) {
	var attaches sync.WaitGroup
	attaches.Add(1)
	var once sync.Once
	_, d := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("codes") != "[All]" || r.URL.Query().Get("heartbeat") != "5" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=myboundary")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, streamBody)
		w.(http.Flusher).Flush()
		once.Do(attaches.Done) // then hang up: Watch reconnects
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	s := &sink{}
	go func() { done <- d.Watch(ctx, s) }()
	attaches.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for s.count() < 4 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.evs) < 4 || s.evs[1].Severity != "alert" || fmt.Sprint(s.evs[2].Objects) != "[doorbell]" {
		t.Fatalf("watch events = %+v", s.evs)
	}
	if _, err := d.Event(context.Background(), s.evs[2].ID); err != nil {
		t.Fatalf("alert lookup: %v", err)
	}
}

func TestWatchDropsHeartbeatWhenRefused(t *testing.T) {
	_, d := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Error", http.StatusBadRequest)
	})
	if err := d.watchOnce(context.Background(), &sink{}); err == nil {
		t.Fatal("want error")
	}
	if strings.Contains(d.streamURL, "heartbeat") {
		t.Fatal("heartbeat should be dropped after a 400")
	}
}
