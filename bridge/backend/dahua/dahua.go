// Package dahua is the Hub backend for Dahua recorders and cameras, and the many brands built
// on them (Amcrest, Lorex and other OEM models). It speaks Dahua's CGI API (Digest auth) for
// cameras, snapshots, file search, PTZ and health, RTSP for live view and playback, and the
// eventManager attach stream for Instant Alerts.
//
// Ported from the app's reviewed adapter (app/src/systems/dahua.ts). Channels are 1-based
// everywhere except the ChannelTitle table, file-search replies and event indexes (0-based).
// All device times are local device time; see clock.go.
//
// Not offered: clip export (recordings download as Dahua's own .dav format, which phones can't
// play or save) and HLS VOD (recordings play through Player as an RTSP replay).
package dahua

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const (
	label = "Dahua, Amcrest or Lorex"
	// findNextFile returns at most 100 files per call (Amcrest HTTP API §4.11.5).
	page = 100
	// A search that hits the page cap is split in halves (newest first) down to this size.
	minSplit   = 3600.0
	clockTTL   = 30 * time.Minute
	channelTTL = 5 * time.Minute
	apiTimeout = 20 * time.Second
)

// videoTypes are recordings (not the JPG pictures the recorder also stores).
var videoTypes = []string{"dav", "mp4"}

var errNotDahua = errors.New("this doesn't look like a Dahua, Amcrest or Lorex device. Check the address")

func init() {
	backend.Register(backend.Descriptor{
		Kind:        "dahua",
		Label:       "Dahua, Amcrest or Lorex recorder or camera",
		Description: "Also other recorders and cameras made by Dahua.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Recorder or camera address", Hint: "192.168.1.108"},
			{Key: backend.FieldUsername, Label: "Username", Default: "admin"},
			{Key: backend.FieldPassword, Label: "Password",
				Help: "The one you use on the recorder's screen or in its app."},
		},
		DefaultPorts: []int{80, 443},
		New:          func(c backend.Config) (backend.Backend, error) { return New(c) },
		Probe: func(ctx context.Context, c backend.Config) error {
			d, err := New(c)
			if err != nil {
				return err
			}
			return d.Probe(ctx)
		},
	})
}

// Dahua is one recorder or camera.
type Dahua struct {
	cfg  backend.Config
	c    *httpx.Client
	host string
	// loc is the Hub's time zone, the device's assumed zone when their offsets agree.
	loc *time.Location
	now func() time.Time

	mu        sync.Mutex
	channels  []channel
	chanAt    time.Time
	ptzCaps   map[int][2]bool // channel → {canMove, canZoom}
	presets   map[int][]preset
	rtspPort  int
	clk       clock
	clkAt     time.Time
	clkSet    bool
	evFilter  int // findFile honors Flag=Event/VideoStream=Main: 0 unknown, 1 yes, -1 no
	lastMove  map[int]string
	finder    chan struct{} // devices allow only a few open file finders: one search at a time
	events    *tracker
	streamURL string // event stream path (heartbeat dropped if the device refuses it)
}

// New builds the backend (no network I/O).
func New(cfg backend.Config) (*Dahua, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("the address isn't valid (it should look like 192.168.1.108)")
	}
	return &Dahua{
		cfg:       cfg,
		c:         httpx.New(cfg.URL, cfg.Username, cfg.Password, httpx.WithTimeout(apiTimeout)),
		host:      u.Hostname(),
		loc:       time.Local,
		now:       time.Now,
		ptzCaps:   map[int][2]bool{},
		presets:   map[int][]preset{},
		lastMove:  map[int]string{},
		finder:    make(chan struct{}, 1),
		events:    newTracker(nil),
		streamURL: "/cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5",
	}, nil
}

func (d *Dahua) ID() string    { return d.cfg.ID }
func (d *Dahua) Kind() string  { return "dahua" }
func (d *Dahua) Label() string { return label }

// Capabilities: PTZ is reported once the channels are known to include a PTZ camera (until
// then it's assumed, and each Camera.PTZ says which really move).
func (d *Dahua) Capabilities() backend.Capabilities {
	d.mu.Lock()
	ptz := d.channels == nil
	for _, c := range d.ptzCaps {
		ptz = ptz || c[0] || c[1]
	}
	d.mu.Unlock()
	return backend.Capabilities{Snapshots: true, Events: true, Recordings: true, Clips: false, PTZ: ptz, Alerts: true}
}

// ---- HTTP ----

type lockedError struct{ err error }

func (e *lockedError) Error() string {
	return "the device has locked this account after too many wrong passwords. Wait 30 minutes, or unlock it from the recorder's screen"
}
func (e *lockedError) Unwrap() error { return e.err }

// cgi fetches /cgi-bin/<path> and returns the body.
func (d *Dahua) cgi(ctx context.Context, path string) (string, error) {
	b, _, err := d.c.GetBytes(ctx, "/cgi-bin/"+path)
	if err != nil {
		var se *httpx.StatusError
		if errors.As(err, &se) && strings.Contains(strings.ToLower(se.Body), "locked") {
			return "", &lockedError{err}
		}
		return "", err
	}
	return string(b), nil
}

func (d *Dahua) kv(ctx context.Context, path string) (map[string]string, error) {
	body, err := d.cgi(ctx, path)
	if err != nil {
		return nil, err
	}
	return parseKV(body), nil
}

// Probe checks the address and password and that this is a Dahua-style device.
func (d *Dahua) Probe(ctx context.Context) error {
	body, err := d.cgi(ctx, "magicBox.cgi?action=getDeviceType")
	if err != nil {
		if errors.Is(err, backend.ErrNotFound) {
			return errNotDahua
		}
		return err
	}
	if isErrorBody(body) || parseKV(body)["type"] == "" {
		return errNotDahua
	}
	_, err = d.Cameras(ctx)
	return err
}

// ---- channels and cameras ----

func (d *Dahua) loadChannels(ctx context.Context) ([]channel, error) {
	d.mu.Lock()
	if d.channels != nil && d.now().Sub(d.chanAt) < channelTTL {
		ch := d.channels
		d.mu.Unlock()
		return ch, nil
	}
	d.mu.Unlock()
	titles, err := d.kv(ctx, "configManager.cgi?action=getConfig&name=ChannelTitle")
	if err != nil {
		return nil, err
	}
	// Recorders only: which slots have a camera. Cameras answer with an error; that's fine.
	remote, _ := d.kv(ctx, "configManager.cgi?action=getConfig&name=RemoteDevice")
	chans := parseChannels(titles, remote)
	if len(chans) == 0 {
		name := d.cfg.Name
		if name == "" {
			name = "Camera"
		}
		chans = []channel{{Number: 1, Name: name, Enabled: true}}
	}
	// Which channels can pan/tilt/zoom (one cheap request each; a failure means "no").
	caps := make(map[int][2]bool, len(chans))
	var wg sync.WaitGroup
	var cmu sync.Mutex
	sem := make(chan struct{}, 4)
	for _, c := range chans {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var mv, zm bool
			if kv, err := d.kv(ctx, fmt.Sprintf("ptz.cgi?action=getCurrentProtocolCaps&channel=%d", c.Number)); err == nil {
				mv, zm = parsePTZCaps(kv)
			}
			cmu.Lock()
			caps[c.Number] = [2]bool{mv, zm}
			cmu.Unlock()
		}()
	}
	wg.Wait()
	d.mu.Lock()
	d.channels, d.chanAt, d.ptzCaps = chans, d.now(), caps
	d.mu.Unlock()
	return chans, nil
}

func (d *Dahua) Cameras(ctx context.Context) ([]backend.Camera, error) {
	chans, err := d.loadChannels(ctx)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]backend.Camera, 0, len(chans))
	for _, c := range chans {
		caps := d.ptzCaps[c.Number]
		out = append(out, backend.Camera{
			ID: strconv.Itoa(c.Number), Name: c.Name, Enabled: c.Enabled, PTZ: caps[0] || caps[1],
			Aspect: 16.0 / 9, Zones: []string{}, Objects: []string{"person", "vehicle", "motion"},
		})
	}
	return out, nil
}

func (d *Dahua) Snapshot(ctx context.Context, camera string, height int) ([]byte, string, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return nil, "", err
	}
	b, ct, err := d.c.GetBytes(ctx, fmt.Sprintf("/cgi-bin/snapshot.cgi?channel=%d", ch))
	if err != nil {
		return nil, "", err
	}
	if !strings.HasPrefix(ct, "image/") {
		ct = "image/jpeg"
	}
	return b, ct, nil
}

// ---- live and playback ----

func (d *Dahua) rtspPortOf(ctx context.Context) int {
	d.mu.Lock()
	p := d.rtspPort
	d.mu.Unlock()
	if p > 0 {
		return p
	}
	p = 554
	if kv, err := d.kv(ctx, "configManager.cgi?action=getConfig&name=RTSP"); err == nil {
		if n, _ := strconv.Atoi(kv["table.RTSP.Port"]); n > 0 && n < 65536 {
			p = n
		}
		d.mu.Lock()
		d.rtspPort = p
		d.mu.Unlock()
	}
	return p
}

func (d *Dahua) rtsp(ctx context.Context, path string) string {
	return rtspURL(d.host, d.rtspPortOf(ctx), d.cfg.Username, d.cfg.Password, path)
}

func (d *Dahua) Live(ctx context.Context, camera, quality string) (backend.LiveSource, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return backend.LiveSource{}, err
	}
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: d.rtsp(ctx, livePath(ch, quality))}, nil
}

// Playback replays [start, end] over RTSP (device-local times). A quick file search checks
// there's something recorded, and moves the start to the first recording when it's later.
func (d *Dahua) Playback(ctx context.Context, camera string, start, end float64) (backend.Playback, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return backend.Playback{}, err
	}
	c := d.clock(ctx)
	var first float64
	if files, _, err := d.findFiles(ctx, ch, start, end, findOpts{types: videoTypes, maxPages: 1, count: 1}); err == nil {
		if len(files) == 0 {
			return backend.Playback{}, backend.ErrNotFound
		}
		if s, ok := c.fromDevice(files[0].StartTime); ok && s > start+1 && s < end {
			first = s
		}
	} else if ctx.Err() != nil {
		return backend.Playback{}, ctx.Err()
	}
	from := start
	if first > 0 {
		from = first
	}
	return backend.Playback{
		Live:      &backend.LiveSource{Kind: backend.LiveRTSP, URL: d.rtsp(ctx, playbackPath(ch, from, end, c))},
		StartTime: first,
	}, nil
}

func (d *Dahua) VOD(context.Context, string, int64, int64, string, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// Clip isn't offered: Dahua exports .dav files, which phones can't play or save.
func (d *Dahua) Clip(context.Context, string, int64, int64, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// ---- clock ----

// clock is the device clock, refreshed every 30 minutes.
func (d *Dahua) clock(ctx context.Context) clock {
	d.mu.Lock()
	if d.clkSet && d.now().Sub(d.clkAt) < clockTTL {
		c := d.clk
		d.mu.Unlock()
		return c
	}
	d.mu.Unlock()
	sent := d.now()
	body, err := d.cgi(ctx, "global.cgi?action=getCurrentTime")
	var c clock
	if err == nil {
		mid := sent.Add(d.now().Sub(sent) / 2)
		c, err = measureClock(body, mid, d.loc)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if err != nil {
		// Fall back to "the device is in the Hub's zone" (true for nearly every home).
		if !d.clkSet {
			return localClock(d.loc)
		}
		return d.clk
	}
	d.clk, d.clkAt, d.clkSet = c, d.now(), true
	return c
}

// ---- file search: factory.create → findFile → findNextFile… → close → destroy ----

type findOpts struct {
	types       []string
	flags       []string
	videoStream string
	maxPages    int
	count       int
}

// findFiles runs one search (oldest first). complete is false when the page cap stopped it.
func (d *Dahua) findFiles(ctx context.Context, ch int, after, before float64, o findOpts) (files []file, complete bool, err error) {
	select {
	case d.finder <- struct{}{}:
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
	defer func() { <-d.finder }()
	c := d.clock(ctx)
	body, err := d.cgi(ctx, "mediaFileFind.cgi?action=factory.create")
	if err != nil {
		return nil, false, err
	}
	id := parseFinderID(body)
	if id == "" {
		return nil, false, errors.New("the recorder couldn't start a search. Try again in a moment")
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_, _ = d.cgi(cctx, "mediaFileFind.cgi?action=close&object="+id)
		_, _ = d.cgi(cctx, "mediaFileFind.cgi?action=destroy&object="+id)
	}()
	count := o.count
	if count <= 0 || count > page {
		count = page
	}
	maxPages := o.maxPages
	if maxPages <= 0 {
		maxPages = 20
	}
	q := findFileQuery(findCond{
		Object: id, Channel: ch, Start: c.deviceTime(after), End: c.deviceTime(before),
		Types: o.types, Flags: o.flags, VideoStream: o.videoStream,
	})
	// "OK" when something matches, "Error" when nothing does (or there's no disk).
	body, err = d.cgi(ctx, "mediaFileFind.cgi?"+q)
	if err != nil {
		return nil, false, err
	}
	if isErrorBody(body) {
		return nil, true, nil
	}
	for p := 0; p < maxPages; p++ {
		next, err := d.cgi(ctx, fmt.Sprintf("mediaFileFind.cgi?action=findNextFile&object=%s&count=%d", id, count))
		if err != nil {
			return files, false, err
		}
		if isErrorBody(next) {
			return files, true, nil
		}
		found, batch := parseFindNext(next)
		files = append(files, batch...)
		if found < count {
			return files, true, nil
		}
	}
	return files, false, nil
}

// walkNewestFirst searches [after, before] one device-local day at a time from the newest, so
// a busy recorder's page cap never hides the most recent files. A search that still hits the
// cap is split in halves, newer half first. take gets each piece's files (newest piece first)
// and returns true to stop.
func (d *Dahua) walkNewestFirst(ctx context.Context, ch int, after, before float64, opts func() findOpts,
	take func(files []file, from, to float64) (bool, error)) error {
	var visit func(a, b float64) (bool, error)
	visit = func(a, b float64) (bool, error) {
		files, complete, err := d.findFiles(ctx, ch, a, b, opts())
		if err != nil {
			return false, err
		}
		if !complete && b-a > minSplit {
			mid := math.Floor((a + b) / 2)
			if stop, err := visit(mid, b); stop || err != nil {
				return stop, err
			}
			return visit(a, mid)
		}
		return take(files, a, b)
	}
	for _, r := range dayRanges(after, before, d.clock(ctx), 62) {
		if stop, err := visit(r[0], r[1]); stop || err != nil {
			return err
		}
	}
	return nil
}

func (d *Dahua) Segments(ctx context.Context, camera string, after, before float64) ([]backend.Segment, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return nil, err
	}
	var files []file
	err = d.walkNewestFirst(ctx, ch, after, before, func() findOpts { return findOpts{types: videoTypes} },
		func(batch []file, _, _ float64) (bool, error) {
			files = append(files, batch...)
			return false, nil
		})
	if err != nil {
		return nil, err
	}
	segs := filesToSegments(files, d.clock(ctx), 2)
	if segs == nil {
		segs = []backend.Segment{}
	}
	return segs, nil
}

// ---- events (recordings the device flagged with events) ----

// eventOpts: video, event-flagged, main stream (unless the device ignores those filters).
func (d *Dahua) eventOpts() findOpts {
	d.mu.Lock()
	f := d.evFilter
	d.mu.Unlock()
	if f < 0 {
		return findOpts{types: videoTypes}
	}
	return findOpts{types: videoTypes, flags: []string{"Event"}, videoStream: "Main"}
}

func (d *Dahua) setEventFilter(v int) {
	d.mu.Lock()
	d.evFilter = v
	d.mu.Unlock()
}

// cameraEvents is one camera's newest limit events in [after, before].
func (d *Dahua) cameraEvents(ctx context.Context, ch int, after, before float64, severity string, limit int) ([]backend.Event, error) {
	c := d.clock(ctx)
	seen := map[string]bool{}
	var out []backend.Event
	keep := func(files []file) []backend.Event {
		var items []backend.Event
		for _, e := range filesToEvents(files, c) {
			if (severity == "" || e.Severity == severity) && e.Start >= after && e.Start <= before {
				items = append(items, e)
			}
		}
		return items
	}
	err := d.walkNewestFirst(ctx, ch, after, before, d.eventOpts, func(files []file, a, b float64) (bool, error) {
		items := keep(files)
		d.mu.Lock()
		unknown := d.evFilter == 0
		d.mu.Unlock()
		if unknown {
			if len(items) > 0 {
				d.setEventFilter(1)
			} else {
				// Nothing with the event filter: either a quiet day, or a device that ignores
				// the filter. A plain search of the same span tells them apart.
				plain, _, err := d.findFiles(ctx, ch, a, b, findOpts{types: videoTypes})
				if err != nil {
					return false, err
				}
				if p := keep(plain); len(p) > 0 {
					d.setEventFilter(-1)
					items = p
				}
			}
		}
		for _, e := range items {
			if !seen[e.ID] {
				seen[e.ID] = true
				out = append(out, e)
			}
		}
		return len(out) >= limit, nil
	})
	return out, err
}

// Events lists event recordings, newest first. Each camera is searched day by day from Before
// back to After and stops once it has Limit events, so a busy recorder shows its latest events.
func (d *Dahua) Events(ctx context.Context, q backend.EventQuery) ([]backend.Event, error) {
	before := q.Before
	if before <= 0 {
		before = float64(d.now().Unix() + 60)
	}
	after := q.After
	if after <= 0 {
		after = before - 86400
	}
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	cams := q.Cameras
	if len(cams) == 0 {
		chans, err := d.loadChannels(ctx)
		if err != nil {
			return nil, err
		}
		for _, c := range chans {
			if c.Enabled {
				cams = append(cams, strconv.Itoa(c.Number))
			}
		}
	}
	var items []backend.Event
	var firstErr error
	failed := 0
	for _, cam := range cams {
		ch, err := parseChannelID(cam)
		if err == nil {
			var evs []backend.Event
			evs, err = d.cameraEvents(ctx, ch, after, before, q.Severity, limit)
			items = append(items, evs...)
		}
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	// One camera failing shouldn't hide the others' events, but if every search failed the
	// user should see why rather than an empty list.
	if len(cams) > 0 && failed == len(cams) {
		return nil, firstErr
	}
	sortNewest(items)
	if len(items) > limit {
		items = items[:limit]
	}
	if items == nil {
		items = []backend.Event{}
	}
	return items, nil
}

func sortNewest(evs []backend.Event) {
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Start > evs[j].Start })
}

// Event finds one event: a recent live alert, or the recording that starts (or is running) at
// the time in its ID.
func (d *Dahua) Event(ctx context.Context, id string) (backend.Event, error) {
	if e, ok := d.events.lookup(id); ok {
		return e, nil
	}
	ch, start, err := parseEventID(id)
	if err != nil {
		return backend.Event{}, err
	}
	files, _, err := d.findFiles(ctx, ch, start-2, start+2, findOpts{types: videoTypes, maxPages: 1})
	if err != nil {
		return backend.Event{}, err
	}
	evs := filesToEvents(files, d.clock(ctx))
	for _, e := range evs {
		if e.ID == id {
			return e, nil
		}
	}
	// A live alert's ID (from before a Hub restart) names the moment it fired, inside a recording.
	for _, e := range evs {
		if e.Start <= start && (e.End == nil || *e.End >= start) {
			e.ID = id
			return e, nil
		}
	}
	return backend.Event{}, backend.ErrNotFound
}

// EventThumbnail is a picture the recorder saved during the event (when it's set to save them).
func (d *Dahua) EventThumbnail(ctx context.Context, id string) ([]byte, string, error) {
	e, err := d.Event(ctx, id)
	if err != nil {
		return nil, "", err
	}
	ch, _ := strconv.Atoi(e.Camera)
	end := e.Start + 60
	if e.End != nil && *e.End > e.Start {
		end = math.Min(*e.End, e.Start+600)
	}
	files, _, err := d.findFiles(ctx, ch, e.Start-5, end+5, findOpts{types: []string{"jpg"}, maxPages: 1})
	if err != nil {
		return nil, "", err
	}
	c := d.clock(ctx)
	path := ""
	for _, f := range files {
		t, ok := c.fromDevice(f.StartTime)
		if f.Type != "jpg" || f.FilePath == "" || f.Channel != ch || !ok || t < e.Start-5 || t > end+5 {
			continue
		}
		if path == "" || len(f.Events) > 0 {
			path = f.FilePath
			if len(f.Events) > 0 {
				break
			}
		}
	}
	if path == "" {
		return nil, "", backend.ErrNotFound
	}
	b, ct, err := d.c.GetBytes(ctx, fileURLPath(path))
	if err != nil {
		return nil, "", err
	}
	if !strings.HasPrefix(ct, "image/") {
		ct = "image/jpeg"
	}
	return b, ct, nil
}

// ---- PTZ (ptz.cgi): moves are continuous between start and stop, matching the app's pad ----

func (d *Dahua) PTZInfo(ctx context.Context, camera string) (backend.PTZInfo, error) {
	ch, err := parseChannelID(camera)
	if err != nil {
		return backend.PTZInfo{}, err
	}
	// A camera without PTZ answers with an error: that just means "can't move".
	caps, err := d.kv(ctx, fmt.Sprintf("ptz.cgi?action=getCurrentProtocolCaps&channel=%d", ch))
	if err != nil && (errors.Is(err, httpx.ErrAuth) || ctx.Err() != nil) {
		return backend.PTZInfo{}, err
	}
	presetKV, _ := d.kv(ctx, fmt.Sprintf("ptz.cgi?action=getPresets&channel=%d", ch))
	mv, zm := parsePTZCaps(caps)
	ps := parsePresets(presetKV)
	d.mu.Lock()
	d.ptzCaps[ch] = [2]bool{mv, zm}
	d.presets[ch] = ps
	d.mu.Unlock()
	names := make([]string, 0, len(ps))
	for _, p := range ps {
		names = append(names, p.Name)
	}
	return backend.PTZInfo{CanMove: mv, CanZoom: zm, Presets: names}, nil
}

func (d *Dahua) PTZ(ctx context.Context, camera, action string) error {
	ch, err := parseChannelID(camera)
	if err != nil {
		return err
	}
	if name, ok := strings.CutPrefix(action, "preset_"); ok {
		d.mu.Lock()
		ps, known := d.presets[ch]
		d.mu.Unlock()
		if !known {
			if _, err := d.PTZInfo(ctx, camera); err != nil {
				return err
			}
			d.mu.Lock()
			ps = d.presets[ch]
			d.mu.Unlock()
		}
		for _, p := range ps {
			if p.Name == name {
				return d.ptzCall(ctx, fmt.Sprintf("ptz.cgi?action=start&channel=%d&code=GotoPreset&arg1=0&arg2=%d&arg3=0", ch, p.Index))
			}
		}
		return fmt.Errorf("%w: that preset no longer exists on the camera", backend.ErrNotFound)
	}
	if action == "STOP" {
		d.mu.Lock()
		code := d.lastMove[ch]
		delete(d.lastMove, ch)
		d.mu.Unlock()
		if code == "" {
			return nil
		}
		return d.ptzCall(ctx, fmt.Sprintf("ptz.cgi?action=stop&channel=%d&code=%s&arg1=0&arg2=0&arg3=0", ch, code))
	}
	code := ptzCode(action)
	if code == "" {
		return errors.New("unknown PTZ action")
	}
	d.mu.Lock()
	d.lastMove[ch] = code
	d.mu.Unlock()
	// arg2 is the speed (1–8) for pan/tilt.
	return d.ptzCall(ctx, fmt.Sprintf("ptz.cgi?action=start&channel=%d&code=%s&arg1=0&arg2=4&arg3=0", ch, code))
}

func (d *Dahua) ptzCall(ctx context.Context, path string) error {
	body, err := d.cgi(ctx, path)
	if err != nil {
		return err
	}
	if isErrorBody(body) {
		return errors.New("the camera didn't accept that move")
	}
	return nil
}

// ---- health ----

func (d *Dahua) Health(ctx context.Context) (backend.Health, error) {
	chans, err := d.loadChannels(ctx)
	if err != nil {
		return backend.Health{}, err
	}
	loss, _ := d.cgi(ctx, "eventManager.cgi?action=getEventIndexes&code=VideoLoss")
	disks, _ := d.kv(ctx, "storageDevice.cgi?action=getDeviceAllInfo")
	enabled := map[int]bool{}
	for _, c := range chans {
		enabled[c.Number] = c.Enabled
	}
	h := backend.Health{Offline: []string{}, Storage: parseStorage(disks)}
	for _, ch := range parseEventChannels(loss) {
		if enabled[ch] {
			h.Offline = append(h.Offline, strconv.Itoa(ch))
		}
	}
	return h, nil
}

// ---- live events (Instant Alerts) ----

// Watch follows the device's event stream until ctx ends, reconnecting with backoff.
func (d *Dahua) Watch(ctx context.Context, sink backend.Sink) error {
	backoff := time.Second
	for ctx.Err() == nil {
		began := time.Now()
		err := d.watchOnce(ctx, sink)
		if ctx.Err() != nil {
			break
		}
		if time.Since(began) > time.Minute {
			backoff = time.Second
		}
		if err != nil {
			log.Printf("%s: event stream: %v (reconnecting in %s)", d.cfg.ID, httpx.Explain(err), backoff)
		}
		select {
		case <-ctx.Done():
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
	return nil
}

// idleTimeout ends a stream that went quiet (heartbeats arrive every 5 seconds).
const idleTimeout = 45 * time.Second

func (d *Dahua) watchOnce(ctx context.Context, sink backend.Sink) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.mu.Lock()
	path := d.streamURL
	d.mu.Unlock()
	heartbeat := strings.Contains(path, "heartbeat=")
	req, err := d.c.NewRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	resp, err := d.c.Media.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		if heartbeat && resp.StatusCode == http.StatusBadRequest {
			// Older firmware rejects the heartbeat option: follow the stream without it.
			d.mu.Lock()
			d.streamURL = strings.Replace(path, "&heartbeat=5", "", 1)
			d.mu.Unlock()
		}
		return &httpx.StatusError{Code: resp.StatusCode}
	}
	d.events.reset()
	var body io.Reader = resp.Body
	if heartbeat {
		timer := time.AfterFunc(idleTimeout, cancel)
		defer timer.Stop()
		body = &idleReader{r: resp.Body, timer: timer}
	}
	err = readEvents(body, boundaryOf(resp.Header.Get("Content-Type")), func(ev rawEvent) {
		for _, e := range d.events.handle(ev) {
			sink.OnEvent(e)
		}
	})
	if err == nil {
		err = errors.New("the device closed the event stream")
	}
	return err
}

// idleReader pushes the idle deadline back whenever data (events or heartbeats) arrives.
type idleReader struct {
	r     io.Reader
	timer *time.Timer
}

func (i *idleReader) Read(p []byte) (int, error) {
	n, err := i.r.Read(p)
	if n > 0 {
		i.timer.Reset(idleTimeout)
	}
	return n, err
}
