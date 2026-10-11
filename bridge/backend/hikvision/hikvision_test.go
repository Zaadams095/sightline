package hikvision

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// Payloads follow real device answers captured in hikvision_next's fixtures (DS-7608NXI-I2
// NVR), as in the app's tests (app/test/hikvision.test.ts).

const nvrInfo = `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<deviceName>nvr</deviceName>
<model>DS-7608NXI-I2/8P/S</model>
<firmwareVersion>V4.62.210</firmwareVersion>
<deviceType>NVR</deviceType>
</DeviceInfo>`

const proxyChannels = `<?xml version="1.0" encoding="UTF-8"?>
<InputProxyChannelList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema" size="4">
<InputProxyChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>1</id><name>garden</name>
<sourceInputPortDescriptor><proxyProtocol>HIKVISION</proxyProtocol><ipAddress>192.168.254.2</ipAddress><srcInputPort>1</srcInputPort></sourceInputPortDescriptor>
</InputProxyChannel>
<InputProxyChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id><name>Back &amp; Side</name>
<sourceInputPortDescriptor><srcInputPort>1</srcInputPort></sourceInputPortDescriptor>
</InputProxyChannel>
</InputProxyChannelList>`

const proxyStatus = `<InputProxyChannelStatusList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<InputProxyChannelStatus><id>1</id><sourceInputPortDescriptor><ipAddress>192.168.254.2</ipAddress></sourceInputPortDescriptor><online>true</online></InputProxyChannelStatus>
<InputProxyChannelStatus><id>2</id><online>false</online><chanDetectResult>offline</chanDetectResult></InputProxyChannelStatus>
</InputProxyChannelStatusList>`

const streamingChannels = `<StreamingChannelList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<StreamingChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>101</id><channelName>garden</channelName><enabled>true</enabled>
<Video><enabled>true</enabled><videoInputChannelID>1</videoInputChannelID><videoCodecType>H.264</videoCodecType><videoResolutionWidth>3840</videoResolutionWidth><videoResolutionHeight>2160</videoResolutionHeight></Video>
</StreamingChannel>
<StreamingChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>102</id><channelName>garden</channelName><enabled>true</enabled>
<Video><videoInputChannelID>1</videoInputChannelID><videoResolutionWidth>640</videoResolutionWidth><videoResolutionHeight>360</videoResolutionHeight></Video>
</StreamingChannel>
</StreamingChannelList>`

const adminAccesses = `<AdminAccessProtocolList><AdminAccessProtocol><id>1</id><enabled>true</enabled><protocol>HTTP</protocol><portNo>80</portNo></AdminAccessProtocol>
<AdminAccessProtocol><id>2</id><enabled>true</enabled><protocol>RTSP</protocol><portNo>10554</portNo></AdminAccessProtocol></AdminAccessProtocolList>`

const deviceTime = `<Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><timeMode>NTP</timeMode><localTime>2024-07-01T12:00:00+02:00</localTime><timeZone>CST-1:00:00DST</timeZone></Time>`

const ptzCaps = `<PTZChanelCap version="2.0"><AbsolutePanTiltPositionSpace><XRange><Min>0</Min><Max>3600</Max></XRange></AbsolutePanTiltPositionSpace>
<ContinuousPanTiltSpace><XRange><Min>-100</Min><Max>100</Max></XRange></ContinuousPanTiltSpace><ContinuousZoomSpace><XRange><Min>-100</Min><Max>100</Max></XRange></ContinuousZoomSpace></PTZChanelCap>`

const ptzPresets = `<PTZPresetList version="2.0">
<PTZPreset><enabled>true</enabled><id>1</id><presetName>Driveway</presetName></PTZPreset>
<PTZPreset><enabled>false</enabled><id>2</id><presetName>Preset 2</presetName></PTZPreset>
<PTZPreset><id>3</id><presetName>Gate</presetName></PTZPreset>
</PTZPresetList>`

// Times are the device's local wall clock (UTC+2) with a "fake Z".
const searchResult = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{ABC}</searchID>
<responseStatus>true</responseStatus>
<responseStatusStrg>OK</responseStatusStrg>
<numOfMatches>3</numOfMatches>
<matchList>
<searchMatchItem>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:00:00Z</startTime><endTime>2024-07-01T12:10:00Z</endTime></timeSpan>
<mediaSegmentDescriptor><contentType>video</contentType>
<playbackURI>rtsp://192.168.1.64/Streaming/tracks/101/?starttime=20240701T120000Z&amp;endtime=20240701T121000Z&amp;name=00000000226000000</playbackURI>
</mediaSegmentDescriptor>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/CMR</metadataDescriptor></metadataMatches>
</searchMatchItem>
<searchMatchItem>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:10:00Z</startTime><endTime>2024-07-01T12:11:30Z</endTime></timeSpan>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/VMD</metadataDescriptor></metadataMatches>
</searchMatchItem>
<searchMatchItem>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:30:00Z</startTime><endTime>2024-07-01T12:31:00Z</endTime></timeSpan>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/humanDetection</metadataDescriptor></metadataMatches>
</searchMatchItem>
</matchList>
</CMSearchResult>`

const storage = `<storage version="2.0"><hddList>
<hdd><id>1</id><hddName>hdd1</hddName><status>ok</status><capacity>2000000</capacity><freeSpace>1000000</freeSpace></hdd>
<hdd><id>2</id><hddName>hdd2</hddName><status>error</status><capacity>0</capacity><freeSpace>0</freeSpace></hdd>
</hddList></storage>`

const okStatus = `<ResponseStatus version="2.0"><requestURL>/x</requestURL><statusCode>1</statusCode><statusString>OK</statusString><subStatusCode>ok</subStatusCode></ResponseStatus>`

const notSupport = `<ResponseStatus version="2.0"><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>`

// at is a UTC time on 2024-07-01.
func at(h, m int) int64 { return time.Date(2024, 7, 1, h, m, 0, 0, time.UTC).Unix() }

type fakeDevice struct {
	srv *httptest.Server
	mu  sync.Mutex
	// requests are "METHOD path?query" (and the body for writes).
	requests   []string
	challenges atomic.Int32
	// noAllEvent answers the "AllEvent" search filter with notSupport.
	noAllEvent bool
	// alertStream writes the multipart stream for connection n (0-based).
	alertStream func(ctx context.Context, w http.ResponseWriter, flush func(), n int)
	alertConns  atomic.Int32
}

func (d *fakeDevice) log(s string) {
	d.mu.Lock()
	d.requests = append(d.requests, s)
	d.mu.Unlock()
}

func (d *fakeDevice) has(prefix string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, r := range d.requests {
		if strings.HasPrefix(r, prefix) {
			return true
		}
	}
	return false
}

// digestOK checks an RFC 7616 MD5 Digest answer the way the device does.
func digestOK(r *http.Request, user, pass, realm, nonce string) bool {
	auth, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Digest ")
	if !ok {
		return false
	}
	p := map[string]string{}
	for _, kv := range strings.Split(auth, ", ") {
		k, v, _ := strings.Cut(kv, "=")
		p[k] = strings.Trim(v, `"`)
	}
	sum := func(s string) string { h := md5.Sum([]byte(s)); return hex.EncodeToString(h[:]) }
	ha1 := sum(user + ":" + realm + ":" + pass)
	ha2 := sum(r.Method + ":" + r.URL.RequestURI())
	want := sum(ha1 + ":" + nonce + ":" + p["nc"] + ":" + p["cnonce"] + ":auth:" + ha2)
	return p["username"] == user && p["response"] == want && p["uri"] == r.URL.RequestURI()
}

func newFakeDevice(t *testing.T) *fakeDevice {
	t.Helper()
	d := &fakeDevice{}
	const realm, nonce = "DS-7608NXI", "6e6f6e6365"
	d.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !digestOK(r, "admin", "Pa$$:word@1", realm, nonce) {
			d.challenges.Add(1)
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Digest qop="auth", realm="%s", nonce="%s", stale="FALSE"`, realm, nonce))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		d.log(r.Method + " " + r.URL.RequestURI() + " " + string(body))
		write := func(s string) { _, _ = io.WriteString(w, s) }
		switch p := r.URL.Path; {
		case p == "/ISAPI/System/deviceInfo":
			write(nvrInfo)
		case p == "/ISAPI/ContentMgmt/InputProxy/channels":
			write(proxyChannels)
		case p == "/ISAPI/ContentMgmt/InputProxy/channels/status":
			write(proxyStatus)
		case p == "/ISAPI/Streaming/channels":
			write(streamingChannels)
		case p == "/ISAPI/Security/adminAccesses":
			write(adminAccesses)
		case p == "/ISAPI/System/time":
			write(deviceTime)
		case p == "/ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/capabilities":
			write(ptzCaps)
		case p == "/ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/presets":
			write(ptzPresets)
		case strings.HasPrefix(p, "/ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/") && r.Method == http.MethodPut:
			write(okStatus)
		case strings.HasPrefix(p, "/ISAPI/ContentMgmt/PTZCtrlProxy/channels/2/"):
			w.WriteHeader(http.StatusForbidden)
		case p == "/ISAPI/Streaming/channels/102/picture":
			w.Header().Set("Content-Type", "image/jpeg")
			write("jpeg-sub")
		case p == "/ISAPI/ContentMgmt/search" && r.Method == http.MethodPost:
			if d.noAllEvent && strings.Contains(string(body), "AllEvent") {
				w.WriteHeader(http.StatusBadRequest)
				write(notSupport)
				return
			}
			if !strings.Contains(string(body), "<trackID>101</trackID>") || !strings.Contains(string(body), "2024-07-01T") {
				write(`<CMSearchResult><responseStatus>false</responseStatus><responseStatusStrg>NO MATCHES</responseStatusStrg></CMSearchResult>`)
				return
			}
			write(searchResult)
		case p == "/ISAPI/ContentMgmt/Storage":
			write(storage)
		case p == "/ISAPI/Event/notification/alertStream":
			n := int(d.alertConns.Add(1)) - 1
			w.Header().Set("Content-Type", "multipart/mixed; boundary=boundary")
			w.WriteHeader(http.StatusOK)
			flush := func() { w.(http.Flusher).Flush() }
			flush()
			if d.alertStream != nil {
				d.alertStream(r.Context(), w, flush, n)
			}
		default:
			w.WriteHeader(http.StatusNotFound)
			write(notSupport)
		}
	}))
	t.Cleanup(d.srv.Close)
	return d
}

func newBackend(t *testing.T, d *fakeDevice) *Hikvision {
	t.Helper()
	b, err := New(backend.Config{ID: "nvr", Kind: "hikvision", URL: d.srv.URL, Username: "admin", Password: "Pa$$:word@1"})
	if err != nil {
		t.Fatal(err)
	}
	b.hubZone = time.UTC
	return b
}

func TestCamerasLiveSnapshotDigest(t *testing.T) {
	d := newFakeDevice(t)
	h := newBackend(t, d)
	ctx := context.Background()

	if err := h.Probe(ctx); err != nil {
		t.Fatalf("probe: %v", err)
	}
	cams, err := h.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cams) != 2 {
		t.Fatalf("cameras = %+v", cams)
	}
	if c := cams[0]; c.ID != "1" || c.Name != "garden" || !c.Enabled || !c.PTZ || c.Aspect < 1.77 || c.Aspect > 1.78 {
		t.Errorf("camera 1 = %+v", c)
	}
	if c := cams[1]; c.ID != "2" || c.Name != "Back & Side" || c.Enabled || c.PTZ {
		t.Errorf("camera 2 = %+v", c)
	}
	// Digest: challenged once, then every request is authorized up front.
	if n := d.challenges.Load(); n != 1 {
		t.Errorf("challenged %d times, want 1", n)
	}

	host := strings.TrimPrefix(d.srv.URL, "http://")
	hostOnly := host[:strings.LastIndex(host, ":")]
	live, err := h.Live(ctx, "1", "main")
	if err != nil {
		t.Fatal(err)
	}
	if live.Kind != backend.LiveRTSP || live.URL != "rtsp://admin:Pa$$%3Aword%401@"+hostOnly+":10554/Streaming/Channels/101" {
		t.Errorf("live = %+v", live)
	}
	u, err := url.Parse(live.URL)
	if p, _ := u.User.Password(); err != nil || p != "Pa$$:word@1" {
		t.Errorf("password doesn't round-trip: %q %v", p, err)
	}
	sub, _ := h.Live(ctx, "2", "sub")
	if !strings.HasSuffix(sub.URL, ":10554/Streaming/Channels/202") {
		t.Errorf("sub = %s", sub.URL)
	}
	if _, err := h.Live(ctx, "9", "main"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("unknown camera: %v", err)
	}
	if _, err := h.Live(ctx, "../x", "main"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("bad id: %v", err)
	}

	img, ct, err := h.Snapshot(ctx, "1", 360)
	if err != nil || string(img) != "jpeg-sub" || ct != "image/jpeg" {
		t.Errorf("snapshot = %q %q %v", img, ct, err)
	}
	if !d.has("GET /ISAPI/Streaming/channels/102/picture?videoResolutionWidth=640&videoResolutionHeight=360") {
		t.Errorf("snapshot request missing: %v", d.requests)
	}

	caps := h.Capabilities()
	if !caps.Snapshots || !caps.Events || !caps.Recordings || caps.Clips || !caps.PTZ || !caps.Alerts {
		t.Errorf("capabilities = %+v", caps)
	}

	// Talk: a recorder's two-way audio isn't a camera's speaker; a lone camera's is (ISAPI).
	if _, err := h.Talk(ctx, "1"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("talk on a 2-channel device: %v", err)
	}
	h.mu.Lock()
	h.info.channels = h.info.channels[:1]
	h.info.channels[0].Proxied = false // now a lone camera
	h.mu.Unlock()
	tt, err := h.Talk(ctx, "1")
	if err != nil || tt.Kind != "isapi" || tt.URL != "http://admin:Pa$$%3Aword%401@"+host {
		t.Errorf("talk = %+v, %v", tt, err)
	}
}

func TestEventsSegmentsPlayback(t *testing.T) {
	for _, noAllEvent := range []bool{false, true} {
		t.Run(fmt.Sprintf("noAllEvent=%v", noAllEvent), func(t *testing.T) {
			d := newFakeDevice(t)
			d.noAllEvent = noAllEvent
			h := newBackend(t, d)
			ctx := context.Background()

			evs, err := h.Events(ctx, backend.EventQuery{Cameras: []string{"1"}, After: float64(at(9, 0)), Before: float64(at(11, 0))})
			if err != nil {
				t.Fatal(err)
			}
			// Newest first; the continuous (CMR) recording isn't an event.
			if len(evs) != 2 {
				t.Fatalf("events = %+v", evs)
			}
			if e := evs[0]; e.ID != fmt.Sprintf("1:%d", at(10, 30)) || e.Camera != "1" || e.Severity != "alert" || e.Objects[0] != "person" || *e.End != float64(at(10, 31)) {
				t.Errorf("event 0 = %+v", e)
			}
			if e := evs[1]; e.Start != float64(at(10, 10)) || e.Severity != "detection" || e.Objects[0] != "motion" {
				t.Errorf("event 1 = %+v", e)
			}
			// Searches are in device-local time with a "fake Z".
			if !d.has("POST /ISAPI/ContentMgmt/search <?xml") || !d.has("POST /ISAPI/ContentMgmt/search") {
				t.Error("no search")
			}
			found := false
			d.mu.Lock()
			for _, r := range d.requests {
				if strings.Contains(r, "<startTime>2024-07-01T11:00:00Z</startTime><endTime>2024-07-01T13:00:00Z</endTime>") {
					found = true
				}
			}
			d.mu.Unlock()
			if !found {
				t.Errorf("search window not in device time: %v", d.requests)
			}
			alerts, _ := h.Events(ctx, backend.EventQuery{After: float64(at(9, 0)), Before: float64(at(11, 0)), Severity: "alert", Limit: 5})
			if len(alerts) != 1 || alerts[0].Objects[0] != "person" {
				t.Errorf("alerts = %+v", alerts)
			}

			ev, err := h.Event(ctx, evs[1].ID)
			if err != nil || ev.Start != evs[1].Start || ev.Severity != "detection" {
				t.Errorf("event = %+v, %v", ev, err)
			}
			if _, err := h.Event(ctx, "1:12345"); !errors.Is(err, backend.ErrNotFound) {
				t.Errorf("missing event: %v", err)
			}
			if _, _, err := h.EventThumbnail(ctx, evs[0].ID); !errors.Is(err, backend.ErrUnsupported) {
				t.Errorf("thumbnail: %v", err)
			}

			segs, err := h.Segments(ctx, "1", float64(at(9, 0)), float64(at(11, 0)))
			if err != nil || len(segs) != 2 || segs[0] != (backend.Segment{Start: float64(at(10, 0)), End: float64(at(10, 11)) + 30}) {
				t.Errorf("segments = %+v, %v", segs, err)
			}

			// Asked from 09:30 UTC, the first recording starts at 10:00 UTC (12:00 at the device).
			pb, err := h.Playback(ctx, "1", float64(at(9, 30)), float64(at(10, 30)))
			if err != nil {
				t.Fatal(err)
			}
			if pb.Live == nil || pb.File != nil || pb.StartTime != float64(at(10, 0)) {
				t.Fatalf("playback = %+v", pb)
			}
			if !strings.HasSuffix(pb.Live.URL, ":10554/Streaming/tracks/101?starttime=20240701T120000Z&endtime=20240701T123000Z") || pb.Live.Kind != backend.LiveRTSP {
				t.Errorf("playback URL = %s", pb.Live.URL)
			}
			// Nothing recorded in the window.
			if _, err := h.Playback(ctx, "1", float64(at(20, 0)), float64(at(21, 0))); !errors.Is(err, backend.ErrNotFound) {
				t.Errorf("empty window: %v", err)
			}
			if _, err := h.VOD(ctx, "1", 0, 1, "", nil); !errors.Is(err, backend.ErrUnsupported) {
				t.Error("VOD should be unsupported")
			}
		})
	}
}

func TestPTZ(t *testing.T) {
	d := newFakeDevice(t)
	h := newBackend(t, d)
	ctx := context.Background()

	info, err := h.PTZInfo(ctx, "1")
	if err != nil || !info.CanMove || !info.CanZoom || strings.Join(info.Presets, ",") != "Driveway,Gate" {
		t.Fatalf("ptz info = %+v, %v", info, err)
	}
	if err := h.PTZ(ctx, "1", "MOVE_LEFT"); err != nil {
		t.Fatal(err)
	}
	if !d.has("PUT /ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/continuous <?xml version=\"1.0\" encoding=\"UTF-8\"?><PTZData><pan>-60</pan><tilt>0</tilt><zoom>0</zoom></PTZData>") {
		t.Errorf("move request missing: %v", d.requests)
	}
	if err := h.PTZ(ctx, "1", "STOP"); err != nil || !d.has("PUT /ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/continuous <?xml version=\"1.0\" encoding=\"UTF-8\"?><PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>") {
		t.Errorf("stop: %v", err)
	}
	if err := h.PTZ(ctx, "1", "preset_Gate"); err != nil || !d.has("PUT /ISAPI/ContentMgmt/PTZCtrlProxy/channels/1/presets/3/goto") {
		t.Errorf("preset: %v", err)
	}
	if err := h.PTZ(ctx, "1", "preset_Nope"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("missing preset: %v", err)
	}
	if _, err := h.PTZInfo(ctx, "2"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("camera 2 can't move: %v", err)
	}
}

func TestHealth(t *testing.T) {
	d := newFakeDevice(t)
	h := newBackend(t, d)
	hl, err := h.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(hl.Offline) != 1 || hl.Offline[0] != "2" {
		t.Errorf("offline = %v", hl.Offline)
	}
	if len(hl.Storage) != 2 || hl.Storage[0].UsedPct != 50 || hl.Storage[0].FreeGB < 976 || hl.Storage[0].Path != "Disk 1" {
		t.Fatalf("storage = %+v", hl.Storage)
	}
	if s := hl.Storage[1]; s.Problem == "" || s.Path != "Disk 2" {
		t.Errorf("failed disk = %+v", s)
	}
}

func TestProbeErrors(t *testing.T) {
	ctx := context.Background()
	d := newFakeDevice(t)
	wrong, _ := New(backend.Config{URL: d.srv.URL, Username: "admin", Password: "nope"})
	if err := wrong.Probe(ctx); !errors.Is(err, httpx.ErrAuth) || err.Error() != "the username or password is wrong" {
		t.Errorf("wrong password: %v", err)
	}

	locked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.Header().Set("WWW-Authenticate", `Digest qop="auth", realm="x", nonce="y"`)
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `<userCheck><statusValue>401</statusValue><statusString>Unauthorized</statusString><lockStatus>lock</lockStatus><unlockTime>1800</unlockTime></userCheck>`)
	}))
	defer locked.Close()
	l, _ := New(backend.Config{URL: locked.URL, Username: "admin", Password: "x"})
	if err := l.Probe(ctx); err == nil || !strings.Contains(err.Error(), "locked this account") {
		t.Errorf("locked: %v", err)
	}

	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "<!DOCTYPE html><html><body><p>Router login<br></body></html>")
	}))
	defer router.Close()
	rt, _ := New(backend.Config{URL: router.URL, Username: "admin", Password: "x"})
	if err := rt.Probe(ctx); err == nil || !strings.Contains(err.Error(), "doesn't look like a Hikvision") {
		t.Errorf("router: %v", err)
	}
	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	ot, _ := New(backend.Config{URL: other.URL, Username: "admin", Password: "x"})
	if err := ot.Probe(ctx); err == nil || !strings.Contains(err.Error(), "doesn't look like a Hikvision") || httpx.Unreachable(err) {
		t.Errorf("404: %v", err)
	}
	if _, err := New(backend.Config{URL: "::"}); err == nil {
		t.Error("bad address accepted")
	}
	if d, ok := backend.Lookup("hikvision"); !ok || d.Label != "Hikvision recorder or camera" || d.DefaultPorts[0] != 80 {
		t.Errorf("registration = %+v", d)
	}
}

// part is one multipart section as Hikvision writes it.
func part(contentType, body string, withLength bool) string {
	s := "--boundary\r\nContent-Type: " + contentType + "\r\n"
	if withLength {
		s += fmt.Sprintf("Content-Length: %d\r\n", len(body))
	}
	return s + "\r\n" + body + "\r\n"
}

func alertDoc(ch, typ, state, extra string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<ipAddress>192.168.1.64</ipAddress><portNo>80</portNo><protocol>HTTP</protocol>
` + ch + `<dateTime>2024-07-01T12:00:00+02:00</dateTime><activePostCount>1</activePostCount>
<eventType>` + typ + `</eventType><eventState>` + state + `</eventState><eventDescription>x</eventDescription>` + extra + `
</EventNotificationAlert>`
}

func TestParseMultipartAndAlerts(t *testing.T) {
	stream := part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>1</channelID>", "VMD", "active", ""), true) +
		part("image/jpeg", "\xff\xd8binary\n--boundary\nnot a boundary\xff\xd9", true) +
		part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>33</channelID><dynChannelID>2</dynChannelID>", "linedetection", "active",
			"<DetectionRegionList><DetectionRegionEntry><regionID>1</regionID><detectionTarget>human</detectionTarget></DetectionRegionEntry></DetectionRegionList>"), false) +
		part("application/json", `{"ipAddress":"192.168.1.64","channelID":3,"dateTime":"2024-07-01T12:00:00+02:00","eventType":"videoIntercomEvent","eventState":"active","VideoIntercomEvent":{"eventType":"callStatus","status":"ring"}}`, true) +
		part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>1</channelID>", "videoloss", "inactive", ""), true) +
		"--boundary--\r\n"
	var got []alert
	err := parseMultipart(strings.NewReader(stream), "boundary", func(ct string, p []byte) {
		if a, ok := parseAlert(ct, p, time.UTC); ok {
			got = append(got, a)
		}
	})
	if err != nil || len(got) != 4 {
		t.Fatalf("alerts = %+v, %v", got, err)
	}
	if got[0].Channel != 1 || got[0].Type != "vmd" || !got[0].Active || got[0].Time.Unix() != at(10, 0) {
		t.Errorf("alert 0 = %+v", got[0])
	}
	if got[1].Channel != 2 || got[1].Type != "linedetection" || len(got[1].Targets) != 1 || got[1].Targets[0] != "human" {
		t.Errorf("alert 1 = %+v", got[1])
	}
	if got[2].Channel != 3 || got[2].Type != "videointercomevent" {
		t.Errorf("alert 2 = %+v", got[2])
	}
	if got[3].Active {
		t.Errorf("videoloss heartbeat = %+v", got[3])
	}

	for _, c := range []struct {
		a        alert
		objects  string
		severity string
		ok       bool
	}{
		{alert{Type: "vmd"}, "motion", "detection", true},
		{alert{Type: "vmd", Targets: []string{"vehicle"}}, "vehicle", "alert", true},
		{alert{Type: "fielddetection"}, "motion", "alert", true},
		{alert{Type: "linedetection", Targets: []string{"human", "vehicle"}}, "person,vehicle", "alert", true},
		{alert{Type: "doorbell"}, "doorbell", "alert", true},
		{alert{Type: "videointercomevent", Raw: `{"unlocktype":"card"}`}, "", "", false},
		{alert{Type: "videoloss"}, "", "", false},
		{alert{Type: "shelteralarm"}, "", "", false},
	} {
		objs, sev, ok := classifyAlert(c.a)
		if strings.Join(objs, ",") != c.objects || sev != c.severity || ok != c.ok {
			t.Errorf("classify %+v = %v %q %v", c.a, objs, sev, ok)
		}
	}

	// Repeats within an episode make one event; a pause starts a new one.
	var k alertTracker
	now := time.Unix(at(10, 0), 0)
	a := alert{Channel: 1, Type: "vmd", Active: true, Time: now}
	e1, ok1 := k.handle(a, now)
	_, ok2 := k.handle(a, now.Add(5*time.Second))
	_, ok3 := k.handle(a, now.Add(15*time.Second))
	a.Time = now.Add(40 * time.Second)
	e4, ok4 := k.handle(a, now.Add(40*time.Second))
	if !ok1 || ok2 || ok3 || !ok4 || e1.ID != fmt.Sprintf("1:%d:vmd", at(10, 0)) || e4.ID == e1.ID {
		t.Errorf("episodes: %v %v %v %v %s %s", ok1, ok2, ok3, ok4, e1.ID, e4.ID)
	}
	if _, ok := k.handle(alert{Channel: 1, Type: "vmd", Active: false}, now.Add(41*time.Second)); ok {
		t.Error("inactive made an event")
	}
	if _, ok := k.handle(a, now.Add(42*time.Second)); !ok {
		t.Error("an event after inactive is a new episode")
	}
}

type sink struct {
	mu  sync.Mutex
	evs []backend.Event
}

func (s *sink) OnEvent(e backend.Event)             { s.mu.Lock(); s.evs = append(s.evs, e); s.mu.Unlock() }
func (s *sink) OnPosition(string, float64, float64) {}
func (s *sink) events() []backend.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]backend.Event(nil), s.evs...)
}

func TestWatchReconnects(t *testing.T) {
	d := newFakeDevice(t)
	d.alertStream = func(ctx context.Context, w http.ResponseWriter, flush func(), n int) {
		switch n {
		case 0: // motion twice (one episode), a picture, then the device drops the connection
			_, _ = io.WriteString(w, part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>1</channelID>", "VMD", "active", ""), true))
			_, _ = io.WriteString(w, part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>1</channelID>", "VMD", "active", ""), true))
			_, _ = io.WriteString(w, part("image/jpeg", "\xff\xd8\xff\xd9", true))
			flush()
		default: // after reconnecting: a doorbell ring, then heartbeats until the Hub leaves
			_, _ = io.WriteString(w, part("application/json", `{"channelID":1,"eventType":"doorbell","eventState":"active"}`, true))
			flush()
			for i := 0; i < 100 && ctx.Err() == nil; i++ {
				_, _ = io.WriteString(w, part(`application/xml; charset="UTF-8"`, alertDoc("<channelID>1</channelID>", "videoloss", "inactive", ""), true))
				flush()
				time.Sleep(50 * time.Millisecond)
			}
		}
	}
	h := newBackend(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	var s sink
	done := make(chan error, 1)
	go func() { done <- h.Watch(ctx, &s) }()
	deadline := time.Now().Add(10 * time.Second)
	for len(s.events()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("watch = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Watch didn't stop when its context ended")
	}
	evs := s.events()
	if len(evs) != 2 {
		t.Fatalf("events = %+v", evs)
	}
	if e := evs[0]; e.Camera != "1" || e.Objects[0] != "motion" || e.Severity != "detection" || !strings.HasSuffix(e.ID, ":vmd") {
		t.Errorf("motion = %+v", e)
	}
	if e := evs[1]; e.Objects[0] != "doorbell" || e.Severity != "alert" {
		t.Errorf("doorbell = %+v", e)
	}
	if n := d.alertConns.Load(); n < 2 {
		t.Errorf("connections = %d, want a reconnect", n)
	}
}

func TestTimeHelpers(t *testing.T) {
	cest := time.FixedZone("device", 2*3600)
	zone := deviceZone(timeXML{LocalTime: "2024-07-01T12:00:00+02:00"}, time.Now(), time.UTC)
	if _, off := time.Now().In(zone).Zone(); off != 7200 {
		t.Errorf("zone offset = %d", off)
	}
	// Without an offset, the wall clock is compared with now.
	now := time.Date(2024, 7, 1, 10, 0, 0, 0, time.UTC)
	zone = deviceZone(timeXML{LocalTime: "2024-07-01T12:00:05"}, now, time.UTC)
	if _, off := now.In(zone).Zone(); off != 7200 {
		t.Errorf("guessed offset = %d", off)
	}
	// Same offset as the Hub: the Hub's zone is used (it knows DST history).
	if z := deviceZone(timeXML{LocalTime: "2024-07-01T10:00:00Z"}, now, time.UTC); z != time.UTC {
		t.Errorf("hub zone not used: %v", z)
	}
	for _, s := range []string{"2024-07-01T12:00:00Z", "2024-07-01T12:00:00+02:00", "20240701T120000Z", "2024-07-01T06:00:00-04:00"} {
		if got, ok := parseHikTime(s, cest); !ok || got.Unix() != at(10, 0) {
			t.Errorf("parse %s = %v %v", s, got, ok)
		}
	}
	if _, ok := parseHikTime("garbage", cest); ok {
		t.Error("garbage parsed")
	}
	if searchTime(at(10, 0), cest) != "2024-07-01T12:00:00Z" || rtspTime(at(10, 0), cest) != "20240701T120000Z" {
		t.Error("formatting")
	}
	// Days in device time, newest first (device midnight is 22:00 UTC).
	day := func(d, h int) int64 { return time.Date(2024, 5, d, h, 0, 0, 0, time.UTC).Unix() }
	got := dayRanges(day(1, 12), day(3, 9), cest, 62)
	want := [][2]int64{{day(2, 22), day(3, 9)}, {day(1, 22), day(2, 22)}, {day(1, 12), day(1, 22)}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("days = %v, want %v", got, want)
	}
	if len(dayRanges(day(3, 9), day(3, 9), cest, 62)) != 0 {
		t.Error("empty range")
	}
	body := searchXML("ABC", 101, at(10, 0), at(11, 0), cest, 50, 50, "AllEvent")
	for _, w := range []string{"<trackID>101</trackID>", "<startTime>2024-07-01T12:00:00Z</startTime><endTime>2024-07-01T13:00:00Z</endTime>",
		"<searchResultPostion>50</searchResultPostion>", "<metadataDescriptor>//recordType.meta.std-cgi.com/AllEvent</metadataDescriptor>"} {
		if !strings.Contains(body, w) {
			t.Errorf("search body lacks %s", w)
		}
	}
}

func TestChannelsDVRAndCamera(t *testing.T) {
	var inputs videoInputsXML
	if err := xml.Unmarshal([]byte(`<VideoInputChannelList version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<VideoInputChannel version="1.0"><id>1</id><inputPort>1</inputPort><videoInputEnabled>true</videoInputEnabled><name>Entrada</name><resDesc>2560*1440(4MP)P30</resDesc></VideoInputChannel>
<VideoInputChannel version="1.0"><id>2</id><inputPort>2</inputPort><videoInputEnabled>true</videoInputEnabled><name>Camera 02</name><resDesc>NO VIDEO</resDesc></VideoInputChannel>
<VideoInputChannel version="1.0"><id>3</id><inputPort>3</inputPort><videoInputEnabled>true</videoInputEnabled><name>Terraza - Taller</name><resDesc>2560*1440(4MP)P25</resDesc></VideoInputChannel>
</VideoInputChannelList>`), &inputs); err != nil {
		t.Fatal(err)
	}
	dvr := buildChannels(deviceInfoXML{DeviceName: "Embedded Net DVR"}, inputProxyListXML{}, inputProxyStatusXML{}, inputs, nil)
	if len(dvr) != 2 || dvr[0].Name != "Entrada" || dvr[1].ID != 3 {
		t.Errorf("dvr = %+v", dvr)
	}
	var sc streamingChannelsXML
	if err := xml.Unmarshal([]byte(streamingChannels), &sc); err != nil {
		t.Fatal(err)
	}
	cam := buildChannels(deviceInfoXML{DeviceName: "Front Porch"}, inputProxyListXML{}, inputProxyStatusXML{}, videoInputsXML{}, parseStreams(sc))
	if len(cam) != 1 || cam[0].Name != "Front Porch" || cam[0].ID != 1 || cam[0].Width != 3840 {
		t.Errorf("camera = %+v", cam)
	}
}
