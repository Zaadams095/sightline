package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Hub API v1 (docs/HUB_API.md). Every route except /v1/info (public part), /v1/pair and
// /v1/redeem needs a token, and every route enforces the caller's grant.

func (h *hub) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/info", h.handleInfo)
	mux.HandleFunc("POST /v1/pair", h.handlePair)
	mux.HandleFunc("POST /v1/redeem", h.handleRedeem)

	mux.HandleFunc("GET /v1/cameras", h.authed(nil, h.handleCameras))
	mux.HandleFunc("GET /v1/cameras/{id}/snapshot.jpg", h.authed(nil, h.handleSnapshot))
	mux.HandleFunc("GET /v1/cameras/{id}/live", h.authed(nil, h.handleLive))
	mux.HandleFunc("GET /v1/cameras/{id}/ptz", h.authed(needPTZ, h.handlePTZInfo))
	mux.HandleFunc("POST /v1/cameras/{id}/ptz", h.authed(needPTZ, h.handlePTZ))

	mux.HandleFunc("GET /v1/events", h.authed(needRecordings, h.handleEvents))
	mux.HandleFunc("GET /v1/events/{id}/thumbnail.jpg", h.authed(needRecordings, h.handleEventThumb))

	mux.HandleFunc("GET /v1/recordings/{cam}/segments", h.authed(needRecordings, h.handleSegments))
	mux.HandleFunc("GET /v1/recordings/{cam}/vod.m3u8", h.authed(needRecordings, h.handleVODMaster))
	mux.HandleFunc("GET /v1/recordings/{cam}/vod/{start}/{end}/{file}", h.authed(needRecordings, h.handleVODFile))
	mux.HandleFunc("GET /v1/recordings/{cam}/clip.mp4", h.authed(needRecordings, h.handleClip))
	mux.HandleFunc("GET /v1/recordings/{cam}/playback", h.authed(needRecordings, h.handlePlayback))
	mux.HandleFunc("GET /v1/recordings/{cam}/playback/stream", h.authed(needRecordings, h.handlePlaybackStream))
	mux.HandleFunc("GET /v1/recordings/{cam}/playback/file.mp4", h.authed(needRecordings, h.handlePlaybackFile))

	mux.HandleFunc("PUT /v1/devices/{id}", h.authed(needPush, h.handleDevicePut))
	mux.HandleFunc("DELETE /v1/devices/{id}", h.authed(needPush, h.handleDeviceDelete))
	mux.HandleFunc("POST /v1/devices/{id}/test", h.authed(needPush, h.handleDeviceTest))

	mux.HandleFunc("GET /v1/grants", h.authed(needManager, h.handleGrantList))
	mux.HandleFunc("POST /v1/grants", h.authed(needManager, h.handleGrantCreate))
	mux.HandleFunc("DELETE /v1/grants/{id}", h.authed(needManager, h.handleGrantRevoke))
	mux.HandleFunc("POST /v1/grants/{id}/invite", h.authed(needManager, h.handleGrantReinvite))
}

// ---- info ----

type systemInfo struct {
	ID           string       `json:"id"`
	Kind         string       `json:"kind"`
	Label        string       `json:"label"`
	Name         string       `json:"name"`
	Capabilities capabilities `json:"capabilities"`
}

type capabilities struct {
	Live       bool `json:"live"`
	Snapshots  bool `json:"snapshots"`
	Events     bool `json:"events"`
	Recordings bool `json:"recordings"`
	Clips      bool `json:"clips"`
	PTZ        bool `json:"ptz"`
	// Alerts: Instant Alerts can be delivered (the system has an event stream).
	Alerts  bool `json:"alerts"`
	Push    bool `json:"push"`
	Sharing bool `json:"sharing"`
}

// capsFor is what the caller can use: the systems' features narrowed by the grant.
func capsFor(g *grant, sys backend.Capabilities) capabilities {
	rec := g.canRecordings()
	return capabilities{
		Live: true, Snapshots: sys.Snapshots, Events: rec && sys.Events, Recordings: rec && sys.Recordings,
		Clips: rec && sys.Clips, PTZ: g.canPTZ() && sys.PTZ, Alerts: g.canPush() && sys.Alerts,
		Push: g.canPush(), Sharing: g.manager(),
	}
}

// anyCaps is the union of every system's features (what at least one camera can do).
func anyCaps(systems []*system) backend.Capabilities {
	var u backend.Capabilities
	for _, s := range systems {
		c := s.b.Capabilities()
		u.Snapshots = u.Snapshots || c.Snapshots
		u.Events = u.Events || c.Events
		u.Recordings = u.Recordings || c.Recordings
		u.Clips = u.Clips || c.Clips
		u.PTZ = u.PTZ || c.PTZ
		u.Alerts = u.Alerts || c.Alerts
	}
	return u
}

func (h *hub) handleInfo(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{
		"sightline":  "hub",
		"name":       h.name(),
		"version":    version,
		"apiVersion": 1,
		"paired":     h.grants.hasOwner(),
		// Optional behaviors newer apps can rely on ("zones": activity zones in device rules).
		"features": []string{"zones"},
	}
	tok := requestToken(r)
	if tok == "" {
		writeJSON(w, http.StatusOK, out)
		return
	}
	h.authed(nil, func(w http.ResponseWriter, r *http.Request) {
		g := grantFrom(r)
		systems := []systemInfo{}
		list := h.systemList()
		for _, s := range list {
			name := s.cfg.Name
			if name == "" {
				name = s.b.Label()
			}
			systems = append(systems, systemInfo{ID: s.cfg.ID, Kind: s.b.Kind(), Label: s.b.Label(), Name: name,
				Capabilities: capsFor(g, s.b.Capabilities())})
		}
		out["systems"] = systems
		out["lanUrl"] = h.lanURL(r)
		if u := h.remoteURL(); u != "" {
			out["remoteUrl"] = u
		} else {
			out["remoteUrl"] = nil
		}
		out["capabilities"] = capsFor(g, anyCaps(list))
		out["grant"] = g.view(time.Now())
		writeJSON(w, http.StatusOK, out)
	})(w, r)
}

// ---- pairing & invites ----

type tokenResponse struct {
	Token string    `json:"token"`
	Grant grantView `json:"grant"`
	Hub   hubRef    `json:"hub"`
}

type hubRef struct {
	Name      string `json:"name"`
	LanURL    string `json:"lanUrl"`
	RemoteURL string `json:"remoteUrl,omitempty"`
}

func (h *hub) ref(r *http.Request) hubRef {
	return hubRef{Name: h.name(), LanURL: h.lanURL(r), RemoteURL: h.remoteURL()}
}

func (h *hub) handlePair(w http.ResponseWriter, r *http.Request) {
	if isRemote(r) {
		apiError(w, http.StatusForbidden, "lan_only", "Pair from your home network.")
		return
	}
	ip := clientIP(r)
	if h.pairLimit.blocked(ip) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many wrong codes. Wait a few minutes and try again.")
		return
	}
	var body struct {
		Code       string `json:"code"`
		DeviceName string `json:"deviceName"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if !h.pairing.use(body.Code) {
		h.pairLimit.fail(ip)
		apiError(w, http.StatusUnauthorized, "bad_code", "That pairing code isn't right. Check the Hub's setup page for the current code.")
		return
	}
	token, g, err := h.grants.addOwner(trimName(body.DeviceName))
	if err != nil {
		apiError(w, http.StatusInternalServerError, "storage", err.Error())
		return
	}
	log.Printf("paired a new owner phone (%s)", g.Name)
	writeJSON(w, http.StatusOK, tokenResponse{Token: token, Grant: g.view(time.Now()), Hub: h.ref(r)})
}

func (h *hub) handleRedeem(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if h.redeemLimit.blocked(ip) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Wait a few minutes and try again.")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	token, g, err := h.grants.redeem(body.Code)
	if err != nil {
		h.redeemLimit.fail(ip)
		apiError(w, http.StatusUnauthorized, "bad_invite", errBadInvite.Error())
		return
	}
	log.Printf("invite redeemed for %q (%s)", g.Name, g.Role)
	writeJSON(w, http.StatusOK, tokenResponse{Token: token, Grant: g.view(time.Now()), Hub: h.ref(r)})
}

func trimName(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

// ---- grants ----

func (h *hub) handleGrantList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.grants.list())
}

type inviteView struct {
	Code      string `json:"code"`
	Link      string `json:"link"`
	WebLink   string `json:"webLink,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
	// QR is a data:image/png URL of Link, so the app can show it without a QR library.
	QR string `json:"qr"`
}

func (h *hub) invite(r *http.Request, code string, g *grant) inviteView {
	lan, remote := h.lanURL(r), h.remoteURL()
	inv := inviteView{Code: code, Link: inviteLink("invite", code, h.name(), lan, remote)}
	if remote != "" {
		inv.WebLink = remote + "/invite?code=" + url.QueryEscape(code)
	}
	if len(g.Invites) > 0 {
		inv.ExpiresAt = g.Invites[len(g.Invites)-1].ExpiresAt
	}
	inv.QR = string(qrDataURL(inv.Link))
	return inv
}

// inviteLink builds sightline://<kind>?url=…&code=…: url is the address to use first (the
// public one when remote access is on), lan/remote are both included when known.
func inviteLink(kind, code, name, lan, remote string) string {
	v := url.Values{}
	primary := lan
	if remote != "" && kind == "invite" {
		primary = remote
	}
	v.Set("url", primary)
	v.Set("code", code)
	if name != "" {
		v.Set("name", name)
	}
	if lan != "" && lan != primary {
		v.Set("lan", lan)
	}
	if remote != "" && remote != primary {
		v.Set("remote", remote)
	}
	return "sightline://" + kind + "?" + v.Encode()
}

type grantRequest struct {
	Name       string     `json:"name"`
	Role       string     `json:"role"`
	Cameras    *cameraSet `json:"cameras"`
	Recordings *recWindow `json:"recordings"`
	ExpiresAt  *int64     `json:"expiresAt"`
}

// validateGrant fills defaults and checks a new grant (docs/HUB_API.md "Roles").
func validateGrant(req grantRequest, known []string, now time.Time) (*grant, error) {
	g := &grant{Name: trimName(req.Name), Role: req.Role, ExpiresAt: req.ExpiresAt}
	if g.Name == "" {
		return nil, errors.New("give this access a name (who is it for?)")
	}
	if !slices.Contains(guestRoles, g.Role) {
		return nil, errors.New(`role must be "full", "household", "temporary" or "live"`)
	}
	if g.ExpiresAt != nil && *g.ExpiresAt <= now.Unix() {
		return nil, errors.New("the end date is in the past")
	}
	if req.Cameras != nil {
		g.Cameras = *req.Cameras
	} else {
		g.Cameras = cameraSet{All: true}
	}
	for _, id := range g.Cameras.IDs {
		if !slices.Contains(known, id) {
			return nil, errors.New("unknown camera: " + id)
		}
	}
	if !g.Cameras.All && len(g.Cameras.IDs) == 0 {
		return nil, errors.New("pick at least one camera")
	}
	switch g.Role {
	case roleFull:
		// Owner-equivalent: everything.
		g.Cameras = cameraSet{All: true}
		g.Recordings = recWindow{Mode: "all"}
	case roleHousehold:
		g.Recordings = recWindow{Mode: "all"}
		if req.Recordings != nil {
			g.Recordings = *req.Recordings
		}
	case roleTemporary:
		if g.ExpiresAt == nil {
			return nil, errors.New("temporary access needs an end date")
		}
		g.Recordings = recWindow{Mode: "window", From: now.Unix(), To: *g.ExpiresAt}
		if req.Recordings != nil {
			g.Recordings = *req.Recordings
		}
	case roleLive:
		g.Recordings = recWindow{Mode: "none"}
	}
	return g, nil
}

func (h *hub) knownCameraIDs(ctx context.Context) []string {
	var ids []string
	for _, c := range h.allCameras(ctx) {
		ids = append(ids, c.ID)
	}
	return ids
}

func (h *hub) handleGrantCreate(w http.ResponseWriter, r *http.Request) {
	var req grantRequest
	if !decodeBody(w, r, &req) {
		return
	}
	g, err := validateGrant(req, h.knownCameraIDs(r.Context()), time.Now())
	if err != nil {
		apiError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	code, g, err := h.grants.create(g, grantFrom(r).ID)
	if err != nil {
		apiError(w, http.StatusInternalServerError, "storage", err.Error())
		return
	}
	log.Printf("shared access created: %q (%s)", g.Name, g.Role)
	writeJSON(w, http.StatusCreated, map[string]any{"grant": g.view(time.Now()), "invite": h.invite(r, code, g)})
}

func (h *hub) handleGrantReinvite(w http.ResponseWriter, r *http.Request) {
	code, g, err := h.grants.reinvite(r.PathValue("id"))
	if err != nil {
		apiError(w, http.StatusNotFound, "not_found", "That access doesn't exist or has ended.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"grant": g.view(time.Now()), "invite": h.invite(r, code, g)})
}

func (h *hub) handleGrantRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	target := h.grants.get(id)
	if target == nil || target.RevokedAt > 0 {
		apiError(w, http.StatusNotFound, "not_found", "That access doesn't exist.")
		return
	}
	caller := grantFrom(r)
	if target.Role == roleOwner && caller.Role != roleOwner {
		apiError(w, http.StatusForbidden, "forbidden", errOwnerOnly.Error())
		return
	}
	if err := h.revokeGrant(id); err != nil {
		apiError(w, http.StatusInternalServerError, "storage", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// revokeGrant removes access immediately and unregisters its phones from alerts.
func (h *hub) revokeGrant(id string) error {
	g, err := h.grants.revoke(id)
	if err != nil {
		return err
	}
	for _, d := range h.store.all() {
		if d.GrantID == id {
			_ = h.store.delete(d.ID)
		}
	}
	log.Printf("access removed: %q (%s)", g.Name, g.Role)
	return nil
}

// ---- cameras ----

type cameraView struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Enabled    bool        `json:"enabled"`
	PTZ        bool        `json:"ptz"`
	Aspect     float64     `json:"aspect"`
	Zones      []string    `json:"zones"`
	Objects    []string    `json:"objects"`
	DetectSize *detectSize `json:"detectSize"`
	System     string      `json:"system"`
}

type detectSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// allCameras lists every system's cameras (systems that fail are skipped).
func (h *hub) allCameras(ctx context.Context) []cameraView {
	systems := h.systemList()
	results := make([][]cameraView, len(systems))
	var wg sync.WaitGroup
	for i, s := range systems {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			cams, err := s.b.Cameras(cctx)
			s.setStatus(err, len(cams))
			if err != nil {
				return
			}
			for _, c := range cams {
				v := cameraView{
					ID: s.publicID(c.ID), Name: c.Name, Enabled: c.Enabled, PTZ: c.PTZ, Aspect: c.Aspect,
					Zones: nonNil(c.Zones), Objects: nonNil(c.Objects), System: s.cfg.ID,
				}
				if c.DetectWidth > 0 && c.DetectHeight > 0 {
					v.DetectSize = &detectSize{c.DetectWidth, c.DetectHeight}
				}
				results[i] = append(results[i], v)
			}
		}()
	}
	wg.Wait()
	var out []cameraView
	for _, r := range results {
		out = append(out, r...)
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (h *hub) handleCameras(w http.ResponseWriter, r *http.Request) {
	g := grantFrom(r)
	out := []cameraView{}
	for _, c := range h.allCameras(r.Context()) {
		if g.Cameras.has(c.ID) {
			if !g.canPTZ() {
				c.PTZ = false
			}
			out = append(out, c)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// camera resolves a public camera ID the caller may see; otherwise it writes 404.
func (h *hub) camera(w http.ResponseWriter, r *http.Request, id string) (*system, string, bool) {
	g := grantFrom(r)
	s, native, ok := h.resolve(id)
	if !ok || !g.Cameras.has(id) {
		apiError(w, http.StatusNotFound, "not_found", "No such camera.")
		return nil, "", false
	}
	return s, native, true
}

func backendError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backend.ErrNotFound):
		apiError(w, http.StatusNotFound, "not_found", "Not found.")
	case errors.Is(err, backend.ErrUnsupported):
		apiError(w, http.StatusNotImplemented, "unsupported", "This system doesn't support that.")
	default:
		apiError(w, http.StatusBadGateway, "upstream", err.Error())
	}
}

func (h *hub) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	height, _ := strconv.Atoi(r.URL.Query().Get("height"))
	if height < 0 || height > 2160 {
		height = 0
	}
	img, ct, err := s.b.Snapshot(r.Context(), native, height)
	if err != nil {
		backendError(w, err)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(img)
}

func (h *hub) handlePTZInfo(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	info, err := s.b.PTZInfo(r.Context(), native)
	if err != nil {
		backendError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *hub) handlePTZ(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("id"))
	if !ok {
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if err := s.b.PTZ(r.Context(), native, body.Action); err != nil {
		backendError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- events ----

type eventView struct {
	ID         string   `json:"id"`
	Camera     string   `json:"camera"`
	Start      float64  `json:"start"`
	End        *float64 `json:"end"`
	Severity   string   `json:"severity"`
	Objects    []string `json:"objects"`
	SubLabels  []string `json:"subLabels"`
	Zones      []string `json:"zones"`
	Detections []string `json:"detections"`
	Reviewed   bool     `json:"reviewed"`
	Thumbnail  string   `json:"thumbnail"`
}

func parseFloat(v string) float64 {
	f, _ := strconv.ParseFloat(v, 64)
	return f
}

// inWindow reports whether t is inside the grant's recordings window.
func inWindow(g *grant, t float64) bool {
	return g.Recordings.Mode == "all" || (g.Recordings.Mode == "window" && t >= float64(g.Recordings.From) && t <= float64(g.Recordings.To))
}

func (h *hub) handleEvents(w http.ResponseWriter, r *http.Request) {
	g := grantFrom(r)
	q := r.URL.Query()
	after, before, ok := g.Recordings.clamp(parseFloat(q.Get("after")), parseFloat(q.Get("before")))
	out := []eventView{}
	if !ok {
		writeJSON(w, http.StatusOK, out)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	// Requested cameras, narrowed to the grant, grouped by system.
	var want []string
	if c := q.Get("cameras"); c != "" {
		want = strings.Split(c, ",")
	}
	bySystem := map[*system][]string{}
	if len(want) == 0 && g.Cameras.All {
		for _, s := range h.systemList() {
			bySystem[s] = nil // all cameras of this system
		}
	} else {
		if len(want) == 0 {
			want = g.Cameras.IDs
		}
		for _, id := range want {
			if !g.Cameras.has(id) {
				continue
			}
			if s, native, ok := h.resolve(id); ok {
				bySystem[s] = append(bySystem[s], native)
			}
		}
	}
	tq := tokenQuery(r)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for s, cams := range bySystem {
		wg.Add(1)
		go func() {
			defer wg.Done()
			evs, err := s.b.Events(r.Context(), backend.EventQuery{Cameras: cams, After: after, Before: before, Severity: q.Get("severity"), Limit: limit})
			if err != nil {
				log.Printf("%s events: %v", s.cfg.ID, err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, e := range evs {
				cam := s.publicID(e.Camera)
				if !g.Cameras.has(cam) || !inWindow(g, e.Start) {
					continue
				}
				id := s.publicID(e.ID)
				dets := make([]string, len(e.Detections))
				for i, d := range e.Detections {
					dets[i] = s.publicID(d)
				}
				out = append(out, eventView{
					ID: id, Camera: cam, Start: e.Start, End: e.End, Severity: e.Severity,
					Objects: nonNil(e.Objects), SubLabels: nonNil(e.SubLabels), Zones: nonNil(e.Zones),
					Detections: dets, Reviewed: e.Reviewed,
					Thumbnail: "/v1/events/" + url.PathEscape(id) + "/thumbnail.jpg" + tq,
				})
			}
		}()
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Start > out[j].Start })
	if len(out) > limit {
		out = out[:limit]
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *hub) handleEventThumb(w http.ResponseWriter, r *http.Request) {
	g := grantFrom(r)
	id := r.PathValue("id")
	s, native, ok := h.resolve(id)
	if !ok {
		apiError(w, http.StatusNotFound, "not_found", "No such event.")
		return
	}
	ev, err := s.b.Event(r.Context(), native)
	if err != nil {
		backendError(w, err)
		return
	}
	// Events on cameras outside the grant don't exist for this caller; outside the window
	// they're forbidden.
	if !g.Cameras.has(s.publicID(ev.Camera)) {
		apiError(w, http.StatusNotFound, "not_found", "No such event.")
		return
	}
	if !inWindow(g, ev.Start) {
		apiError(w, http.StatusForbidden, "outside_window", "This is outside the time you were given access to.")
		return
	}
	img, ct, err := s.b.EventThumbnail(r.Context(), native)
	if err != nil {
		backendError(w, err)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write(img)
}

// ---- recordings ----

func (h *hub) handleSegments(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("cam"))
	if !ok {
		return
	}
	g := grantFrom(r)
	q := r.URL.Query()
	reqAfter, reqBefore := parseFloat(q.Get("after")), parseFloat(q.Get("before"))
	if reqBefore == 0 {
		reqBefore = float64(time.Now().Unix())
	}
	after, before, ok := g.Recordings.clamp(reqAfter, reqBefore)
	out := []backend.Segment{}
	if !ok {
		writeJSON(w, http.StatusOK, out)
		return
	}
	segs, err := s.b.Segments(r.Context(), native, after, before)
	if err != nil {
		backendError(w, err)
		return
	}
	for _, sg := range segs {
		sg.Start, sg.End = max(sg.Start, after), min(sg.End, before)
		if sg.End > sg.Start {
			out = append(out, sg)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// mediaWindow parses start/end and applies the grant: entirely outside the window → 403,
// partly outside → clamped (strict: any part outside → 403).
func mediaWindow(w http.ResponseWriter, g *grant, startS, endS string, strict bool) (int64, int64, bool) {
	start, err1 := strconv.ParseInt(startS, 10, 64)
	end, err2 := strconv.ParseInt(endS, 10, 64)
	if err1 != nil || err2 != nil || end <= start || start <= 0 {
		apiError(w, http.StatusBadRequest, "bad_request", "start and end must be unix seconds with start < end")
		return 0, 0, false
	}
	if end-start > 7200 {
		end = start + 7200 // one playlist covers at most 2 hours
	}
	switch g.Recordings.Mode {
	case "all":
		return start, end, true
	case "window":
		from, to := g.Recordings.From, g.Recordings.To
		inside := start >= from && end <= to
		overlaps := end > from && start < to
		if inside || (!strict && overlaps) {
			return max(start, from), min(end, to), true
		}
	}
	apiError(w, http.StatusForbidden, "outside_window", "This is outside the time you were given access to.")
	return 0, 0, false
}

func (h *hub) handleVODMaster(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("cam"))
	if !ok {
		return
	}
	q := r.URL.Query()
	start, end, ok := mediaWindow(w, grantFrom(r), q.Get("start"), q.Get("end"), false)
	if !ok {
		return
	}
	resp, err := s.b.VOD(r.Context(), native, start, end, "", r.Header)
	if err != nil {
		backendError(w, err)
		return
	}
	h.proxyMedia(w, resp, "vod/"+strconv.FormatInt(start, 10)+"/"+strconv.FormatInt(end, 10)+"/", tokenQuery(r))
}

func (h *hub) handleVODFile(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("cam"))
	if !ok {
		return
	}
	start, end, ok := mediaWindow(w, grantFrom(r), r.PathValue("start"), r.PathValue("end"), true)
	if !ok {
		return
	}
	if ps, _ := strconv.ParseInt(r.PathValue("end"), 10, 64); ps != end {
		// Playlists are always issued with a clamped window, so a mismatch is a forged URL.
		apiError(w, http.StatusForbidden, "outside_window", "This is outside the time you were given access to.")
		return
	}
	file := r.PathValue("file")
	if !safeFileName.MatchString(file) || strings.Contains(file, "..") {
		apiError(w, http.StatusNotFound, "not_found", "No recording here.")
		return
	}
	resp, err := s.b.VOD(r.Context(), native, start, end, file, r.Header)
	if err != nil {
		backendError(w, err)
		return
	}
	h.proxyMedia(w, resp, "", tokenQuery(r))
}

func (h *hub) handleClip(w http.ResponseWriter, r *http.Request) {
	s, native, ok := h.camera(w, r, r.PathValue("cam"))
	if !ok {
		return
	}
	q := r.URL.Query()
	start, end, ok := mediaWindow(w, grantFrom(r), q.Get("start"), q.Get("end"), false)
	if !ok {
		return
	}
	resp, err := s.b.Clip(r.Context(), native, start, end, r.Header)
	if err != nil {
		backendError(w, err)
		return
	}
	h.proxyMedia(w, resp, "", "")
}

// proxyMedia streams an upstream media response; HLS playlists are rewritten so every URI
// points back at the Hub (prefix is prepended to each, query appended).
func (h *hub) proxyMedia(w http.ResponseWriter, resp *http.Response, prefix, query string) {
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		apiError(w, http.StatusNotFound, "not_found", "No recording here.")
		return
	}
	if resp.StatusCode >= 400 {
		apiError(w, http.StatusBadGateway, "upstream", "The recorder returned HTTP "+strconv.Itoa(resp.StatusCode))
		return
	}
	ct := resp.Header.Get("Content-Type")
	if isPlaylist(ct, resp.Request) {
		b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			apiError(w, http.StatusBadGateway, "upstream", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, rewritePlaylist(string(b), prefix, query))
		return
	}
	for _, k := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag", "Content-Disposition"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func isPlaylist(ct string, req *http.Request) bool {
	ct = strings.ToLower(ct)
	if strings.Contains(ct, "mpegurl") {
		return true
	}
	return req != nil && strings.HasSuffix(req.URL.Path, ".m3u8")
}

// ---- devices (Instant Alerts) ----

func (h *hub) ownsDevice(w http.ResponseWriter, g *grant, id string) bool {
	if old, ok := h.store.get(id); ok && old.GrantID != g.ID && g.Role != roleOwner {
		apiError(w, http.StatusForbidden, "forbidden", "This phone is registered by someone else.")
		return false
	}
	return true
}

func (h *hub) handleDevicePut(w http.ResponseWriter, r *http.Request) {
	g := grantFrom(r)
	id := r.PathValue("id")
	if !h.ownsDevice(w, g, id) {
		return
	}
	var d device
	if !decodeBody(w, r, &d) {
		return
	}
	if !strings.HasPrefix(d.PushToken, "ExponentPushToken[") {
		apiError(w, http.StatusBadRequest, "bad_request", "invalid push token")
		return
	}
	if d.ThumbKey != "" && len(d.ThumbKey) < 16 {
		apiError(w, http.StatusBadRequest, "bad_request", "thumbKey must be at least 16 characters")
		return
	}
	d.ID = id
	d.GrantID = g.ID
	d.UpdatedAt = time.Now().Unix()
	if err := h.store.put(d); err != nil {
		apiError(w, http.StatusInternalServerError, "storage", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *hub) handleDeviceDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !h.ownsDevice(w, grantFrom(r), id) {
		return
	}
	_ = h.store.delete(id)
	w.WriteHeader(http.StatusNoContent)
}

func (h *hub) handleDeviceTest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	d, ok := h.store.get(id)
	if !ok || (d.GrantID != grantFrom(r).ID && grantFrom(r).Role != roleOwner) {
		apiError(w, http.StatusNotFound, "not_found", "This phone isn't registered for alerts.")
		return
	}
	if err := sendTestPush(r.Context(), h.pusher, d); err != nil {
		apiError(w, http.StatusBadGateway, "push", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
