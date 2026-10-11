package onvif

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// The ONVIF Core spec's UsernameToken example.
func TestPasswordDigestSpecVector(t *testing.T) {
	nonce, _ := base64.StdEncoding.DecodeString("LKqI6G/AikKCQrN0zqZFlg==")
	got := passwordDigest(nonce, "2010-09-16T07:50:45Z", "userpassword")
	if got != "tuOSpGlFlIXsozq4HFNeeGeFLEI=" {
		t.Fatalf("digest = %s", got)
	}
	if ts := onvifTimestamp(time.Date(2024, 1, 2, 3, 4, 5, 600e6, time.FixedZone("x", 3600))); ts != "2024-01-02T02:04:05Z" {
		t.Fatalf("timestamp = %s", ts)
	}
}

// ---- a fake ONVIF device ----

type fakeCam struct {
	t        *testing.T
	user     string
	pass     string
	clock    time.Duration // camera clock minus real time
	rejectWS bool          // answer NotAuthorized to every WS-Security login
	alwaysNo bool          // reject every login, WS-Security or not
	html     bool          // a web page, not ONVIF

	mu     sync.Mutex
	calls  []string // operation names, in order
	bodies map[string]string
	pulls  int
	srv    *httptest.Server
}

var (
	reUser    = regexp.MustCompile(`<wsse:Username>([^<]*)</wsse:Username>`)
	rePass    = regexp.MustCompile(`<wsse:Password[^>]*>([^<]*)</wsse:Password>`)
	reNonce   = regexp.MustCompile(`<wsse:Nonce[^>]*>([^<]*)</wsse:Nonce>`)
	reCreated = regexp.MustCompile(`<wsu:Created>([^<]*)</wsu:Created>`)
	reOp      = regexp.MustCompile(`<s:Body><(?:\w+:)?(\w+)`)
)

func soapOK(body string) string {
	return `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" ` +
		`xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ` +
		`xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" ` +
		`xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" ` +
		`xmlns:wsa5="http://www.w3.org/2005/08/addressing" xmlns:tns1="http://www.onvif.org/ver10/topics" ` +
		`xmlns:dom0="http://www.example.com/sub">` +
		`<SOAP-ENV:Body>` + body + `</SOAP-ENV:Body></SOAP-ENV:Envelope>`
}

const authFault = `<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value>` +
	`<SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code>` +
	`<SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`

const profilesXML = `<trt:GetProfilesResponse>
<trt:Profiles token="Profile_1" fixed="true"><tt:Name>mainStream</tt:Name>
  <tt:VideoSourceConfiguration token="VSC_1"><tt:SourceToken>VideoSource_1</tt:SourceToken><tt:Bounds x="0" y="0" width="2560" height="1440"/></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VE_1"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
  <tt:PTZConfiguration token="PTZ_1"><tt:NodeToken>PTZNODE_1</tt:NodeToken></tt:PTZConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_2"><tt:Name>subStream</tt:Name>
  <tt:VideoSourceConfiguration token="VSC_1"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VE_2"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_3"><tt:Name>jpeg</tt:Name>
  <tt:VideoSourceConfiguration token="VSC_1"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VE_3"><tt:Encoding>JPEG</tt:Encoding><tt:Resolution><tt:Width>320</tt:Width><tt:Height>180</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_201"><tt:Name>ch2</tt:Name>
  <tt:VideoSourceConfiguration token="VSC_2"><tt:SourceToken>VideoSource 2</tt:SourceToken></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VE_4"><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>1280</tt:Width><tt:Height>960</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>
</trt:GetProfilesResponse>`

func newFakeCam(t *testing.T) *fakeCam {
	f := &fakeCam{t: t, user: "admin", pass: "p@ss:word", bodies: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCam) cfg() backend.Config {
	return backend.Config{ID: "onvif", Kind: kind, URL: f.srv.URL, Username: f.user, Password: f.pass}
}

func (f *fakeCam) count(op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == op {
			n++
		}
	}
	return n
}

func (f *fakeCam) body(op string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[op]
}

// wsseOK checks a WS-Security header: right user, right digest, timed by the camera's clock.
func (f *fakeCam) wsseOK(body string) (present, ok bool) {
	u := reUser.FindStringSubmatch(body)
	if u == nil {
		return false, false
	}
	p, n, c := rePass.FindStringSubmatch(body), reNonce.FindStringSubmatch(body), reCreated.FindStringSubmatch(body)
	if p == nil || n == nil || c == nil {
		return true, false
	}
	nonce, _ := base64.StdEncoding.DecodeString(n[1])
	created, err := time.Parse(time.RFC3339, c[1])
	if err != nil {
		f.t.Errorf("bad Created %q", c[1])
		return true, false
	}
	if d := created.Sub(time.Now().Add(f.clock)); d > 10*time.Second || d < -10*time.Second {
		f.t.Errorf("Created %s isn't the camera's clock (off by %s)", c[1], d)
		return true, false
	}
	return true, u[1] == f.user && p[1] == passwordDigest(nonce, c[1], f.pass)
}

func (f *fakeCam) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/snap" {
		user, pass, ok := r.BasicAuth()
		if !ok || user != f.user || pass != f.pass {
			w.Header().Set("WWW-Authenticate", `Basic realm="cam"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("JPEGDATA"))
		return
	}
	if f.html {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html><body>Login</body></html>")
		return
	}
	raw, _ := io.ReadAll(r.Body)
	body := string(raw)
	m := reOp.FindStringSubmatch(body)
	if m == nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	op := m[1]
	f.mu.Lock()
	f.calls = append(f.calls, op)
	f.bodies[op] = body
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/soap+xml")

	reply := func(s string) { _, _ = io.WriteString(w, soapOK(s)) }
	if op == "GetSystemDateAndTime" {
		ct := time.Now().Add(f.clock).UTC()
		reply(fmt.Sprintf(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>`+
			`<tt:Time><tt:Hour>%d</tt:Hour><tt:Minute>%d</tt:Minute><tt:Second>%d</tt:Second></tt:Time>`+
			`<tt:Date><tt:Year>%d</tt:Year><tt:Month>%d</tt:Month><tt:Day>%d</tt:Day></tt:Date>`+
			`</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
			ct.Hour(), ct.Minute(), ct.Second(), ct.Year(), int(ct.Month()), ct.Day()))
		return
	}
	present, ok := f.wsseOK(body)
	if f.alwaysNo || (present && (f.rejectWS || !ok)) || (!present && !f.rejectWS) {
		w.WriteHeader(http.StatusBadRequest)
		reply(authFault)
		return
	}

	switch op {
	case "GetServices":
		reply(`<tds:GetServicesResponse>
<tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>http://10.9.9.9/onvif/device_service</tds:XAddr></tds:Service>
<tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>http://10.9.9.9/onvif/Media http://[fe80::1]/onvif/Media</tds:XAddr></tds:Service>
<tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>http://10.9.9.9/onvif/PTZ</tds:XAddr></tds:Service>
<tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>http://10.9.9.9/onvif/Events</tds:XAddr></tds:Service>
</tds:GetServicesResponse>`)
	case "GetDeviceInformation":
		reply(`<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer><tds:Model>IPC-200</tds:Model></tds:GetDeviceInformationResponse>`)
	case "GetProfiles":
		if r.URL.Path != "/onvif/Media" {
			f.t.Errorf("GetProfiles went to %s", r.URL.Path)
		}
		reply(profilesXML)
	case "GetSnapshotUri":
		if strings.Contains(body, "Profile_201") {
			w.WriteHeader(http.StatusBadRequest)
			reply(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Receiver</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:ActionNotSupported</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code></SOAP-ENV:Fault>`)
			return
		}
		port := f.srv.URL[strings.LastIndex(f.srv.URL, ":")+1:]
		reply(`<trt:GetSnapshotUriResponse><trt:MediaUri><tt:Uri>http://localhost:` + port + `/snap</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`)
	case "GetStreamUri":
		path := "Streaming/Channels/101"
		if strings.Contains(body, "Profile_2<") {
			path = "Streaming/Channels/102"
		}
		reply(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://192.168.1.64:554/` + path + `?transportmode=unicast&amp;profile=x</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`)
	case "GetNodes":
		reply(`<tptz:GetNodesResponse><tptz:PTZNode token="PTZNODE_1"><tt:SupportedPTZSpaces>` +
			`<tt:ContinuousPanTiltVelocitySpace><tt:URI>x</tt:URI></tt:ContinuousPanTiltVelocitySpace>` +
			`</tt:SupportedPTZSpaces></tptz:PTZNode></tptz:GetNodesResponse>`)
	case "GetPresets":
		reply(`<tptz:GetPresetsResponse><tptz:Preset token="1"><tt:Name>Driveway</tt:Name></tptz:Preset>` +
			`<tptz:Preset token="2"><tt:Name>Gate</tt:Name></tptz:Preset><tptz:Preset token="3"><tt:Name>Gate</tt:Name></tptz:Preset></tptz:GetPresetsResponse>`)
	case "ContinuousMove", "Stop", "GotoPreset", "Unsubscribe", "Renew":
		reply(`<x:` + op + `Response xmlns:x="urn:x"/>`)
	case "CreatePullPointSubscription":
		if r.URL.Path != "/onvif/Events" {
			f.t.Errorf("subscription went to %s", r.URL.Path)
		}
		reply(`<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference>` +
			`<wsa5:Address>http://10.9.9.9/onvif/Subscription?Idx=7</wsa5:Address>` +
			`<wsa5:ReferenceParameters><dom0:SubscriptionId>7</dom0:SubscriptionId></wsa5:ReferenceParameters>` +
			`</tev:SubscriptionReference><wsnt:CurrentTime>2024-01-01T00:00:00Z</wsnt:CurrentTime>` +
			`<wsnt:TerminationTime>2024-01-01T00:02:00Z</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`)
	case "PullMessages":
		if r.URL.Path != "/onvif/Subscription" || r.URL.RawQuery != "Idx=7" {
			f.t.Errorf("pull went to %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		f.mu.Lock()
		f.pulls++
		n := f.pulls
		f.mu.Unlock()
		msgs := ""
		if n == 1 {
			msgs = motionMsg("Initialized", "false") + motionMsg("Changed", "true")
		}
		reply(`<tev:PullMessagesResponse><tev:CurrentTime>2024-01-01T00:00:05Z</tev:CurrentTime>` +
			`<tev:TerminationTime>2024-01-01T00:02:05Z</tev:TerminationTime>` + msgs + `</tev:PullMessagesResponse>`)
	default:
		w.WriteHeader(http.StatusBadRequest)
		reply(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Receiver</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:ActionNotSupported</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code></SOAP-ENV:Fault>`)
	}
}

func motionMsg(op, state string) string {
	return `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>` +
		`<wsnt:Message><tt:Message UtcTime="2024-01-01T00:00:04Z" PropertyOperation="` + op + `">` +
		`<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="VSC_1"/><tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="VAC_1"/><tt:SimpleItem Name="Rule" Value="MyMotionDetectorRule"/></tt:Source>` +
		`<tt:Data><tt:SimpleItem Name="IsMotion" Value="` + state + `"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`
}

func TestDiscoveryLiveSnapshotPTZ(t *testing.T) {
	f := newFakeCam(t)
	f.clock = 3 * time.Hour // the camera's clock is off; logins must use its time
	o, err := New(f.cfg())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := backend.Probe(ctx, f.cfg()); err != nil {
		t.Fatalf("probe: %v", err)
	}
	cams, err := o.Cameras(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(cams) != 2 {
		t.Fatalf("cameras = %+v", cams)
	}
	if cams[0].ID != "VideoSource_1" || cams[0].Name != "Acme IPC-200 1" || !cams[0].PTZ || cams[0].Aspect != 2560.0/1440 {
		t.Errorf("camera 1 = %+v", cams[0])
	}
	if cams[1].ID != "VideoSource_2" || cams[1].PTZ || cams[1].Name != "Acme IPC-200 2" {
		t.Errorf("camera 2 = %+v", cams[1])
	}
	caps := o.Capabilities()
	if !caps.Snapshots || !caps.PTZ || !caps.Alerts || caps.Recordings || caps.Events || caps.Clips {
		t.Errorf("capabilities = %+v", caps)
	}

	// Live: main and sub profiles, host rewritten to the configured one, login URL-encoded.
	live, err := o.Live(ctx, "VideoSource_1", "main")
	if err != nil {
		t.Fatal(err)
	}
	want := "rtsp://admin:p%40ss%3Aword@127.0.0.1:554/Streaming/Channels/101?transportmode=unicast&profile=x"
	if live.Kind != backend.LiveRTSP || live.URL != want {
		t.Errorf("live = %+v, want %s", live, want)
	}
	if tt, err := o.Talk(ctx, "VideoSource_1"); err != nil || tt.Kind != "rtsp" || tt.URL != want || !o.Capabilities().Talk {
		t.Errorf("talk = %+v %v", tt, err)
	}
	sub, _ := o.Live(ctx, "VideoSource_1", "sub")
	if !strings.Contains(sub.URL, "/Channels/102") {
		t.Errorf("sub = %s", sub.URL)
	}
	if !strings.Contains(f.body("GetStreamUri"), "<trt:ProfileToken>Profile_2</trt:ProfileToken>") {
		t.Errorf("sub stream asked for the wrong profile: %s", f.body("GetStreamUri"))
	}
	before := f.count("GetStreamUri")
	_, _ = o.Live(ctx, "VideoSource_1", "main")
	if f.count("GetStreamUri") != before {
		t.Error("stream URL wasn't cached")
	}
	if _, err := o.Live(ctx, "nope", "main"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("unknown camera: %v", err)
	}

	// Snapshot through the camera-reported (rewritten) URL with Basic auth.
	img, ct, err := o.Snapshot(ctx, "VideoSource_1", 360)
	if err != nil || string(img) != "JPEGDATA" || ct != "image/jpeg" {
		t.Errorf("snapshot = %q %q %v", img, ct, err)
	}
	if _, _, err := o.Snapshot(ctx, "VideoSource_2", 360); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("camera without snapshots: %v", err)
	}

	// PTZ.
	info, err := o.PTZInfo(ctx, "VideoSource_1")
	if err != nil || !info.CanMove || info.CanZoom || strings.Join(info.Presets, ",") != "Driveway,Gate" {
		t.Errorf("ptz info = %+v %v", info, err)
	}
	if err := o.PTZ(ctx, "VideoSource_1", "MOVE_LEFT"); err != nil {
		t.Fatal(err)
	}
	if b := f.body("ContinuousMove"); !strings.Contains(b, `<tt:PanTilt x="-0.5" y="0"/>`) || !strings.Contains(b, "<tptz:ProfileToken>Profile_1</tptz:ProfileToken>") {
		t.Errorf("move = %s", b)
	}
	if err := o.PTZ(ctx, "VideoSource_1", "ZOOM_IN"); err != nil {
		t.Fatal(err)
	}
	if b := f.body("ContinuousMove"); !strings.Contains(b, `<tt:Zoom x="0.5"/>`) {
		t.Errorf("zoom = %s", b)
	}
	if err := o.PTZ(ctx, "VideoSource_1", "STOP"); err != nil || !strings.Contains(f.body("Stop"), "<tptz:PanTilt>true</tptz:PanTilt>") {
		t.Errorf("stop: %v %s", err, f.body("Stop"))
	}
	if err := o.PTZ(ctx, "VideoSource_1", "preset_Gate"); err != nil || !strings.Contains(f.body("GotoPreset"), "<tptz:PresetToken>2</tptz:PresetToken>") {
		t.Errorf("preset: %v %s", err, f.body("GotoPreset"))
	}
	if err := o.PTZ(ctx, "VideoSource_1", "preset_Moon"); !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("missing preset: %v", err)
	}
	if err := o.PTZ(ctx, "VideoSource_2", "MOVE_UP"); !errors.Is(err, backend.ErrUnsupported) {
		t.Errorf("no-PTZ camera: %v", err)
	}
	for _, op := range []func() error{
		func() error { _, err := o.Events(ctx, backend.EventQuery{}); return err },
		func() error { _, err := o.Segments(ctx, "VideoSource_1", 0, 1); return err },
		func() error { _, err := o.VOD(ctx, "VideoSource_1", 0, 1, "", nil); return err },
		func() error { _, err := o.Clip(ctx, "VideoSource_1", 0, 1, nil); return err },
	} {
		if err := op(); !errors.Is(err, backend.ErrUnsupported) {
			t.Errorf("want ErrUnsupported, got %v", err)
		}
	}
	if _, err := o.Health(ctx); err != nil {
		t.Errorf("health: %v", err)
	}
}

func TestProbeWrongPassword(t *testing.T) {
	f := newFakeCam(t)
	cfg := f.cfg()
	cfg.Password = "nope"
	err := backend.Probe(context.Background(), cfg)
	if !errors.Is(err, httpx.ErrAuth) || httpx.Unreachable(err) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "username or password") || strings.Contains(err.Error(), "clock") {
		t.Errorf("message = %q", err)
	}
	if got := httpx.Explain(err).Error(); got != err.Error() {
		t.Errorf("Explain changed the message: %q", got)
	}
}

func TestProbeClockFarOff(t *testing.T) {
	f := newFakeCam(t)
	f.clock = -26 * time.Hour
	f.alwaysNo = true
	err := backend.Probe(context.Background(), f.cfg())
	if !errors.Is(err, httpx.ErrAuth) || !strings.Contains(err.Error(), "clock is about 26 hours off") {
		t.Fatalf("err = %v", err)
	}
}

func TestProbeNotONVIF(t *testing.T) {
	f := newFakeCam(t)
	f.html = true
	err := backend.Probe(context.Background(), f.cfg())
	if !errors.Is(err, httpx.ErrWrongService) || !strings.Contains(err.Error(), "ONVIF") {
		t.Fatalf("err = %v", err)
	}
	if !httpx.Unreachable(err) {
		t.Error("a web page instead of ONVIF should make the setup page try the next port")
	}
}

func TestWSSecurityRefusedFallsBackToHTTPLogin(t *testing.T) {
	f := newFakeCam(t)
	f.rejectWS = true
	o, _ := New(f.cfg())
	cams, err := o.Cameras(context.Background())
	if err != nil || len(cams) != 2 {
		t.Fatalf("cameras = %v, %v", cams, err)
	}
	if !o.soap.noWSSE {
		t.Error("expected WS-Security to be turned off")
	}
}

// ---- events ----

type sinkRec struct {
	mu     sync.Mutex
	events []backend.Event
}

func (s *sinkRec) OnEvent(e backend.Event) {
	s.mu.Lock()
	s.events = append(s.events, e)
	s.mu.Unlock()
}
func (s *sinkRec) OnPosition(string, float64, float64) {}

func (s *sinkRec) snapshot() []backend.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]backend.Event(nil), s.events...)
}

func TestClassifyTopic(t *testing.T) {
	for topic, want := range map[string]string{
		"tns1:RuleEngine/CellMotionDetector/Motion":           kMotion,
		"tns1:VideoSource/MotionAlarm":                        kMotion,
		"tns1:RuleEngine/MyRuleDetector/PeopleDetect":         kPerson,
		"tns1:RuleEngine/PeopleDetector/People":               kPerson,
		"tns1:RuleEngine/MyRuleDetector/VehicleDetect":        kVehicle,
		"tns1:RuleEngine/LineDetector/Crossed":                kPerimeter,
		"tns1:RuleEngine/FieldDetector/ObjectsInside":         kPerimeter,
		"tns1:RuleEngine/MyRuleDetector/DogCatDetect":         kAnimal,
		"tns1:RuleEngine/MyRuleDetector/Visitor":              kDoorbell,
		"tns1:VideoSource/ImageTooBlurry/AnalyticsService":    "",
		"tns1:Device/Trigger/DigitalInput":                    "",
		"tns1:VideoSource/GlobalSceneChange/AnalyticsService": "",
	} {
		if got := classifyTopic(topic); got != want {
			t.Errorf("%s → %q, want %q", topic, got, want)
		}
	}
}

func notifDoc(t *testing.T, msgs ...string) *node {
	t.Helper()
	doc, err := parseXML([]byte(soapOK(`<tev:PullMessagesResponse>` + strings.Join(msgs, "") + `</tev:PullMessagesResponse>`)))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func analyticsMsg(topic, source, dataName, value string) string {
	return `<wsnt:NotificationMessage><wsnt:Topic>` + topic + `</wsnt:Topic><wsnt:Message>` +
		`<tt:Message UtcTime="2024-01-01T00:00:04Z" PropertyOperation="Changed"><tt:Source><tt:SimpleItem Name="Source" Value="` + source + `"/></tt:Source>` +
		`<tt:Data><tt:SimpleItem Name="` + dataName + `" Value="` + value + `"/></tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`
}

func TestParseNotificationsAndTracker(t *testing.T) {
	doc := notifDoc(t,
		motionMsg("Initialized", "true"),
		motionMsg("Changed", "true"),
		analyticsMsg("tns1:RuleEngine/MyRuleDetector/PeopleDetect", "VideoSource_1", "State", "true"),
	)
	msgs := parseNotifications(doc)
	if len(msgs) != 3 {
		t.Fatalf("messages = %+v", msgs)
	}
	m := msgs[0]
	if m.Topic != "tns1:RuleEngine/CellMotionDetector/Motion" || m.Op != "Initialized" || len(m.Source) != 3 || m.Data[0] != (item{"IsMotion", "true"}) {
		t.Errorf("message = %+v", m)
	}

	cams := camerasFromProfiles(parseProfiles(mustParse(t, soapOK(profilesXML))))
	tr := newTracker()
	tr.cams = cams
	sink := &sinkRec{}
	t0 := time.Unix(1_700_000_000, 0)

	// The state at subscription time isn't news.
	tr.handleAt(msgs[0], t0, sink)
	if len(sink.events) != 0 {
		t.Fatalf("initialized state opened an event: %+v", sink.events)
	}
	// Motion: a detection.
	tr.handleAt(msgs[1], t0.Add(time.Second), sink)
	// A person on the same camera upgrades the same event to an alert.
	tr.handleAt(msgs[2], t0.Add(2*time.Second), sink)
	ev := sink.snapshot()
	if len(ev) != 2 || ev[0].ID != ev[1].ID || ev[0].Camera != "VideoSource_1" {
		t.Fatalf("events = %+v", ev)
	}
	if ev[0].Severity != "detection" || strings.Join(ev[0].Objects, ",") != "motion" || ev[0].End != nil {
		t.Errorf("motion event = %+v", ev[0])
	}
	if ev[1].Severity != "alert" || strings.Join(ev[1].Objects, ",") != "person" || ev[1].Start != float64(t0.Unix()+1) {
		t.Errorf("person event = %+v", ev[1])
	}

	// Falling edges: the event ends linger after the last detector went quiet, not before.
	tr.handleAt(parseNotifications(notifDoc(t, motionMsg("Changed", "false")))[0], t0.Add(5*time.Second), sink)
	tr.handleAt(parseNotifications(notifDoc(t, analyticsMsg("tns1:RuleEngine/MyRuleDetector/PeopleDetect", "VideoSource_1", "State", "false")))[0], t0.Add(6*time.Second), sink)
	tr.tick(t0.Add(10*time.Second), sink)
	if n := len(sink.snapshot()); n != 2 {
		t.Fatalf("ended too early: %d events", n)
	}
	tr.tick(t0.Add(17*time.Second), sink)
	ev = sink.snapshot()
	if len(ev) != 3 || ev[2].End == nil || *ev[2].End != float64(t0.Unix()+6) || ev[2].ID != ev[0].ID {
		t.Fatalf("end = %+v", ev)
	}

	// A line crossing on camera 2 (named by its configuration token): a momentary alert.
	tr.handleAt(parseNotifications(notifDoc(t, analyticsMsg("tns1:RuleEngine/LineDetector/Crossed", "VSC_2", "ObjectId", "12")))[0], t0.Add(20*time.Second), sink)
	tr.tick(t0.Add(31*time.Second), sink)
	ev = sink.snapshot()
	if len(ev) != 5 || ev[3].Camera != "VideoSource_2" || ev[3].Severity != "alert" || ev[4].End == nil {
		t.Fatalf("line crossing = %+v", ev[3:])
	}
	if ev[3].ID == ev[0].ID {
		t.Error("event IDs must differ")
	}

	// Unknown sources on a multi-camera device are dropped rather than guessed.
	tr.handleAt(parseNotifications(notifDoc(t, analyticsMsg("tns1:RuleEngine/CellMotionDetector/Motion", "nope", "IsMotion", "true")))[0], t0.Add(40*time.Second), sink)
	if len(sink.snapshot()) != 5 {
		t.Error("event from an unknown source")
	}
}

func mustParse(t *testing.T, s string) *node {
	t.Helper()
	n, err := parseXML([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestWatchPullPoint(t *testing.T) {
	f := newFakeCam(t)
	o, _ := New(f.cfg())
	sink := &sinkRec{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- o.Watch(ctx, sink) }()

	deadline := time.Now().Add(5 * time.Second)
	for len(sink.snapshot()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	ev := sink.snapshot()
	if len(ev) != 1 || ev[0].Camera != "VideoSource_1" || ev[0].End != nil {
		t.Fatalf("events = %+v", ev)
	}
	pull := f.body("PullMessages")
	for _, want := range []string{
		"<wsa:To>http://10.9.9.9/onvif/Subscription?Idx=7</wsa:To>",
		`<SubscriptionId xmlns="http://www.example.com/sub">7</SubscriptionId>`,
		"PullMessagesRequest</wsa:Action>",
		"<wsse:Security",
	} {
		if !strings.Contains(pull, want) {
			t.Errorf("PullMessages lacks %s:\n%s", want, pull)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("watch: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watch didn't stop")
	}
	ev = sink.snapshot()
	if len(ev) != 2 || ev[1].End == nil {
		t.Errorf("open event not ended on stop: %+v", ev)
	}
	if f.count("Unsubscribe") != 1 {
		t.Errorf("unsubscribe calls = %d", f.count("Unsubscribe"))
	}
}

func TestWatchWithoutEventService(t *testing.T) {
	o := &Onvif{st: &state{cameras: []onvifCamera{{ID: "a"}}}}
	if err := o.Watch(context.Background(), &sinkRec{}); !errors.Is(err, backend.ErrUnsupported) {
		t.Fatalf("err = %v", err)
	}
	if o.Capabilities().Alerts {
		t.Error("alerts without an event service")
	}
}

func TestAddresses(t *testing.T) {
	for _, c := range []struct {
		reported, configured string
		want                 bool
	}{
		{"192.168.1.64", "192.168.1.64", false},
		{"192.168.1.65", "192.168.1.64", false}, // a recorder's camera on the same subnet
		{"10.0.0.5", "192.168.1.64", true},
		{"127.0.0.1", "192.168.1.64", true},
		{"169.254.3.4", "192.168.1.64", true},
		{"ipcam", "192.168.1.64", true},
		{"192.168.1.64", "cam.example.com", true},
		{"fe80::1", "192.168.1.64", true},
	} {
		if got := shouldRewriteHost(c.reported, c.configured); got != c.want {
			t.Errorf("shouldRewriteHost(%s, %s) = %v", c.reported, c.configured, got)
		}
	}
	if p := xaddrPath("http://10.0.0.5:8000/onvif/Events?x=1", "/d"); p != "/onvif/Events?x=1" {
		t.Errorf("xaddrPath = %s", p)
	}
	if p := xaddrPath("http://10.0.0.5", "/d"); p != "/d" {
		t.Errorf("xaddrPath = %s", p)
	}
	if u := streamURL("rtsp://0.0.0.0/live", "192.168.1.9", "", ""); u != "rtsp://192.168.1.9/live" {
		t.Errorf("streamURL = %s", u)
	}
}

func TestMedia2Profiles(t *testing.T) {
	doc := mustParse(t, soapOK(`<tr2:GetProfilesResponse xmlns:tr2="http://www.onvif.org/ver20/media/wsdl">
<tr2:Profiles token="P0" fixed="true"><tr2:Name>Main</tr2:Name><tr2:Configurations>
<tr2:VideoSource token="VSC0"><tt:SourceToken>VS0</tt:SourceToken><tt:Bounds x="0" y="0" width="3840" height="2160"/></tr2:VideoSource>
<tr2:VideoEncoder token="VE0"><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>3840</tt:Width><tt:Height>2160</tt:Height></tt:Resolution></tr2:VideoEncoder>
<tr2:PTZ token="PTZ0"><tt:NodeToken>N0</tt:NodeToken></tr2:PTZ></tr2:Configurations></tr2:Profiles>
</tr2:GetProfilesResponse>`))
	p := parseProfiles(doc)
	if len(p) != 1 || p[0].SourceToken != "VS0" || p[0].Encoding != "H265" || p[0].Width != 3840 || !p[0].HasPTZ || p[0].PTZNode != "N0" {
		t.Fatalf("profiles = %+v", p)
	}
}
