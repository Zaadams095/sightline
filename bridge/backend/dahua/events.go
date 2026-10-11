package dahua

import (
	"bufio"
	"encoding/json"
	"io"
	"mime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// The live event stream: /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5
// answers multipart/x-mixed-replace, one part per event:
//
//	--myboundary
//	Content-Type: text/plain
//	Content-Length: 37
//
//	Code=VideoMotion;action=Start;index=0
//
// Newer firmware appends `;data={…}` (JSON, often over several lines). `index` is the 0-based
// channel. Heartbeat parts just say "Heartbeat".

// rawEvent is one parsed part.
type rawEvent struct {
	Code   string
	Action string // Start | Stop | Pulse
	Index  int
	Data   map[string]any
}

// boundaryOf reads the multipart boundary from a Content-Type ("myboundary" when missing).
func boundaryOf(contentType string) string {
	_, params, _ := mime.ParseMediaType(contentType)
	b := strings.TrimPrefix(params["boundary"], "--")
	if b == "" {
		b = "myboundary"
	}
	return b
}

// readEvents reads parts until r ends, calling fn for every event. Dahua's multipart framing
// isn't always well-formed (missing blank lines, wrong Content-Length), so parts are split on
// boundary lines rather than with mime/multipart.
func readEvents(r io.Reader, boundary string, fn func(rawEvent)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	marker := "--" + boundary
	var part []string
	flush := func() {
		for _, ev := range parsePart(part) {
			fn(ev)
		}
		part = part[:0]
	}
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			t := strings.TrimSpace(line)
			if strings.HasPrefix(t, marker) || t == boundary {
				flush()
			} else if len(part) < 2000 {
				part = append(part, strings.TrimRight(line, "\r\n"))
			}
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

// parsePart drops part headers and returns the events in the body (usually one).
func parsePart(lines []string) []rawEvent {
	var body []string
	for _, l := range lines {
		low := strings.ToLower(strings.TrimSpace(l))
		if strings.HasPrefix(low, "content-type:") || strings.HasPrefix(low, "content-length:") {
			continue
		}
		body = append(body, l)
	}
	var out []rawEvent
	var cur []string
	emit := func() {
		if len(cur) > 0 {
			if ev, ok := parseEventText(strings.Join(cur, "\n")); ok {
				out = append(out, ev)
			}
		}
		cur = nil
	}
	for _, l := range body {
		if strings.HasPrefix(strings.TrimSpace(l), "Code=") {
			emit()
		}
		if cur != nil || strings.HasPrefix(strings.TrimSpace(l), "Code=") {
			cur = append(cur, l)
		}
	}
	emit()
	return out
}

// parseEventText reads `Code=X;action=Start;index=0;data={…}`.
func parseEventText(s string) (rawEvent, bool) {
	s = strings.TrimSpace(s)
	head, data, hasData := strings.Cut(s, ";data=")
	var ev rawEvent
	for _, kv := range strings.Split(head, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(kv), "=")
		if !ok {
			continue
		}
		switch strings.ToLower(k) {
		case "code":
			ev.Code = v
		case "action":
			ev.Action = v
		case "index":
			ev.Index, _ = strconv.Atoi(v)
		}
	}
	if hasData {
		_ = json.Unmarshal([]byte(strings.TrimSpace(data)), &ev.Data) // best effort
	}
	return ev, ev.Code != ""
}

// objectTypes maps the ObjectType of IVS / SMD data to objects.
var objectTypes = map[string]string{
	"human": "person", "person": "person", "humanface": "person", "face": "person",
	"vehicle": "vehicle", "motorvehicle": "vehicle", "car": "vehicle", "bus": "vehicle", "truck": "vehicle",
	"nonmotor": "vehicle", "bicycle": "vehicle", "motorcycle": "vehicle",
	"animal": "animal", "dog": "animal", "cat": "animal",
}

// dataObjects finds ObjectType fields in an event's data (Object, Objects[], or top level).
func dataObjects(d map[string]any) []string {
	var out []string
	add := func(v any) {
		if m, ok := v.(map[string]any); ok {
			if t, ok := m["ObjectType"].(string); ok {
				if o := objectTypes[strings.ToLower(t)]; o != "" {
					out = append(out, o)
				}
			}
		}
	}
	add(d)
	add(d["Object"])
	if list, ok := d["Objects"].([]any); ok {
		for _, o := range list {
			add(o)
		}
	}
	return uniq(out)
}

// classifyLive says what a live event means: objects, whether it's a perimeter alert, and
// whether it's a doorbell ring. ok=false: not something to alert on (heartbeats, NewFile,
// TimeChange, VideoLoss and so on).
func classifyLive(ev rawEvent) (objects []string, alertCode, ring, ok bool) {
	switch ev.Code {
	case "DoorBell", "CallNoAnswered", "PhoneCallDetect", "Invite":
		return []string{"doorbell"}, false, true, true
	case "_DoTalkAction_": // Amcrest AD110/AD410: a press is a talk "Invite"
		if a, _ := ev.Data["Action"].(string); a == "Invite" {
			return []string{"doorbell"}, false, true, true
		}
		return nil, false, false, false
	case "BackKeyLight":
		// The doorbell's ring light changes for many reasons; only the app's recording search
		// uses it. Rings arrive as DoorBell / _DoTalkAction_ / CallNoAnswered.
		return nil, false, false, false
	case "IntelliFrame":
		// Per-frame analytics: only meaningful when it names an object.
		objs := dataObjects(ev.Data)
		return objs, false, false, len(objs) > 0
	case "CrossLineDetection", "CrossRegionDetection":
		objs := dataObjects(ev.Data)
		if len(objs) == 0 {
			objs = []string{"motion"}
		}
		return objs, true, false, true
	}
	l := eventLabels[ev.Code]
	if l == "" {
		return nil, false, false, false
	}
	objs := append([]string{l}, dataObjects(ev.Data)...)
	return objs, alertCodes[ev.Code], false, true
}

// tracker turns the device's per-code Start/Stop/Pulse events into one event per channel
// "episode" (like a Frigate review item): codes that overlap on a channel share an ID, their
// objects merge, and the event ends when the last code stops. Doorbell rings are always their
// own event so a ring is never hidden behind an earlier motion alert.
type tracker struct {
	mu     sync.Mutex
	now    func() time.Time
	active map[int]*episode
	rings  map[int]time.Time
	recent map[string]backend.Event
	order  []string
}

type episode struct {
	ev      backend.Event
	started time.Time
	codes   map[string]bool // active code|index keys
	objects []string
	alert   bool
}

const (
	maxEpisode = 10 * time.Minute
	ringRepeat = 5 * time.Second
	maxRecent  = 500
)

func newTracker(now func() time.Time) *tracker {
	if now == nil {
		now = time.Now
	}
	return &tracker{now: now, active: map[int]*episode{}, rings: map[int]time.Time{}, recent: map[string]backend.Event{}}
}

// reset forgets open episodes (after a reconnect, Stops may have been missed).
func (t *tracker) reset() {
	t.mu.Lock()
	t.active = map[int]*episode{}
	t.mu.Unlock()
}

// handle returns the events to send for one raw event.
func (t *tracker) handle(ev rawEvent) []backend.Event {
	objects, alertCode, ring, ok := classifyLive(ev)
	if !ok || ev.Index < 0 {
		return nil
	}
	ch := ev.Index + 1
	now := t.now()
	ts := float64(now.Unix())
	action := strings.ToLower(ev.Action)
	t.mu.Lock()
	defer t.mu.Unlock()

	if ring {
		if action == "stop" || now.Sub(t.rings[ch]) < ringRepeat {
			return nil
		}
		t.rings[ch] = now
		e := newEvent(eventID(ch, ts, "ring"), ch, ts)
		e.Objects, e.Severity = summarize(objects, false)
		e.End = &ts
		return t.remember(e)
	}

	key := ev.Code + "|" + strconv.Itoa(ev.Index)
	ep := t.active[ch]
	if ep != nil && now.Sub(ep.started) > maxEpisode && action != "stop" {
		ep = nil // a camera that never goes quiet still gets a fresh event now and then
	}
	switch action {
	case "stop":
		if ep == nil {
			return nil
		}
		delete(ep.codes, key)
		if len(ep.codes) > 0 {
			return nil
		}
		delete(t.active, ch)
		ep.ev.End = &ts
		return t.remember(ep.ev)
	case "start", "pulse":
		if ep == nil {
			ep = &episode{ev: newEvent(eventID(ch, ts, ""), ch, ts), started: now, codes: map[string]bool{}}
			if action == "start" {
				t.active[ch] = ep
			} else {
				ep.ev.End = &ts
			}
		}
		if action == "start" {
			ep.codes[key] = true
		}
		before := strings.Join(ep.objects, ",") + strconv.FormatBool(ep.alert)
		isNew := len(ep.objects) == 0
		ep.objects = uniq(append(ep.objects, objects...))
		ep.alert = ep.alert || alertCode
		if !isNew && strings.Join(ep.objects, ",")+strconv.FormatBool(ep.alert) == before {
			return nil
		}
		ep.ev.Objects, ep.ev.Severity = summarize(ep.objects, ep.alert)
		return t.remember(ep.ev)
	}
	return nil
}

func newEvent(id string, ch int, start float64) backend.Event {
	return backend.Event{
		ID: id, Camera: strconv.Itoa(ch), Start: start,
		SubLabels: []string{}, Zones: []string{}, Detections: []string{},
	}
}

// remember keeps recent live events so Event(id) can answer for an alert's ID. Callers hold mu.
func (t *tracker) remember(e backend.Event) []backend.Event {
	e.Objects = append([]string(nil), e.Objects...)
	if _, ok := t.recent[e.ID]; !ok {
		t.order = append(t.order, e.ID)
		if len(t.order) > maxRecent {
			delete(t.recent, t.order[0])
			t.order = t.order[1:]
		}
	}
	t.recent[e.ID] = e
	return []backend.Event{e}
}

func (t *tracker) lookup(id string) (backend.Event, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.recent[id]
	return e, ok
}
