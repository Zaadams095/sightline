package hikvision

// Instant Alerts: /ISAPI/Event/notification/alertStream is a never-ending multipart answer.
// Each part is an <EventNotificationAlert> XML document (newer firmware: JSON for some
// events), sometimes followed by a JPEG part. Active events repeat about once a second while
// they last; "videoloss inactive" parts arrive every few seconds as a heartbeat.
//
//	--boundary
//	Content-Type: application/xml; charset="UTF-8"
//	Content-Length: 480
//
//	<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
//	<channelID>1</channelID><dateTime>2024-07-01T12:00:00+02:00</dateTime>
//	<eventType>VMD</eventType><eventState>active</eventState>…
//	</EventNotificationAlert>

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

const maxPart = 2 << 20

// readLine reads one line (without the line ending). Lines longer than maxPart are cut.
func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(line)+len(chunk) <= maxPart {
			line = append(line, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil && len(line) == 0 {
			return nil, err
		}
		return bytes.TrimRight(line, "\r\n"), nil
	}
}

// parseMultipart reads a (possibly sloppy) multipart stream and calls fn for each part. Parts
// with a Content-Length are read exactly; others run to the next boundary line. It returns
// when the stream ends (io.EOF → nil).
func parseMultipart(body io.Reader, boundary string, fn func(contentType string, part []byte)) error {
	boundary = strings.TrimPrefix(strings.TrimSpace(boundary), "--")
	isBoundary := func(line []byte) (is, last bool) {
		s := string(bytes.TrimSpace(line))
		if !strings.HasPrefix(s, "--") {
			return false, false
		}
		s = s[2:]
		if boundary == "" {
			return s != "", strings.HasSuffix(s, "--")
		}
		if s == boundary {
			return true, false
		}
		return s == boundary+"--", s == boundary+"--"
	}
	r := bufio.NewReaderSize(body, 64<<10)
	var pending []byte // a boundary line already read
	for {
		line := pending
		pending = nil
		if line == nil {
			var err error
			if line, err = readLine(r); err != nil {
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
		}
		is, last := isBoundary(line)
		if last {
			return nil
		}
		if !is {
			continue // stray blank lines between parts
		}
		var ct string
		length := -1
		for {
			h, err := readLine(r)
			if err != nil {
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
			if len(bytes.TrimSpace(h)) == 0 {
				break
			}
			k, v, _ := strings.Cut(string(h), ":")
			switch strings.ToLower(strings.TrimSpace(k)) {
			case "content-type":
				ct = strings.TrimSpace(v)
			case "content-length":
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
					length = n
				}
			}
		}
		if length >= 0 {
			if length > maxPart {
				if _, err := io.CopyN(io.Discard, r, int64(length)); err != nil {
					return nilIfEOF(err)
				}
				continue
			}
			part := make([]byte, length)
			if _, err := io.ReadFull(r, part); err != nil {
				return nilIfEOF(err)
			}
			fn(ct, part)
			continue
		}
		var part []byte
		for {
			l, err := readLine(r)
			if err != nil {
				if errors.Is(err, io.EOF) {
					if len(part) > 0 {
						fn(ct, part)
					}
					return nil
				}
				return err
			}
			if is, _ := isBoundary(l); is {
				pending = l
				break
			}
			if len(part)+len(l) < maxPart {
				part = append(append(part, l...), '\n')
			}
		}
		fn(ct, part)
	}
}

func nilIfEOF(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return nil
	}
	return err
}

// alert is one notification from the stream.
type alert struct {
	Channel int
	Type    string // lowercased eventType
	Active  bool
	Time    time.Time // zero when missing
	Targets []string  // detection targets ("human", "vehicle")
	Raw     string    // lowercased part, for doorbell call details
}

type alertXML struct {
	XMLName      xml.Name
	ChannelID    string   `xml:"channelID"`
	DynChannelID string   `xml:"dynChannelID"`
	DateTime     string   `xml:"dateTime"`
	EventType    string   `xml:"eventType"`
	EventState   string   `xml:"eventState"`
	TargetType   string   `xml:"targetType"`
	Targets      []string `xml:"DetectionRegionList>DetectionRegionEntry>detectionTarget"`
	Targets2     []string `xml:"DetectionRegionList>DetectionRegionEntry>targetType"`
}

// parseAlert reads one stream part (XML or JSON); ok is false for pictures and other parts.
func parseAlert(contentType string, part []byte, zone *time.Location) (alert, bool) {
	trimmed := bytes.TrimSpace(part)
	if len(trimmed) == 0 {
		return alert{}, false
	}
	ct := strings.ToLower(contentType)
	switch {
	case strings.Contains(ct, "json") || trimmed[0] == '{':
		return parseAlertJSON(trimmed, zone)
	case strings.Contains(ct, "xml") || trimmed[0] == '<':
		var x alertXML
		if err := xml.Unmarshal(trimmed, &x); err != nil || x.XMLName.Local != "EventNotificationAlert" {
			return alert{}, false
		}
		a := alert{
			Channel: firstPositive(x.DynChannelID, x.ChannelID),
			Type:    strings.ToLower(strings.TrimSpace(x.EventType)),
			Active:  !strings.EqualFold(strings.TrimSpace(x.EventState), "inactive"),
			Raw:     strings.ToLower(string(trimmed)),
		}
		if t, ok := parseHikTime(x.DateTime, zone); ok {
			a.Time = t
		}
		for _, t := range append(append([]string{x.TargetType}, x.Targets...), x.Targets2...) {
			if t = strings.TrimSpace(t); t != "" {
				a.Targets = append(a.Targets, strings.ToLower(t))
			}
		}
		return a, a.Type != ""
	}
	return alert{}, false
}

func firstPositive(vals ...string) int {
	for _, v := range vals {
		if n := atoi(v); n > 0 {
			return n
		}
	}
	return 1
}

func parseAlertJSON(b []byte, zone *time.Location) (alert, bool) {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return alert{}, false
	}
	str := func(k string) string {
		switch v := m[k].(type) {
		case string:
			return v
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
		return ""
	}
	a := alert{
		Channel: firstPositive(str("dynChannelID"), str("channelID")),
		Type:    strings.ToLower(strings.TrimSpace(str("eventType"))),
		Active:  !strings.EqualFold(strings.TrimSpace(str("eventState")), "inactive"),
		Raw:     strings.ToLower(string(b)),
	}
	if t, ok := parseHikTime(str("dateTime"), zone); ok {
		a.Time = t
	}
	var walk func(v any)
	walk = func(v any) {
		switch v := v.(type) {
		case map[string]any:
			for k, x := range v {
				if s, ok := x.(string); ok && (k == "targetType" || k == "detectionTarget") && s != "" {
					a.Targets = append(a.Targets, strings.ToLower(s))
				}
				walk(x)
			}
		case []any:
			for _, x := range v {
				walk(x)
			}
		}
	}
	walk(m)
	return a, a.Type != ""
}

var (
	doorbellTypeRe = regexp.MustCompile(`^(doorbell\w*|callstatus|calling|ringing|ring)$`)
	// Video intercom events cover calls and door unlocks; only calls ring.
	intercomCallRe = regexp.MustCompile(`"(ring|ringing|calling)"|callstatus|doorbell|"call"`)
)

// classifyAlert maps an event type to objects and severity; ok is false for events that
// aren't alerts (heartbeats, video loss, tampering…).
func classifyAlert(a alert) (objects []string, severity string, ok bool) {
	targets := targetObjects(a.Targets)
	switch t := a.Type; {
	case doorbellTypeRe.MatchString(t),
		(t == "videointercomevent" || t == "videointercom") && intercomCallRe.MatchString(a.Raw):
		return []string{"doorbell"}, "alert", true
	case t == "vmd" || t == "motion" || t == "motiondetection" || t == "pir" || t == "pir alarm":
		if len(targets) > 0 {
			return targets, "alert", true
		}
		return []string{"motion"}, "detection", true
	case t == "linedetection" || t == "fielddetection" || t == "regionentrance" || t == "regionexiting" || t == "intrusion":
		if len(targets) > 0 {
			return targets, "alert", true
		}
		return []string{"motion"}, "alert", true
	case strings.Contains(t, "human") || strings.Contains(t, "pedestrian") || t == "facedetection" || t == "facesnap":
		return []string{"person"}, "alert", true
	case strings.Contains(t, "vehicle") || t == "anpr":
		return []string{"vehicle"}, "alert", true
	}
	return nil, "", false
}

func targetObjects(targets []string) []string {
	var out []string
	add := func(s string) {
		for _, x := range out {
			if x == s {
				return
			}
		}
		out = append(out, s)
	}
	for _, t := range targets {
		switch {
		case strings.Contains(t, "human") || strings.Contains(t, "person") || strings.Contains(t, "pedestrian"):
			add("person")
		case strings.Contains(t, "vehicle") || strings.Contains(t, "car") || strings.Contains(t, "motor") || strings.Contains(t, "bicycle"):
			add("vehicle")
		}
	}
	return out
}

// episodeGap: an event repeated within this long continues the same episode (one alert).
const episodeGap = 15 * time.Second

// alertTracker turns the stream's repeating notifications into one Event per episode.
type alertTracker struct {
	mu       sync.Mutex
	episodes map[string]time.Time // channel|type → last seen
}

// handle returns the Event to send for a, if it starts a new episode.
func (k *alertTracker) handle(a alert, now time.Time) (backend.Event, bool) {
	objects, severity, ok := classifyAlert(a)
	if !ok || a.Channel <= 0 {
		return backend.Event{}, false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.episodes == nil {
		k.episodes = map[string]time.Time{}
	}
	key := strconv.Itoa(a.Channel) + "|" + a.Type
	if !a.Active {
		delete(k.episodes, key)
		return backend.Event{}, false
	}
	last, seen := k.episodes[key]
	k.episodes[key] = now
	if seen && now.Sub(last) < episodeGap {
		return backend.Event{}, false
	}
	for kk, t := range k.episodes {
		if now.Sub(t) > time.Hour {
			delete(k.episodes, kk)
		}
	}
	// The device's own time when its clock is sane, else the Hub's.
	start := now
	if !a.Time.IsZero() && a.Time.Sub(now).Abs() < 10*time.Minute {
		start = a.Time
	}
	kind := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, a.Type)
	return backend.Event{
		ID:       eventID(a.Channel, start.Unix(), kind),
		Camera:   strconv.Itoa(a.Channel),
		Start:    float64(start.Unix()),
		Severity: severity,
		Objects:  objects,
	}, true
}
