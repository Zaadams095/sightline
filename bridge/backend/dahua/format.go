package dahua

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/zachadams/sightline/bridge/backend"
)

// Pure helpers for the Dahua / Amcrest / Lorex CGI API, ported from the app's reviewed adapter
// (app/src/systems/dahua-format.ts). References: Amcrest HTTP API 3.2017 (Dahua CGI),
// python-amcrest (mediaFileFind workflow), rroller/dahua (Home Assistant client).

// parseKV parses Dahua's `key=value` line bodies. Whitespace inside keys is dropped (some
// firmware pads it).
func parseKV(body string) map[string]string {
	out := map[string]string{}
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.Join(strings.Fields(line[:eq]), "")
		out[key] = strings.TrimSpace(line[eq+1:])
	}
	return out
}

// isErrorBody: Dahua answers 200 with a body of `Error` for many failures.
func isErrorBody(body string) bool {
	s := strings.ToLower(strings.TrimSpace(body))
	if !strings.HasPrefix(s, "error") {
		return false
	}
	rest := s[len("error"):]
	return rest == "" || !isWordChar(rest[0])
}

func isWordChar(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}

// ---- channels ----

// channel is one camera slot. Number is 1-based (snapshot.cgi, RTSP, ptz.cgi, mediaFileFind).
type channel struct {
	Number  int
	Name    string
	Enabled bool
}

var (
	titleRe  = regexp.MustCompile(`ChannelTitle\[(\d+)\]\.Name$`)
	remoteRe = regexp.MustCompile(`NETCAMERA_INFO_(\d+)\.Enable$`)
)

// parseChannels reads `getConfig&name=ChannelTitle` (0-based table) and, on recorders,
// `getConfig&name=RemoteDevice` (marks empty slots).
func parseChannels(titles, remote map[string]string) []channel {
	names := map[int]string{}
	for k, v := range titles {
		if m := titleRe.FindStringSubmatch(k); m != nil {
			i, _ := strconv.Atoi(m[1])
			names[i] = v
		}
	}
	enabled := map[int]bool{}
	for k, v := range remote {
		if m := remoteRe.FindStringSubmatch(k); m != nil {
			i, _ := strconv.Atoi(m[1])
			enabled[i] = strings.EqualFold(v, "true")
		}
	}
	idx := make([]int, 0, len(names))
	for i := range names {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	out := make([]channel, 0, len(idx))
	for _, i := range idx {
		name := strings.TrimSpace(names[i])
		if name == "" {
			name = fmt.Sprintf("Camera %d", i+1)
		}
		en, ok := enabled[i]
		out = append(out, channel{Number: i + 1, Name: name, Enabled: !ok || en})
	}
	return out
}

// parseChannelID turns a camera ID ("3") into its channel number.
func parseChannelID(id string) (int, error) {
	n, err := strconv.Atoi(id)
	if err != nil || n < 1 || n > 1024 || strconv.Itoa(n) != id {
		return 0, backend.ErrNotFound
	}
	return n, nil
}

// ---- file search (mediaFileFind.cgi) ----

// file is one search hit. Channel is 1-based (the reply's is 0-based).
type file struct {
	Channel     int
	StartTime   string
	EndTime     string
	Type        string
	FilePath    string
	Events      []string
	Flags       []string
	VideoStream string
}

func (f file) isVideo() bool { return f.Type != "jpg" }

type findCond struct {
	Object      string
	Channel     int
	Start, End  string // device local
	Types       []string
	Flags       []string
	Events      []string
	VideoStream string
}

// findFileQuery builds `mediaFileFind.cgi?action=findFile…`. condition.Channel is 1-based.
func findFileQuery(c findCond) string {
	parts := []string{
		"action=findFile",
		"object=" + url.QueryEscape(c.Object),
		"condition.Channel=" + strconv.Itoa(c.Channel),
		"condition.StartTime=" + pathEscape(c.Start),
		"condition.EndTime=" + pathEscape(c.End),
	}
	for i, t := range c.Types {
		parts = append(parts, fmt.Sprintf("condition.Types[%d]=%s", i, pathEscape(t)))
	}
	for i, f := range c.Flags {
		parts = append(parts, fmt.Sprintf("condition.Flag[%d]=%s", i, pathEscape(f)))
	}
	for i, e := range c.Events {
		parts = append(parts, fmt.Sprintf("condition.Events[%d]=%s", i, pathEscape(e)))
	}
	if c.VideoStream != "" {
		parts = append(parts, "condition.VideoStream="+pathEscape(c.VideoStream))
	}
	return strings.Join(parts, "&")
}

// pathEscape is encodeURIComponent: spaces as %20 (Dahua doesn't read '+').
func pathEscape(s string) string { return url.PathEscape(s) }

var digitsRe = regexp.MustCompile(`^\d+$`)

// parseFinderID reads `factory.create` → `result=2086170840`.
func parseFinderID(body string) string {
	v := parseKV(body)["result"]
	if digitsRe.MatchString(v) {
		return v
	}
	return ""
}

var itemRe = regexp.MustCompile(`^items\[(\d+)\]\.(\w+)(?:\[(\d+)\])?$`)

// parseFindNext reads a `findNextFile` reply: `found=N` then `items[i].Field=…`.
func parseFindNext(body string) (found int, files []file) {
	kv := parseKV(body)
	found, _ = strconv.Atoi(kv["found"])
	type arr struct{ events, flags map[int]string }
	fields := map[int]map[string]string{}
	arrays := map[int]*arr{}
	for k, v := range kv {
		m := itemRe.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		i, _ := strconv.Atoi(m[1])
		if m[3] != "" {
			j, _ := strconv.Atoi(m[3])
			a := arrays[i]
			if a == nil {
				a = &arr{events: map[int]string{}, flags: map[int]string{}}
				arrays[i] = a
			}
			switch m[2] {
			case "Events":
				a.events[j] = v
			case "Flags", "Flag":
				a.flags[j] = v
			}
			continue
		}
		if fields[i] == nil {
			fields[i] = map[string]string{}
		}
		fields[i][m[2]] = v
	}
	idx := make([]int, 0, len(fields))
	for i := range fields {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	ordered := func(m map[int]string) []string {
		keys := make([]int, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Ints(keys)
		out := make([]string, 0, len(keys))
		for _, k := range keys {
			out = append(out, m[k])
		}
		return out
	}
	for _, i := range idx {
		f := fields[i]
		if f["StartTime"] == "" || f["EndTime"] == "" {
			continue
		}
		ch, _ := strconv.Atoi(f["Channel"])
		fl := file{
			Channel: ch + 1, StartTime: f["StartTime"], EndTime: f["EndTime"],
			Type: strings.ToLower(f["Type"]), FilePath: f["FilePath"], VideoStream: f["VideoStream"],
		}
		if a := arrays[i]; a != nil {
			fl.Events, fl.Flags = ordered(a.events), ordered(a.flags)
		}
		files = append(files, fl)
	}
	return found, files
}

// filesToSegments merges video files into recording spans (unix seconds); gaps up to gap
// seconds are joined.
func filesToSegments(files []file, c clock, gap float64) []backend.Segment {
	var spans []backend.Segment
	for _, f := range files {
		if !f.isVideo() {
			continue
		}
		s, ok1 := c.fromDevice(f.StartTime)
		e, ok2 := c.fromDevice(f.EndTime)
		if ok1 && ok2 && e > s {
			spans = append(spans, backend.Segment{Start: s, End: e})
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].Start < spans[j].Start })
	var out []backend.Segment
	for _, s := range spans {
		if n := len(out); n > 0 && s.Start-out[n-1].End <= gap {
			out[n-1].End = math.Max(out[n-1].End, s.End)
			continue
		}
		out = append(out, s)
	}
	return out
}

// ---- events ----

// eventLabels maps Dahua event codes found on recordings (and in the live event stream) to
// brand-neutral objects. Unknown codes are ignored.
var eventLabels = map[string]string{
	"SmartMotionHuman":     "person",
	"HumanTrait":           "person",
	"FaceDetection":        "person",
	"FaceRecognition":      "person",
	"SmartMotionVehicle":   "vehicle",
	"VehicleDetection":     "vehicle",
	"TrafficJunction":      "vehicle",
	"TrafficParking":       "vehicle",
	"ParkingDetection":     "vehicle",
	"VideoMotion":          "motion",
	"MotionDetect":         "motion",
	"CrossLineDetection":   "motion",
	"CrossRegionDetection": "motion",
	"AlarmLocal":           "alarm",
	"AudioMutation":        "sound",
	"AudioAnomaly":         "sound",
	"DoorBell":             "doorbell",
	"BackKeyLight":         "doorbell",
	"CallNoAnswered":       "doorbell",
	"PhoneCallDetect":      "doorbell",
	"Invite":               "doorbell",
}

// Perimeter rules (tripwire / intrusion) are deliberate user setups, so they count as alerts.
var alertCodes = map[string]bool{"CrossLineDetection": true, "CrossRegionDetection": true, "AlarmLocal": true}
var alertLabels = map[string]bool{"person": true, "vehicle": true, "doorbell": true}

// summarize turns a set of objects into what's shown (motion next to a real object adds
// nothing) and a severity.
func summarize(objects []string, alertCode bool) ([]string, string) {
	shown := uniq(objects)
	if len(shown) > 1 {
		shown = without(shown, "motion")
	}
	sev := "detection"
	if alertCode {
		sev = "alert"
	}
	for _, o := range shown {
		if alertLabels[o] {
			sev = "alert"
		}
	}
	return shown, sev
}

// classifyCodes maps recording event codes to objects and a severity (ok=false: not an event).
func classifyCodes(codes []string) (objects []string, severity string, ok bool) {
	alert := false
	for _, c := range codes {
		if l := eventLabels[c]; l != "" {
			objects = append(objects, l)
		}
		alert = alert || alertCodes[c]
	}
	if len(objects) == 0 {
		return nil, "", false
	}
	objects, severity = summarize(objects, alert)
	return objects, severity, true
}

// eventID is "<channel>@<unix start>", with an optional "-<tag>" (doorbell rings).
func eventID(ch int, start float64, tag string) string {
	id := fmt.Sprintf("%d@%d", ch, int64(start))
	if tag != "" {
		id += "-" + tag
	}
	return id
}

var eventIDRe = regexp.MustCompile(`^(\d+)@(\d+)(?:-([a-z]+))?$`)

func parseEventID(id string) (ch int, start float64, err error) {
	m := eventIDRe.FindStringSubmatch(id)
	if m == nil {
		return 0, 0, backend.ErrNotFound
	}
	if ch, err = parseChannelID(m[1]); err != nil {
		return 0, 0, err
	}
	s, _ := strconv.ParseInt(m[2], 10, 64)
	return ch, float64(s), nil
}

// filesToEvents turns event-triggered recordings into events, newest first. Main and sub-stream
// copies of the same event (same channel + start) are kept once.
func filesToEvents(files []file, c clock) []backend.Event {
	seen := map[string]bool{}
	var out []backend.Event
	for _, f := range files {
		if !f.isVideo() {
			continue
		}
		objects, sev, ok := classifyCodes(f.Events)
		if !ok {
			continue
		}
		start, ok := c.fromDevice(f.StartTime)
		if !ok {
			continue
		}
		id := eventID(f.Channel, start, "")
		if seen[id] {
			continue
		}
		seen[id] = true
		ev := backend.Event{
			ID: id, Camera: strconv.Itoa(f.Channel), Start: start, Severity: sev,
			Objects: objects, SubLabels: []string{}, Zones: []string{}, Detections: []string{},
		}
		if end, ok := c.fromDevice(f.EndTime); ok {
			ev.End = &end
		}
		out = append(out, ev)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	return out
}

// ---- PTZ ----

// ptzCode maps the Hub's actions to `ptz.cgi?action=start|stop&code=…` (Amcrest HTTP API §4.10.7).
func ptzCode(action string) string {
	switch action {
	case "MOVE_UP":
		return "Up"
	case "MOVE_DOWN":
		return "Down"
	case "MOVE_LEFT":
		return "Left"
	case "MOVE_RIGHT":
		return "Right"
	case "ZOOM_IN":
		return "ZoomTele"
	case "ZOOM_OUT":
		return "ZoomWide"
	case "FOCUS_IN":
		return "FocusNear"
	case "FOCUS_OUT":
		return "FocusFar"
	}
	return ""
}

type preset struct {
	Index int
	Name  string
}

var presetRe = regexp.MustCompile(`presets\[(\d+)\]\.(Index|Name)$`)

// parsePresets reads `ptz.cgi?action=getPresets`. Names are made unique.
func parsePresets(kv map[string]string) []preset {
	type entry struct {
		index int
		name  string
	}
	byIdx := map[int]*entry{}
	for k, v := range kv {
		m := presetRe.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		i, _ := strconv.Atoi(m[1])
		e := byIdx[i]
		if e == nil {
			e = &entry{}
			byIdx[i] = e
		}
		if m[2] == "Index" {
			e.index, _ = strconv.Atoi(v)
		} else {
			e.name = v
		}
	}
	keys := make([]int, 0, len(byIdx))
	for k := range byIdx {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	used := map[string]bool{}
	out := []preset{}
	for _, k := range keys {
		e := byIdx[k]
		if e.index <= 0 {
			continue
		}
		name := strings.TrimSpace(e.name)
		if name == "" {
			name = fmt.Sprintf("Preset %d", e.index)
		}
		if used[name] {
			name = fmt.Sprintf("%s (%d)", name, e.index)
		}
		used[name] = true
		out = append(out, preset{Index: e.index, Name: name})
	}
	return out
}

// parsePTZCaps reads `ptz.cgi?action=getCurrentProtocolCaps` ("Tile" is Dahua's spelling).
func parsePTZCaps(kv map[string]string) (canMove, canZoom bool) {
	t := func(k string) bool { return strings.EqualFold(kv["caps."+k], "true") }
	return t("Pan") || t("Tile") || t("Tilt"), t("Zoom")
}

// ---- health ----

var eventChanRe = regexp.MustCompile(`^channels\[\d+\]$`)

// parseEventChannels reads `getEventIndexes&code=VideoLoss` (0-based) → 1-based channels.
func parseEventChannels(body string) []int {
	if isErrorBody(body) {
		return nil
	}
	var out []int
	for k, v := range parseKV(body) {
		if !eventChanRe.MatchString(k) {
			continue
		}
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			out = append(out, n+1)
		}
	}
	sort.Ints(out)
	return out
}

var storageRe = regexp.MustCompile(`^list(?:\.info)?\[(\d+)\]\.Detail\[(\d+)\]\.(Path|TotalBytes|UsedBytes)$`)

// parseStorage reads `storageDevice.cgi?action=getDeviceAllInfo`.
func parseStorage(kv map[string]string) []backend.Storage {
	type part struct {
		disk        int
		path        string
		total, used float64
	}
	parts := map[string]*part{}
	for k, v := range kv {
		m := storageRe.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		key := m[1] + "/" + m[2]
		p := parts[key]
		if p == nil {
			d, _ := strconv.Atoi(m[1])
			p = &part{disk: d}
			parts[key] = p
		}
		switch m[3] {
		case "Path":
			p.path = v
		case "TotalBytes":
			p.total, _ = strconv.ParseFloat(v, 64)
		case "UsedBytes":
			p.used, _ = strconv.ParseFloat(v, 64)
		}
	}
	keys := make([]string, 0, len(parts))
	for k := range parts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []backend.Storage{}
	for _, k := range keys {
		p := parts[k]
		if p.total <= 0 {
			continue
		}
		path := p.path
		if path == "" {
			path = fmt.Sprintf("Disk %d", p.disk+1)
		}
		out = append(out, backend.Storage{
			Path:    path,
			UsedPct: int(math.Round(p.used / p.total * 100)),
			FreeGB:  math.Round((p.total-p.used)/1e9*10) / 10,
		})
	}
	return out
}

// ---- URLs ----

// rtspURL points straight at the device; credentials are percent-encoded (passwords often
// contain @ or #).
func rtspURL(host string, port int, user, pass, path string) string {
	auth := ""
	if user != "" {
		auth = userinfoEscape(user) + ":" + userinfoEscape(pass) + "@"
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("rtsp://%s%s:%d%s", auth, host, port, path)
}

// userinfoEscape is encodeURIComponent: everything but unreserved characters is escaped.
func userinfoEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// livePath: subtype 0 = main stream, 1 = sub stream.
func livePath(ch int, quality string) string {
	sub := 0
	if quality == "sub" {
		sub = 1
	}
	return fmt.Sprintf("/cam/realmonitor?channel=%d&subtype=%d", ch, sub)
}

// playbackPath: `/cam/playback?channel=N&starttime=YYYY_MM_DD_HH_MM_SS&endtime=…`, device local.
func playbackPath(ch int, start, end float64, c clock) string {
	return fmt.Sprintf("/cam/playback?channel=%d&starttime=%s&endtime=%s", ch, c.playbackTime(start), c.playbackTime(end))
}

// fileURLPath serves a found file by its device path (RPC_Loadfile, Amcrest HTTP API §4.11.6).
func fileURLPath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return "/cgi-bin/RPC_Loadfile" + strings.NewReplacer("%", "%25", " ", "%20", "#", "%23", "?", "%3F").Replace(p)
}

// ---- small helpers ----

func uniq(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func without(in []string, drop string) []string {
	out := in[:0:0]
	for _, s := range in {
		if s != drop {
			out = append(out, s)
		}
	}
	return out
}
