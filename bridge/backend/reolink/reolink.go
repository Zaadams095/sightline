// Package reolink is the Hub backend for Reolink NVRs, the Home Hub and standalone Reolink
// cameras, through the Reolink HTTP API (/cgi-bin/api.cgi, token login). Live video is RTSP
// (turned on when it's off); recordings are MP4 files the device streams; events come from the
// trigger flags in recording file names; Instant Alerts poll the device's AI/motion state.
//
// The logic is ported from the app's reviewed adapter (app/src/systems/reolink.ts).
package reolink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

const (
	// stateTTL: device info and channels are re-read this often (online status changes).
	stateTTL = time.Minute
	// reviewDays: how far back Events searches at most.
	reviewDays = 7
	// segmentTolerance merges files this close together into one span.
	segmentTolerance = 2
)

func init() {
	backend.Register(backend.Descriptor{
		Kind:        "reolink",
		Label:       "Reolink camera, NVR or Home Hub",
		Description: "Reolink recorders (NVR), the Reolink Home Hub, and Reolink cameras on their own.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Reolink address", Hint: "192.168.1.50",
				Help: "The recorder's or camera's address on your network. The Reolink app shows it under the device's settings → Network."},
			{Key: backend.FieldUsername, Label: "Username", Default: "admin"},
			{Key: backend.FieldPassword, Label: "Password"},
		},
		DefaultPorts: []int{80, 443},
		New:          func(c backend.Config) (backend.Backend, error) { return New(c), nil },
		Probe:        func(ctx context.Context, c backend.Config) error { return New(c).Probe(ctx) },
	})
}

// state is what the device said about itself (refreshed every stateTTL).
type state struct {
	dev      devInfo
	channels []channel
	ability  *ability
	net      *netPort
	loc      *time.Location
	extras   map[int]extras
	at       time.Time
}

type extras struct {
	enc      *encValue
	rtspMain string
	rtspSub  string
}

func (s *state) channel(id string) (channel, bool) {
	ch, err := strconv.Atoi(id)
	if err != nil || ch < 0 || strconv.Itoa(ch) != id {
		return channel{}, false
	}
	for _, c := range s.channels {
		if c.Ch == ch {
			return c, true
		}
	}
	return channel{}, false
}

type Reolink struct {
	cfg  backend.Config
	c    *client
	host string // for RTSP URLs

	loadMu sync.Mutex // one load at a time

	mu      sync.Mutex
	st      *state
	known   map[int]bool // channels seen online (kept when they go offline)
	files   map[int]*fileCache
	presets map[int][]preset

	rtspMu   sync.Mutex
	rtspSent bool // SetNetPort is tried at most once
	rtspErr  error

	// Watch
	pollEvery time.Duration
	// local is the Hub's time zone (time.Local; tests pin it).
	local    *time.Location
	recentMu sync.Mutex
	recent   map[string]backend.Event
	order    []string
}

// New builds the backend; it does no network I/O.
func New(cfg backend.Config) *Reolink {
	host := cfg.URL
	if u, err := url.Parse(cfg.URL); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	return &Reolink{
		cfg: cfg, c: newClient(cfg.URL, cfg.Username, cfg.Password), host: host,
		known: map[int]bool{}, files: map[int]*fileCache{}, presets: map[int][]preset{},
		pollEvery: 2 * time.Second, local: time.Local, recent: map[string]backend.Event{},
	}
}

func (r *Reolink) ID() string    { return r.cfg.ID }
func (r *Reolink) Kind() string  { return "reolink" }
func (r *Reolink) Label() string { return "Reolink" }

// Capabilities: Reolink can't cut clips (whole recording files only) and has no HLS.
func (r *Reolink) Capabilities() backend.Capabilities {
	return backend.Capabilities{Snapshots: true, Events: true, Recordings: true, Clips: false, PTZ: true, Alerts: true, Talk: true, Deter: true}
}

// Probe signs in with a fresh session (proving the password), checks it's a Reolink device and
// closes the session again.
func (r *Reolink) Probe(ctx context.Context) error {
	tok, _, err := r.c.doLogin(ctx)
	if err != nil {
		return err
	}
	defer r.c.logout(tok)
	items, err := r.c.post(ctx, []command{cmd("GetDevInfo", nil)}, tok)
	if err != nil {
		return err
	}
	if len(items) == 0 || !items[0].ok() {
		if len(items) > 0 {
			return commandError(&items[0])
		}
		return errNotReolink
	}
	return nil
}

// load returns the device state, re-reading it when older than stateTTL.
func (r *Reolink) load(ctx context.Context) (*state, error) {
	r.mu.Lock()
	st := r.st
	r.mu.Unlock()
	if st != nil && time.Since(st.at) < stateTTL {
		return st, nil
	}
	r.loadMu.Lock()
	defer r.loadMu.Unlock()
	r.mu.Lock()
	st = r.st
	r.mu.Unlock()
	if st != nil && time.Since(st.at) < stateTTL {
		return st, nil
	}

	items, err := r.c.api(ctx,
		cmd("GetDevInfo", nil),
		cmd("GetChannelstatus", nil),
		cmd("GetAbility", map[string]any{"User": map[string]any{"userName": r.c.user}}),
		cmd("GetNetPort", nil),
		cmd("GetTime", nil),
	)
	if err != nil {
		return nil, err
	}
	by := func(name string) json.RawMessage {
		for i := range items {
			if items[i].Cmd == name && items[i].ok() {
				return items[i].Value
			}
		}
		return nil
	}
	var devItem *item
	for i := range items {
		if items[i].Cmd == "GetDevInfo" {
			devItem = &items[i]
		}
	}
	if !devItem.ok() {
		return nil, commandError(devItem)
	}
	next := &state{dev: parseDevInfo(devItem.Value), loc: r.local, extras: map[int]extras{}, at: time.Now()}
	r.mu.Lock()
	known := make(map[int]bool, len(r.known))
	for k := range r.known {
		known[k] = true
	}
	old := r.st
	r.mu.Unlock()
	next.channels = parseChannels(next.dev, by("GetChannelstatus"), known)
	if raw := by("GetAbility"); raw != nil {
		next.ability = &ability{}
		_ = json.Unmarshal(raw, next.ability)
	}
	if raw := by("GetNetPort"); raw != nil {
		next.net = parseNetPort(raw)
	} else if old != nil {
		next.net = old.net
	}
	if raw := by("GetTime"); raw != nil {
		var t struct {
			Time *wall `json:"Time"`
		}
		if json.Unmarshal(raw, &t) == nil && t.Time != nil && t.Time.Year > 0 {
			next.loc = deviceZone(*t.Time, time.Now(), r.local)
		}
	} else if old != nil {
		next.loc = old.loc
	}

	// Encoding (stream paths, aspect ratio) and, on newer firmware, the exact RTSP paths. These
	// rarely change: only channels not seen before are asked.
	var ask []int
	for _, c := range next.channels {
		if old != nil {
			if x, ok := old.extras[c.Ch]; ok && x.enc != nil {
				next.extras[c.Ch] = x
				continue
			}
		}
		ask = append(ask, c.Ch)
	}
	if len(ask) > 0 {
		var cmds []command
		for _, ch := range ask {
			cmds = append(cmds, cmd("GetEnc", chParam(ch)), cmd("GetRtspUrl", chParam(ch)))
		}
		if res, err := r.c.api(ctx, cmds...); err == nil {
			for i, ch := range ask {
				var x extras
				if 2*i < len(res) && res[2*i].ok() {
					var e encValue
					if json.Unmarshal(res[2*i].Value, &e) == nil {
						x.enc = &e
					}
				}
				if 2*i+1 < len(res) && res[2*i+1].ok() {
					x.rtspMain, x.rtspSub = parseRTSPPaths(res[2*i+1].Value)
				}
				next.extras[ch] = x
			}
		}
	}

	r.mu.Lock()
	for _, c := range next.channels {
		if c.Online {
			r.known[c.Ch] = true
		}
	}
	r.st = next
	r.mu.Unlock()
	return next, nil
}

func (r *Reolink) channelOf(ctx context.Context, id string) (*state, channel, error) {
	st, err := r.load(ctx)
	if err != nil {
		return nil, channel{}, err
	}
	c, ok := st.channel(id)
	if !ok {
		return nil, channel{}, backend.ErrNotFound
	}
	return st, c, nil
}

// ---- cameras, snapshots, live ----

func (r *Reolink) Cameras(ctx context.Context) ([]backend.Camera, error) {
	st, err := r.load(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]backend.Camera, 0, len(st.channels))
	for _, c := range st.channels {
		move, zoom := st.ability.ptzSupport(c.Ch)
		aspect := 16.0 / 9
		if x := st.extras[c.Ch].enc; x != nil && x.Enc.Main.Width > 0 && x.Enc.Main.Height > 0 {
			aspect = float64(x.Enc.Main.Width) / float64(x.Enc.Main.Height)
		}
		objects := []string{"person", "vehicle", "animal"}
		if c.Doorbell {
			objects = append(objects, "doorbell", "package")
		}
		out = append(out, backend.Camera{
			ID: strconv.Itoa(c.Ch), Name: c.Name, Enabled: true, PTZ: move || zoom,
			Aspect: aspect, Zones: []string{}, Objects: objects,
		})
	}
	return out, nil
}

// Snapshot is cmd=Snap. Small pictures use the sub stream's frame at its exact size
// (reolink_aio passes snapType=sub with the sub stream's width and height).
func (r *Reolink) Snapshot(ctx context.Context, camera string, height int) ([]byte, string, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return nil, "", err
	}
	size := ""
	if x := st.extras[c.Ch].enc; x != nil && height > 0 && height <= 480 && x.Enc.Sub.Width > 0 && x.Enc.Sub.Height > 0 {
		size = fmt.Sprintf("&snapType=sub&width=%d&height=%d", x.Enc.Sub.Width.Int(), x.Enc.Sub.Height.Int())
	}
	rs := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	resp, err := r.c.media(ctx, func(tok string) string {
		return fmt.Sprintf("/cgi-bin/api.cgi?cmd=Snap&channel=%d&rs=sl%s%s&token=%s", c.Ch, rs, size, url.QueryEscape(tok))
	}, nil, false)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := readAll(resp, 16<<20)
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "application/octet") {
		ct = "image/jpeg"
	}
	return b, ct, err
}

// ensureRTSP: RTSP must be on for live video. It's off by default on newer models, so it's
// turned on, at most once (concurrent callers share the attempt; a refusal isn't retried).
func (r *Reolink) ensureRTSP(ctx context.Context, st *state) (*netPort, error) {
	if st.net != nil && st.net.RTSPEnabled {
		return st.net, nil
	}
	r.rtspMu.Lock()
	defer r.rtspMu.Unlock()
	r.mu.Lock()
	cur := r.st
	r.mu.Unlock()
	if cur != nil && cur.net != nil && cur.net.RTSPEnabled {
		return cur.net, nil
	}
	if r.rtspSent && (r.rtspErr != nil || cur == nil || cur.net == nil) {
		if r.rtspErr != nil {
			return nil, r.rtspErr
		}
		return &netPort{RTSPPort: 554, RTSPEnabled: true}, nil
	}
	if r.rtspSent {
		return cur.net, nil
	}
	np := st.net
	if np == nil {
		raw, err := r.c.one(ctx, cmd("GetNetPort", nil))
		if err != nil {
			return nil, err // couldn't even ask: try again later
		}
		np = parseNetPort(raw)
		if np.RTSPEnabled {
			r.setNet(np)
			return np, nil
		}
	}
	r.rtspSent = true
	items, err := r.c.api(ctx, np.enableRTSP())
	if err == nil && (len(items) == 0 || !items[0].ok()) {
		err = errors.New("refused")
	}
	if err != nil {
		r.rtspErr = &Error{"live video is turned off on this Reolink device. In the Reolink app, open the device's settings → Network → Advanced → Port Settings, and turn on RTSP", backend.ErrUnsupported}
		return nil, r.rtspErr
	}
	// Changing port settings ends the session (reolink_aio expires its token here too).
	r.c.drop()
	on := *np
	on.RTSPEnabled = true
	r.setNet(&on)
	return &on, nil
}

func (r *Reolink) setNet(n *netPort) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.st != nil {
		cp := *r.st
		cp.net = n
		r.st = &cp
	}
}

func (r *Reolink) Live(ctx context.Context, camera, quality string) (backend.LiveSource, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return backend.LiveSource{}, err
	}
	if quality != "sub" {
		quality = "main"
	}
	np, err := r.ensureRTSP(ctx, st)
	if err != nil {
		return backend.LiveSource{}, err
	}
	x := st.extras[c.Ch]
	path, codec := x.rtspMain, "h264"
	if x.enc != nil {
		codec = x.enc.Enc.Main.codec()
	}
	if quality == "sub" {
		path = x.rtspSub
		if x.enc != nil {
			codec = x.enc.Enc.Sub.codec()
		}
	}
	if path == "" {
		path = defaultRTSPPath(c.Ch, quality, codec)
	}
	u := url.URL{
		Scheme: "rtsp",
		User:   url.UserPassword(r.c.user, r.c.pass),
		Host:   net.JoinHostPort(r.host, strconv.Itoa(np.RTSPPort)),
		Path:   path,
	}
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: u.String()}, nil
}

// ---- recordings ----

// searchFiles lists one camera's recording files in [after, before], searched day by day
// (device-local days), oldest first.
func (r *Reolink) searchFiles(ctx context.Context, st *state, ch int, after, before float64, maxDays int) ([]vodFile, error) {
	chunks := dayChunks(after, before, st.loc, maxDays)
	if len(chunks) == 0 {
		return nil, nil
	}
	cmds := make([]command, len(chunks))
	for i, c := range chunks {
		cmds[i] = searchCommand(ch, c[0], c[1])
	}
	items, err := r.c.api(ctx, cmds...)
	if err != nil {
		return nil, err
	}
	var files []vodFile
	var failed *item
	okCount := 0
	for i := range items {
		if !items[i].ok() {
			failed = &items[i]
			continue
		}
		okCount++
		files = append(files, parseSearchFiles(items[i].Value, st.loc)...)
	}
	if okCount == 0 && failed != nil {
		return nil, commandError(failed)
	}
	seen := map[float64]bool{}
	out := files[:0]
	for _, f := range files {
		if f.End > after && f.Start < before && !seen[f.Start] {
			seen[f.Start] = true
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out, nil
}

func (r *Reolink) Segments(ctx context.Context, camera string, after, before float64) ([]backend.Segment, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return nil, err
	}
	at := float64(time.Now().Unix())
	files, err := r.searchFiles(ctx, st, c.Ch, after, before, 8)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.files[c.Ch] = &fileCache{After: after, Before: before, At: at, Files: files}
	r.mu.Unlock()
	return mergeSegments(files, segmentTolerance), nil
}

// Playback: Reolink has no RTSP replay, so recordings play file by file as MP4 (as Home
// Assistant does). The file starts at its own beginning; StartTime/EndTime say where.
func (r *Reolink) Playback(ctx context.Context, camera string, start, end float64) (backend.Playback, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return backend.Playback{}, err
	}
	r.mu.Lock()
	cache := r.files[c.Ch]
	r.mu.Unlock()
	if !cache.covers(start, end) {
		// Files are a few minutes to an hour long: look back far enough to find the one at start.
		after, before := start-3600, max(end, start+60)
		at := float64(time.Now().Unix())
		files, err := r.searchFiles(ctx, st, c.Ch, after, before, 8)
		if err != nil {
			return backend.Playback{}, err
		}
		cache = &fileCache{After: after, Before: before, At: at, Files: files}
		r.mu.Lock()
		r.files[c.Ch] = cache
		r.mu.Unlock()
	}
	f := fileAt(cache.Files, start, end)
	if f == nil {
		return backend.Playback{}, backend.ErrNotFound
	}
	name, err := r.fileName(ctx, st, c.Ch, f)
	if err != nil {
		return backend.Playback{}, err
	}
	nvr, startWall := st.dev.IsNVR, f.StartWall
	return backend.Playback{
		File: func(ctx context.Context, hdr http.Header) (*http.Response, error) {
			return r.c.media(ctx, func(tok string) string { return vodPath(name, startWall, nvr, tok) }, hdr, true)
		},
		StartTime: f.Start,
		EndTime:   f.End,
	}, nil
}

// fileName is the name to stream a file by, preparing it first (NvrDownload) on NVRs whose
// search results have no playable name (reolink_aio _generate_NVR_download_vod).
func (r *Reolink) fileName(ctx context.Context, st *state, ch int, f *vodFile) (string, error) {
	name := f.Name
	if st.dev.IsNVR && !st.dev.IsHub && !playableRe.MatchString(name) {
		raw, err := r.c.one(ctx, nvrDownloadCommand(ch, f.StartWall, f.EndWall))
		if err != nil {
			return "", &Error{"the Reolink recorder couldn't prepare this recording for playback", err}
		}
		name = parseNvrDownload(raw)
	}
	if name == "" {
		return "", &Error{"the Reolink device didn't name this recording, so it can't be played", backend.ErrNotFound}
	}
	return name, nil
}

func (r *Reolink) VOD(context.Context, string, int64, int64, string, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// Clip: Reolink can't cut a window out of a recording (Playback serves whole files).
func (r *Reolink) Clip(context.Context, string, int64, int64, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// ---- events ----

// Events come from the recordings: each motion/AI-triggered file is one event, and its file
// name says what triggered it. Devices whose search results have no file names (some NVR
// firmware) can't be classified and show none.
func (r *Reolink) Events(ctx context.Context, q backend.EventQuery) ([]backend.Event, error) {
	st, err := r.load(ctx)
	if err != nil {
		return nil, err
	}
	before := q.Before
	if before <= 0 {
		before = float64(time.Now().Unix())
	}
	after := q.After
	if after <= 0 {
		after = before - 86400
	}
	after = max(after, before-reviewDays*86400)
	var chans []int
	if len(q.Cameras) == 0 {
		for _, c := range st.channels {
			chans = append(chans, c.Ch)
		}
	} else {
		for _, id := range q.Cameras {
			if c, ok := st.channel(id); ok {
				chans = append(chans, c.Ch)
			}
		}
	}

	type result struct {
		events []backend.Event
		err    error
	}
	results := make([]result, len(chans))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3) // devices are slow; don't flood them
	for i, ch := range chans {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			files, err := r.searchFiles(ctx, st, ch, after, before, reviewDays+1)
			for _, f := range files {
				if e, ok := fileEvent(ch, f); ok {
					results[i].events = append(results[i].events, e)
				}
			}
			results[i].err = err
		}()
	}
	wg.Wait()
	out := []backend.Event{}
	var firstErr error
	okAny := false
	for _, res := range results {
		if res.err != nil {
			firstErr = cmp(firstErr, res.err)
			continue
		}
		okAny = true
		for _, e := range res.events {
			if e.Start >= after-600 && e.Start <= before && (q.Severity == "" || e.Severity == q.Severity) {
				out = append(out, e)
			}
		}
	}
	if !okAny && firstErr != nil {
		return nil, firstErr
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func cmp(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

// Event finds an event by ID: "<ch>-<unix>" for recordings, "<ch>-<unix ms>-<kind>" for live
// (Watch) events still remembered.
func (r *Reolink) Event(ctx context.Context, id string) (backend.Event, error) {
	parts := strings.Split(id, "-")
	if len(parts) == 3 {
		r.recentMu.Lock()
		e, ok := r.recent[id]
		r.recentMu.Unlock()
		if !ok {
			return backend.Event{}, backend.ErrNotFound
		}
		return e, nil
	}
	if len(parts) != 2 {
		return backend.Event{}, backend.ErrNotFound
	}
	start, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return backend.Event{}, backend.ErrNotFound
	}
	st, c, err := r.channelOf(ctx, parts[0])
	if err != nil {
		return backend.Event{}, err
	}
	files, err := r.searchFiles(ctx, st, c.Ch, float64(start)-1, float64(start)+1, 2)
	if err != nil {
		return backend.Event{}, err
	}
	for _, f := range files {
		if int64(f.Start) == start {
			if e, ok := fileEvent(c.Ch, f); ok {
				return e, nil
			}
		}
	}
	return backend.Event{}, backend.ErrNotFound
}

// EventThumbnail: Reolink keeps no per-event pictures the API can fetch.
func (r *Reolink) EventThumbnail(context.Context, string) ([]byte, string, error) {
	return nil, "", backend.ErrUnsupported
}

// ---- PTZ ----

func (r *Reolink) PTZInfo(ctx context.Context, camera string) (backend.PTZInfo, error) {
	st, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return backend.PTZInfo{}, err
	}
	move, zoom := st.ability.ptzSupport(c.Ch)
	names := []string{}
	if move && st.ability.ver(c.Ch, "ptzPreset") > 0 {
		if ps, err := r.loadPresets(ctx, c.Ch); err == nil {
			for _, p := range ps {
				names = append(names, p.Name)
			}
		}
	}
	return backend.PTZInfo{CanMove: move, CanZoom: zoom, Presets: names}, nil
}

func (r *Reolink) loadPresets(ctx context.Context, ch int) ([]preset, error) {
	raw, err := r.c.one(ctx, cmd("GetPtzPreset", chParam(ch)))
	if err != nil {
		return nil, err
	}
	ps := parsePresets(raw)
	r.mu.Lock()
	r.presets[ch] = ps
	r.mu.Unlock()
	return ps, nil
}

func (r *Reolink) PTZ(ctx context.Context, camera, action string) error {
	_, c, err := r.channelOf(ctx, camera)
	if err != nil {
		return err
	}
	var cm command
	if name, ok := strings.CutPrefix(action, "preset_"); ok {
		r.mu.Lock()
		ps, have := r.presets[c.Ch]
		r.mu.Unlock()
		if !have {
			if ps, err = r.loadPresets(ctx, c.Ch); err != nil {
				return err
			}
		}
		id := -1
		for _, p := range ps {
			if p.Name == name {
				id = p.ID
				break
			}
		}
		if id < 0 {
			return &Error{"that preset no longer exists on the camera", backend.ErrNotFound}
		}
		cm = ptzCommand(c.Ch, "ToPos", id)
	} else {
		op, ok := ptzOps[action]
		if !ok {
			return fmt.Errorf("unknown PTZ action")
		}
		cm = ptzCommand(c.Ch, op, 0)
	}
	_, err = r.c.one(ctx, cm)
	return err
}

// ---- health ----

// Health reports the disks (GetHddInfo) and channels that were online and no longer are.
func (r *Reolink) Health(ctx context.Context) (backend.Health, error) {
	st, err := r.load(ctx)
	if err != nil {
		return backend.Health{}, err
	}
	cmds := []command{cmd("GetHddInfo", nil)}
	if st.dev.IsNVR {
		cmds = append(cmds, cmd("GetChannelstatus", nil))
	}
	items, err := r.c.api(ctx, cmds...)
	if err != nil {
		return backend.Health{}, err
	}
	h := backend.Health{Offline: []string{}, Storage: []backend.Storage{}}
	if len(items) > 0 && items[0].ok() {
		h.Storage = parseHDD(items[0].Value)
	}
	if st.dev.IsNVR && len(items) > 1 && items[1].ok() {
		r.mu.Lock()
		known := make(map[int]bool, len(r.known))
		for k := range r.known {
			known[k] = true
		}
		r.mu.Unlock()
		for _, c := range parseChannels(st.dev, items[1].Value, known) {
			if !c.Online {
				h.Offline = append(h.Offline, strconv.Itoa(c.Ch))
			}
		}
	}
	return h, nil
}

func readAll(resp *http.Response, limit int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}
