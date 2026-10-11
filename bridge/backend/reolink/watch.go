package reolink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Instant Alerts. The Reolink HTTP API has no push stream, so Watch polls every channel's
// detection state about every 2 s in one request: GetEvents on newer firmware (AI, motion and
// the doorbell's visitor state together), else GetMdState + GetAiState. Rising edges start an
// event; the falling edge sets its End. Motion/person/vehicle/animal are one ongoing event per
// camera (objects added as they're seen); doorbell rings and packages are separate events, so
// a ring during ongoing motion still notifies.

// detection is one channel's state at one poll.
type detection struct {
	Motion, Person, Vehicle, Animal, Package, Visitor bool
}

// alarmState is {"alarm_state":1,"support":1}.
type alarmState struct {
	AlarmState num `json:"alarm_state"`
	Support    num `json:"support"`
}

// aiKeys maps Reolink's AI types to Sightline objects (reolink_aio: people, vehicle, dog_cat,
// package).
func (d *detection) setAI(ai map[string]json.RawMessage) {
	on := func(key string) bool {
		var s alarmState
		if raw, ok := ai[key]; ok && json.Unmarshal(raw, &s) == nil {
			return s.AlarmState == 1
		}
		return false
	}
	d.Person = on("people")
	d.Vehicle = on("vehicle")
	d.Animal = on("dog_cat")
	d.Package = on("package")
}

// parseGetEvents: {"channel":0,"ai":{"people":{"alarm_state":1,…},…},"md":{"alarm_state":1},
// "visitor":{"alarm_state":0}}.
func parseGetEvents(raw json.RawMessage) (detection, bool) {
	var v struct {
		AI      map[string]json.RawMessage `json:"ai"`
		MD      *alarmState                `json:"md"`
		Visitor *alarmState                `json:"visitor"`
	}
	if json.Unmarshal(raw, &v) != nil || (v.AI == nil && v.MD == nil && v.Visitor == nil) {
		return detection{}, false
	}
	var d detection
	d.setAI(v.AI)
	d.Motion = v.MD != nil && v.MD.AlarmState == 1
	d.Visitor = v.Visitor != nil && v.Visitor.AlarmState == 1
	return d, true
}

// parseMdAi: GetMdState {"state":1} and GetAiState {"people":{"alarm_state":1,…},…}.
func parseMdAi(md, ai json.RawMessage) detection {
	var d detection
	var m struct {
		State num `json:"state"`
	}
	if json.Unmarshal(md, &m) == nil {
		d.Motion = m.State == 1
	}
	var a map[string]json.RawMessage
	if len(ai) > 0 && json.Unmarshal(ai, &a) == nil {
		d.setAI(a)
	}
	return d
}

// open events of one channel.
type chanEvents struct {
	activity, ring, pkg *backend.Event
}

type watcher struct {
	r *Reolink
	// mode: "" (not decided), "events" (GetEvents) or "mdai" (GetMdState + GetAiState).
	mode  string
	open  map[int]*chanEvents
	now   func() time.Time
	lastT int64
}

func (r *Reolink) newWatcher() *watcher {
	return &watcher{r: r, open: map[int]*chanEvents{}, now: time.Now}
}

// Watch polls detection state until ctx ends.
func (r *Reolink) Watch(ctx context.Context, sink backend.Sink) error {
	w := r.newWatcher()
	failures := 0
	for {
		err := w.poll(ctx, sink)
		if errors.Is(err, backend.ErrUnsupported) {
			return err
		}
		wait := r.pollEvery
		if err != nil && ctx.Err() == nil {
			failures++
			if failures == 1 || failures%30 == 0 {
				log.Printf("%s: reading detections: %v", r.cfg.ID, err)
			}
			wait = min(time.Duration(failures)*r.pollEvery, 30*time.Second)
		} else {
			failures = 0
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// poll reads every online channel's state once and emits the edges.
func (w *watcher) poll(ctx context.Context, sink backend.Sink) error {
	st, err := w.r.load(ctx)
	if err != nil {
		return err
	}
	var chans []int
	for _, c := range st.channels {
		if c.Online {
			chans = append(chans, c.Ch)
		}
	}
	if len(chans) == 0 {
		return nil
	}
	states := map[int]detection{}
	if w.mode != "mdai" {
		cmds := make([]command, len(chans))
		for i, ch := range chans {
			cmds[i] = cmd("GetEvents", chParam(ch))
		}
		items, err := w.r.c.api(ctx, cmds...)
		if err != nil {
			return err
		}
		for i, ch := range chans {
			if i < len(items) && items[i].ok() {
				if d, ok := parseGetEvents(items[i].Value); ok {
					states[ch] = d
				}
			}
		}
		if len(states) == 0 && w.mode == "" {
			w.mode = "mdai" // older firmware: no GetEvents
		} else if len(states) > 0 {
			w.mode = "events"
		}
	}
	if w.mode == "mdai" {
		cmds := make([]command, 0, 2*len(chans))
		for _, ch := range chans {
			cmds = append(cmds, cmd("GetMdState", chParam(ch)), cmd("GetAiState", chParam(ch)))
		}
		items, err := w.r.c.api(ctx, cmds...)
		if err != nil {
			return err
		}
		var failed *item
		for i, ch := range chans {
			if 2*i >= len(items) || !items[2*i].ok() {
				if 2*i < len(items) {
					failed = &items[2*i]
				}
				continue
			}
			var ai json.RawMessage
			if 2*i+1 < len(items) && items[2*i+1].ok() {
				ai = items[2*i+1].Value
			}
			states[ch] = parseMdAi(items[2*i].Value, ai)
		}
		if len(states) == 0 && failed != nil {
			return commandError(failed)
		}
	}
	now := w.now()
	for _, ch := range chans {
		if d, ok := states[ch]; ok {
			w.update(ch, d, now, sink)
		}
	}
	return nil
}

// id is "<ch>-<unix ms>-<kind>", unique even for edges in the same millisecond.
func (w *watcher) id(ch int, now time.Time, kind string) string {
	t := now.UnixMilli()
	if t <= w.lastT {
		t = w.lastT + 1
	}
	w.lastT = t
	return fmt.Sprintf("%d-%d-%s", ch, t, kind)
}

// update applies one channel's state: start, grow or end its events.
func (w *watcher) update(ch int, d detection, now time.Time, sink backend.Sink) {
	o := w.open[ch]
	if o == nil {
		o = &chanEvents{}
		w.open[ch] = o
	}
	var objects []string
	for _, x := range []struct {
		on   bool
		name string
	}{{d.Person, "person"}, {d.Vehicle, "vehicle"}, {d.Animal, "animal"}} {
		if x.on {
			objects = append(objects, x.name)
		}
	}
	o.activity = w.edge(ch, o.activity, d.Motion || len(objects) > 0, objects, "a", now, sink)
	o.ring = w.edge(ch, o.ring, d.Visitor, []string{"doorbell"}, "ring", now, sink)
	o.pkg = w.edge(ch, o.pkg, d.Package, []string{"package"}, "pkg", now, sink)
}

// edge: active and no open event → new event; active → add new objects; inactive → end it.
func (w *watcher) edge(ch int, ev *backend.Event, active bool, objects []string, kind string, now time.Time, sink backend.Sink) *backend.Event {
	t := float64(now.UnixMilli()) / 1000
	switch {
	case active && ev == nil:
		ev = &backend.Event{
			ID: w.id(ch, now, kind), Camera: strconv.Itoa(ch), Start: t,
			Severity: severity(objects), Objects: append([]string{}, objects...),
			SubLabels: []string{}, Zones: []string{}, Detections: []string{},
		}
		w.emit(*ev, sink)
		return ev
	case active:
		grew := false
		for _, o := range objects {
			if !contains(ev.Objects, o) {
				ev.Objects = append(ev.Objects, o)
				grew = true
			}
		}
		if grew {
			ev.Severity = severity(ev.Objects)
			w.emit(*ev, sink)
		}
		return ev
	case ev != nil:
		end := t
		ev.End = &end
		w.emit(*ev, sink)
		return nil
	}
	return nil
}

func (w *watcher) emit(e backend.Event, sink backend.Sink) {
	e.Objects = append([]string{}, e.Objects...)
	if e.End != nil {
		end := *e.End
		e.End = &end
	}
	w.r.remember(e)
	sink.OnEvent(e)
}

const recentMax = 500

// remember keeps recent live events so Event(id) finds them (a notification is tapped).
func (r *Reolink) remember(e backend.Event) {
	r.recentMu.Lock()
	defer r.recentMu.Unlock()
	if _, ok := r.recent[e.ID]; !ok {
		r.order = append(r.order, e.ID)
	}
	r.recent[e.ID] = e
	for len(r.order) > recentMax {
		delete(r.recent, r.order[0])
		r.order = r.order[1:]
	}
}

func contains(s []string, x string) bool {
	for _, y := range s {
		if y == x {
			return true
		}
	}
	return false
}
