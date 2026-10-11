// Package unifi is the Hub backend for UniFi Protect on a UniFi OS console (Dream Machine,
// Cloud Key Gen2+, UNVR, Cloud Gateway). It uses the console's local (unofficial) API, the
// same one Home Assistant's uiprotect and the app's own adapter use:
//
//   - POST /api/auth/login {username, password} → TOKEN session cookie + X-CSRF-Token header
//     (rotated on some answers via X-Updated-CSRF-Token).
//   - GET /proxy/protect/api/bootstrap → cameras, console info, lastUpdateId.
//   - /proxy/protect/api/events → events; /video/export → MP4 of any window.
//   - wss /proxy/protect/ws/updates → real-time updates (Instant Alerts).
//
// Live video is Protect's RTSPS restream (port 7441). A local console user is needed: Ubiquiti
// cloud accounts use two-step sign-in, which a Hub can't answer.
package unifi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const (
	kind    = "unifi-protect"
	label   = "UniFi Protect"
	api     = "/proxy/protect/api"
	bootTTL = 30 * time.Second
	// maxExport is the longest window one playback file is asked for: Protect builds the MP4
	// before it answers, so long windows would keep the player waiting.
	maxExport = 600.0
)

func init() {
	backend.Register(backend.Descriptor{
		Kind:        kind,
		Label:       "UniFi Protect (Dream Machine, Cloud Key, NVR)",
		Description: "UniFi consoles running Protect: Dream Machine, Cloud Key Gen2+, UNVR, Cloud Gateway.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Console address", Hint: "192.168.1.1",
				Help: "The address of your Dream Machine, Cloud Key or NVR."},
			{Key: backend.FieldUsername, Label: "Username",
				Help: "A local user made on the console (Admins & Users, “Restrict to local access only”), not your Ubiquiti cloud account."},
			{Key: backend.FieldPassword, Label: "Password"},
		},
		Scheme:       "https",
		DefaultPorts: []int{443},
		New:          func(c backend.Config) (backend.Backend, error) { return New(c) },
		Probe: func(ctx context.Context, c backend.Config) error {
			p, err := New(c)
			if err != nil {
				return err
			}
			return p.Probe(ctx)
		},
	})
}

// Protect is one UniFi Protect console.
type Protect struct {
	cfg  backend.Config
	base string
	host string
	api  *http.Client
	// media waits longer for headers: exports are built before Protect answers.
	media *http.Client
	now   func() time.Time

	mu      sync.Mutex
	cookies map[string]string
	csrf    string
	gen     int // session generation, bumped by every sign-in
	loginMu sync.Mutex

	bootMu sync.Mutex
	boot   *bootstrap
	bootAt time.Time

	presetMu sync.Mutex
	presets  map[string][]preset
}

// New builds the backend (no network I/O).
func New(cfg backend.Config) (*Protect, error) {
	base := strings.TrimRight(cfg.URL, "/")
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("enter the address of your UniFi console (like 192.168.1.1)")
	}
	c := httpx.New(base, "", "") // UniFi OS uses a session cookie, not Basic/Digest
	mediaRT := httpx.Transport("", "", true)
	if t, ok := mediaRT.(*http.Transport); ok {
		t = t.Clone()
		t.ResponseHeaderTimeout = 3 * time.Minute
		mediaRT = t
	}
	return &Protect{
		cfg: cfg, base: base, host: u.Hostname(),
		api:     c.API,
		media:   &http.Client{Transport: mediaRT},
		now:     time.Now,
		presets: map[string][]preset{},
	}, nil
}

func (p *Protect) ID() string    { return p.cfg.ID }
func (p *Protect) Kind() string  { return kind }
func (p *Protect) Label() string { return label }

func (p *Protect) Capabilities() backend.Capabilities {
	return backend.Capabilities{Snapshots: true, Events: true, Recordings: true, Clips: true, PTZ: true, Alerts: true}
}

// ---- errors ----

// protectError is an HTTP error from the console, in plain words.
type protectError struct {
	code int
	msg  string
}

func (e *protectError) Error() string { return e.msg }

func (e *protectError) Is(target error) bool {
	switch target {
	case backend.ErrNotFound:
		return e.code == http.StatusNotFound
	case httpx.ErrAuth:
		return e.code == http.StatusUnauthorized
	}
	return false
}

func httpError(code int) error {
	var msg string
	switch code {
	case http.StatusUnauthorized:
		msg = "UniFi Protect signed the Hub out and signing in again didn't work; check the username and password"
	case http.StatusForbidden:
		msg = "this UniFi user isn't allowed to do that. Give it the Protect “View only” role or higher (Full Management for camera control)"
	case http.StatusNotFound:
		msg = "UniFi Protect isn't running on this console, or that camera or event no longer exists"
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		msg = "couldn't reach UniFi Protect. Check that the console is on and Protect has finished starting"
	default:
		msg = fmt.Sprintf("UniFi Protect answered with an error (HTTP %d); try again in a moment", code)
	}
	return &protectError{code: code, msg: msg}
}

var mfaRe = regexp.MustCompile(`(?i)mfa|2fa|two.?factor|token required`)

// loginError explains a failed sign-in. Wrong credentials match httpx.ErrAuth.
func loginError(code int, body string) error {
	switch {
	case code == http.StatusTooManyRequests || strings.Contains(strings.ToLower(body), "too many"):
		return &protectError{code: code, msg: "too many sign-in attempts. Wait a few minutes, then try again"}
	case (code == 400 || code == 401 || code == 403 || code == 499) && mfaRe.MatchString(body):
		return &protectError{code: http.StatusUnauthorized, msg: "this account uses two-step verification. Make a local user on your UniFi console " +
			"(Admins & Users → add an admin with “Restrict to local access only”) and use that here"}
	case code == 400 || code == 401 || code == 403:
		return &protectError{code: http.StatusUnauthorized, msg: "the username or password is wrong. Use a local user made on the UniFi console " +
			"(one with “Restrict to local access only”), not your Ubiquiti cloud account"}
	case code == http.StatusNotFound:
		return &protectError{code: code, msg: "this doesn't look like a UniFi console. Enter the address of your Dream Machine, Cloud Key or NVR"}
	}
	return httpError(code)
}

// ---- session ----

type loginBody struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	Token      string `json:"token"`
	RememberMe bool   `json:"rememberMe"`
}

func (p *Protect) session() (gen int, signedIn bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gen, len(p.cookies) > 0
}

// login signs in unless someone else already did since session generation seen.
func (p *Protect) login(ctx context.Context, seen int) error {
	p.loginMu.Lock()
	defer p.loginMu.Unlock()
	if gen, ok := p.session(); ok && gen != seen {
		return nil
	}
	b, _ := json.Marshal(loginBody{Username: p.cfg.Username, Password: p.cfg.Password, RememberMe: true})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.base+"/api/auth/login", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := p.api.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return loginError(resp.StatusCode, string(body))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cookies = map[string]string{}
	p.absorbLocked(resp)
	if len(p.cookies) == 0 {
		return errors.New("the console accepted the sign-in but didn't start a session; is this a UniFi OS console?")
	}
	p.gen++
	return nil
}

// absorbLocked keeps rotated session cookies and CSRF tokens from an answer.
func (p *Protect) absorbLocked(resp *http.Response) {
	if t := resp.Header.Get("X-Updated-Csrf-Token"); t != "" {
		p.csrf = t
	} else if t := resp.Header.Get("X-Csrf-Token"); t != "" {
		p.csrf = t
	}
	if p.cookies == nil {
		return
	}
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(p.cookies, c.Name)
			continue
		}
		p.cookies[c.Name] = c.Value
	}
}

// signOut forgets the session so the next request signs in again.
func (p *Protect) signOut(gen int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen == gen {
		p.cookies = nil
	}
}

func (p *Protect) cookieHeader() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	names := make([]string, 0, len(p.cookies))
	for n := range p.cookies {
		names = append(names, n)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, n := range names {
		parts = append(parts, n+"="+p.cookies[n])
	}
	return strings.Join(parts, "; ")
}

// send makes an authorized request: it signs in first if needed and, when the session expired
// (401) or a write's CSRF token was refused (403), signs in again and retries once. The answer
// is returned whatever its status; the caller closes the body.
func (p *Protect) send(ctx context.Context, client *http.Client, method, path string, body []byte, hdr http.Header) (*http.Response, error) {
	write := method != http.MethodGet && method != http.MethodHead
	for attempt := 0; ; attempt++ {
		gen, ok := p.session()
		if !ok {
			if err := p.login(ctx, gen); err != nil {
				return nil, err
			}
			gen, _ = p.session()
		}
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, p.base+path, rd)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		httpx.CopyRangeHeaders(req.Header, hdr)
		req.Header.Set("Cookie", p.cookieHeader())
		p.mu.Lock()
		if p.csrf != "" {
			req.Header.Set("X-CSRF-Token", p.csrf)
		}
		p.mu.Unlock()
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		p.mu.Lock()
		p.absorbLocked(resp)
		p.mu.Unlock()
		retry := resp.StatusCode == http.StatusUnauthorized || (write && resp.StatusCode == http.StatusForbidden)
		if !retry || attempt > 0 {
			return resp, nil
		}
		resp.Body.Close()
		p.signOut(gen)
	}
}

// call sends a request and turns error answers into plain errors; the caller closes the body.
func (p *Protect) call(ctx context.Context, method, path string, in any) (*http.Response, error) {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return nil, err
		}
	}
	resp, err := p.send(ctx, p.api, method, path, body, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, httpError(resp.StatusCode)
	}
	return resp, nil
}

func (p *Protect) json(ctx context.Context, method, path string, in, out any) error {
	resp, err := p.call(ctx, method, path, in)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, out); err != nil {
		return errors.New("the UniFi console sent an unexpected answer. Check that the address points to your UniFi console")
	}
	return nil
}

func (p *Protect) bytes(ctx context.Context, path string) ([]byte, string, error) {
	resp, err := p.call(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "application/octet-stream") {
		ct = "image/jpeg"
	}
	return b, ct, err
}

// stream fetches media (Range passed through) and returns the answer as it is.
func (p *Protect) stream(ctx context.Context, path string, hdr http.Header) (*http.Response, error) {
	return p.send(ctx, p.media, http.MethodGet, path, nil, hdr)
}

// ---- bootstrap ----

func (p *Protect) bootstrap(ctx context.Context, force bool) (*bootstrap, error) {
	p.bootMu.Lock()
	if !force && p.boot != nil && time.Since(p.bootAt) < bootTTL {
		b := p.boot
		p.bootMu.Unlock()
		return b, nil
	}
	p.bootMu.Unlock()
	var b bootstrap
	if err := p.json(ctx, http.MethodGet, api+"/bootstrap", nil, &b); err != nil {
		return nil, err
	}
	p.bootMu.Lock()
	p.boot, p.bootAt = &b, time.Now()
	p.bootMu.Unlock()
	return &b, nil
}

func (p *Protect) forgetBootstrap() {
	p.bootMu.Lock()
	p.boot = nil
	p.bootMu.Unlock()
}

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (p *Protect) camera(ctx context.Context, id string) (*camera, error) {
	if !idRe.MatchString(id) {
		return nil, backend.ErrNotFound
	}
	b, err := p.bootstrap(ctx, false)
	if err != nil {
		return nil, err
	}
	for i := range b.Cameras {
		if b.Cameras[i].ID == id && b.Cameras[i].adopted() {
			c := b.Cameras[i]
			return &c, nil
		}
	}
	return nil, backend.ErrNotFound
}

// Probe signs in and reads the console's cameras, explaining failures plainly.
func (p *Protect) Probe(ctx context.Context) error {
	gen, _ := p.session()
	if err := p.login(ctx, gen); err != nil {
		return err
	}
	if _, err := p.bootstrap(ctx, true); err != nil {
		var pe *protectError
		if errors.As(err, &pe) {
			switch pe.code {
			case http.StatusNotFound:
				return errors.New("signed in, but UniFi Protect isn't installed or running on this console")
			case http.StatusForbidden, http.StatusUnauthorized:
				return errors.New("signed in, but this user can't see UniFi Protect. Give it a Protect role (“View only” or higher) on the console")
			}
		}
		return err
	}
	return nil
}

// ---- cameras ----

func (p *Protect) Cameras(ctx context.Context) ([]backend.Camera, error) {
	b, err := p.bootstrap(ctx, true)
	if err != nil {
		return nil, err
	}
	out := []backend.Camera{}
	for i := range b.Cameras {
		if c := &b.Cameras[i]; c.adopted() {
			out = append(out, c.toCamera())
		}
	}
	return out, nil
}

func (p *Protect) Snapshot(ctx context.Context, cam string, height int) ([]byte, string, error) {
	if !idRe.MatchString(cam) {
		return nil, "", backend.ErrNotFound
	}
	path := api + "/cameras/" + cam + "/snapshot?force=true"
	if height > 0 {
		path += fmt.Sprintf("&h=%d", height)
	}
	return p.bytes(ctx, path)
}

func (p *Protect) Live(ctx context.Context, cam, quality string) (backend.LiveSource, error) {
	c, err := p.camera(ctx, cam)
	if err != nil {
		return backend.LiveSource{}, err
	}
	ch := pickChannel(c, quality)
	if ch == nil || ch.RtspAlias == "" {
		// RTSP is off by default in Protect. An account that can manage cameras can turn it
		// on (homebridge-unifi-protect does the same).
		if err := p.enableRTSP(ctx, cam); err == nil {
			p.forgetBootstrap()
			if c, err = p.camera(ctx, cam); err == nil {
				ch = pickChannel(c, quality)
			}
		}
		if ch == nil || ch.RtspAlias == "" {
			return backend.LiveSource{}, errors.New("live video needs this camera's RTSP stream turned on. In UniFi Protect, open the camera → Settings → Advanced " +
				"and turn on an RTSP stream (any quality), or use an admin user here and the Hub turns it on for you")
		}
	}
	b, err := p.bootstrap(ctx, false)
	if err != nil {
		return backend.LiveSource{}, err
	}
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: rtspURL(p.host, ch.RtspAlias, b.NVR.Ports.RTSPS)}, nil
}

// enableRTSP turns RTSP on for every channel but the package lens, keeping the rest of each
// channel as the console sent it.
func (p *Protect) enableRTSP(ctx context.Context, cam string) error {
	var raw struct {
		Channels []map[string]any `json:"channels"`
	}
	if err := p.json(ctx, http.MethodGet, api+"/cameras/"+cam, nil, &raw); err != nil {
		return err
	}
	if len(raw.Channels) == 0 {
		return backend.ErrUnsupported
	}
	for _, ch := range raw.Channels {
		if id, _ := ch["id"].(float64); id != 3 {
			ch["isRtspEnabled"] = true
		}
	}
	return p.json(ctx, http.MethodPatch, api+"/cameras/"+cam, map[string]any{"channels": raw.Channels}, nil)
}

// ---- events ----

func (p *Protect) fetchEvents(ctx context.Context, after, before float64, limit int) ([]event, error) {
	var evs []event
	err := p.json(ctx, http.MethodGet, api+"/events?"+eventsQuery(after, before, limit), nil, &evs)
	return evs, err
}

func (p *Protect) Events(ctx context.Context, q backend.EventQuery) ([]backend.Event, error) {
	before := q.Before
	if before <= 0 {
		before = float64(p.now().Unix() + 60)
	}
	after := q.After
	if after <= 0 {
		after = before - 86400
	}
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	// No server-side camera or severity filter: over-fetch when only some are wanted.
	fetch := limit
	if len(q.Cameras) > 0 || q.Severity != "" {
		fetch = min(1000, limit*4)
	}
	raw, err := p.fetchEvents(ctx, after, before, fetch)
	if err != nil {
		return nil, err
	}
	wanted := map[string]bool{}
	for _, c := range q.Cameras {
		wanted[c] = true
	}
	out := []backend.Event{}
	for i := range raw {
		e, ok := raw[i].toEvent()
		if !ok || (len(wanted) > 0 && !wanted[e.Camera]) || (q.Severity != "" && e.Severity != q.Severity) {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (p *Protect) Event(ctx context.Context, id string) (backend.Event, error) {
	if !idRe.MatchString(id) {
		return backend.Event{}, backend.ErrNotFound
	}
	var e event
	if err := p.json(ctx, http.MethodGet, api+"/events/"+id, nil, &e); err != nil {
		return backend.Event{}, err
	}
	ev, ok := e.toEvent()
	if !ok {
		return backend.Event{}, backend.ErrNotFound
	}
	return ev, nil
}

// EventThumbnail: Protect renders it when the event ends.
func (p *Protect) EventThumbnail(ctx context.Context, id string) ([]byte, string, error) {
	if !idRe.MatchString(id) {
		return nil, "", backend.ErrNotFound
	}
	return p.bytes(ctx, api+"/events/"+id+"/thumbnail")
}

// ---- recordings ----

// Segments: Protect has no public query for recorded ranges. Cameras recording "always" are
// reported as one span from the oldest recording kept; cameras recording on detections get
// their events (with the camera's pre/post padding); "never" has none.
func (p *Protect) Segments(ctx context.Context, cam string, after, before float64) ([]backend.Segment, error) {
	c, err := p.camera(ctx, cam)
	if err != nil {
		return nil, err
	}
	now := float64(p.now().UnixMilli()) / 1000
	before = min(before, now)
	if before <= after {
		return []backend.Segment{}, nil
	}
	rs := c.RecordingSettings
	switch rs.Mode {
	case "never":
		return []backend.Segment{}, nil
	case "", "always":
		start := after
		if first := c.Stats.Video.RecordingStart / 1000; first > start {
			start = first
		}
		if start >= before {
			return []backend.Segment{}, nil
		}
		return []backend.Segment{{Start: start, End: before}}, nil
	}
	pre, post := 2.0, 2.0
	if rs.PrePaddingSecs != nil {
		pre = *rs.PrePaddingSecs
	}
	if rs.PostPaddingSecs != nil {
		post = *rs.PostPaddingSecs
	}
	raw, err := p.fetchEvents(ctx, after-pre-3600, before+pre, 1000)
	if err != nil {
		return nil, err
	}
	var spans []backend.Segment
	for i := range raw {
		e := &raw[i]
		if e.cameraID() != cam || e.Start <= 0 {
			continue
		}
		s := e.Start/1000 - pre
		end := now
		if e.End != nil && *e.End > 0 {
			end = *e.End/1000 + post
		}
		s, end = max(s, after), min(end, before)
		if end > s {
			spans = append(spans, backend.Segment{Start: s, End: end})
		}
	}
	return mergeSpans(spans), nil
}

func mergeSpans(spans []backend.Segment) []backend.Segment {
	sort.Slice(spans, func(i, j int) bool { return spans[i].Start < spans[j].Start })
	out := []backend.Segment{}
	for _, s := range spans {
		if n := len(out); n > 0 && s.Start-out[n-1].End <= 1 {
			out[n-1].End = max(out[n-1].End, s.End)
			continue
		}
		out = append(out, s)
	}
	return out
}

// Playback hands out an MP4 export from start, at most maxExport seconds long (the player asks
// for a new window when seeking further).
func (p *Protect) Playback(ctx context.Context, cam string, start, end float64) (backend.Playback, error) {
	if _, err := p.camera(ctx, cam); err != nil {
		return backend.Playback{}, err
	}
	now := float64(p.now().UnixMilli()) / 1000
	e := min(end, start+maxExport, now)
	if e <= start {
		return backend.Playback{}, backend.ErrNotFound
	}
	path := exportPath(cam, start, e)
	return backend.Playback{
		File: func(ctx context.Context, hdr http.Header) (*http.Response, error) {
			return p.stream(ctx, path, hdr)
		},
		StartTime: start,
		EndTime:   e,
	}, nil
}

func (p *Protect) VOD(context.Context, string, int64, int64, string, http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

func (p *Protect) Clip(ctx context.Context, cam string, start, end int64, hdr http.Header) (*http.Response, error) {
	if !idRe.MatchString(cam) {
		return nil, backend.ErrNotFound
	}
	return p.stream(ctx, exportPath(cam, float64(start), float64(end)), hdr)
}

// ---- PTZ: PTZ cameras (G4/G5 PTZ) via /move and /ptz/*; optical-zoom cameras via ispSettings ----

func (p *Protect) PTZInfo(ctx context.Context, cam string) (backend.PTZInfo, error) {
	c, err := p.camera(ctx, cam)
	if err != nil {
		return backend.PTZInfo{}, err
	}
	if !c.FeatureFlags.IsPtz {
		return backend.PTZInfo{CanZoom: c.FeatureFlags.CanOpticalZoom, Presets: []string{}}, nil
	}
	var raw []preset
	if err := p.json(ctx, http.MethodGet, api+"/cameras/"+cam+"/ptz/preset", nil, &raw); err != nil {
		raw = nil // no presets saved (or an older firmware): Home still works
	}
	presets := presetNames(raw)
	p.presetMu.Lock()
	p.presets[cam] = presets
	p.presetMu.Unlock()
	names := make([]string, len(presets))
	for i, pr := range presets {
		names[i] = pr.Name
	}
	return backend.PTZInfo{CanMove: true, CanZoom: true, Presets: names}, nil
}

func (p *Protect) PTZ(ctx context.Context, cam, action string) error {
	if action == "STOP" {
		return nil // Protect moves are relative steps; nothing to stop.
	}
	c, err := p.camera(ctx, cam)
	if err != nil {
		return err
	}
	f := c.FeatureFlags
	base := api + "/cameras/" + cam
	if name, ok := strings.CutPrefix(action, "preset_"); ok {
		if !f.IsPtz {
			return backend.ErrUnsupported
		}
		p.presetMu.Lock()
		_, known := p.presets[cam]
		p.presetMu.Unlock()
		if !known {
			if _, err := p.PTZInfo(ctx, cam); err != nil {
				return err
			}
		}
		p.presetMu.Lock()
		list := p.presets[cam]
		p.presetMu.Unlock()
		for _, pr := range list {
			if pr.Name == name {
				return p.json(ctx, http.MethodPost, fmt.Sprintf("%s/ptz/goto/%d", base, pr.Slot), nil, nil)
			}
		}
		return errors.New("that preset no longer exists on the camera")
	}
	if pan, tilt, ok := relativeMove(action); ok {
		if !f.IsPtz {
			return backend.ErrUnsupported
		}
		return p.json(ctx, http.MethodPost, base+"/move", map[string]any{
			"type":    "relative",
			"payload": map[string]any{"panPos": pan, "tiltPos": tilt, "panSpeed": 10, "tiltSpeed": 10, "scale": 0},
		}, nil)
	}
	dir := 0
	switch action {
	case "ZOOM_IN":
		dir = 1
	case "ZOOM_OUT":
		dir = -1
	default:
		return fmt.Errorf("unknown PTZ action")
	}
	switch {
	case f.IsPtz:
		var pos struct {
			Steps struct {
				Zoom float64 `json:"zoom"`
			} `json:"steps"`
		}
		if err := p.json(ctx, http.MethodGet, base+"/ptz/position", nil, &pos); err != nil {
			return err
		}
		return p.json(ctx, http.MethodPost, base+"/move", map[string]any{
			"type": "zoom", "payload": map[string]any{"zoomPos": nextZoom(pos.Steps.Zoom, dir, f.Zoom), "zoomSpeed": 100},
		}, nil)
	case f.CanOpticalZoom:
		z := nextOpticalZoom(c.IspSettings.ZoomPosition, dir)
		err := p.json(ctx, http.MethodPatch, base, map[string]any{"ispSettings": map[string]any{"zoomPosition": z}}, nil)
		if err == nil {
			p.forgetBootstrap()
		}
		return err
	}
	return backend.ErrUnsupported
}

// ---- health ----

func (p *Protect) Health(ctx context.Context) (backend.Health, error) {
	b, err := p.bootstrap(ctx, true)
	if err != nil {
		return backend.Health{}, err
	}
	return backend.Health{Offline: offlineCameras(b), Storage: storageOf(b)}, nil
}
