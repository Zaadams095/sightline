package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"rsc.io/qr"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// The setup page (GET /) is the Hub's only "settings screen": plain HTML forms, no scripts,
// readable on a phone. It's served on the home network only (never over the public link).

// pairWindow: after a restart, the page can make a new pairing code for this long even when
// a phone is already paired (restarting the Hub is the "I own this box" proof).
const pairWindow = 15 * time.Minute

func (h *hub) handler(legacy http.Handler) http.Handler {
	mux := http.NewServeMux()
	h.routes(mux)
	mux.HandleFunc("GET /{$}", h.guardSetup(h.handleSetupPage))
	mux.HandleFunc("POST /setup/{action...}", h.guardSetup(h.handleSetupAction))
	mux.HandleFunc("GET /invite", h.handleInviteLanding)
	if legacy != nil {
		mux.Handle("/", legacy)
	}
	h.lanHandler = mux
	return mux
}

// localHost reports whether a Host header names this Hub on the local network. Browsers send
// the attacker's name under DNS rebinding, so only IPs and local-only names pass.
func (h *hub) localHost(hostport string) bool {
	host := strings.ToLower(hostport)
	if hn, _, err := net.SplitHostPort(host); err == nil {
		host = hn
	}
	host = strings.Trim(host, "[]")
	if net.ParseIP(host) != nil || host == "localhost" || !strings.Contains(host, ".") {
		return true
	}
	for _, suf := range []string{".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain"} {
		if strings.HasSuffix(host, suf) {
			return true
		}
	}
	return slices.Contains(h.cfg.setupHosts, host)
}

// guardSetup protects the setup page: home network only, local host names only, same-origin
// form posts, and the optional SETUP_PASSWORD.
func (h *hub) guardSetup(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if isRemote(r) {
			http.NotFound(w, r)
			return
		}
		ingress := isIngress(r)
		if !ingress && !h.localHost(r.Host) {
			http.Error(w, "Open the setup page using the Hub's IP address (or add this name to SETUP_HOSTS).", http.StatusMisdirectedRequest)
			return
		}
		if r.Method == http.MethodPost && !sameOrigin(r) {
			http.Error(w, "cross-site request blocked", http.StatusForbidden)
			return
		}
		if h.cfg.setupPassword != "" && !ingress {
			_, pass, ok := r.BasicAuth()
			if !ok || subtle.ConstantTimeCompare([]byte(pass), []byte(h.cfg.setupPassword)) != 1 {
				w.Header().Set("WWW-Authenticate", `Basic realm="Sightline Hub setup"`)
				http.Error(w, "password required", http.StatusUnauthorized)
				return
			}
		}
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		fn(w, r)
	}
}

func sameOrigin(r *http.Request) bool {
	if s := r.Header.Get("Sec-Fetch-Site"); s != "" && s != "same-origin" && s != "none" {
		return false
	}
	for _, hdr := range []string{"Origin", "Referer"} {
		v := r.Header.Get(hdr)
		if v == "" || v == "null" {
			continue
		}
		u, err := url.Parse(v)
		if err != nil {
			return false
		}
		return strings.EqualFold(u.Host, r.Host)
	}
	return true
}

// ---- page ----

type pageSystem struct {
	ID, Name, Kind, URL, Status string
	OK, FromEnv                 bool
	Alerts                      bool
}

// pageBrand is one choice under "Add a camera system", with its form fields.
type pageBrand struct {
	Kind, Label, Description string
	Fields                   []pageField
	Sections                 []pageSection
}

type pageSection struct {
	Title  string
	Fields []pageField
}

type pageField struct {
	Name, Label, Hint, Help, Default string
	InputType, InputMode             string
	Required                         bool
}

func pageBrands() ([]pageBrand, bool) {
	var out []pageBrand
	onvif := false
	for _, d := range backend.Descriptors() {
		onvif = onvif || d.Kind == "onvif"
		b := pageBrand{Kind: d.Kind, Label: d.Label, Description: d.Description}
		for _, f := range d.Fields {
			pf := pageField{Name: "f-" + f.Key, Label: f.Label, Hint: f.Hint, Help: f.Help, Default: f.Default,
				InputType: "text", Required: !f.Optional && f.Default == ""}
			switch f.Type {
			case backend.FieldSecret:
				pf.InputType = "password"
			case backend.FieldAddress:
				pf.InputMode = "url"
			case backend.FieldNumber:
				pf.InputMode = "numeric"
			}
			if f.Section == "" {
				b.Fields = append(b.Fields, pf)
				continue
			}
			i := slices.IndexFunc(b.Sections, func(s pageSection) bool { return s.Title == f.Section })
			if i < 0 {
				b.Sections = append(b.Sections, pageSection{Title: f.Section})
				i = len(b.Sections) - 1
			}
			b.Sections[i].Fields = append(b.Sections[i].Fields, pf)
		}
		out = append(out, b)
	}
	return out, onvif
}

type pageGrant struct {
	ID, Name, Kind, Detail string
}

type setupData struct {
	Name, Version string
	Message       string
	IsError       bool
	Ingress       bool

	Paired        bool
	PairCode      string
	PairExpires   string
	PairQR        template.URL
	PairLink      string
	LanURL        string
	CanRenewPair  bool
	RestartToPair bool

	Systems   []pageSystem
	Brands    []pageBrand
	HasONVIF  bool
	Cameras   int
	SystemsOK bool
	NoSystems bool

	Remote          remoteStatus
	RemoteAvailable bool
	Refresh         bool

	Owners []pageGrant
	Guests []pageGrant
}

func qrDataURL(text string) template.URL {
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		return ""
	}
	c.Scale = 6
	return template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(c.PNG()))
}

func roleLabel(role string) string {
	switch role {
	case roleOwner:
		return "Owner"
	case roleFull:
		return "Full access"
	case roleHousehold:
		return "Household"
	case roleTemporary:
		return "Temporary"
	case roleLive:
		return "Live only"
	}
	return role
}

func fmtDate(unix int64) string { return time.Unix(unix, 0).Format("Jan 2, 2006 3:04 PM") }

func grantDetail(g grantView, now time.Time) string {
	var parts []string
	if g.Cameras.All {
		parts = append(parts, "All cameras")
	} else {
		parts = append(parts, fmt.Sprintf("%d camera%s", len(g.Cameras.IDs), plural(len(g.Cameras.IDs))))
	}
	switch g.Recordings.Mode {
	case "none":
		parts = append(parts, "no recordings")
	case "window":
		parts = append(parts, "recordings "+fmtDate(g.Recordings.From)+" – "+fmtDate(g.Recordings.To))
	}
	if g.ExpiresAt != nil {
		if *g.ExpiresAt <= now.Unix() {
			parts = append(parts, "ended")
		} else {
			parts = append(parts, "ends "+fmtDate(*g.ExpiresAt))
		}
	}
	if g.Devices == 0 && g.Role != roleOwner {
		if g.PendingInvite {
			parts = append(parts, "invite not used yet")
		} else {
			parts = append(parts, "no phones")
		}
	}
	return strings.Join(parts, " · ")
}

func (h *hub) handleSetupPage(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cams := h.allCameras(ctx)

	d := setupData{
		Name: h.name(), Version: version, Ingress: isIngress(r),
		Message: r.URL.Query().Get("msg"), IsError: r.URL.Query().Get("err") == "1",
		Paired: h.grants.hasOwner(), LanURL: h.lanURL(r), Cameras: len(cams),
		Remote: h.remote.status(), RemoteAvailable: h.remote.available(),
	}
	if code := h.pairing.current(); code != "" {
		d.PairCode = code
		d.PairLink = inviteLink("hub", code, d.Name, d.LanURL, h.remoteURL())
		d.PairQR = qrDataURL(d.PairLink)
		if exp := h.pairing.expiresAt(); !exp.IsZero() {
			d.PairExpires = exp.Format("3:04 PM")
		}
	} else if d.Paired {
		d.CanRenewPair = now.Sub(h.startedAt) < pairWindow
		d.RestartToPair = !d.CanRenewPair
	}

	d.SystemsOK = true
	for _, s := range h.systemList() {
		status, ok := s.getStatus()
		if status == "" {
			status = "Checking…"
		}
		name := s.cfg.Name
		if name == "" {
			name = s.b.Label()
		}
		d.Systems = append(d.Systems, pageSystem{
			ID: s.cfg.ID, Name: name, Kind: s.b.Label(), URL: s.cfg.URL, Status: status, OK: ok,
			FromEnv: s.cfg.FromEnv, Alerts: s.b.Capabilities().Alerts,
		})
		d.SystemsOK = d.SystemsOK && ok
	}
	d.NoSystems = len(d.Systems) == 0
	d.Brands, d.HasONVIF = pageBrands()

	for _, g := range h.grants.list() {
		pg := pageGrant{ID: g.ID, Name: g.Name, Kind: roleLabel(g.Role), Detail: grantDetail(g, now)}
		if g.Role == roleOwner {
			pg.Detail = "Paired " + fmtDate(g.CreatedAt)
			d.Owners = append(d.Owners, pg)
		} else {
			d.Guests = append(d.Guests, pg)
		}
	}
	switch d.Remote.State {
	case "starting", "needs-login", "needs-funnel":
		d.Refresh = true
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := setupTmpl.Execute(w, d); err != nil {
		log.Printf("setup page: %v", err)
	}
}

// ---- actions ----

func redirectBack(w http.ResponseWriter, r *http.Request, msg string, isErr bool) {
	q := url.Values{}
	if msg != "" {
		q.Set("msg", msg)
	}
	if isErr {
		q.Set("err", "1")
	}
	loc := "../"
	if strings.Count(r.URL.Path, "/") > 2 { // /setup/a/b
		loc = "../../"
	}
	if len(q) > 0 {
		loc += "?" + q.Encode()
	}
	http.Redirect(w, r, loc, http.StatusSeeOther)
}

func (h *hub) handleSetupAction(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch r.PathValue("action") {
	case "pair":
		if h.grants.hasOwner() && time.Since(h.startedAt) >= pairWindow {
			redirectBack(w, r, "To pair another phone, restart the Hub, then open this page within 15 minutes.", true)
			return
		}
		code := h.pairing.renew()
		log.Printf("New pairing code: %s (valid for 15 minutes)", code)
		redirectBack(w, r, "", false)
	case "name":
		name := trimName(r.PostFormValue("name"))
		_ = h.saveSettings(func(s *hubSettings) { s.Name = name })
		redirectBack(w, r, "Saved.", false)
	case "systems/add":
		h.addSystem(w, r)
	case "systems/remove":
		id := r.PostFormValue("id")
		removed := false
		_ = h.saveSettings(func(s *hubSettings) {
			s.Systems = slices.DeleteFunc(s.Systems, func(c backend.Config) bool {
				removed = removed || c.ID == id
				return c.ID == id
			})
		})
		if removed {
			h.reloadSystems()
		}
		redirectBack(w, r, "Removed.", false)
	case "remote/enable":
		if !h.remote.available() {
			redirectBack(w, r, h.remote.status().Message, true)
			return
		}
		_ = h.saveSettings(func(s *hubSettings) { s.RemoteEnabled = true })
		h.remote.enable()
		redirectBack(w, r, "", false)
	case "remote/disable", "remote/forget":
		_ = h.saveSettings(func(s *hubSettings) { s.RemoteEnabled = false })
		forget := strings.HasSuffix(r.PathValue("action"), "forget")
		h.remote.disable(forget)
		msg := "Remote access is off."
		if forget {
			msg = "Remote access is off and the Hub is signed out of Tailscale."
		}
		redirectBack(w, r, msg, false)
	case "grants/revoke":
		if err := h.revokeGrant(r.PostFormValue("id")); err != nil {
			redirectBack(w, r, "That access was already removed.", true)
			return
		}
		redirectBack(w, r, "Access removed.", false)
	default:
		http.NotFound(w, r)
	}
}

// addressCandidates turns a typed address ("192.168.1.10", "nvr.local:8000" or a full URL)
// into the URLs to try, in order: as typed when it has a port, otherwise one per default port
// (port 443 means https unless a scheme was typed; the scheme's own port is left out).
func addressCandidates(raw, scheme string, ports []int) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if scheme == "" {
		scheme = "http"
	}
	typedScheme := strings.Contains(raw, "://")
	if !typedScheme {
		raw = scheme + "://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || strings.ContainsAny(u.Hostname(), " /") {
		return nil, fmt.Errorf("%q isn't an address", raw)
	}
	u.User, u.Path, u.RawQuery, u.Fragment = nil, strings.TrimRight(u.Path, "/"), "", ""
	if u.Port() != "" || len(ports) == 0 {
		return []string{u.String()}, nil
	}
	var out []string
	for _, p := range ports {
		c := *u
		if !typedScheme && p == 443 {
			c.Scheme = "https"
		}
		if (c.Scheme == "http" && p == 443) || (c.Scheme == "https" && p == 80) {
			continue // the typed scheme rules this port out
		}
		if !(c.Scheme == "http" && p == 80) && !(c.Scheme == "https" && p == 443) {
			c.Host = net.JoinHostPort(u.Hostname(), strconv.Itoa(p))
		}
		out = append(out, c.String())
	}
	if len(out) == 0 {
		out = []string{u.String()}
	}
	return out, nil
}

// normalizeURL is addressCandidates for one default port ("" stays "").
func normalizeURL(raw, scheme string, defPort int) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var ports []int
	if defPort > 0 {
		ports = []int{defPort}
	}
	c, err := addressCandidates(raw, scheme, ports)
	if err != nil {
		return "", err
	}
	return c[0], nil
}

// systemForm reads the "Add" form for a brand into a config and the addresses to try.
func systemForm(d backend.Descriptor, form func(string) string) (backend.Config, []string, error) {
	cfg := backend.Config{Kind: d.Kind, Name: trimName(form("name"))}
	var candidates []string
	for _, f := range d.Fields {
		v := form("f-" + f.Key)
		if f.Type != backend.FieldSecret {
			v = strings.TrimSpace(v)
		}
		if v == "" {
			v = f.Default
		}
		if v == "" {
			if !f.Optional {
				return cfg, nil, fmt.Errorf("Please fill in %q.", f.Label)
			}
			continue
		}
		switch f.Type {
		case backend.FieldNumber:
			if _, err := strconv.Atoi(v); err != nil {
				return cfg, nil, fmt.Errorf("%s should be a number.", f.Label)
			}
		case backend.FieldAddress:
			if f.Key == backend.FieldURL {
				c, err := addressCandidates(v, d.Scheme, d.DefaultPorts)
				if err != nil {
					return cfg, nil, fmt.Errorf("%s doesn't look like an address. Try something like %s.", f.Label, hintOr(f.Hint, "192.168.1.64"))
				}
				candidates, v = c, c[0]
			} else {
				u, err := normalizeURL(v, f.Scheme, f.DefaultPort)
				if err != nil {
					return cfg, nil, fmt.Errorf("%s doesn't look like an address. Try something like %s.", f.Label, hintOr(f.Hint, "192.168.1.64"))
				}
				v = u
			}
		}
		cfg.Set(f.Key, v)
	}
	if len(candidates) == 0 {
		candidates = []string{cfg.URL}
	}
	return cfg, candidates, nil
}

func hintOr(h, def string) string {
	if h != "" {
		return h
	}
	return def
}

// probeTimeout bounds one connection check; probeBudget bounds trying every default port.
var probeTimeout, probeBudget = 8 * time.Second, 25 * time.Second

func (h *hub) addSystem(w http.ResponseWriter, r *http.Request) {
	d, ok := backend.Lookup(r.PostFormValue("kind"))
	if !ok {
		redirectBack(w, r, "Pick the kind of camera system first.", true)
		return
	}
	cfg, candidates, err := systemForm(d, r.PostFormValue)
	if err != nil {
		redirectBack(w, r, err.Error(), true)
		return
	}
	// Try each likely address until one answers; keep the most useful failure (a real answer
	// such as "wrong password" beats "nothing answered" on another port).
	ctx, cancel := context.WithTimeout(r.Context(), probeBudget)
	defer cancel()
	var probeErr error
	failedAt := candidates[0]
	for _, addr := range candidates {
		try := cfg
		if addr != "" {
			try.URL = addr
		}
		pctx, pcancel := context.WithTimeout(ctx, probeTimeout)
		err := backend.Probe(pctx, try)
		pcancel()
		if err == nil {
			cfg, probeErr = try, nil
			break
		}
		if probeErr == nil || (httpx.Unreachable(probeErr) && !httpx.Unreachable(err)) {
			probeErr, failedAt = err, addr
		}
		if !httpx.Unreachable(err) || ctx.Err() != nil {
			break
		}
	}
	if probeErr != nil {
		where := ""
		if failedAt != "" {
			where = " at " + failedAt
		}
		redirectBack(w, r, "Couldn't connect to "+d.Label+where+": "+sentence(httpx.Explain(probeErr).Error()), true)
		return
	}
	existing := map[string]bool{}
	for _, c := range h.systemConfigs() {
		existing[c.ID] = true
	}
	for n := 1; ; n++ {
		id := d.Kind
		if n > 1 {
			id = fmt.Sprintf("%s%d", d.Kind, n)
		}
		if !existing[id] {
			cfg.ID = id
			break
		}
	}
	_ = h.saveSettings(func(s *hubSettings) { s.Systems = append(s.Systems, cfg) })
	h.reloadSystems()
	name := cfg.Name
	if name == "" {
		name = d.Label
	}
	redirectBack(w, r, "Added "+name+".", false)
}

// sentence ends a plain-language fragment with a period.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasSuffix(s, ".") || strings.HasSuffix(s, "?") || strings.HasSuffix(s, "!") {
		return s
	}
	return s + "."
}

// ---- invite landing page (works over the public link) ----

func (h *hub) handleInviteLanding(w http.ResponseWriter, r *http.Request) {
	code := normalizeInvite(r.URL.Query().Get("code"))
	if len(code) == 10 {
		code = code[:5] + "-" + code[5:]
	}
	lan, remote := h.lanURL(r), h.remoteURL()
	if isRemote(r) && remote == "" {
		remote = "https://" + r.Host
	}
	d := struct {
		Name, Code string
		Link       template.URL
	}{Name: h.name(), Code: code, Link: template.URL(inviteLink("invite", code, h.name(), lan, remote))}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_ = inviteTmpl.Execute(w, d)
}

const pageCSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#16181d;--muted:#5d6370;--line:#e3e5ea;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#eef0f4;--muted:#9aa1ad;--line:#2a2e36;--accent:#5b8cff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:28px;margin:8px 0 2px}h2{font-size:19px;margin:0 0 8px}
.sub,.muted{color:var(--muted)}.small{font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0}
.msg{padding:12px 14px;border-radius:12px;background:var(--card);border:1px solid var(--line)}.msg.err{border-color:var(--bad);color:var(--bad)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:var(--ok)}.dot.bad{background:var(--bad)}
.code{font:600 34px/1.2 ui-monospace,Menlo,monospace;letter-spacing:6px}
.qr{display:block;width:220px;height:220px;image-rendering:pixelated;background:#fff;padding:8px;border-radius:12px;margin:8px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
button,.btn{font:inherit;border:0;border-radius:12px;padding:10px 16px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--accent);padding:6px 4px}button.danger{background:transparent;color:var(--bad);padding:6px 4px}
input{font:inherit;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);margin:4px 0 10px}
label{font-size:14px;color:var(--muted)}details summary{cursor:pointer;color:var(--accent);margin:6px 0}
code{font-size:15px;word-break:break-all}a{color:var(--accent)}form{margin:0}
.help{margin:-6px 0 10px}details.brand{border-top:1px solid var(--line);padding:2px 0}details.brand>summary{font-weight:600}
`

var setupTmpl = template.Must(template.New("setup").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
{{if .Refresh}}<meta http-equiv="refresh" content="5">{{end}}
<title>Sightline Hub</title><style>` + pageCSS + `</style></head><body><main>
<h1>Sightline Hub</h1>
<div class="sub">{{.Name}} · version {{.Version}}</div>
{{if .Message}}<p class="msg{{if .IsError}} err{{end}}">{{.Message}}</p>{{end}}

<section class="card">
  <h2>Status</h2>
  {{if .NoSystems}}
    <p><span class="dot bad"></span>Not connected to any cameras yet. Add your recorder below.</p>
  {{else}}
    <p><span class="dot{{if not .SystemsOK}} bad{{end}}"></span>{{if .SystemsOK}}Running.{{else}}Running, but a camera system needs attention.{{end}}
    {{.Cameras}} camera{{if ne .Cameras 1}}s{{end}} available.</p>
  {{end}}
</section>

<section class="card">
  <h2>Connect your phone</h2>
  {{if .PairCode}}
    <p>Open <b>Sightline</b> on your iPhone, tap <b>I have a Sightline Hub</b>, and scan this code.</p>
    {{if .PairQR}}<img class="qr" src="{{.PairQR}}" alt="Pairing QR code">{{end}}
    <p class="small muted">Or type the address <code>{{.LanURL}}</code> and this pairing code:</p>
    <div class="code">{{.PairCode}}</div>
    {{if .PairExpires}}<p class="small muted">This code works until {{.PairExpires}}.</p>{{end}}
  {{else if .Paired}}
    <p><span class="dot"></span>Your phone is connected.</p>
    <p class="small muted">To give someone else access, use <b>Share access</b> in the Sightline app. To add another of your own phones, share <b>Full access</b> with yourself{{if .CanRenewPair}}, or:{{else}}.{{end}}</p>
    {{if .CanRenewPair}}<form method="post" action="setup/pair"><button>Pair another phone</button></form>{{end}}
    {{if .RestartToPair}}<p class="small muted">Lost your phone? Restart the Hub, then come back to this page within 15 minutes to pair again.</p>{{end}}
  {{else}}
    <form method="post" action="setup/pair"><button>Show a pairing code</button></form>
  {{end}}
</section>

<section class="card">
  <h2>Camera systems</h2>
  {{range .Systems}}
  <div class="row"><div>
    <div><span class="dot{{if not .OK}} bad{{end}}"></span><b>{{.Name}}</b> <span class="muted small">{{.Kind}}</span></div>
    <div class="small muted"><code>{{.URL}}</code></div>
    <div class="small">{{.Status}}{{if not .Alerts}} · instant alerts off{{end}}</div>
  </div>
  {{if .FromEnv}}<span class="small muted">From Hub settings</span>{{else}}
  <form method="post" action="setup/systems/remove"><input type="hidden" name="id" value="{{.ID}}"><button class="danger">Remove</button></form>{{end}}
  </div>
  {{end}}
  <details{{if .NoSystems}} open{{end}}><summary>Add a camera system</summary>
  <p class="small muted">Pick what your cameras record to. The Hub needs the same address, username and password you use to sign in to it.</p>
  {{range .Brands}}
  <details class="brand"><summary>{{.Label}}</summary>
  {{if .Description}}<p class="small muted">{{.Description}}</p>{{end}}
  <form method="post" action="setup/systems/add">
    <input type="hidden" name="kind" value="{{.Kind}}">
    {{range .Fields}}{{template "field" .}}{{end}}
    <label>Name (optional)</label><input name="name" placeholder="{{.Label}}" maxlength="60">
    {{range .Sections}}<details><summary>{{.Title}}</summary>{{range .Fields}}{{template "field" .}}{{end}}</details>{{end}}
    <button>Add</button>
  </form></details>
  {{end}}
  {{if .HasONVIF}}<p class="small muted">Brand not listed? Most cameras and recorders also work as <b>Other camera (ONVIF)</b>.</p>{{end}}
  </details>
</section>

<section class="card">
  <h2>Remote access</h2>
  {{$r := .Remote}}
  {{if not .RemoteAvailable}}
    <p class="muted">{{$r.Message}}</p>
  {{else if eq $r.State "off"}}
    <p>Watch your cameras away from home. Sightline uses a free Tailscale account to give this Hub a private, encrypted public link. No router settings needed.</p>
    <form method="post" action="setup/remote/enable"><button>Enable remote access</button></form>
  {{else if eq $r.State "starting"}}
    <p>Starting… this page refreshes by itself.</p>
  {{else if eq $r.State "needs-login"}}
    {{if $r.LoginURL}}
      <p><b>Step 1 of 2:</b> sign in to Tailscale (or create a free account).</p>
      <p><a class="btn" href="{{$r.LoginURL}}" target="_blank" rel="noopener">Sign in to Tailscale</a></p>
      <p class="small muted">Come back to this page afterwards. It refreshes by itself.</p>
    {{else}}<p>{{if $r.Message}}{{$r.Message}}{{else}}Getting the sign-in link…{{end}}</p>{{end}}
  {{else if eq $r.State "needs-funnel"}}
    <p><b>Step 2 of 2:</b> {{$r.Message}}</p>
    {{if $r.EnableURL}}<p><a class="btn" href="{{$r.EnableURL}}" target="_blank" rel="noopener">Allow a public link</a></p>
    {{else}}<p class="small muted">In the Tailscale admin console, turn on HTTPS certificates and Funnel for this Hub (Access controls → Funnel).</p>{{end}}
  {{else if eq $r.State "running"}}
    <p><span class="dot"></span>On. Your phones use <code>{{$r.URL}}</code> when away.</p>
    <p class="small muted">Everything is still checked by this Hub: only paired phones and people you share with can see anything.</p>
  {{else if eq $r.State "error"}}
    <p class="msg err">{{$r.Message}}</p>
  {{end}}
  {{if and .RemoteAvailable (ne $r.State "off")}}
    <form method="post" action="setup/remote/disable" style="display:inline"><button class="ghost">Turn off</button></form>
    <form method="post" action="setup/remote/forget" style="display:inline"><button class="danger">Turn off and sign out</button></form>
  {{end}}
</section>

<section class="card">
  <h2>Who has access</h2>
  {{range .Owners}}<div class="row"><div><b>{{.Name}}</b> <span class="small muted">{{.Kind}}</span><div class="small muted">{{.Detail}}</div></div>
    <form method="post" action="setup/grants/revoke"><input type="hidden" name="id" value="{{.ID}}"><button class="danger">Remove</button></form></div>{{end}}
  {{range .Guests}}<div class="row"><div><b>{{.Name}}</b> <span class="small muted">{{.Kind}}</span><div class="small muted">{{.Detail}}</div></div>
    <form method="post" action="setup/grants/revoke"><input type="hidden" name="id" value="{{.ID}}"><button class="danger">Revoke</button></form></div>{{end}}
  {{if and (not .Owners) (not .Guests)}}<p class="muted">Nobody yet.</p>{{end}}
  <p class="small muted">Share access from the Sightline app: Settings → Sharing.</p>
</section>

<section class="card">
  <h2>Hub name</h2>
  <form method="post" action="setup/name"><input name="name" value="{{.Name}}" maxlength="60"><button>Save</button></form>
</section>
<p class="small muted">Your video never leaves your home except to your own phones.</p>
</main></body></html>
{{define "field"}}<label>{{.Label}}{{if not .Required}} (optional){{end}}</label><input name="{{.Name}}"{{if ne .InputType "text"}} type="{{.InputType}}"{{end}}{{if .InputMode}} inputmode="{{.InputMode}}"{{end}}{{if .Hint}} placeholder="{{.Hint}}"{{end}}{{if .Default}} value="{{.Default}}"{{end}} autocapitalize="off" autocomplete="off"{{if .Required}} required{{end}}>
{{if .Help}}<div class="small muted help">{{.Help}}</div>{{end}}{{end}}`))

var inviteTmpl = template.Must(template.New("invite").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sightline invite</title><style>` + pageCSS + `</style></head><body><main>
<h1>You're invited</h1>
<p>Someone shared cameras from <b>{{.Name}}</b> with you.</p>
<section class="card">
<p><b>1.</b> Install <b>Sightline</b> on your iPhone.</p>
<p><b>2.</b> Tap this button:</p>
<p><a class="btn" href="{{.Link}}">Open in Sightline</a></p>
<p class="small muted">Or open Sightline, tap <b>Someone shared cameras with me</b>, and enter this code:</p>
<div class="code">{{.Code}}</div>
</section>
<p class="small muted">The code works once. Ask for a new invite if it has expired.</p>
</main></body></html>`))
