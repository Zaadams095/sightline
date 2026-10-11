// Package hikvision is the Hub backend for Hikvision NVRs, DVRs and IP cameras, and the many
// rebrands that run Hikvision's firmware (LTS, Annke, some Swann…), through ISAPI: XML over
// HTTP with Digest auth. Live video and recordings play over RTSP straight from the device.
// Ported from the app's adapter (app/src/systems/hikvision.ts).
package hikvision

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

const (
	pageSize   = 50
	maxPages   = 20
	maxDays    = 62
	reviewDays = 7
	cacheTTL   = time.Minute
	// idleTimeout reconnects an alert stream that went quiet (devices send a heartbeat every
	// few seconds, so silence means a dead connection).
	idleTimeout = 3 * time.Minute
)

func init() {
	backend.Register(backend.Descriptor{
		Kind:        "hikvision",
		Label:       "Hikvision recorder or camera",
		Description: "Also LTS, Annke and other recorders and cameras that run Hikvision's software.",
		Fields: []backend.Field{
			{Key: backend.FieldURL, Label: "Recorder or camera address", Hint: "192.168.1.64",
				Help: "The address you type to open the recorder in a web browser."},
			{Key: backend.FieldUsername, Label: "Username", Default: "admin"},
			{Key: backend.FieldPassword, Label: "Password"},
		},
		DefaultPorts: []int{80, 443},
		New:          func(c backend.Config) (backend.Backend, error) { return New(c) },
		Probe: func(ctx context.Context, c backend.Config) error {
			h, err := New(c)
			if err != nil {
				return err
			}
			return h.Probe(ctx)
		},
	})
}

// Hikvision is one ISAPI device.
type Hikvision struct {
	cfg  backend.Config
	c    *httpx.Client
	host string
	// hubZone is the Hub's own time zone (time.Local; tests pin it).
	hubZone *time.Location

	mu       sync.Mutex
	info     *deviceState
	infoTime time.Time
	// ptz: channel → route (nil = can't be steered, known for sure).
	ptz     map[int]*ptzRoute
	presets map[int][]preset
	// allEvent: whether the device accepts the "event recordings only" search filter
	// (0 unknown, 1 yes, -1 no).
	allEvent int
}

type deviceState struct {
	name     string
	channels []channel
	streams  []stream
	rtsp     int
	zone     *time.Location
}

type ptzRoute struct {
	// path is /ISAPI/PTZCtrl/channels/<n> or /ISAPI/ContentMgmt/PTZCtrlProxy/channels/<n>.
	path             string
	canMove, canZoom bool
}

// New builds the backend; it doesn't touch the network.
func New(cfg backend.Config) (*Hikvision, error) {
	u, err := url.Parse(strings.TrimSpace(cfg.URL))
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("the address doesn't look right. Type it like 192.168.1.64")
	}
	if cfg.Username == "" {
		cfg.Username = "admin"
	}
	return &Hikvision{
		cfg:     cfg,
		c:       httpx.New(cfg.URL, cfg.Username, cfg.Password, httpx.WithTimeout(20*time.Second)),
		host:    u.Hostname(),
		hubZone: time.Local,
		ptz:     map[int]*ptzRoute{},
		presets: map[int][]preset{},
	}, nil
}

func (h *Hikvision) ID() string    { return h.cfg.ID }
func (h *Hikvision) Kind() string  { return "hikvision" }
func (h *Hikvision) Label() string { return "Hikvision" }

func (h *Hikvision) Capabilities() backend.Capabilities {
	ptz := true
	h.mu.Lock()
	if h.info != nil {
		ptz = false
		for _, c := range h.info.channels {
			if r, known := h.ptz[c.ID]; r != nil || !known {
				ptz = true
			}
		}
	}
	h.mu.Unlock()
	// Events: the timeline and review list work; EventThumbnail doesn't (the recorder keeps no
	// per-event picture we can fetch reliably), and the app falls back to video.
	return backend.Capabilities{Snapshots: true, Events: true, Recordings: true, Clips: false, PTZ: ptz, Alerts: true}
}

// ---------------------------------------------------------------------------------------------
// Errors

// plainError is a plain-language explanation that still unwraps to the original error.
type plainError struct {
	msg string
	err error
}

func (e *plainError) Error() string { return e.msg }
func (e *plainError) Unwrap() error { return e.err }

var (
	errNotHikvision = errors.New("that address answered, but it doesn't look like a Hikvision recorder or camera. Check the address (and the port, if you typed one)")
	lockedRe        = regexp.MustCompile(`(?i)<lockStatus>\s*lock\s*<|locked|userLocked`)
)

// statusOf returns the HTTP code and ISAPI ResponseStatus of an error answer.
func statusOf(err error) (int, responseStatusXML, bool) {
	var se *httpx.StatusError
	if !errors.As(err, &se) {
		return 0, responseStatusXML{}, false
	}
	var rs responseStatusXML
	_ = xml.Unmarshal([]byte(se.Body), &rs)
	return se.Code, rs, true
}

// definitiveNo: the device itself said no ("not supported", "not allowed"), as opposed to a
// timeout or a busy device, which are worth asking again.
func definitiveNo(err error) bool {
	if errors.Is(err, backend.ErrUnsupported) {
		return true
	}
	code, rs, ok := statusOf(err)
	if !ok {
		return false
	}
	sub := strings.ToLower(rs.SubStatusCode)
	return code == 400 || code == 403 || code == 404 || sub == "notsupport" || sub == "invalidoperation" || strings.TrimSpace(rs.StatusCode) == "4"
}

// explain turns an ISAPI answer into plain words where the generic ones don't fit.
func explain(err error) error {
	code, rs, ok := statusOf(err)
	if !ok {
		return err
	}
	var se *httpx.StatusError
	errors.As(err, &se)
	sub := strings.ToLower(rs.SubStatusCode)
	switch {
	case code == http.StatusUnauthorized && lockedRe.MatchString(se.Body):
		return &plainError{"the device has locked this account after too many wrong passwords. Wait about 30 minutes, then try again", err}
	case code == http.StatusUnauthorized:
		return &plainError{"the username or password is wrong", err}
	case code == http.StatusForbidden || sub == "nopermission" || sub == "lowprivilege":
		return &plainError{"this account isn't allowed to do that. Use the recorder's admin account", err}
	case sub == "notsupport" || sub == "invalidoperation":
		return &plainError{"this Hikvision device doesn't support that", fmt.Errorf("%w: %w", backend.ErrUnsupported, err)}
	case sub == "devicebusy" || strings.TrimSpace(rs.StatusCode) == "2":
		return &plainError{"the device is busy. Try again in a moment", err}
	}
	return err
}

// ---------------------------------------------------------------------------------------------
// Transport

func (h *Hikvision) get(ctx context.Context, path string, out any) error {
	return explain(h.c.GetXML(ctx, path, out))
}

// maybe fetches an optional resource; false when the device doesn't have it.
func (h *Hikvision) maybe(ctx context.Context, path string, out any) (bool, error) {
	err := h.c.GetXML(ctx, path, out)
	if err == nil {
		return true, nil
	}
	if code, _, ok := statusOf(err); ok && code != http.StatusUnauthorized {
		return false, nil // 400/403/404/500: not on this device
	}
	if errors.Is(err, httpx.ErrBadAnswer) {
		return false, nil
	}
	return false, explain(err)
}

// send does a POST/PUT and returns the answer. Writes answer 200 with a ResponseStatus whose
// statusCode 1 means OK.
func (h *Hikvision) send(ctx context.Context, method, path, body string) ([]byte, error) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := h.c.NewRequest(ctx, method, path, rd)
	if err != nil {
		return nil, err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/xml; charset=UTF-8")
	}
	resp, err := h.c.Do(req)
	if err != nil {
		return nil, explain(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	var rs responseStatusXML
	if xml.Unmarshal(b, &rs) == nil && rs.XMLName.Local == "ResponseStatus" {
		if c := strings.TrimSpace(rs.StatusCode); c != "" && c != "1" {
			return nil, explain(&httpx.StatusError{Code: http.StatusBadRequest, Body: string(b)})
		}
	}
	return b, nil
}

// ---------------------------------------------------------------------------------------------
// Setup and channels

// Probe checks the address, the device and the password, in plain words.
func (h *Hikvision) Probe(ctx context.Context) error {
	var info deviceInfoXML
	err := h.c.GetXML(ctx, "/ISAPI/System/deviceInfo", &info)
	switch {
	case err == nil && info.XMLName.Local != "DeviceInfo":
		return errNotHikvision
	case err == nil:
		_, err = h.state(ctx, true)
		return err
	case errors.Is(err, httpx.ErrBadAnswer):
		return &plainError{errNotHikvision.Error(), err}
	}
	code, _, ok := statusOf(err)
	switch {
	case !ok:
		return err // network: the Hub explains it
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return explain(err)
	case code < 500:
		return &plainError{errNotHikvision.Error(), err}
	}
	return err
}

func (h *Hikvision) state(ctx context.Context, fresh bool) (*deviceState, error) {
	h.mu.Lock()
	if !fresh && h.info != nil && time.Since(h.infoTime) < cacheTTL {
		s := h.info
		h.mu.Unlock()
		return s, nil
	}
	h.mu.Unlock()

	var dev deviceInfoXML
	if err := h.get(ctx, "/ISAPI/System/deviceInfo", &dev); err != nil {
		if errors.Is(err, httpx.ErrBadAnswer) || errors.Is(err, backend.ErrNotFound) {
			return nil, &plainError{errNotHikvision.Error(), err}
		}
		return nil, err
	}
	if dev.XMLName.Local != "DeviceInfo" {
		return nil, errNotHikvision
	}
	var (
		proxy   inputProxyListXML
		status  inputProxyStatusXML
		inputs  videoInputsXML
		streams streamingChannelsXML
		access  adminAccessesXML
		clock   timeXML
		wg      sync.WaitGroup
		errMu   sync.Mutex
		firstEr error
		hasTime bool
		hasAcc  bool
	)
	fetch := func(path string, out any, ok *bool) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := h.maybe(ctx, path, out)
			if ok != nil {
				*ok = got
			}
			if err != nil {
				errMu.Lock()
				if firstEr == nil {
					firstEr = err
				}
				errMu.Unlock()
			}
		}()
	}
	fetch("/ISAPI/ContentMgmt/InputProxy/channels", &proxy, nil)
	fetch("/ISAPI/ContentMgmt/InputProxy/channels/status", &status, nil)
	fetch("/ISAPI/System/Video/inputs/channels", &inputs, nil)
	fetch("/ISAPI/Streaming/channels", &streams, nil)
	fetch("/ISAPI/Security/adminAccesses", &access, &hasAcc)
	fetch("/ISAPI/System/time", &clock, &hasTime)
	wg.Wait()
	if firstEr != nil {
		return nil, firstEr
	}
	st := &deviceState{name: dev.DeviceName, streams: parseStreams(streams), rtsp: 554, zone: h.hubZone}
	st.channels = buildChannels(dev, proxy, status, inputs, st.streams)
	if len(st.channels) == 0 {
		name := strings.TrimSpace(dev.DeviceName)
		if name == "" {
			name = "Camera"
		}
		st.channels = []channel{{ID: 1, Name: name, Online: true}}
	}
	if hasAcc {
		st.rtsp = rtspPort(access)
	}
	if hasTime {
		st.zone = deviceZone(clock, time.Now(), h.hubZone)
	}
	// Which channels can be steered (in parallel; remembered once the device has said).
	var pwg sync.WaitGroup
	for _, c := range st.channels {
		pwg.Add(1)
		go func() {
			defer pwg.Done()
			_, _ = h.ptzRoute(ctx, c)
		}()
	}
	pwg.Wait()
	h.mu.Lock()
	h.info, h.infoTime = st, time.Now()
	h.mu.Unlock()
	return st, nil
}

// ptzRoute finds how to steer a channel: directly, or through the recorder's PTZ proxy.
// "Can't be steered" is remembered only when the device says so.
func (h *Hikvision) ptzRoute(ctx context.Context, c channel) (*ptzRoute, error) {
	h.mu.Lock()
	r, known := h.ptz[c.ID]
	h.mu.Unlock()
	if known {
		return r, nil
	}
	paths := []string{fmt.Sprintf("/ISAPI/PTZCtrl/channels/%d", c.ID)}
	if c.Proxied {
		paths = []string{fmt.Sprintf("/ISAPI/ContentMgmt/PTZCtrlProxy/channels/%d", c.ID), paths[0]}
	}
	var transient error
	for _, p := range paths {
		var caps ptzCapsXML
		if err := h.c.GetXML(ctx, p+"/capabilities", &caps); err != nil {
			if !definitiveNo(err) && !errors.Is(err, httpx.ErrBadAnswer) {
				transient = err
			}
			continue
		}
		canMove := caps.ContinuousPanTilt != nil || caps.AbsolutePanTilt != nil
		canZoom := caps.ContinuousZoom != nil || caps.AbsoluteZoom != nil
		if canMove || canZoom {
			r := &ptzRoute{path: p, canMove: canMove, canZoom: canZoom}
			h.mu.Lock()
			h.ptz[c.ID] = r
			h.mu.Unlock()
			return r, nil
		}
	}
	if transient != nil {
		return nil, explain(transient)
	}
	h.mu.Lock()
	h.ptz[c.ID] = nil
	h.mu.Unlock()
	return nil, nil
}

func (h *Hikvision) Cameras(ctx context.Context) ([]backend.Camera, error) {
	st, err := h.state(ctx, false)
	if err != nil {
		return nil, err
	}
	out := make([]backend.Camera, 0, len(st.channels))
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range st.channels {
		aspect := 16.0 / 9
		if c.Width > 0 && c.Height > 0 {
			aspect = float64(c.Width) / float64(c.Height)
		}
		out = append(out, backend.Camera{
			ID: strconv.Itoa(c.ID), Name: c.Name, Enabled: c.Online, PTZ: h.ptz[c.ID] != nil,
			Aspect: aspect, Objects: []string{"person", "vehicle", "motion"},
		})
	}
	return out, nil
}

// channelOf parses a camera ID ("1", "2", …).
func channelOf(camera string) (int, error) {
	ch, err := strconv.Atoi(camera)
	if err != nil || ch < 1 || ch > 4096 {
		return 0, backend.ErrNotFound
	}
	return ch, nil
}

func (st *deviceState) channel(ch int) (channel, bool) {
	for _, c := range st.channels {
		if c.ID == ch {
			return c, true
		}
	}
	return channel{}, false
}

// ---------------------------------------------------------------------------------------------
// Snapshots and live

// Snapshot is /ISAPI/Streaming/channels/<n>01/picture. Small tiles ask for the sub stream's
// picture at its own size, as hikvision_next does.
func (h *Hikvision) Snapshot(ctx context.Context, camera string, height int) ([]byte, string, error) {
	ch, err := channelOf(camera)
	if err != nil {
		return nil, "", err
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return nil, "", err
	}
	if _, ok := st.channel(ch); !ok {
		return nil, "", backend.ErrNotFound
	}
	pick := findStream(st.streams, streamID(ch, "main"))
	if sub := findStream(st.streams, streamID(ch, "sub")); height > 0 && height <= 480 && sub != nil && sub.Width > 0 && sub.Height > 0 {
		pick = sub
	}
	path := fmt.Sprintf("/ISAPI/Streaming/channels/%d/picture", streamID(ch, "main"))
	if pick != nil {
		path = fmt.Sprintf("/ISAPI/Streaming/channels/%d/picture", pick.ID)
		if pick.Width > 0 && pick.Height > 0 {
			path += fmt.Sprintf("?videoResolutionWidth=%d&videoResolutionHeight=%d", pick.Width, pick.Height)
		}
	}
	b, ct, err := h.c.GetBytes(ctx, path)
	if err != nil {
		return nil, "", explain(err)
	}
	if ct == "" || !strings.HasPrefix(ct, "image/") {
		ct = "image/jpeg"
	}
	return b, ct, nil
}

// rtspURL is rtsp://user:pass@host:port<path> with the credentials escaped.
func (h *Hikvision) rtspURL(st *deviceState, path, query string) string {
	u := url.URL{
		Scheme:   "rtsp",
		User:     url.UserPassword(h.cfg.Username, h.cfg.Password),
		Host:     net.JoinHostPort(h.host, strconv.Itoa(st.rtsp)),
		Path:     path,
		RawQuery: query,
	}
	return u.String()
}

// Live: rtsp://…/Streaming/Channels/101 (main) or …/102 (sub).
func (h *Hikvision) Live(ctx context.Context, camera, quality string) (backend.LiveSource, error) {
	ch, err := channelOf(camera)
	if err != nil {
		return backend.LiveSource{}, err
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return backend.LiveSource{}, err
	}
	if _, ok := st.channel(ch); !ok {
		return backend.LiveSource{}, backend.ErrNotFound
	}
	return backend.LiveSource{Kind: backend.LiveRTSP, URL: h.rtspURL(st, fmt.Sprintf("/Streaming/Channels/%d", streamID(ch, quality)), "")}, nil
}

// ---------------------------------------------------------------------------------------------
// Recordings and events

func randomSearchID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	s := strings.ToUpper(hex.EncodeToString(b))
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

// searchDay fetches all pages of one search (a day or less).
func (h *Hikvision) searchDay(ctx context.Context, st *deviceState, ch int, start, end int64, metadata string) ([]match, error) {
	id := randomSearchID()
	var out []match
	for page := 0; page < maxPages; page++ {
		body := searchXML(id, streamID(ch, "main"), start, end, st.zone, len(out), pageSize, metadata)
		b, err := h.send(ctx, http.MethodPost, "/ISAPI/ContentMgmt/search", body)
		if err != nil {
			return nil, err
		}
		var res searchResultXML
		if err := xml.Unmarshal(b, &res); err != nil {
			return nil, fmt.Errorf("%w: %v", httpx.ErrBadAnswer, err)
		}
		ms, more := parseSearchResult(res, st.zone)
		out = append(out, ms...)
		if !more || len(ms) == 0 {
			break
		}
	}
	kept := out[:0]
	for _, m := range out {
		if m.End > start && m.Start < end {
			kept = append(kept, m)
		}
	}
	return kept, nil
}

// findRecordings searches one channel's main track a device-local day at a time from the
// newest; stop ends the walk early once the caller has enough.
func (h *Hikvision) findRecordings(ctx context.Context, st *deviceState, ch int, start, end int64, metadata string, stop func([]match) bool) ([]match, error) {
	var out []match
	for _, day := range dayRanges(start, end, st.zone, maxDays) {
		ms, err := h.searchDay(ctx, st, ch, day[0], day[1], metadata)
		if err != nil {
			return nil, err
		}
		out = append(out, ms...)
		if stop != nil && stop(out) {
			break
		}
	}
	return out, nil
}

// eventMatches finds event recordings (motion, line crossing, intrusion, AcuSense
// human/vehicle): with the "AllEvent" filter, or, on devices without it, a plain search
// keeping only segments whose type marks them as events.
func (h *Hikvision) eventMatches(ctx context.Context, st *deviceState, ch int, after, before int64, stop func([]match) bool) ([]match, error) {
	h.mu.Lock()
	filter := h.allEvent
	h.mu.Unlock()
	if filter >= 0 {
		ms, err := h.findRecordings(ctx, st, ch, after, before, "AllEvent", stop)
		if err == nil {
			h.mu.Lock()
			h.allEvent = 1
			h.mu.Unlock()
			return ms, nil
		}
		code, _, isStatus := statusOf(err)
		if !isStatus || code == http.StatusUnauthorized || code == http.StatusForbidden {
			return nil, err
		}
		if definitiveNo(err) {
			h.mu.Lock()
			h.allEvent = -1
			h.mu.Unlock()
		}
	}
	typed := func(ms []match) []match {
		var out []match
		for _, m := range ms {
			if m.RecordType != "" {
				out = append(out, m)
			}
		}
		return out
	}
	ms, err := h.findRecordings(ctx, st, ch, after, before, "", func(all []match) bool { return stop(typed(all)) })
	return typed(ms), err
}

func (h *Hikvision) Events(ctx context.Context, q backend.EventQuery) ([]backend.Event, error) {
	st, err := h.state(ctx, false)
	if err != nil {
		return nil, err
	}
	before := int64(q.Before + 0.999)
	if q.Before <= 0 {
		before = time.Now().Unix() + 60
	}
	after := int64(q.After)
	if q.After <= 0 {
		after = before - 86400
	}
	after = max(after, before-reviewDays*86400)
	limit := q.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	cams := q.Cameras
	if len(cams) == 0 {
		for _, c := range st.channels {
			cams = append(cams, strconv.Itoa(c.ID))
		}
	}
	keep := func(e backend.Event) bool {
		return e.Start <= float64(before) && (q.Severity == "" || e.Severity == q.Severity)
	}
	type result struct {
		evs []backend.Event
		err error
	}
	results := make([]result, len(cams))
	var wg sync.WaitGroup
	for i, cam := range cams {
		ch, err := channelOf(cam)
		if err != nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Each camera walks back day by day until it has `limit` matching events: the merged
			// list is cut to the newest `limit`, so older ones from one camera never show.
			enough := func(sofar []match) bool {
				n := 0
				for _, e := range matchesToEvents(sofar, ch) {
					if keep(e) {
						n++
					}
				}
				return n >= limit
			}
			ms, err := h.eventMatches(ctx, st, ch, after, before, enough)
			results[i] = result{matchesToEvents(ms, ch), err}
		}()
	}
	wg.Wait()
	var out []backend.Event
	var firstErr error
	for _, r := range results {
		if r.err != nil && firstErr == nil {
			firstErr = r.err
		}
		for _, e := range r.evs {
			if keep(e) {
				out = append(out, e)
			}
		}
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if len(out) > limit {
		out = out[:limit]
	}
	if out == nil {
		out = []backend.Event{}
	}
	return out, nil
}

// Event finds one event by ID: recorded events are searched again around their start; live
// alerts ("<ch>:<start>:<type>") are rebuilt from the ID when the recorder has no recording.
func (h *Hikvision) Event(ctx context.Context, id string) (backend.Event, error) {
	ch, start, kind, ok := parseEventID(id)
	if !ok {
		return backend.Event{}, backend.ErrNotFound
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return backend.Event{}, err
	}
	if _, ok := st.channel(ch); !ok {
		return backend.Event{}, backend.ErrNotFound
	}
	if kind != "" {
		objects, severity, ok := classifyAlert(alert{Type: kind, Active: true})
		if !ok {
			objects, severity = []string{"motion"}, "detection"
		}
		return backend.Event{ID: id, Camera: strconv.Itoa(ch), Start: float64(start), Severity: severity, Objects: objects}, nil
	}
	ms, err := h.eventMatches(ctx, st, ch, start, start+1, func([]match) bool { return true })
	if err != nil {
		return backend.Event{}, err
	}
	for _, e := range matchesToEvents(ms, ch) {
		if e.ID == id {
			return e, nil
		}
	}
	return backend.Event{}, backend.ErrNotFound
}

// EventThumbnail: recorders keep no per-event picture that can be fetched reliably by time.
func (h *Hikvision) EventThumbnail(ctx context.Context, id string) ([]byte, string, error) {
	return nil, "", backend.ErrUnsupported
}

func (h *Hikvision) Segments(ctx context.Context, camera string, after, before float64) ([]backend.Segment, error) {
	ch, err := channelOf(camera)
	if err != nil {
		return nil, err
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return nil, err
	}
	ms, err := h.findRecordings(ctx, st, ch, int64(after), int64(before+0.999), "", nil)
	if err != nil {
		return nil, err
	}
	segs := mergeSegments(ms, 2)
	if segs == nil {
		segs = []backend.Segment{}
	}
	return segs, nil
}

// Playback replays the main track over RTSP:
// rtsp://…/Streaming/tracks/101?starttime=20240501T100000Z&endtime=… (device-local "fake Z").
// It starts at the first recording in the window (ErrNotFound when there is none).
func (h *Hikvision) Playback(ctx context.Context, camera string, start, end float64) (backend.Playback, error) {
	ch, err := channelOf(camera)
	if err != nil {
		return backend.Playback{}, err
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return backend.Playback{}, err
	}
	if _, ok := st.channel(ch); !ok {
		return backend.Playback{}, backend.ErrNotFound
	}
	from, to := int64(start), int64(end+0.999)
	var startTime float64
	ms, err := h.findRecordings(ctx, st, ch, from, to, "", nil)
	switch {
	case err == nil:
		segs := mergeSegments(ms, 2)
		if len(segs) == 0 {
			return backend.Playback{}, backend.ErrNotFound
		}
		if first := int64(segs[0].Start); first > from {
			from, startTime = first, float64(first)
		}
	case errors.Is(err, httpx.ErrAuth):
		return backend.Playback{}, err
	}
	// A failed search isn't fatal: the recorder itself skips to the next recording.
	q := "starttime=" + rtspTime(from, st.zone) + "&endtime=" + rtspTime(to, st.zone)
	src := backend.LiveSource{Kind: backend.LiveRTSP, URL: h.rtspURL(st, fmt.Sprintf("/Streaming/tracks/%d", streamID(ch, "main")), q)}
	return backend.Playback{Live: &src, StartTime: startTime}, nil
}

// VOD: recorders replay over RTSP (Playback), not HLS.
func (h *Hikvision) VOD(ctx context.Context, camera string, start, end int64, file string, hdr http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// Clip: ISAPI downloads are in Hikvision's own container (not MP4) on most recorders.
func (h *Hikvision) Clip(ctx context.Context, camera string, start, end int64, hdr http.Header) (*http.Response, error) {
	return nil, backend.ErrUnsupported
}

// ---------------------------------------------------------------------------------------------
// PTZ

func (h *Hikvision) route(ctx context.Context, camera string) (*ptzRoute, int, error) {
	ch, err := channelOf(camera)
	if err != nil {
		return nil, 0, err
	}
	st, err := h.state(ctx, false)
	if err != nil {
		return nil, 0, err
	}
	c, ok := st.channel(ch)
	if !ok {
		return nil, 0, backend.ErrNotFound
	}
	r, err := h.ptzRoute(ctx, c)
	if err != nil {
		return nil, 0, err
	}
	if r == nil {
		return nil, 0, backend.ErrUnsupported
	}
	return r, ch, nil
}

func (h *Hikvision) loadPresets(ctx context.Context, r *ptzRoute, ch int) ([]preset, error) {
	var x ptzPresetsXML
	if _, err := h.maybe(ctx, r.path+"/presets", &x); err != nil {
		return nil, err
	}
	p := parsePresets(x)
	h.mu.Lock()
	h.presets[ch] = p
	h.mu.Unlock()
	return p, nil
}

func (h *Hikvision) PTZInfo(ctx context.Context, camera string) (backend.PTZInfo, error) {
	r, ch, err := h.route(ctx, camera)
	if err != nil {
		return backend.PTZInfo{}, err
	}
	names := []string{}
	if r.canMove {
		ps, err := h.loadPresets(ctx, r, ch)
		if err != nil {
			return backend.PTZInfo{}, err
		}
		for _, p := range ps {
			names = append(names, p.Name)
		}
	}
	return backend.PTZInfo{CanMove: r.canMove, CanZoom: r.canZoom, Presets: names}, nil
}

// PTZ: continuous moves (the app sends STOP when the button is released) and preset_<name>.
func (h *Hikvision) PTZ(ctx context.Context, camera, action string) error {
	r, ch, err := h.route(ctx, camera)
	if err != nil {
		return err
	}
	if name, ok := strings.CutPrefix(action, "preset_"); ok {
		h.mu.Lock()
		ps, have := h.presets[ch]
		h.mu.Unlock()
		if !have {
			if ps, err = h.loadPresets(ctx, r, ch); err != nil {
				return err
			}
		}
		for _, p := range ps {
			if p.Name == name {
				_, err := h.send(ctx, http.MethodPut, fmt.Sprintf("%s/presets/%d/goto", r.path, p.ID), "")
				return err
			}
		}
		return &plainError{"that preset no longer exists on the camera", backend.ErrNotFound}
	}
	body, ok := ptzXML(action)
	if !ok {
		return backend.ErrUnsupported
	}
	_, err = h.send(ctx, http.MethodPut, r.path+"/continuous", body)
	return err
}

// ---------------------------------------------------------------------------------------------
// Health

// Health: network cameras the recorder can't reach, and its disks.
func (h *Hikvision) Health(ctx context.Context) (backend.Health, error) {
	st, err := h.state(ctx, false)
	if err != nil {
		return backend.Health{}, err
	}
	var hl backend.Health
	var status inputProxyStatusXML
	if ok, err := h.maybe(ctx, "/ISAPI/ContentMgmt/InputProxy/channels/status", &status); err != nil {
		return backend.Health{}, err
	} else if ok {
		for _, s := range status.Channels {
			id := atoi(s.ID)
			if _, known := st.channel(id); known && strings.TrimSpace(s.Online) == "false" {
				hl.Offline = append(hl.Offline, strconv.Itoa(id))
			}
		}
	}
	var storage storageXML
	if ok, err := h.maybe(ctx, "/ISAPI/ContentMgmt/Storage", &storage); err != nil {
		return backend.Health{}, err
	} else if ok {
		hl.Storage = storageHealth(storage)
	}
	return hl, nil
}

// ---------------------------------------------------------------------------------------------
// Instant Alerts

// Watch follows the alert stream until ctx ends, reconnecting with backoff.
func (h *Hikvision) Watch(ctx context.Context, sink backend.Sink) error {
	var tracker alertTracker
	backoff := time.Second
	for {
		started := time.Now()
		err := h.watchOnce(ctx, sink, &tracker)
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		if err == nil {
			err = errors.New("the device closed the connection")
		}
		log.Printf("%s: alert stream: %v (reconnecting in %s)", h.cfg.ID, httpx.Explain(err), backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 2*time.Minute)
	}
}

// idleReader cancels the stream when nothing arrives for a while.
type idleReader struct {
	r     io.Reader
	timer *time.Timer
	d     time.Duration
}

func (i *idleReader) Read(p []byte) (int, error) {
	n, err := i.r.Read(p)
	if n > 0 {
		i.timer.Reset(i.d)
	}
	return n, err
}

func (h *Hikvision) watchOnce(ctx context.Context, sink backend.Sink, tracker *alertTracker) error {
	zone := h.hubZone
	if st, err := h.state(ctx, false); err == nil {
		zone = st.zone
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	resp, err := h.c.Stream(ctx, "/ISAPI/Event/notification/alertStream", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return explain(&httpx.StatusError{Code: resp.StatusCode, Body: string(b)})
	}
	boundary := ""
	if _, params, err := mime.ParseMediaType(resp.Header.Get("Content-Type")); err == nil {
		boundary = params["boundary"]
	}
	timer := time.AfterFunc(idleTimeout, cancel)
	defer timer.Stop()
	return parseMultipart(&idleReader{r: resp.Body, timer: timer, d: idleTimeout}, boundary, func(ct string, part []byte) {
		a, ok := parseAlert(ct, bytes.TrimSpace(part), zone)
		if !ok {
			return
		}
		if ev, ok := tracker.handle(a, time.Now()); ok {
			sink.OnEvent(ev)
		}
	})
}

var (
	_ backend.Backend = (*Hikvision)(nil)
	_ backend.Player  = (*Hikvision)(nil)
)
