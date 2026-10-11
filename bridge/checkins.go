package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Family check-ins ("Let me know if there's no activity at Mom's by 10 AM"). This is the
// reliable path: the Hub watches around the clock, keeps its state in checkins.json so a
// restart loses nothing, fills gaps from the recorder's own event list after a restart, and
// double-checks with the recorder before ever saying "no activity". The schedule and wording
// mirror app/src/alerts/checkins.ts (the app's best-effort fallback); keep them in sync.
//
// Check-ins are per phone (synced with its device rules), and only cameras that phone's
// access covers count, so a family member with shared access can set up their own.

type checkin struct {
	ID              string              `json:"id"`
	Enabled         bool                `json:"enabled"`
	Who             string              `json:"who"`
	Place           string              `json:"place,omitempty"`
	Cameras         []string            `json:"cameras"`
	Zones           map[string][]string `json:"zones"`
	PeopleOnly      bool                `json:"peopleOnly"`
	ByTime          string              `json:"byTime,omitempty"`
	QuietLimitHours float64             `json:"quietLimitHours,omitempty"`
	DayStart        string              `json:"dayStart"`
	DayEnd          string              `json:"dayEnd"`
	SummaryTime     string              `json:"summaryTime,omitempty"`
	Timezone        string              `json:"timezone"`
	// Check-ins come through during the user's quiet hours unless this is false.
	DuringQuietHours bool              `json:"duringQuietHours"`
	CameraNames      map[string]string `json:"cameraNames,omitempty"`
}

type checkinState struct {
	WatchingSince int64    `json:"watchingSince"`
	Day           string   `json:"day,omitempty"`
	FirstToday    int64    `json:"firstToday,omitempty"`
	MomentsToday  int      `json:"momentsToday"`
	TodayIDs      []string `json:"todayIds,omitempty"`
	LastActivity  int64    `json:"lastActivity,omitempty"`
	LastCamera    string   `json:"lastCamera,omitempty"`
	OKAt          int64    `json:"okAt,omitempty"`
	FiredByTime   string   `json:"firedByTime,omitempty"`
	FiredQuietFor int64    `json:"firedQuietFor,omitempty"`
	SummarySent   string   `json:"summarySent,omitempty"`
	// Hub only: fill events from here (unix) from the recorder before trusting the counts.
	BackfillFrom int64 `json:"backfillFrom,omitempty"`
}

type checkinNotice struct {
	Kind  string // "by-time" | "quiet" | "summary"
	Title string
	Body  string
}

// ---- schedule (mirrors checkins.ts) ----

func checkinCounts(c checkin, r backend.Event) bool {
	if !slices.Contains(c.Cameras, r.Camera) || slices.Contains(r.Objects, "doorbell") {
		return false
	}
	if zones := c.Zones[r.Camera]; len(zones) > 0 && !anyIn(r.Zones, zones) {
		return false
	}
	return !c.PeopleOnly || slices.Contains(r.Objects, "person")
}

func rollDay(st checkinState, now int64, loc *time.Location) checkinState {
	today := dayKey(now, loc)
	if st.Day == today || (st.Day != "" && st.Day > today) {
		return st
	}
	st.Day, st.FirstToday, st.MomentsToday, st.TodayIDs = today, 0, 0, nil
	return st
}

func observeCheckin(c checkin, st checkinState, r backend.Event, now int64, loc *time.Location) checkinState {
	if !checkinCounts(c, r) {
		return st
	}
	st = rollDay(st, now, loc)
	start := int64(math.Floor(r.Start))
	if dayKey(start, loc) == st.Day {
		if !slices.Contains(st.TodayIDs, r.ID) {
			st.TodayIDs = append(slices.Clone(st.TodayIDs), r.ID)
			if len(st.TodayIDs) > 500 {
				st.TodayIDs = st.TodayIDs[len(st.TodayIDs)-500:]
			}
			st.MomentsToday++
		}
		if st.FirstToday == 0 || start < st.FirstToday {
			st.FirstToday = start
		}
	}
	last := start
	if r.End != nil && int64(*r.End) > last {
		last = int64(*r.End)
	}
	if last > st.LastActivity {
		st.LastActivity, st.LastCamera = last, r.Camera
	}
	return st
}

var endsInS = regexp.MustCompile(`(?i)s$`)

func checkinPlace(c checkin) string {
	who := strings.TrimSpace(c.Who)
	if who == "" {
		if p := strings.TrimSpace(c.Place); p != "" {
			return p
		}
		return "home"
	}
	if endsInS.MatchString(who) {
		return who + "’"
	}
	return who + "’s"
}

func checkinOKLabel(c checkin) string {
	if who := strings.TrimSpace(c.Who); who != "" {
		return who + "’s fine"
	}
	return "All fine"
}

func checkinCamName(c checkin, id string) string {
	if n := c.CameraNames[id]; n != "" {
		return n
	}
	return id
}

// checkinPlaceAt is "at Mom’s" / "en casa de Mom" / "chez Mom" / "bei Mom" / "na casa de Mom".
func checkinPlaceAt(lang string, c checkin) string {
	if who := strings.TrimSpace(c.Who); who != "" {
		if lang == "en" {
			who = checkinPlace(c) // the English possessive
		}
		return tr(lang, "checkin.at.who", who)
	}
	if p := strings.TrimSpace(c.Place); p != "" {
		return tr(lang, "checkin.at.place", p)
	}
	return tr(lang, "checkin.at.home")
}

func checkinLastText(lang string, c checkin, st checkinState, now int64, loc *time.Location) string {
	if st.LastActivity != 0 {
		return tr(lang, "checkin.lastActive", checkinCamName(c, st.LastCamera), whenText(lang, st.LastActivity, now, loc))
	}
	names := make([]string, len(c.Cameras))
	for i, id := range c.Cameras {
		names[i] = checkinCamName(c, id)
	}
	if len(names) == 0 {
		return tr(lang, "checkin.notSeenAny")
	}
	return tr(lang, "checkin.notSeen", joinOr(lang, names))
}

// dueCheckin is what's due at now, and the state after sending it, worded in lang. quietNow:
// the user's quiet hours are on (check-ins wait unless DuringQuietHours).
func dueCheckin(lang string, c checkin, st checkinState, now int64, quietNow bool, loc *time.Location) ([]checkinNotice, checkinState) {
	lang = normLang(lang)
	st = rollDay(st, now, loc)
	var out []checkinNotice
	if !c.Enabled || len(c.Cameras) == 0 || (quietNow && !c.DuringQuietHours) {
		return out, st
	}
	today := st.Day
	place := checkinPlaceAt(lang, c)
	midnight := atTimeOfDay(now, "00:00", loc)
	okToday := st.OKAt != 0 && dayKey(st.OKAt, loc) == today

	if c.ByTime != "" && st.FiredByTime != today {
		due := atTimeOfDay(now, c.ByTime, loc)
		if now >= due && st.FirstToday == 0 && !okToday && st.WatchingSince <= midnight {
			out = append(out, checkinNotice{Kind: "by-time", Title: tr(lang, "checkin.byTime.title", place),
				Body: tr(lang, "checkin.byTime.body", clockAt(lang, now, loc), checkinLastText(lang, c, st, now, loc))})
			st.FiredByTime = today
		}
	}

	if c.QuietLimitHours > 0 {
		from := atTimeOfDay(now, c.DayStart, loc)
		until := atTimeOfDay(now, c.DayEnd, loc)
		if now >= from && now < until {
			since := max(st.LastActivity, st.OKAt, from, st.WatchingSince)
			if float64(now-since) >= c.QuietLimitHours*3600 && st.FiredQuietFor != since {
				hours := trCount(lang, "checkin.hours", c.QuietLimitHours, decimalText(lang, c.QuietLimitHours, -1))
				out = append(out, checkinNotice{Kind: "quiet", Title: tr(lang, "checkin.quiet.title", place, hours),
					Body: checkinLastText(lang, c, st, now, loc)})
				st.FiredQuietFor = since
			}
		}
	}

	if c.SummaryTime != "" && st.SummarySent != today && now >= atTimeOfDay(now, c.SummaryTime, loc) {
		if st.FirstToday != 0 {
			moments := trCount(lang, "checkin.moments", float64(st.MomentsToday), st.MomentsToday)
			out = append(out, checkinNotice{Kind: "summary", Title: tr(lang, "checkin.normal.title", place),
				Body: tr(lang, "checkin.normal.body", clockAt(lang, st.FirstToday, loc), moments)})
		} else {
			out = append(out, checkinNotice{Kind: "summary", Title: tr(lang, "checkin.none.title", place),
				Body: checkinLastText(lang, c, st, now, loc)})
		}
		st.SummarySent = today
	}
	return out, st
}

// ---- runner ----

type checkinRunner struct {
	path   string
	store  *store
	pusher pusher
	// allow: may this phone see this camera (nil = yes).
	allow func(d device, camera string) bool
	// recent lists recorder events on these cameras since after (nil = can't double-check).
	recent func(ctx context.Context, cameras []string, after float64) ([]backend.Event, error)
	now    func() time.Time

	mu      sync.Mutex
	states  map[string]checkinState // deviceID|checkinID
	dirty   bool
	savedAt int64
}

type checkinFile struct {
	SavedAt int64                   `json:"savedAt"`
	States  map[string]checkinState `json:"states"`
}

func openCheckins(dir string, s *store, p pusher) (*checkinRunner, error) {
	r := &checkinRunner{path: filepath.Join(dir, "checkins.json"), store: s, pusher: p, now: time.Now, states: map[string]checkinState{}}
	b, err := os.ReadFile(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	var f checkinFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("checkins.json: %w", err)
	}
	if f.States != nil {
		r.states = f.States
	}
	// Whatever happened while the Hub was off is fetched from the recorder on the first tick.
	for k, st := range r.states {
		if f.SavedAt > 0 && (st.BackfillFrom == 0 || st.BackfillFrom > f.SavedAt-300) {
			st.BackfillFrom = f.SavedAt - 300
		}
		r.states[k] = st
	}
	r.savedAt = f.SavedAt
	return r, nil
}

func (r *checkinRunner) save() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	if !r.dirty {
		r.mu.Unlock()
		return nil
	}
	f := checkinFile{SavedAt: r.now().Unix(), States: r.states}
	b, err := json.MarshalIndent(f, "", "  ")
	r.dirty = false
	r.mu.Unlock()
	if err != nil {
		return err
	}
	return writeFileAtomic(r.path, b)
}

func (r *checkinRunner) run(ctx context.Context, every time.Duration) {
	if r == nil {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		r.tick(ctx)
		select {
		case <-ctx.Done():
			_ = r.save()
			return
		case <-t.C:
		}
	}
}

func checkinKey(deviceID, id string) string { return deviceID + "|" + id }

// effective is the check-in limited to the cameras this phone may see, with its zone.
func (r *checkinRunner) effective(d device, c checkin) (checkin, *time.Location) {
	var cams []string
	for _, id := range c.Cameras {
		if r.allow == nil || r.allow(d, id) {
			cams = append(cams, id)
		}
	}
	c.Cameras = cams
	return c, zoneFor(c.Timezone, d.Timezone)
}

// newStateLocked starts watching a check-in; today's events are fetched from the recorder.
func (r *checkinRunner) stateLocked(key string, now int64, loc *time.Location) checkinState {
	st, ok := r.states[key]
	if !ok {
		st = checkinState{WatchingSince: now, BackfillFrom: atTimeOfDay(now, "00:00", loc)}
		r.states[key] = st
		r.dirty = true
	}
	return st
}

// observe feeds a live event to every check-in it counts for (backend.Sink path).
func (r *checkinRunner) observe(ev backend.Event) {
	if r == nil {
		return
	}
	now := r.now().Unix()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, d := range r.store.all() {
		for _, c0 := range d.Checkins {
			c, loc := r.effective(d, c0)
			if !c.Enabled || !checkinCounts(c, ev) {
				continue
			}
			k := checkinKey(d.ID, c.ID)
			st := r.stateLocked(k, now, loc)
			r.states[k] = observeCheckin(c, st, ev, now, loc)
			r.dirty = true
		}
	}
}

// tick sends whatever check-in notices are due, after double-checking with the recorder.
func (r *checkinRunner) tick(ctx context.Context) {
	now := r.now().Unix()
	var msgs []pushMessage
	live := map[string]bool{}
	for _, d := range r.store.all() {
		for _, c0 := range d.Checkins {
			k := checkinKey(d.ID, c0.ID)
			live[k] = true
			c, loc := r.effective(d, c0)
			if !c.Enabled || len(c.Cameras) == 0 {
				continue
			}
			quiet := inQuietHours(d, time.Unix(now, 0))

			r.mu.Lock()
			st := r.stateLocked(k, now, loc)
			r.mu.Unlock()

			// Fill gaps (new check-in: since midnight; after a restart: since the last save).
			var fetched []backend.Event
			backfilled := false
			if st.BackfillFrom != 0 && r.recent != nil {
				if evs, err := r.recent(ctx, c.Cameras, float64(st.BackfillFrom)); err == nil {
					fetched, backfilled = evs, true
				}
			}
			// Before saying "no activity", ask the recorder (events can be missed by the stream).
			notices, _ := dueCheckin(d.Lang, c, r.apply(c, st, fetched, now, loc, backfilled), now, quiet, loc)
			verifyNote := ""
			if needsVerify(notices) && r.recent != nil {
				after := float64(atTimeOfDay(now, "00:00", loc))
				if st.LastActivity > 0 {
					after = min(after, float64(st.LastActivity))
				}
				if evs, err := r.recent(ctx, c.Cameras, after); err == nil {
					fetched = append(fetched, evs...)
				} else {
					verifyNote = tr(d.Lang, "checkin.verifyFailed")
				}
			}

			r.mu.Lock()
			st = r.apply(c, r.stateLocked(k, now, loc), fetched, now, loc, backfilled)
			notices, st = dueCheckin(d.Lang, c, st, now, quiet, loc)
			if !equalState(st, r.states[k]) {
				r.states[k] = st
				r.dirty = true
			}
			r.mu.Unlock()

			for _, n := range notices {
				if n.Kind != "summary" {
					n.Body += verifyNote
				}
				msgs = append(msgs, checkinMessage(d, c, st, n))
			}
		}
	}
	r.mu.Lock()
	for k := range r.states {
		if !live[k] {
			delete(r.states, k)
			r.dirty = true
		}
	}
	r.mu.Unlock()
	if err := r.save(); err != nil {
		log.Printf("check-ins: saving state: %v", err)
	}
	if len(msgs) > 0 {
		sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := r.pusher.send(sctx, msgs); err != nil {
			log.Printf("check-in push failed: %v", err)
		}
	}
}

// apply observes fetched events; a successful backfill from midnight means today was watched.
func (r *checkinRunner) apply(c checkin, st checkinState, evs []backend.Event, now int64, loc *time.Location, backfilled bool) checkinState {
	for _, ev := range evs {
		st = observeCheckin(c, st, ev, now, loc)
	}
	if backfilled && st.BackfillFrom != 0 {
		if st.BackfillFrom <= atTimeOfDay(now, "00:00", loc) {
			st.WatchingSince = min(st.WatchingSince, st.BackfillFrom)
		}
		st.BackfillFrom = 0
	}
	return st
}

func needsVerify(ns []checkinNotice) bool {
	for _, n := range ns {
		if n.Kind != "summary" {
			return true
		}
	}
	return false
}

func equalState(a, b checkinState) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func checkinMessage(d device, c checkin, st checkinState, n checkinNotice) pushMessage {
	cam := st.LastCamera
	if cam == "" || !slices.Contains(c.Cameras, cam) {
		cam = c.Cameras[0]
	}
	m := pushMessage{
		To: d.PushToken, Title: n.Title, Body: n.Body, Sound: "default", Priority: "high",
		ThreadID:   "checkin:" + c.ID,
		CategoryID: "checkin-" + c.ID, // "Watch Kitchen" / "Call Mom" / "Mom's fine", registered by the app
		Data: map[string]string{
			"kind": "checkin", "checkinId": c.ID, "notice": n.Kind, "systemId": d.SystemID, "cameraId": cam,
		},
	}
	// A missing check-in is worth breaking through Focus (unless the user asked it to wait).
	if n.Kind != "summary" && c.DuringQuietHours {
		m.InterruptionLevel = "time-sensitive"
	}
	return forDevice(d, m, channelCheckins)
}

// markOK is "Mom's fine" from the notification.
func (r *checkinRunner) markOK(deviceID, id string) bool {
	if r == nil {
		return false
	}
	d, ok := r.store.get(deviceID)
	if !ok {
		return false
	}
	for _, c := range d.Checkins {
		if c.ID != id {
			continue
		}
		now := r.now().Unix()
		r.mu.Lock()
		st := r.stateLocked(checkinKey(deviceID, id), now, zoneFor(c.Timezone, d.Timezone))
		st.OKAt = now
		r.states[checkinKey(deviceID, id)] = st
		r.dirty = true
		r.mu.Unlock()
		_ = r.save()
		return true
	}
	return false
}

// statesFor is each of a phone's check-ins' current state (for the app's status line).
func (r *checkinRunner) statesFor(d device) map[string]checkinState {
	out := map[string]checkinState{}
	if r == nil {
		return out
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now().Unix()
	for _, c := range d.Checkins {
		if st, ok := r.states[checkinKey(d.ID, c.ID)]; ok {
			st.TodayIDs = nil
			out[c.ID] = rollDay(st, now, zoneFor(c.Timezone, d.Timezone))
		}
	}
	return out
}

// recentEvents asks each camera's recorder for its events since after (public IDs).
func (h *hub) recentEvents(ctx context.Context, cameras []string, after float64) ([]backend.Event, error) {
	bySystem := map[*system][]string{}
	for _, id := range cameras {
		if s, native, ok := h.resolve(id); ok {
			bySystem[s] = append(bySystem[s], native)
		}
	}
	var out []backend.Event
	var firstErr error
	for s, natives := range bySystem {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		evs, err := s.b.Events(cctx, backend.EventQuery{Cameras: natives, After: after, Limit: 500})
		cancel()
		if err != nil {
			if !errors.Is(err, backend.ErrUnsupported) && firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, e := range evs {
			e.ID, e.Camera = s.publicID(e.ID), s.publicID(e.Camera)
			out = append(out, e)
		}
	}
	return out, firstErr
}
