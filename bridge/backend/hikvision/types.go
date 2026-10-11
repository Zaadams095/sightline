package hikvision

// ISAPI wire types and the pure helpers around them (channels, time, search, PTZ). Ported from
// the app's adapter (app/src/systems/hikvision-parse.ts), which cites its sources:
//   - Hikvision "IP Surveillance API (RaCM part) 2.0": ContentMgmt/search, archive streaming
//     (/Streaming/tracks/<id>?starttime=…).
//   - hikvision_next (Home Assistant): deviceInfo, InputProxy and video input channels, RTSP port.
//
// Struct tags carry no namespace, so they match whichever one the firmware uses
// (isapi.org/ver20 or hikvision.com/ver20).

import (
	"encoding/xml"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// ---------------------------------------------------------------------------------------------
// Device and channels

type deviceInfoXML struct {
	XMLName    xml.Name
	DeviceName string `xml:"deviceName"`
	Model      string `xml:"model"`
	DeviceType string `xml:"deviceType"`
}

type inputProxyListXML struct {
	Channels []struct {
		ID   string `xml:"id"`
		Name string `xml:"name"`
	} `xml:"InputProxyChannel"`
}

type inputProxyStatusXML struct {
	Channels []struct {
		ID     string `xml:"id"`
		Online string `xml:"online"`
	} `xml:"InputProxyChannelStatus"`
}

type videoInputsXML struct {
	Channels []struct {
		ID      string `xml:"id"`
		Name    string `xml:"name"`
		Enabled string `xml:"videoInputEnabled"`
		ResDesc string `xml:"resDesc"`
	} `xml:"VideoInputChannel"`
}

type streamingChannelsXML struct {
	Channels []struct {
		ID    string `xml:"id"`
		Name  string `xml:"channelName"`
		Video struct {
			Input  string `xml:"videoInputChannelID"`
			Width  string `xml:"videoResolutionWidth"`
			Height string `xml:"videoResolutionHeight"`
		} `xml:"Video"`
	} `xml:"StreamingChannel"`
}

type adminAccessesXML struct {
	Protocols []struct {
		Protocol string `xml:"protocol"`
		Port     string `xml:"portNo"`
	} `xml:"AdminAccessProtocol"`
}

type timeXML struct {
	LocalTime string `xml:"localTime"`
	TimeZone  string `xml:"timeZone"`
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

// stream is one entry of /ISAPI/Streaming/channels (101, 102, 201, …).
type stream struct {
	ID, Channel   int
	Name          string
	Width, Height int
}

func parseStreams(x streamingChannelsXML) []stream {
	var out []stream
	for _, s := range x.Channels {
		id := atoi(s.ID)
		if id <= 0 {
			continue
		}
		ch := atoi(s.Video.Input)
		if ch <= 0 {
			ch = id / 100
		}
		out = append(out, stream{ID: id, Channel: ch, Name: strings.TrimSpace(s.Name), Width: atoi(s.Video.Width), Height: atoi(s.Video.Height)})
	}
	return out
}

// channel is one camera of the device.
type channel struct {
	ID     int
	Name   string
	Online bool
	// Proxied: a network camera on a recorder (PTZ may go through PTZCtrlProxy).
	Proxied       bool
	Width, Height int
}

func streamID(ch int, quality string) int {
	if quality == "sub" {
		return ch*100 + 2
	}
	return ch*100 + 1
}

func findStream(streams []stream, id int) *stream {
	for i := range streams {
		if streams[i].ID == id {
			return &streams[i]
		}
	}
	return nil
}

// buildChannels finds the cameras the way hikvision_next does: network cameras on a recorder
// (InputProxy), analog inputs (unused DVR inputs say "NO VIDEO" and are left out), else the
// streaming channels of a single camera.
func buildChannels(dev deviceInfoXML, proxy inputProxyListXML, status inputProxyStatusXML, inputs videoInputsXML, streams []stream) []channel {
	online := map[int]bool{}
	for _, s := range status.Channels {
		if id := atoi(s.ID); id > 0 {
			online[id] = strings.TrimSpace(s.Online) != "false"
		}
	}
	size := func(ch int) (int, int) {
		s := findStream(streams, streamID(ch, "main"))
		if s == nil {
			for i := range streams {
				if streams[i].Channel == ch {
					s = &streams[i]
					break
				}
			}
		}
		if s == nil {
			return 0, 0
		}
		return s.Width, s.Height
	}
	byID := map[int]*channel{}
	for _, p := range proxy.Channels {
		id := atoi(p.ID)
		if id <= 0 {
			continue
		}
		on, ok := online[id]
		if !ok {
			on = true
		}
		c := &channel{ID: id, Name: strings.TrimSpace(p.Name), Online: on, Proxied: true}
		if c.Name == "" {
			c.Name = fmt.Sprintf("Camera %d", id)
		}
		c.Width, c.Height = size(id)
		byID[id] = c
	}
	for _, in := range inputs.Channels {
		id := atoi(in.ID)
		if id <= 0 || byID[id] != nil || strings.Contains(strings.ToLower(in.ResDesc), "no video") {
			continue
		}
		c := &channel{ID: id, Name: strings.TrimSpace(in.Name), Online: strings.TrimSpace(in.Enabled) != "false"}
		if c.Name == "" {
			c.Name = fmt.Sprintf("Camera %d", id)
		}
		c.Width, c.Height = size(id)
		byID[id] = c
	}
	if len(byID) == 0 {
		for _, s := range streams {
			if byID[s.Channel] != nil || s.Channel <= 0 {
				continue
			}
			c := &channel{ID: s.Channel, Name: s.Name, Online: true}
			c.Width, c.Height = size(s.Channel)
			byID[s.Channel] = c
		}
	}
	out := make([]channel, 0, len(byID))
	for _, c := range byID {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	devName := strings.TrimSpace(dev.DeviceName)
	if devName == "" {
		devName = strings.TrimSpace(dev.Model)
	}
	if devName == "" {
		devName = "Hikvision"
	}
	// A single camera: its own name is the friendliest label.
	if len(out) == 1 && len(proxy.Channels) == 0 {
		out[0].Name = devName
	}
	for i := range out {
		if out[i].Name == "" {
			out[i].Name = fmt.Sprintf("%s %d", devName, out[i].ID)
		}
	}
	return out
}

// rtspPort is the device's RTSP port (554 unless changed; one NVR in the wild uses 10554).
func rtspPort(x adminAccessesXML) int {
	for _, p := range x.Protocols {
		if strings.EqualFold(strings.TrimSpace(p.Protocol), "RTSP") {
			if n := atoi(p.Port); n > 0 {
				return n
			}
		}
	}
	return 554
}

// ---------------------------------------------------------------------------------------------
// Time. Recorders write their *local* wall clock with a "Z" suffix in search results and in
// playback URLs ("fake Z"; a real-UTC starttime is rejected by Hikvision-OEM firmware). An
// explicit offset (+02:00) is honored.

var (
	localTimeRe = regexp.MustCompile(`^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$`)
	hikTimeRe   = regexp.MustCompile(`^(\d{4})-?(\d\d)-?(\d\d)T(\d\d):?(\d\d):?(\d\d)(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$`)
)

func offsetMinutes(tz string) int {
	sign := 1
	if tz[0] == '-' {
		sign = -1
	}
	d := strings.ReplaceAll(tz[1:], ":", "")
	return sign * (atoi(d[:2])*60 + atoi(d[2:4]))
}

// deviceZone reads /ISAPI/System/time. <localTime>…+02:00</localTime> carries the current
// offset; without one the wall clock is compared with now. When the Hub's own zone has the
// same offset right now it is used instead (it knows historic DST changes); hubZone is
// time.Local outside tests.
func deviceZone(x timeXML, now time.Time, hubZone *time.Location) *time.Location {
	m := localTimeRe.FindStringSubmatch(strings.TrimSpace(x.LocalTime))
	if m == nil {
		return hubZone
	}
	var off int
	if tz := m[7]; tz != "" && tz != "Z" {
		off = offsetMinutes(tz)
	} else {
		wall := time.Date(atoi(m[1]), time.Month(atoi(m[2])), atoi(m[3]), atoi(m[4]), atoi(m[5]), atoi(m[6]), 0, time.UTC)
		diff := wall.Sub(now).Minutes()
		off = int(roundTo(diff, 15))
	}
	if _, hubOff := now.In(hubZone).Zone(); hubOff == off*60 {
		return hubZone
	}
	return time.FixedZone("device", off*60)
}

func roundTo(v, step float64) float64 {
	if v < 0 {
		return -roundTo(-v, step)
	}
	return float64(int64(v/step+0.5)) * step
}

// parseHikTime reads "2024-05-01T10:00:00Z" (device-local, fake Z), "20240501T100000Z" or an
// explicit offset.
func parseHikTime(s string, zone *time.Location) (time.Time, bool) {
	m := hikTimeRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return time.Time{}, false
	}
	loc := zone
	if tz := m[7]; tz != "" && tz != "Z" {
		loc = time.FixedZone("", offsetMinutes(tz)*60)
	}
	return time.Date(atoi(m[1]), time.Month(atoi(m[2])), atoi(m[3]), atoi(m[4]), atoi(m[5]), atoi(m[6]), 0, loc), true
}

// searchTime: "2024-05-01T10:00:00Z" in device-local time.
func searchTime(t int64, zone *time.Location) string {
	return time.Unix(t, 0).In(zone).Format("2006-01-02T15:04:05") + "Z"
}

// rtspTime: "20240501T100000Z" in device-local time.
func rtspTime(t int64, zone *time.Location) string {
	return time.Unix(t, 0).In(zone).Format("20060102T150405") + "Z"
}

// dayRanges splits [after, before) into device-local calendar days, newest first. Searches
// page oldest-first, so walking day by day from the newest keeps a busy day from crowding
// out the most recent recordings.
func dayRanges(after, before int64, zone *time.Location, maxDays int) [][2]int64 {
	var out [][2]int64
	end := before
	for end > after && len(out) < maxDays {
		w := time.Unix(end-1, 0).In(zone)
		dayStart := time.Date(w.Year(), w.Month(), w.Day(), 0, 0, 0, 0, zone).Unix()
		from := max(after, min(dayStart, end-1))
		out = append(out, [2]int64{from, end})
		end = from
	}
	return out
}

// ---------------------------------------------------------------------------------------------
// Recordings search

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// searchXML asks for one track's recordings in a window; metadata ("AllEvent") narrows it to
// event recordings.
func searchXML(searchID string, track int, start, end int64, zone *time.Location, position, maxResults int, metadata string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription>`)
	fmt.Fprintf(&b, "<searchID>%s</searchID>", xmlEscape(searchID))
	fmt.Fprintf(&b, "<trackIDList><trackID>%d</trackID></trackIDList>", track)
	fmt.Fprintf(&b, "<timeSpanList><timeSpan><startTime>%s</startTime><endTime>%s</endTime></timeSpan></timeSpanList>",
		searchTime(start, zone), searchTime(end, zone))
	fmt.Fprintf(&b, "<maxResults>%d</maxResults>", maxResults)
	// Sic: Hikvision's schema spells it "Postion".
	fmt.Fprintf(&b, "<searchResultPostion>%d</searchResultPostion>", position)
	if metadata != "" {
		fmt.Fprintf(&b, "<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com/%s</metadataDescriptor></metadataList>", xmlEscape(metadata))
	}
	b.WriteString("</CMSearchDescription>")
	return b.String()
}

type matchXML struct {
	TrackID   string `xml:"trackID"`
	StartTime string `xml:"timeSpan>startTime"`
	EndTime   string `xml:"timeSpan>endTime"`
	// Some firmware puts the times directly in the item.
	StartTime2  string `xml:"startTime"`
	EndTime2    string `xml:"endTime"`
	PlaybackURI string `xml:"mediaSegmentDescriptor>playbackURI"`
	RecordType  string `xml:"metadataMatches>metadataDescriptor"`
}

type searchResultXML struct {
	Status string `xml:"responseStatusStrg"`
	// Devices use searchMatchItem; the spec says matchElement.
	Items    []matchXML `xml:"matchList>searchMatchItem"`
	Elements []matchXML `xml:"matchList>matchElement"`
}

// match is one recording found by a search.
type match struct {
	Track      int
	Start, End int64
	// RecordType is e.g. "recordType.meta.std-cgi.com/VMD" (may be empty).
	RecordType string
}

func parseSearchResult(x searchResultXML, zone *time.Location) (matches []match, more bool) {
	for _, m := range append(append([]matchXML(nil), x.Items...), x.Elements...) {
		st, et := m.StartTime, m.EndTime
		if st == "" {
			st, et = m.StartTime2, m.EndTime2
		}
		s, ok1 := parseHikTime(st, zone)
		e, ok2 := parseHikTime(et, zone)
		if !ok1 || !ok2 {
			continue
		}
		matches = append(matches, match{Track: atoi(m.TrackID), Start: s.Unix(), End: e.Unix(), RecordType: strings.TrimSpace(m.RecordType)})
	}
	return matches, strings.EqualFold(strings.TrimSpace(x.Status), "MORE")
}

func mergeSegments(ms []match, tolerance int64) []backend.Segment {
	sorted := append([]match(nil), ms...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	var out []backend.Segment
	for _, m := range sorted {
		if m.End <= m.Start {
			continue
		}
		if n := len(out); n > 0 && float64(m.Start)-out[n-1].End <= float64(tolerance) {
			out[n-1].End = max(out[n-1].End, float64(m.End))
			continue
		}
		out = append(out, backend.Segment{Start: float64(m.Start), End: float64(m.End)})
	}
	return out
}

var (
	notEventRe = regexp.MustCompile(`^(cmr|timing|time|continuous|manual|command|schedule)$`)
	personRe   = regexp.MustCompile(`human|person|pedestrian|face`)
	vehicleRe  = regexp.MustCompile(`vehicle|car|plate|lpr|anpr`)
	smartRe    = regexp.MustCompile(`line|field|intrusion|region|perimeter|smart|alarm|^io`)
)

// classifyRecordType says what a recording's type means for events. Continuous, scheduled and
// manual recordings are not events. Smart events (line crossing, intrusion, region entry/exit)
// are alerts; plain motion is a detection; AcuSense human/vehicle types name the object.
func classifyRecordType(descriptor string) (objects []string, severity string, ok bool) {
	t := strings.ToLower(descriptor[strings.LastIndex(descriptor, "/")+1:])
	switch {
	case notEventRe.MatchString(t):
		return nil, "", false
	case personRe.MatchString(t):
		return []string{"person"}, "alert", true
	case vehicleRe.MatchString(t):
		return []string{"vehicle"}, "alert", true
	case smartRe.MatchString(t):
		return []string{"motion"}, "alert", true
	}
	return []string{"motion"}, "detection", true
}

// eventID is "<channel>:<unix start>" for recorded events; alerts from the live stream add
// ":<type>" ("1:1719828000:linedetection").
func eventID(ch int, start int64, kind string) string {
	if kind == "" {
		return fmt.Sprintf("%d:%d", ch, start)
	}
	return fmt.Sprintf("%d:%d:%s", ch, start, kind)
}

func parseEventID(id string) (ch int, start int64, kind string, ok bool) {
	parts := strings.SplitN(id, ":", 3)
	if len(parts) < 2 {
		return 0, 0, "", false
	}
	ch, err1 := strconv.Atoi(parts[0])
	start, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || ch <= 0 || start <= 0 {
		return 0, 0, "", false
	}
	if len(parts) == 3 {
		kind = parts[2]
	}
	return ch, start, kind, true
}

func matchesToEvents(ms []match, ch int) []backend.Event {
	var out []backend.Event
	seen := map[string]bool{}
	for _, m := range ms {
		objects, severity, ok := classifyRecordType(m.RecordType)
		if !ok {
			continue
		}
		id := eventID(ch, m.Start, "")
		if seen[id] {
			continue
		}
		seen[id] = true
		end := float64(m.End)
		out = append(out, backend.Event{
			ID: id, Camera: strconv.Itoa(ch), Start: float64(m.Start), End: &end,
			Severity: severity, Objects: objects,
		})
	}
	return out
}

// ---------------------------------------------------------------------------------------------
// PTZ, storage, write answers

type ptzCapsXML struct {
	ContinuousPanTilt *struct{} `xml:"ContinuousPanTiltSpace"`
	AbsolutePanTilt   *struct{} `xml:"AbsolutePanTiltPositionSpace"`
	ContinuousZoom    *struct{} `xml:"ContinuousZoomSpace"`
	AbsoluteZoom      *struct{} `xml:"AbsoluteZoomPositionSpace"`
}

type ptzPresetsXML struct {
	Presets []struct {
		Enabled string `xml:"enabled"`
		ID      string `xml:"id"`
		Name    string `xml:"presetName"`
	} `xml:"PTZPreset"`
}

type preset struct {
	Name string
	ID   int
}

// parsePresets lists enabled presets (cameras list all 256 slots, most unused).
func parsePresets(x ptzPresetsXML) []preset {
	var out []preset
	seen := map[string]bool{}
	for _, p := range x.Presets {
		if strings.TrimSpace(p.Enabled) == "false" {
			continue
		}
		id, err := strconv.Atoi(strings.TrimSpace(p.ID))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = fmt.Sprintf("Preset %d", id)
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, preset{Name: name, ID: id})
		}
	}
	return out
}

// ptzXML is a continuous move; speeds are -100…100 and all zeros stops.
func ptzXML(action string) (string, bool) {
	const speed = 60
	v, ok := map[string][3]int{
		"MOVE_UP":    {0, speed, 0},
		"MOVE_DOWN":  {0, -speed, 0},
		"MOVE_LEFT":  {-speed, 0, 0},
		"MOVE_RIGHT": {speed, 0, 0},
		"ZOOM_IN":    {0, 0, speed},
		"ZOOM_OUT":   {0, 0, -speed},
		"STOP":       {0, 0, 0},
	}[action]
	if !ok {
		return "", false
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><PTZData><pan>%d</pan><tilt>%d</tilt><zoom>%d</zoom></PTZData>`, v[0], v[1], v[2]), true
}

// storageXML is /ISAPI/ContentMgmt/Storage; capacity and freeSpace are in MB.
type storageXML struct {
	HDDs []struct {
		ID       string `xml:"id"`
		Name     string `xml:"hddName"`
		Status   string `xml:"status"`
		Capacity string `xml:"capacity"`
		Free     string `xml:"freeSpace"`
	} `xml:"hddList>hdd"`
}

// storageHealth reports each disk. A disk that stopped working (status other than ok, idle or
// standby) can't take recordings, so it's reported as full, with the reason in its name.
func storageHealth(x storageXML) []backend.Storage {
	var out []backend.Storage
	for _, d := range x.HDDs {
		name := "Disk " + strings.TrimSpace(d.ID)
		status := strings.ToLower(strings.TrimSpace(d.Status))
		switch status {
		case "ok", "idle", "standby", "sleeping", "":
		default:
			out = append(out, backend.Storage{Path: name + ", which has stopped working (" + status + ")", UsedPct: 100})
			continue
		}
		capMB, _ := strconv.ParseFloat(strings.TrimSpace(d.Capacity), 64)
		freeMB, _ := strconv.ParseFloat(strings.TrimSpace(d.Free), 64)
		if capMB <= 0 {
			continue
		}
		pct := int((capMB - freeMB) / capMB * 100)
		out = append(out, backend.Storage{Path: name, UsedPct: min(100, max(1, pct)), FreeGB: freeMB / 1024})
	}
	return out
}

// responseStatusXML is the answer to writes (and the body of most ISAPI errors).
type responseStatusXML struct {
	XMLName       xml.Name
	StatusCode    string `xml:"statusCode"`
	StatusString  string `xml:"statusString"`
	SubStatusCode string `xml:"subStatusCode"`
}
