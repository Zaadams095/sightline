package onvif

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// Instant Alerts from the camera's ONVIF PullPoint subscription: CreatePullPointSubscription,
// then PullMessages in a loop (each waits up to pullTimeout for news), renewing the
// subscription before it lapses. Motion and analytics topics become backend.Events.

const (
	pullTimeout = 10 * time.Second
	// subscription lifetime asked for, and how often it's renewed
	termination = "PT120S"
	renewEvery  = 60 * time.Second
	// linger keeps an event open this long after the camera reports it over, so a flickering
	// motion detector makes one event rather than dozens.
	linger = 10 * time.Second

	actCreate = "http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest"
	actPull   = "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest"
	actRenew  = "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest"
	actUnsub  = "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest"
)

var (
	reqCreatePullPoint = `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>` + termination +
		`</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`
	reqPullMessages = `<tev:PullMessages><tev:Timeout>PT` + fmt.Sprint(int(pullTimeout.Seconds())) +
		`S</tev:Timeout><tev:MessageLimit>32</tev:MessageLimit></tev:PullMessages>`
	reqRenew       = `<wsnt:Renew><wsnt:TerminationTime>` + termination + `</wsnt:TerminationTime></wsnt:Renew>`
	reqUnsubscribe = `<wsnt:Unsubscribe/>`
)

// subscription is a PullPoint: requests go to path on the configured address; to is the
// address as the camera gave it (WS-Addressing To), refParams its reference parameters, which
// some cameras need echoed back as headers.
type subscription struct {
	path, to, refParams string
}

func wsaHeader(action string, sub *subscription) string {
	h := `<wsa:Action>` + action + `</wsa:Action>`
	if sub != nil {
		h += `<wsa:To>` + escapeXML(sub.to) + `</wsa:To>` + sub.refParams
	}
	return h
}

func parseSubscription(doc *node, eventsPath string) (*subscription, error) {
	ref := doc.find("SubscriptionReference")
	addr := strings.TrimSpace(ref.textOf("Address"))
	if addr == "" {
		return nil, errors.New("the camera didn't start an event subscription")
	}
	sub := &subscription{path: xaddrPath(addr, eventsPath), to: addr}
	if rp := ref.find("ReferenceParameters"); rp != nil {
		var b strings.Builder
		for _, c := range rp.Children {
			c.marshal(&b)
		}
		sub.refParams = b.String()
	}
	return sub, nil
}

// Watch delivers the camera's motion and analytics events until ctx ends, resubscribing with a
// growing pause whenever the subscription breaks.
func (o *Onvif) Watch(ctx context.Context, sink backend.Sink) error {
	t := newTracker()
	backoff := 5 * time.Second
	for ctx.Err() == nil {
		st, err := o.load(ctx)
		if err == nil {
			if st.events == "" || o.pullUnsupported() {
				return backend.ErrUnsupported
			}
			t.cams = st.cameras
			began := time.Now()
			err = o.pullLoop(ctx, st, t, sink)
			if time.Since(began) > 2*renewEvery {
				backoff = 5 * time.Second
			}
			if errors.Is(err, backend.ErrUnsupported) {
				o.mu.Lock()
				o.noPull = true
				o.mu.Unlock()
				log.Printf("%s: this camera can't send events to the Hub (no ONVIF pull-point support)", o.cfg.ID)
				return err
			}
		}
		t.reset(time.Now(), sink)
		if ctx.Err() != nil {
			break
		}
		log.Printf("%s: camera events interrupted (%v); trying again in %s", o.cfg.ID, httpx.Explain(err), backoff)
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 2*time.Minute)
	}
	return nil
}

func (o *Onvif) pullUnsupported() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.noPull
}

func (o *Onvif) pullLoop(ctx context.Context, st *state, t *tracker, sink backend.Sink) error {
	doc, err := o.soap.call(ctx, o.http, st.events, reqCreatePullPoint, callOpts{header: wsaHeader(actCreate, nil)})
	if err != nil {
		return unsupported(err)
	}
	sub, err := parseSubscription(doc, st.events)
	if err != nil {
		return err
	}
	defer func() {
		uctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = o.soap.call(uctx, o.http, sub.path, reqUnsubscribe, callOpts{header: wsaHeader(actUnsub, sub)})
	}()

	renewAt := time.Now().Add(renewEvery)
	for ctx.Err() == nil {
		if time.Now().After(renewAt) {
			renewAt = time.Now().Add(renewEvery)
			_, err := o.soap.call(ctx, o.http, sub.path, reqRenew, callOpts{header: wsaHeader(actRenew, sub)})
			if err != nil && !errors.Is(err, errFault) {
				return err
			}
			// A camera that refuses Renew keeps the subscription alive while it's pulled from;
			// if it lapses, PullMessages fails and Watch subscribes again.
		}
		began := time.Now()
		doc, err := o.soap.call(ctx, o.events, sub.path, reqPullMessages, callOpts{header: wsaHeader(actPull, sub)})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		msgs := parseNotifications(doc)
		for _, m := range msgs {
			t.handle(m, sink)
		}
		t.tick(time.Now(), sink)
		if len(msgs) == 0 && time.Since(began) < time.Second {
			// The camera doesn't wait for news; don't spin.
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
	return nil
}

// ---- notifications ----

type item struct{ Name, Value string }

type notification struct {
	Topic        string
	Op           string // PropertyOperation: Initialized | Changed | Deleted ("" for plain events)
	Source, Data []item
}

func simpleItems(n *node) []item {
	var out []item
	for _, s := range n.findAll("SimpleItem") {
		out = append(out, item{Name: s.attr("Name"), Value: s.attr("Value")})
	}
	return out
}

func parseNotifications(doc *node) []notification {
	var out []notification
	for _, nm := range doc.findAll("NotificationMessage") {
		msg := nm.find("Message")
		if inner := msg.find("Message"); inner != nil {
			msg = inner // wsnt:Message wraps tt:Message
		}
		out = append(out, notification{
			Topic:  nm.textOf("Topic"),
			Op:     msg.attr("PropertyOperation"),
			Source: simpleItems(msg.find("Source")),
			Data:   simpleItems(msg.find("Data")),
		})
	}
	return out
}

// Kinds of detection, as the brand-neutral object labels the app's rules use.
const (
	kMotion    = "motion"
	kPerson    = "person"
	kVehicle   = "vehicle"
	kAnimal    = "animal"
	kDoorbell  = "doorbell"
	kPerimeter = "perimeter" // line crossing / intrusion: an alert, no object named
)

var topicKinds = []struct {
	kind  string
	words []string
}{
	{kDoorbell, []string{"visitor", "doorbell"}},
	{kPerson, []string{"people", "human", "person", "pedestrian", "face"}},
	{kVehicle, []string{"vehicle", "licenseplate", "platedetect"}},
	{kAnimal, []string{"dogcat", "animal"}},
	{kPerimeter, []string{"linedetector", "linecross", "crossed", "fielddetector", "fielddetection",
		"intrusion", "objectsinside", "tripwire", "regionentr", "regionexit", "loitering"}},
	{kMotion, []string{"motion"}},
}

// classifyTopic maps an ONVIF topic ("tns1:RuleEngine/CellMotionDetector/Motion") to a kind,
// or "" for topics that aren't detections (tamper, storage, inputs…).
func classifyTopic(topic string) string {
	segs := strings.Split(topic, "/")
	for i, s := range segs {
		segs[i] = localPart(strings.TrimSpace(s))
	}
	t := strings.ToLower(strings.Join(segs, "/"))
	for _, k := range topicKinds {
		for _, w := range k.words {
			if strings.Contains(t, w) {
				return k.kind
			}
		}
	}
	return ""
}

func parseBool(v string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "1", "on", "active":
		return true, true
	case "false", "0", "off", "inactive":
		return false, true
	}
	return false, false
}

// stateOf finds the on/off value in a message's data (IsMotion, State, IsPeople, IsInside…).
// ok is false for momentary events such as a line being crossed.
func stateOf(data []item) (on, ok bool) {
	for _, it := range data {
		n := strings.ToLower(it.Name)
		if strings.HasPrefix(n, "is") || n == "state" || n == "logicalstate" || n == "value" || n == "active" || n == "alarm" {
			if v, ok := parseBool(it.Value); ok {
				return v, true
			}
		}
	}
	for _, it := range data {
		switch strings.ToLower(it.Value) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}

// ---- tracker: messages → events ----

// tracker turns the camera's on/off messages into one event per camera at a time (like a
// Frigate review item): it opens on the first detection, gains objects as analytics report
// them (motion, then a person: one event upgraded to an alert), and ends linger after the
// last detector went quiet.
type tracker struct {
	cams   []onvifCamera
	linger time.Duration
	active map[string]bool // camera|kind|topic|rule → on
	open   map[string]*openEvent
}

type openEvent struct {
	ev        backend.Event
	kinds     map[string]bool
	idleSince time.Time // zero while something is still detected
}

func newTracker() *tracker {
	return &tracker{linger: linger, active: map[string]bool{}, open: map[string]*openEvent{}}
}

func (t *tracker) cameraFor(source []item) string {
	for _, it := range source {
		v := strings.TrimSpace(it.Value)
		if v == "" {
			continue
		}
		for _, c := range t.cams {
			if v == c.Source || v == c.ID {
				return c.ID
			}
			for _, p := range c.profiles {
				if v == p.Token || v == p.SourceConfig {
					return c.ID
				}
			}
		}
	}
	if len(t.cams) == 1 {
		return t.cams[0].ID
	}
	return ""
}

func (t *tracker) handle(n notification, sink backend.Sink) {
	t.handleAt(n, time.Now(), sink)
}

func (t *tracker) handleAt(n notification, now time.Time, sink backend.Sink) {
	kind := classifyTopic(n.Topic)
	if kind == "" {
		return
	}
	cam := t.cameraFor(n.Source)
	if cam == "" {
		return
	}
	rule := ""
	for _, it := range n.Source {
		if strings.EqualFold(it.Name, "Rule") {
			rule = it.Value
		}
	}
	key := cam + "|" + kind + "|" + n.Topic + "|" + rule
	on, isState := stateOf(n.Data)
	if strings.EqualFold(n.Op, "Deleted") {
		on, isState = false, true
	}
	initial := strings.EqualFold(n.Op, "Initialized")
	switch {
	case !isState:
		if initial {
			return
		}
		t.touch(cam, kind, now, sink) // momentary: a line was crossed
	case on:
		t.active[key] = true
		// The state when subscribing isn't news; only changes open events.
		if !initial {
			t.touch(cam, kind, now, sink)
		}
	default:
		delete(t.active, key)
	}
	t.settle(cam, now)
}

func (t *tracker) touch(cam, kind string, now time.Time, sink backend.Sink) {
	oe := t.open[cam]
	if oe == nil {
		start := float64(now.UnixMilli()) / 1000
		oe = &openEvent{
			ev:    backend.Event{ID: fmt.Sprintf("%s-%d", cam, now.UnixMilli()), Camera: cam, Start: start},
			kinds: map[string]bool{},
		}
		t.open[cam] = oe
	} else if oe.kinds[kind] {
		return
	}
	oe.kinds[kind] = true
	oe.ev.Objects, oe.ev.Severity = describe(oe.kinds)
	sink.OnEvent(oe.ev)
}

// settle marks the camera's event idle when no detector is on any more.
func (t *tracker) settle(cam string, now time.Time) {
	oe := t.open[cam]
	if oe == nil {
		return
	}
	prefix := cam + "|"
	for k := range t.active {
		if strings.HasPrefix(k, prefix) {
			oe.idleSince = time.Time{}
			return
		}
	}
	if oe.idleSince.IsZero() {
		oe.idleSince = now
	}
}

// tick ends events that have been idle for linger (End = when they went quiet).
func (t *tracker) tick(now time.Time, sink backend.Sink) {
	for cam, oe := range t.open {
		if !oe.idleSince.IsZero() && now.Sub(oe.idleSince) >= t.linger {
			t.finish(cam, oe, oe.idleSince, sink)
		}
	}
}

// reset ends every open event (the subscription broke; state will be re-learned).
func (t *tracker) reset(now time.Time, sink backend.Sink) {
	for cam, oe := range t.open {
		end := now
		if !oe.idleSince.IsZero() {
			end = oe.idleSince
		}
		t.finish(cam, oe, end, sink)
	}
	clear(t.active)
}

func (t *tracker) finish(cam string, oe *openEvent, end time.Time, sink backend.Sink) {
	e := float64(end.UnixMilli()) / 1000
	oe.ev.End = &e
	sink.OnEvent(oe.ev)
	delete(t.open, cam)
}

// describe lists the objects ("motion" only when nothing more specific was seen) and the
// severity: people, vehicles, doorbells and perimeter rules are alerts; motion and animals
// are detections.
func describe(kinds map[string]bool) ([]string, string) {
	var objs []string
	for _, k := range []string{kPerson, kVehicle, kAnimal, kDoorbell} {
		if kinds[k] {
			objs = append(objs, k)
		}
	}
	if len(objs) == 0 && (kinds[kMotion] || kinds[kPerimeter]) {
		objs = []string{kMotion}
	}
	sev := "detection"
	if kinds[kPerson] || kinds[kVehicle] || kinds[kDoorbell] || kinds[kPerimeter] {
		sev = "alert"
	}
	return objs, sev
}
