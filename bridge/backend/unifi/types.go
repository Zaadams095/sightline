package unifi

import (
	"fmt"
	"math"
	"net"
	"net/url"
	"sort"
	"strings"

	"github.com/zachadams/sightline/bridge/backend"
)

// Wire types of the UniFi Protect private API (GET /proxy/protect/api/bootstrap, /events).
// The API is unofficial; field names follow the open-source uiprotect library used by Home
// Assistant and hjdhjd's unifi-protect, as the app's adapter (app/src/systems/unifi-protect*)
// does. Only the fields the Hub uses are decoded.

type bootstrap struct {
	LastUpdateID string   `json:"lastUpdateId"`
	NVR          nvr      `json:"nvr"`
	Cameras      []camera `json:"cameras"`
}

type nvr struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Ports   struct {
		RTSP  int `json:"rtsp"`
		RTSPS int `json:"rtsps"`
	} `json:"ports"`
	SystemInfo struct {
		Storage struct {
			Size      float64 `json:"size"`
			Used      float64 `json:"used"`
			Available float64 `json:"available"`
		} `json:"storage"`
	} `json:"systemInfo"`
}

type channel struct {
	// ID: 0 = high, 1 = medium, 2 = low, 3 = package camera (second lens on some doorbells).
	ID            int    `json:"id"`
	Name          string `json:"name"`
	Enabled       *bool  `json:"enabled"`
	IsRtspEnabled bool   `json:"isRtspEnabled"`
	RtspAlias     string `json:"rtspAlias"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
}

type stepRange struct {
	Steps struct {
		Min *float64 `json:"min"`
		Max *float64 `json:"max"`
	} `json:"steps"`
}

type camera struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	DisplayName      string    `json:"displayName"`
	MarketName       string    `json:"marketName"`
	Type             string    `json:"type"`
	State            string    `json:"state"`
	IsConnected      *bool     `json:"isConnected"`
	IsAdopted        *bool     `json:"isAdopted"`
	IsAdoptedByOther bool      `json:"isAdoptedByOther"`
	IsRecording      bool      `json:"isRecording"`
	Channels         []channel `json:"channels"`
	FeatureFlags     struct {
		IsDoorbell            *bool     `json:"isDoorbell"`
		HasChime              bool      `json:"hasChime"`
		HasSmartDetect        *bool     `json:"hasSmartDetect"`
		SmartDetectTypes      []string  `json:"smartDetectTypes"`
		SmartDetectAudioTypes []string  `json:"smartDetectAudioTypes"`
		CanOpticalZoom        bool      `json:"canOpticalZoom"`
		IsPtz                 bool      `json:"isPtz"`
		HasPackageCamera      bool      `json:"hasPackageCamera"`
		Zoom                  stepRange `json:"zoom"`
	} `json:"featureFlags"`
	IspSettings struct {
		ZoomPosition float64 `json:"zoomPosition"`
	} `json:"ispSettings"`
	RecordingSettings struct {
		// Mode is "always", "detections" (older: "motion") or "never".
		Mode            string   `json:"mode"`
		PrePaddingSecs  *float64 `json:"prePaddingSecs"`
		PostPaddingSecs *float64 `json:"postPaddingSecs"`
	} `json:"recordingSettings"`
	Stats struct {
		Video struct {
			// RecordingStart is the oldest recording kept, unix milliseconds.
			RecordingStart float64 `json:"recordingStart"`
		} `json:"video"`
	} `json:"stats"`
}

func (c *camera) adopted() bool { return (c.IsAdopted == nil || *c.IsAdopted) && !c.IsAdoptedByOther }

func (c *camera) doorbell() bool {
	if c.FeatureFlags.IsDoorbell != nil {
		return *c.FeatureFlags.IsDoorbell
	}
	return c.FeatureFlags.HasChime
}

func (c *camera) connected() bool {
	if c.IsConnected != nil {
		return *c.IsConnected
	}
	return c.State == "CONNECTED"
}

func (c *camera) displayName() string {
	for _, n := range []string{c.DisplayName, c.Name, c.MarketName} {
		if strings.TrimSpace(n) != "" {
			return n
		}
	}
	return "Camera"
}

// smartLabels maps Protect's detection types to the app's vocabulary.
var smartLabels = map[string]string{
	"person":         "person",
	"vehicle":        "vehicle",
	"car":            "vehicle",
	"animal":         "animal",
	"pet":            "animal",
	"package":        "package",
	"licensePlate":   "vehicle",
	"face":           "person",
	"alrmSmoke":      "smoke alarm",
	"alrmCmonx":      "CO alarm",
	"smoke_cmonx":    "smoke alarm",
	"alrmSiren":      "siren",
	"alrmBabyCry":    "baby crying",
	"alrmSpeak":      "speech",
	"alrmBark":       "dog barking",
	"alrmBurglar":    "burglar alarm",
	"alrmCarHorn":    "car horn",
	"alrmGlassBreak": "glass breaking",
}

func smartLabel(t string) string {
	if l, ok := smartLabels[t]; ok {
		return l
	}
	return strings.ToLower(strings.TrimPrefix(t, "alrm"))
}

func (c *camera) toCamera() backend.Camera {
	f := c.FeatureFlags
	seen := map[string]bool{}
	objects := []string{}
	add := func(o string) {
		if o != "" && !seen[o] {
			seen[o] = true
			objects = append(objects, o)
		}
	}
	add("motion")
	if f.HasSmartDetect == nil || *f.HasSmartDetect {
		for _, t := range f.SmartDetectTypes {
			add(smartLabel(t))
		}
	}
	for _, t := range f.SmartDetectAudioTypes {
		add(smartLabel(t))
	}
	if c.doorbell() {
		add("doorbell")
	}
	aspect := 16.0 / 9
	if m := c.mainChannel(); m != nil && m.Width > 0 && m.Height > 0 {
		aspect = float64(m.Width) / float64(m.Height)
	}
	return backend.Camera{
		ID: c.ID, Name: c.displayName(), Enabled: true,
		PTZ: f.IsPtz || f.CanOpticalZoom, Aspect: aspect, Zones: []string{}, Objects: objects,
	}
}

func (c *camera) mainChannel() *channel {
	for i := range c.Channels {
		if c.Channels[i].ID == 0 {
			return &c.Channels[i]
		}
	}
	if len(c.Channels) > 0 {
		return &c.Channels[0]
	}
	return nil
}

// pickChannel: main = the highest quality (id 0), sub = the lowest; RTSP-enabled channels are
// preferred. The package camera (id 3) is never chosen.
func pickChannel(c *camera, quality string) *channel {
	var chans, withRTSP []channel
	for _, ch := range c.Channels {
		if ch.ID == 3 || (ch.Enabled != nil && !*ch.Enabled) {
			continue
		}
		chans = append(chans, ch)
	}
	sort.Slice(chans, func(i, j int) bool { return chans[i].ID < chans[j].ID })
	for _, ch := range chans {
		if ch.IsRtspEnabled && ch.RtspAlias != "" {
			withRTSP = append(withRTSP, ch)
		}
	}
	pool := chans
	if len(withRTSP) > 0 {
		pool = withRTSP
	}
	if len(pool) == 0 {
		return nil
	}
	if quality == "sub" {
		return &pool[len(pool)-1]
	}
	return &pool[0]
}

// rtspURL is Protect's encrypted restream of a channel: rtsps://<console>:7441/<alias>
// (uiprotect CameraChannel.rtsps_url). The scheme is go2rtc's "rtspx": RTSPS without
// certificate verification, since every console has a self-signed certificate. The stream
// needs no credentials (the alias is the secret).
func rtspURL(host, alias string, port int) string {
	if port <= 0 {
		port = 7441
	}
	return "rtspx://" + net.JoinHostPort(host, fmt.Sprint(port)) + "/" + url.PathEscape(alias)
}

func offlineCameras(b *bootstrap) []string {
	out := []string{}
	for i := range b.Cameras {
		c := &b.Cameras[i]
		if c.adopted() && !c.connected() {
			out = append(out, c.ID)
		}
	}
	return out
}

func storageOf(b *bootstrap) []backend.Storage {
	s := b.NVR.SystemInfo.Storage
	if s.Size <= 0 {
		return []backend.Storage{}
	}
	used := s.Used
	if used == 0 {
		used = s.Size - s.Available
	}
	avail := s.Available
	if avail == 0 {
		avail = s.Size - used
	}
	return []backend.Storage{{
		Path:    "Recording drive",
		UsedPct: int(math.Round(used / s.Size * 100)),
		FreeGB:  math.Round(avail/1e9*10) / 10,
	}}
}

// ---- events ----

type event struct {
	ID               string   `json:"id"`
	Type             string   `json:"type"`
	Start            float64  `json:"start"` // ms
	End              *float64 `json:"end"`   // ms; null while in progress
	Camera           string   `json:"camera"`
	CameraID         string   `json:"cameraId"`
	SmartDetectTypes []string `json:"smartDetectTypes"`
	Metadata         *struct {
		DetectedThumbnails []struct {
			Type  string `json:"type"`
			Name  string `json:"name"`
			Group *struct {
				Name        string `json:"name"`
				MatchedName string `json:"matchedName"`
			} `json:"group"`
		} `json:"detectedThumbnails"`
		LicensePlate *struct {
			Name string `json:"name"`
		} `json:"licensePlate"`
	} `json:"metadata"`
}

// reviewTypes are the event types shown in the app (and sent as Instant Alerts).
var reviewTypes = []string{"motion", "smartDetectZone", "smartDetectLine", "smartAudioDetect", "ring"}

func (e *event) cameraID() string {
	if e.Camera != "" {
		return e.Camera
	}
	return e.CameraID
}

// toEvent normalizes a Protect event; ok is false for types the app doesn't show.
func (e *event) toEvent() (backend.Event, bool) {
	cam := e.cameraID()
	if cam == "" || e.ID == "" || e.Start <= 0 {
		return backend.Event{}, false
	}
	var objects []string
	var severity string
	switch e.Type {
	case "ring":
		// The app's doorbell call screen keys on "doorbell".
		objects, severity = []string{"doorbell"}, "alert"
	case "smartDetectZone", "smartDetectLine", "smartAudioDetect":
		seen := map[string]bool{}
		for _, t := range e.SmartDetectTypes {
			if l := smartLabel(t); !seen[l] {
				seen[l] = true
				objects = append(objects, l)
			}
		}
		if len(objects) == 0 {
			objects = []string{"motion"}
		}
		severity = "alert"
	case "motion":
		objects, severity = []string{"motion"}, "detection"
	default:
		return backend.Event{}, false
	}
	names := []string{}
	seen := map[string]bool{}
	addName := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	if m := e.Metadata; m != nil {
		for _, t := range m.DetectedThumbnails {
			switch {
			case t.Group != nil && t.Group.MatchedName != "":
				addName(t.Group.MatchedName)
			case t.Group != nil && t.Group.Name != "":
				addName(t.Group.Name)
			default:
				addName(t.Name)
			}
		}
		if m.LicensePlate != nil {
			addName(m.LicensePlate.Name)
		}
	}
	out := backend.Event{
		ID: e.ID, Camera: cam, Start: e.Start / 1000, Severity: severity,
		Objects: objects, SubLabels: names, Zones: []string{}, Detections: []string{},
	}
	if e.End != nil && *e.End > 0 {
		end := *e.End / 1000
		out.End = &end
	}
	return out, true
}

// eventsQuery is the query string for /events (milliseconds). types must be given whenever
// start/end are: Protect ignores the time range without them (uiprotect TYPES_BUG_MESSAGE).
// There is no camera filter; callers filter afterwards.
func eventsQuery(after, before float64, limit int) string {
	v := []string{
		fmt.Sprintf("start=%d", int64(math.Floor(after*1000))),
		fmt.Sprintf("end=%d", int64(math.Ceil(before*1000))),
		fmt.Sprintf("limit=%d", limit),
		"orderDirection=DESC",
	}
	for _, t := range reviewTypes {
		v = append(v, "types="+t)
	}
	return strings.Join(v, "&")
}

// exportPath is Protect's MP4 export of a window (built on request).
func exportPath(cam string, start, end float64) string {
	return fmt.Sprintf("/proxy/protect/api/video/export?camera=%s&start=%d&end=%d&channel=0",
		url.QueryEscape(cam), int64(math.Floor(start*1000)), int64(math.Ceil(end*1000)))
}

// ---- PTZ ----

type preset struct {
	Name string `json:"name"`
	Slot int    `json:"slot"`
}

// presetNames: Home first (slot -1), then the camera's saved positions, names made unique.
func presetNames(raw []preset) []preset {
	out := []preset{{Name: "Home", Slot: -1}}
	used := map[string]bool{"Home": true}
	sorted := append([]preset(nil), raw...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Slot < sorted[j].Slot })
	for _, p := range sorted {
		if p.Slot < 0 {
			continue
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = fmt.Sprintf("Preset %d", p.Slot+1)
		}
		if used[name] {
			name = fmt.Sprintf("%s (%d)", name, p.Slot+1)
		}
		used[name] = true
		out = append(out, preset{Name: name, Slot: p.Slot})
	}
	return out
}

// relativeMove: Protect PTZ only does relative steps, so each press nudges the camera
// (±1000 steps ≈ 10°). Sign convention (positive = right/up) is unverified on hardware.
func relativeMove(action string) (pan, tilt int, ok bool) {
	const step = 1000
	switch action {
	case "MOVE_LEFT":
		return -step, 0, true
	case "MOVE_RIGHT":
		return step, 0, true
	case "MOVE_UP":
		return 0, step, true
	case "MOVE_DOWN":
		return 0, -step, true
	}
	return 0, 0, false
}

// nextZoom moves a PTZ camera's zoom a tenth of its range per press (G4 PTZ: 0–2010).
func nextZoom(current float64, dir int, r stepRange) float64 {
	lo, hi := 0.0, 2010.0
	if r.Steps.Min != nil {
		lo = *r.Steps.Min
	}
	if r.Steps.Max != nil {
		hi = *r.Steps.Max
	}
	step := math.Max(1, math.Round((hi-lo)/10))
	return math.Min(hi, math.Max(lo, current+float64(dir)*step))
}

// nextOpticalZoom: non-PTZ optical-zoom cameras use ispSettings.zoomPosition (0–100).
func nextOpticalZoom(current float64, dir int) float64 {
	return math.Min(100, math.Max(0, math.Round(current+float64(dir)*10)))
}
