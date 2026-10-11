package reolink

// Wire types and pure helpers for the Reolink HTTP API (/cgi-bin/api.cgi). Ported from the
// app's reviewed adapter (app/src/systems/reolink-parse.ts), which cites its sources:
// Reolink's "Camera HTTP API User Guide" and reolink_aio (the library behind Home Assistant's
// Reolink integration).

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// num accepts a JSON number or a numeric string (Reolink sends both, e.g. "size":"113246208").
// Anything else reads as 0.
type num float64

func (n *num) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		f = 0
	}
	*n = num(f)
	return nil
}

func (n num) Int() int { return int(n) }

// item is one command's result in a response array.
type item struct {
	Cmd   string          `json:"cmd"`
	Code  num             `json:"code"`
	Value json.RawMessage `json:"value"`
	Error *struct {
		Detail  string `json:"detail"`
		RspCode num    `json:"rspCode"`
	} `json:"error"`
}

func (it *item) ok() bool { return it != nil && it.Code == 0 }

func (it *item) detail() string {
	if it == nil || it.Error == nil {
		return ""
	}
	return it.Error.Detail
}

func (it *item) rspCode() int {
	if it == nil || it.Error == nil {
		return 0
	}
	return it.Error.RspCode.Int()
}

// command is one entry of a request array.
type command struct {
	Cmd    string `json:"cmd"`
	Action int    `json:"action"`
	Param  any    `json:"param"`
}

func cmd(name string, param any) command {
	if param == nil {
		param = map[string]any{}
	}
	return command{Cmd: name, Param: param}
}

func chParam(ch int) map[string]any { return map[string]any{"channel": ch} }

// ---------------------------------------------------------------------------------------------
// Errors

// Error is a failed command, in plain words. It unwraps to httpx.ErrAuth, backend.ErrUnsupported
// etc. where that applies, so the Hub can react to the kind of failure.
type Error struct {
	msg string
	err error
}

func (e *Error) Error() string { return e.msg }
func (e *Error) Unwrap() error { return e.err }

// loginExpired: rspCode -6 / "please login first" means the token expired or the device rebooted.
func loginExpired(it *item) bool {
	if it == nil || it.ok() {
		return false
	}
	return it.rspCode() == -6 || strings.Contains(strings.ToLower(it.detail()), "please login first")
}

var badLoginRe = regexp.MustCompile(`invalid user|login failed|password wrong`)

// commandError turns a failed command into a plain-language error (fragments, as the Hub
// prefixes them: "Couldn't connect to …: <error>").
func commandError(it *item) error {
	detail := strings.ToLower(it.detail())
	switch {
	case strings.Contains(detail, "locked"):
		return &Error{"the Reolink device has locked this account after too many wrong passwords. Wait a few minutes, then try again", httpx.ErrAuth}
	case badLoginRe.MatchString(detail):
		return &Error{"the username or password is wrong", httpx.ErrAuth}
	case strings.Contains(detail, "max session"):
		return &Error{"too many apps are signed in to the Reolink device. Close the Reolink app or web page on other phones and computers, then try again", nil}
	case loginExpired(it):
		return &Error{"the Reolink device signed the Hub out. Try again", nil}
	case strings.Contains(detail, "ability") || strings.Contains(detail, "not support") || it.rspCode() == -9:
		return &Error{"this Reolink device doesn't support that", backend.ErrUnsupported}
	case it == nil:
		return &Error{"the Reolink device sent an unexpected reply", httpx.ErrBadAnswer}
	case it.detail() != "":
		return &Error{"the Reolink device couldn't do that (" + it.detail() + ")", nil}
	}
	return &Error{"the Reolink device couldn't do that", nil}
}

// ---------------------------------------------------------------------------------------------
// Time

// wall is Reolink's date/time object (Search, GetTime, NvrDownload). Month is 1-based.
type wall struct {
	Year num `json:"year"`
	Mon  num `json:"mon"`
	Day  num `json:"day"`
	Hour num `json:"hour"`
	Min  num `json:"min"`
	Sec  num `json:"sec"`
}

type wallOut struct {
	Year int `json:"year"`
	Mon  int `json:"mon"`
	Day  int `json:"day"`
	Hour int `json:"hour"`
	Min  int `json:"min"`
	Sec  int `json:"sec"`
}

func (w wall) time(loc *time.Location) time.Time {
	return time.Date(w.Year.Int(), time.Month(w.Mon.Int()), w.Day.Int(), w.Hour.Int(), w.Min.Int(), w.Sec.Int(), 0, loc)
}

func toWall(t time.Time) wallOut {
	return wallOut{t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second()}
}

// compactTime is the start= format of the Playback/Download commands ("20240317153000").
func compactTime(t time.Time) string { return t.Format("20060102150405") }

// deviceZone turns the device's current local time into a time zone. Reolink reports
// recordings in the device's local time. The offset is rounded to 15 minutes (absorbs a
// slightly wrong device clock). When it equals the Hub's own current offset, the Hub's zone is
// used (it knows past DST changes); otherwise a fixed offset.
func deviceZone(deviceNow wall, now time.Time, local *time.Location) *time.Location {
	asUTC := deviceNow.time(time.UTC)
	offsetMin := int(math.Round(asUTC.Sub(now).Minutes()/15)) * 15
	if _, off := now.In(local).Zone(); off == offsetMin*60 {
		return local
	}
	return time.FixedZone(fmt.Sprintf("device%+d", offsetMin), offsetMin*60)
}

// dayChunks splits [after, before] into device-local calendar days, newest first (Search works
// per day). At most maxDays chunks.
func dayChunks(after, before float64, loc *time.Location, maxDays int) [][2]time.Time {
	a, e := int64(math.Floor(after)), int64(math.Floor(before))
	var out [][2]time.Time
	for e > a && len(out) < maxDays {
		w := time.Unix(e, 0).In(loc)
		dayStart := time.Date(w.Year(), w.Month(), w.Day(), 0, 0, 0, 0, loc).Unix()
		from := max(a, dayStart)
		out = append(out, [2]time.Time{time.Unix(from, 0).In(loc), w})
		e = dayStart - 1
	}
	return out
}

// ---------------------------------------------------------------------------------------------
// Device and channels

type devInfoValue struct {
	DevInfo struct {
		Name       string `json:"name"`
		Model      string `json:"model"`
		ChannelNum num    `json:"channelNum"`
		ExactType  string `json:"exactType"`
		Type       string `json:"type"`
	} `json:"DevInfo"`
}

type devInfo struct {
	Name       string
	Model      string
	ChannelNum int
	// NVRs and the Home Hub: several channels, and the Download command for files.
	IsNVR bool
	IsHub bool
}

// parseDevInfo: reolink_aio treats exactType/type NVR, WIFI_NVR and HOMEHUB as recorders.
func parseDevInfo(raw json.RawMessage) devInfo {
	var v devInfoValue
	_ = json.Unmarshal(raw, &v)
	d := v.DevInfo
	exact := strings.ToUpper(firstNonEmpty(d.ExactType, d.Type, "IPC"))
	typ := strings.ToUpper(firstNonEmpty(d.Type, "IPC"))
	isRec := func(s string) bool { return s == "NVR" || s == "WIFI_NVR" || s == "HOMEHUB" }
	name := strings.TrimSpace(d.Name)
	if name == "" {
		name = firstNonEmpty(d.Model, "Reolink")
	}
	return devInfo{
		Name:       name,
		Model:      d.Model,
		ChannelNum: max(1, d.ChannelNum.Int()),
		IsNVR:      isRec(exact) || isRec(typ),
		IsHub:      exact == "HOMEHUB" || typ == "HOMEHUB",
	}
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

type channelStatusValue struct {
	Status []struct {
		Channel  num    `json:"channel"`
		Name     string `json:"name"`
		Online   num    `json:"online"`
		TypeInfo string `json:"typeInfo"`
	} `json:"status"`
}

type channel struct {
	Ch     int
	Name   string
	Online bool
	// Doorbell is a video doorbell (from the model / typeInfo), so rings work whatever it's named.
	Doorbell bool
}

var doorbellRe = regexp.MustCompile(`(?i)doorbell|^D3\d\d`)

// isDoorbellModel: "Reolink Video Doorbell …" or model D340P/D340W.
func isDoorbellModel(model string) bool { return doorbellRe.MatchString(strings.TrimSpace(model)) }

// parseChannels lists a device's cameras. A single camera is channel 0. NVR/Hub: channels from
// GetChannelstatus. Empty slots report online 0 and are skipped (as reolink_aio does); an
// offline channel is kept when it has a camera model (typeInfo) or was online before (known),
// so Health can say it went offline.
func parseChannels(dev devInfo, raw json.RawMessage, known map[int]bool) []channel {
	if !dev.IsNVR {
		return []channel{{Ch: 0, Name: dev.Name, Online: true, Doorbell: isDoorbellModel(dev.Model)}}
	}
	var v channelStatusValue
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &v)
	}
	if len(v.Status) == 0 {
		out := make([]channel, dev.ChannelNum)
		for i := range out {
			out[i] = channel{Ch: i, Name: fmt.Sprintf("Camera %d", i+1), Online: true}
		}
		return out
	}
	var out []channel
	for _, s := range v.Status {
		ch := s.Channel.Int()
		online := s.Online == 1
		if !online && !known[ch] && strings.TrimSpace(s.TypeInfo) == "" {
			continue
		}
		name := strings.TrimSpace(s.Name)
		if name == "" {
			name = fmt.Sprintf("Camera %d", ch+1)
		}
		out = append(out, channel{Ch: ch, Name: name, Online: online, Doorbell: isDoorbellModel(s.TypeInfo)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ch < out[j].Ch })
	return out
}

// ability is GetAbility's per-channel capability table.
type ability struct {
	Ability struct {
		AbilityChn []map[string]json.RawMessage `json:"abilityChn"`
	} `json:"Ability"`
}

// ver is a channel's capability version (0 when missing).
func (a *ability) ver(ch int, key string) int {
	if a == nil {
		return 0
	}
	chn := a.Ability.AbilityChn
	var entry map[string]json.RawMessage
	switch {
	case ch >= 0 && ch < len(chn):
		entry = chn[ch]
	case len(chn) == 1:
		entry = chn[0]
	}
	var v struct {
		Ver num `json:"ver"`
	}
	if raw, ok := entry[key]; ok {
		_ = json.Unmarshal(raw, &v)
	}
	return v.Ver.Int()
}

// ptzSupport from ptzType (reolink_aio): 1/2/5 can zoom, 2/3/5/6/7 can pan and tilt.
func (a *ability) ptzSupport(ch int) (canMove, canZoom bool) {
	switch a.ver(ch, "ptzType") {
	case 1:
		return false, true
	case 2, 5:
		return true, true
	case 3, 6, 7:
		return true, false
	}
	return false, false
}

// netPort is GetNetPort's answer, kept raw so SetNetPort can send it back with only RTSP changed.
type netPort struct {
	RTSPPort    int
	RTSPEnabled bool
	raw         map[string]any
}

func parseNetPort(raw json.RawMessage) *netPort {
	var v struct {
		NetPort struct {
			RTSPPort   num  `json:"rtspPort"`
			RTSPEnable *num `json:"rtspEnable"`
		} `json:"NetPort"`
	}
	_ = json.Unmarshal(raw, &v)
	n := &netPort{RTSPPort: v.NetPort.RTSPPort.Int(), RTSPEnabled: v.NetPort.RTSPEnable == nil || *v.NetPort.RTSPEnable == 1}
	if n.RTSPPort == 0 {
		n.RTSPPort = 554
	}
	_ = json.Unmarshal(raw, &n.raw)
	return n
}

// enableRTSP is the SetNetPort command turning RTSP on, every other port setting unchanged.
func (n *netPort) enableRTSP() command {
	param := map[string]any{}
	for k, v := range n.raw {
		param[k] = v
	}
	np := map[string]any{}
	if m, ok := param["NetPort"].(map[string]any); ok {
		for k, v := range m {
			np[k] = v
		}
	}
	np["rtspEnable"] = 1
	param["NetPort"] = np
	return cmd("SetNetPort", param)
}

type streamInfo struct {
	VType  string `json:"vType"`
	Width  num    `json:"width"`
	Height num    `json:"height"`
}

func (s streamInfo) codec() string {
	if strings.EqualFold(s.VType, "h265") {
		return "h265"
	}
	return "h264"
}

type encValue struct {
	Enc struct {
		Main streamInfo `json:"mainStream"`
		Sub  streamInfo `json:"subStream"`
	} `json:"Enc"`
}

// rtspPaths from GetRtspUrl (newer firmware): "/Preview_01_main".
func parseRTSPPaths(raw json.RawMessage) (main, sub string) {
	var v struct {
		RTSPURL struct {
			Main string `json:"mainStream"`
			Sub  string `json:"subStream"`
		} `json:"rtspUrl"`
	}
	_ = json.Unmarshal(raw, &v)
	return rtspPath(v.RTSPURL.Main), rtspPath(v.RTSPURL.Sub)
}

var rtspURLRe = regexp.MustCompile(`(?i)^rtsps?://[^/]+(/.*)$`)

func rtspPath(u string) string {
	if m := rtspURLRe.FindStringSubmatch(u); m != nil {
		return m[1]
	}
	return ""
}

// defaultRTSPPath is the classic path, /h264Preview_01_main (channels count from 01). H.265
// cameras use h265Preview_… (reolink_aio picks the prefix from GetEnc's vType).
func defaultRTSPPath(ch int, quality, codec string) string {
	return fmt.Sprintf("/%sPreview_%02d_%s", codec, ch+1, quality)
}

// ---------------------------------------------------------------------------------------------
// PTZ

var ptzOps = map[string]string{
	"MOVE_UP": "Up", "MOVE_DOWN": "Down", "MOVE_LEFT": "Left", "MOVE_RIGHT": "Right",
	"ZOOM_IN": "ZoomInc", "ZOOM_OUT": "ZoomDec", "FOCUS_IN": "FocusInc", "FOCUS_OUT": "FocusDec",
	"STOP": "Stop",
}

const ptzSpeed = 32

// ptzCommand is PtzCtrl. Speed only applies to moves; id to presets (ToPos).
func ptzCommand(ch int, op string, id int) command {
	p := map[string]any{"channel": ch, "op": op}
	switch op {
	case "Up", "Down", "Left", "Right", "ToPos":
		p["speed"] = ptzSpeed
	}
	if op == "ToPos" {
		p["id"] = id
	}
	return cmd("PtzCtrl", p)
}

// preset is one enabled PTZ preset.
type preset struct {
	Name string
	ID   int
}

// parsePresets: GetPtzPreset → enabled presets, in device order, first of each name.
func parsePresets(raw json.RawMessage) []preset {
	var v struct {
		PtzPreset []struct {
			Enable num    `json:"enable"`
			ID     num    `json:"id"`
			Name   string `json:"name"`
		} `json:"PtzPreset"`
	}
	_ = json.Unmarshal(raw, &v)
	seen := map[string]bool{}
	var out []preset
	for _, p := range v.PtzPreset {
		if p.Enable != 1 {
			continue
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = fmt.Sprintf("Preset %d", p.ID.Int())
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, preset{Name: name, ID: p.ID.Int()})
		}
	}
	return out
}

// ---------------------------------------------------------------------------------------------
// Recordings

func searchCommand(ch int, from, to time.Time) command {
	return cmd("Search", map[string]any{"Search": map[string]any{
		"channel": ch, "onlyStatus": 0, "streamType": "main",
		"StartTime": toWall(from), "EndTime": toWall(to),
	}})
}

// trigger flags decoded from a recording file name.
type trigger struct {
	Person, Vehicle, Animal, Timer, Motion, Doorbell, Package bool
}

// vodFile is one recording file.
type vodFile struct {
	Start, End float64 // unix seconds
	// Name is the device's file name (cameras, Home Hub, newer NVRs). Older NVRs omit it.
	Name string
	// StartWall/EndWall are device-local, needed by NvrDownload and the start= parameter.
	StartWall, EndWall time.Time
	// Triggers is nil when the file name carries no flags.
	Triggers *trigger
}

// Bit positions (MSB-first) of the flags in the file name's hex field (reolink_aio typings.py).
var (
	flagsCam   = map[string]int{"person": 17, "vehicle": 19, "animal": 20, "timer": 23, "motion": 24, "doorbell": 26}
	flagsHubV0 = map[string]int{"person": 17, "vehicle": 19, "animal": 20, "timer": 23, "motion": 24, "doorbell": 26, "package": 37}
	flagsHubV2 = map[string]int{"person": 17, "vehicle": 19, "animal": 20, "timer": 24, "motion": 25, "doorbell": 27, "package": 37}
	hexRe      = regexp.MustCompile(`^[0-9a-fA-F]+$`)
)

// parseVodName decodes the trigger flags in a recording file name, e.g.
//
//	Mp4Record/2020-12-22/RecM01_20201222_075939_080140_6D28808_1A468F9.mp4   (camera)
//	RecS07_20250219_111146_111238_0_A714C0A000_21E67C.mp4                    (camera, newer)
//	…/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4       (Home Hub)
//
// Format reverse-engineered in https://github.com/sven337/ReolinkLinux/wiki/Figuring-out-the-file-names
// and implemented in reolink_aio's parse_file_name/decode_hex_to_flags.
func parseVodName(name string) *trigger {
	dot := strings.LastIndex(name, ".")
	if dot < 0 {
		return nil
	}
	base := name[:dot]
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	parts := strings.Split(base, "_")
	if !strings.HasPrefix(parts[0], "Rec") || len(parts[0]) != 6 {
		return nil
	}
	version, _ := strconv.ParseInt(parts[0][4:6], 16, 32)
	var hex string
	var flags map[string]int
	switch len(parts) {
	case 6:
		hex, flags = parts[4], flagsCam
	case 7:
		hex, flags = parts[5], flagsCam
	case 9:
		hex, flags = parts[7], flagsHubV0
		if version >= 2 {
			flags = flagsHubV2
		}
	default:
		return nil
	}
	if !hexRe.MatchString(hex) {
		return nil
	}
	var bits strings.Builder
	for _, c := range hex {
		d, _ := strconv.ParseUint(string(c), 16, 8)
		fmt.Fprintf(&bits, "%04b", d)
	}
	b := bits.String()
	bit := func(k string) bool {
		i, ok := flags[k]
		return ok && i < len(b) && b[i] == '1'
	}
	return &trigger{
		Person: bit("person"), Vehicle: bit("vehicle"), Animal: bit("animal"), Timer: bit("timer"),
		Motion: bit("motion"), Doorbell: bit("doorbell"), Package: bit("package"),
	}
}

type searchValue struct {
	SearchResult struct {
		File []struct {
			StartTime *wall  `json:"StartTime"`
			EndTime   *wall  `json:"EndTime"`
			Name      string `json:"name"`
		} `json:"File"`
	} `json:"SearchResult"`
}

// parseSearchFiles: Search (onlyStatus 0) → recording files, oldest first.
func parseSearchFiles(raw json.RawMessage, loc *time.Location) []vodFile {
	var v searchValue
	_ = json.Unmarshal(raw, &v)
	var out []vodFile
	for _, f := range v.SearchResult.File {
		if f.StartTime == nil || f.EndTime == nil || f.StartTime.Year == 0 || f.EndTime.Year == 0 {
			continue
		}
		s, e := f.StartTime.time(loc), f.EndTime.time(loc)
		vf := vodFile{Start: float64(s.Unix()), End: float64(e.Unix()), Name: f.Name, StartWall: s, EndWall: e}
		if f.Name != "" {
			vf.Triggers = parseVodName(f.Name)
		}
		out = append(out, vf)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

// mergeSegments joins files into continuous spans (Reolink splits recordings into files).
func mergeSegments(files []vodFile, tolerance float64) []backend.Segment {
	sorted := append([]vodFile(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	spans := []backend.Segment{}
	for _, f := range sorted {
		if f.End <= f.Start {
			continue
		}
		if n := len(spans); n > 0 && f.Start-spans[n-1].End <= tolerance {
			spans[n-1].End = max(spans[n-1].End, f.End)
			continue
		}
		spans = append(spans, backend.Segment{Start: f.Start, End: f.End})
	}
	return spans
}

// fileCache is the files from one search of a camera and what that search covered.
type fileCache struct {
	After, Before float64 // searched span
	At            float64 // when the search ran: later recordings can't be in it
	Files         []vodFile
}

// covers: a cached search can say which file plays at start (for a window up to end) when a
// cached file contains start, or the search covered the whole window (and had already happened
// by end). Otherwise a stale list could open the wrong recording.
func (c *fileCache) covers(start, end float64) bool {
	if c == nil {
		return false
	}
	for _, f := range c.Files {
		if f.Start <= start && start < f.End {
			return true
		}
	}
	return c.After <= start && min(c.Before, c.At) >= end
}

// fileAt is the file to play for a moment: the one containing t, else the next one before until.
func fileAt(files []vodFile, t, until float64) *vodFile {
	sorted := append([]vodFile(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	for i := range sorted {
		if sorted[i].Start <= t && t < sorted[i].End {
			return &sorted[i]
		}
	}
	for i := range sorted {
		if sorted[i].Start >= t && sorted[i].Start < until {
			return &sorted[i]
		}
	}
	return nil
}

// fileEventID is a recording-based event's ID: "<channel>-<start unix seconds>".
func fileEventID(ch int, start float64) string { return fmt.Sprintf("%d-%d", ch, int64(start)) }

// fileEvent turns a motion/AI-triggered file into an event. Schedule-only (continuous)
// recordings and files whose names carry no flags are not events.
func fileEvent(ch int, f vodFile) (backend.Event, bool) {
	t := f.Triggers
	if t == nil {
		return backend.Event{}, false
	}
	var objects []string
	for _, o := range []struct {
		on   bool
		name string
	}{{t.Person, "person"}, {t.Vehicle, "vehicle"}, {t.Animal, "animal"}, {t.Package, "package"}, {t.Doorbell, "doorbell"}} {
		if o.on {
			objects = append(objects, o.name)
		}
	}
	if len(objects) == 0 && !t.Motion {
		return backend.Event{}, false
	}
	end := f.End
	return backend.Event{
		ID: fileEventID(ch, f.Start), Camera: strconv.Itoa(ch), Start: f.Start, End: &end,
		Severity: severity(objects), Objects: nonNil(objects), SubLabels: []string{}, Zones: []string{},
		Detections: []string{},
	}, true
}

func severity(objects []string) string {
	if len(objects) > 0 {
		return "alert"
	}
	return "detection"
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// vodPath streams one recording file as MP4: Download on NVRs/Home Hub, Playback on cameras
// (the same choice as Home Assistant's media_source.py). Both honor HTTP Range.
func vodPath(fileName string, startWall time.Time, nvr bool, token string) string {
	c := "Playback"
	if nvr {
		c = "Download"
	}
	start := compactTime(startWall)
	source := strings.ReplaceAll(fileName, " ", "%20")
	source = strings.ReplaceAll(source, "&", "%26")
	return fmt.Sprintf("/cgi-bin/api.cgi?cmd=%s&source=%s&output=sightline_%s.mp4&start=%s&token=%s",
		c, source, start, start, url.QueryEscape(token))
}

// nvrDownloadCommand prepares a file for a time range on NVRs whose search results have no name.
func nvrDownloadCommand(ch int, from, to time.Time) command {
	return command{Cmd: "NvrDownload", Action: 1, Param: map[string]any{"NvrDownload": map[string]any{
		"channel": ch, "iLogicChannel": 0, "streamType": "main", "StartTime": toWall(from), "EndTime": toWall(to),
	}}}
}

// parseNvrDownload → the prepared file name (the largest, as reolink_aio does).
func parseNvrDownload(raw json.RawMessage) string {
	var v struct {
		FileList []struct {
			FileName string `json:"fileName"`
			FileSize num    `json:"fileSize"`
		} `json:"fileList"`
	}
	_ = json.Unmarshal(raw, &v)
	best, size := "", -1.0
	for _, f := range v.FileList {
		if f.FileName != "" && float64(f.FileSize) > size {
			best, size = f.FileName, float64(f.FileSize)
		}
	}
	return best
}

var playableRe = regexp.MustCompile(`(?i)\.(mp4|vref)$`)

// ---------------------------------------------------------------------------------------------
// Health

// parseHDD: GetHddInfo → storage. capacity and size (free) are in MB (reolink_aio).
func parseHDD(raw json.RawMessage) []backend.Storage {
	var v struct {
		HddInfo []struct {
			Capacity    num `json:"capacity"`
			Size        num `json:"size"`
			Mount       num `json:"mount"`
			Number      num `json:"number"`
			StorageType num `json:"storageType"`
		} `json:"HddInfo"`
	}
	_ = json.Unmarshal(raw, &v)
	out := []backend.Storage{}
	for i, h := range v.HddInfo {
		if h.Capacity <= 0 {
			continue
		}
		n := h.Number.Int()
		if n == 0 {
			n = i + 1
		}
		path := fmt.Sprintf("Hard drive %d", n)
		if h.StorageType == 2 {
			path = "SD card"
			if len(v.HddInfo) > 1 {
				path = fmt.Sprintf("SD card %d", n)
			}
		}
		free := float64(h.Size)
		used := 100 * (float64(h.Capacity) - free) / float64(h.Capacity)
		if h.Mount == 0 {
			// Not mounted (unformatted or failed): nothing can be recorded on it.
			free, used = 0, 100
		}
		out = append(out, backend.Storage{
			Path: path, UsedPct: int(math.Round(math.Max(0, math.Min(100, used)))),
			FreeGB: math.Round(free/1024*10) / 10,
		})
	}
	return out
}
