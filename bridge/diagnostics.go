package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// Diagnostics: a small in-memory ring of recent backend errors, by brand and feature, that
// the owner's app can attach to a problem report (GET /v1/diagnostics, owner only). Nothing
// is sent anywhere by the Hub itself. Entries are scrubbed when recorded: no addresses,
// usernames, passwords, tokens, emails or system names, only brand + feature + category and
// a short plain-language detail.

const (
	diagMax       = 100
	diagDetailMax = 200
)

type diagEntry struct {
	Time     int64  `json:"time"`  // unix seconds of the latest occurrence
	Brand    string `json:"brand"` // system kind ("frigate", "hikvision", …)
	Area     string `json:"area"`  // feature: "cameras", "live", "snapshot", "events", …
	Category string `json:"category"`
	Detail   string `json:"detail,omitempty"`
	Count    int    `json:"count"`
}

type diagLog struct {
	mu      sync.Mutex
	entries []diagEntry
	now     func() time.Time
}

func newDiagLog() *diagLog { return &diagLog{now: time.Now} }

// add records one error. Expected outcomes (not found, unsupported, cancelled) are skipped.
// secrets are literal strings (system name, username, password…) to blank out of the detail.
func (d *diagLog) add(brand, area string, err error, secrets ...string) {
	if d == nil || err == nil || errors.Is(err, backend.ErrNotFound) || errors.Is(err, backend.ErrUnsupported) || errors.Is(err, context.Canceled) {
		return
	}
	e := diagEntry{
		Time:     d.now().Unix(),
		Brand:    scrubDiag(brand),
		Area:     area,
		Category: errCategory(err),
		Detail:   truncate(scrubDiag(httpx.Explain(err).Error(), secrets...), diagDetailMax),
		Count:    1,
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if n := len(d.entries); n > 0 {
		last := &d.entries[n-1]
		if last.Brand == e.Brand && last.Area == e.Area && last.Category == e.Category && last.Detail == e.Detail {
			last.Count++
			last.Time = e.Time
			return
		}
	}
	d.entries = append(d.entries, e)
	if len(d.entries) > diagMax {
		d.entries = append([]diagEntry(nil), d.entries[len(d.entries)-diagMax:]...)
	}
}

func (d *diagLog) list() []diagEntry {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]diagEntry{}, d.entries...)
}

// errCategory is a short, stable label for what went wrong.
func errCategory(err error) string {
	var se *httpx.StatusError
	var dnsErr *net.DNSError
	text := strings.ToLower(err.Error())
	switch {
	case errors.As(err, &se):
		if se.Code == http.StatusUnauthorized || se.Code == http.StatusForbidden {
			return "auth-" + strconv.Itoa(se.Code)
		}
		return "http-" + strconv.Itoa(se.Code)
	case errors.Is(err, httpx.ErrAuth):
		return "auth"
	case errors.Is(err, context.DeadlineExceeded) || isNetTimeout(err) || strings.Contains(text, "timeout"):
		return "timeout"
	case errors.As(err, &dnsErr) || strings.Contains(text, "no such host"):
		return "dns"
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(text, "connection refused"):
		return "refused"
	case errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) || strings.Contains(text, "unreachable") || strings.Contains(text, "no route to host"):
		return "unreachable"
	case errors.Is(err, syscall.ECONNRESET) || strings.Contains(text, "connection reset") || strings.Contains(text, "eof"):
		return "reset"
	case strings.Contains(text, "certificate") || strings.Contains(text, "tls") || strings.Contains(text, "x509"):
		return "tls"
	case errors.Is(err, httpx.ErrBadAnswer) || errors.Is(err, httpx.ErrWrongService) || strings.Contains(text, "json") || strings.Contains(text, "xml"):
		return "bad-reply"
	}
	return "other"
}

func isNetTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Cut on a rune boundary.
	for n > 0 && !utf8Start(s[n]) {
		n--
	}
	return s[:n] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

var (
	reURL      = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]{1,15})://[^\s"'<>]+`)
	reUserPass = regexp.MustCompile(`[^\s:/@"']+:[^\s/@"']+@[^\s/"']+`)
	reEmail    = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`)
	reBearer   = regexp.MustCompile(`(?i)\b(bearer|basic|digest)\s+[^\s,;]+`)
	reKV       = regexp.MustCompile(`(?i)\b(password|passwd|pass|pwd|token|access_token|refresh_token|api[_-]?key|apikey|secret|auth|authorization|session|sessionid|sid|cookie|user|username|usr|privatekey|presharedkey)("?\s*[=:]\s*"?)[^\s&"',;]+`)
	reJWT      = regexp.MustCompile(`eyJ[\w-]+\.[\w-]+\.[\w-]+`)
	reIPv4     = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\b`)
	reIPv6     = regexp.MustCompile(`(?i)\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[\w.]+)?\]?(?::\d{1,5})?`)
	reMAC      = regexp.MustCompile(`(?i)\b[0-9a-f]{2}(?:-[0-9a-f]{2}){5}\b`)
	reHost     = regexp.MustCompile(`(?i)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|dev|me|us|uk|de|fr|nl|ca|au|info|biz|co|local|lan|home|internal|arpa|cloud|xyz|online|site)\b(?::\d{1,5})?`)
	reToken    = regexp.MustCompile(`[A-Za-z0-9+/=_-]{24,}`)
	hasDigit   = regexp.MustCompile(`\d`)
	hasLetter  = regexp.MustCompile(`[A-Za-z]`)
)

// scrubDiag removes anything that could identify a home or unlock it: URLs, user:pass@,
// IP and MAC addresses, host names, emails, tokens and key=value secrets, plus the given
// literal strings. Mirrors app/src/diagnostics/scrub.ts.
func scrubDiag(s string, secrets ...string) string {
	for _, sec := range secrets {
		if len(strings.TrimSpace(sec)) >= 3 {
			s = replaceFold(s, sec, "<name>")
		}
	}
	s = reURL.ReplaceAllString(s, "$1://<redacted>")
	s = reUserPass.ReplaceAllString(s, "<credentials>@<host>")
	s = reEmail.ReplaceAllString(s, "<email>")
	s = reJWT.ReplaceAllString(s, "<token>")
	s = reBearer.ReplaceAllString(s, "$1 <redacted>")
	s = reKV.ReplaceAllString(s, "$1$2<redacted>")
	s = reIPv4.ReplaceAllString(s, "<ip>")
	s = reMAC.ReplaceAllString(s, "<mac>")
	s = reIPv6.ReplaceAllStringFunc(s, func(m string) string {
		core := strings.Trim(m, "[]")
		if i := strings.IndexByte(core, '%'); i >= 0 {
			core = core[:i]
		}
		// Times (12:30:45) have three short decimal groups and no "::"; addresses don't.
		if strings.Contains(core, "::") || strings.Count(core, ":") >= 3 {
			return "<ip>"
		}
		return m
	})
	s = reHost.ReplaceAllString(s, "<host>")
	s = reToken.ReplaceAllStringFunc(s, func(m string) string {
		if hasDigit.MatchString(m) && hasLetter.MatchString(m) {
			return "<token>"
		}
		return m
	})
	return s
}

// replaceFold replaces every case-insensitive occurrence of old in s.
func replaceFold(s, old, repl string) string {
	lo, lold := strings.ToLower(s), strings.ToLower(old)
	if len(lo) != len(s) || !strings.Contains(lo, lold) {
		return strings.ReplaceAll(s, old, repl)
	}
	var b strings.Builder
	for {
		i := strings.Index(lo, lold)
		if i < 0 {
			b.WriteString(s)
			return b.String()
		}
		b.WriteString(s[:i])
		b.WriteString(repl)
		s, lo = s[i+len(old):], lo[i+len(old):]
	}
}

// secrets are the strings of a system's config that must never appear in diagnostics.
func (s *system) secrets() []string {
	c := s.cfg
	return []string{c.Name, c.Username, c.Password, c.MQTTUser, c.MQTTPassword}
}

// noteErr records a backend failure for /v1/diagnostics.
func (h *hub) noteErr(s *system, area string, err error) {
	if s == nil {
		return
	}
	h.diag.add(s.cfg.Kind, area, err, s.secrets()...)
}

// upstream records a backend failure, then answers the request as backendError does.
func (h *hub) upstream(w http.ResponseWriter, s *system, area string, err error) {
	h.noteErr(s, area, err)
	backendError(w, err)
}

type diagSystem struct {
	Brand     string `json:"brand"`
	Connected bool   `json:"connected"`
}

// GET /v1/diagnostics (owner only): scrubbed recent backend errors and each system's brand
// and whether it's connected. No names, addresses or camera IDs.
func (h *hub) handleDiagnostics(w http.ResponseWriter, _ *http.Request) {
	systems := []diagSystem{}
	for _, s := range h.systemList() {
		_, ok := s.getStatus()
		systems = append(systems, diagSystem{Brand: s.cfg.Kind, Connected: ok})
	}
	streams, viewers := h.live.counts()
	sessions, summary := h.liveStats.snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"version": version,
		"uptime":  int64(time.Since(h.startedAt).Seconds()),
		"systems": systems,
		"errors":  h.diag.list(),
		// Live startup timing (live_stats.go): the newest sessions and medians by route.
		"live": map[string]any{
			"graceSeconds": int(h.live.grace.Seconds()),
			"active":       map[string]int{"streams": streams, "viewers": viewers},
			"summary":      summary,
			"sessions":     sessions,
		},
	})
}

var needOwner = func(g *grant) error {
	if g.Role != roleOwner {
		return errOwnerOnly
	}
	return nil
}
