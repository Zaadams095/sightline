package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ---- Pairing (owner) ----

// pairingCodeTTL applies to codes made with "Pair another phone". The first code (before
// anyone has paired) lasts until it's used, so a fresh install never needs a refresh.
const pairingCodeTTL = 15 * time.Minute

type pairing struct {
	mu      sync.Mutex
	code    string
	expires time.Time // zero = until used
}

func newPairing(firstRun bool) *pairing {
	p := &pairing{}
	if firstRun {
		p.code = sixDigits()
	}
	return p
}

func sixDigits() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

// current returns the active code ("" when none).
func (p *pairing) current() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.code != "" && !p.expires.IsZero() && time.Now().After(p.expires) {
		p.code = ""
	}
	return p.code
}

func (p *pairing) expiresAt() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.expires
}

// renew makes a new code for pairing another phone.
func (p *pairing) renew() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code = sixDigits()
	p.expires = time.Now().Add(pairingCodeTTL)
	return p.code
}

// use consumes the code if it matches.
func (p *pairing) use(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.code == "" || (!p.expires.IsZero() && time.Now().After(p.expires)) {
		return false
	}
	code = strings.TrimSpace(strings.ReplaceAll(code, " ", ""))
	if subtle.ConstantTimeCompare([]byte(code), []byte(p.code)) != 1 {
		return false
	}
	p.code, p.expires = "", time.Time{}
	return true
}

// ---- Rate limiting (failed pairing/redeem attempts) ----

type window struct {
	start time.Time
	n     int
}

// limiter blocks a client after perMax failures in perWin, and everyone after globalMax
// failures in globalWin (so guessing from many addresses doesn't help either).
type limiter struct {
	mu                sync.Mutex
	perMax, globalMax int
	perWin, globalWin time.Duration
	per               map[string]*window
	global            window
	now               func() time.Time
}

func newLimiter(perMax int, perWin time.Duration, globalMax int, globalWin time.Duration) *limiter {
	return &limiter{perMax: perMax, perWin: perWin, globalMax: globalMax, globalWin: globalWin, per: map[string]*window{}, now: time.Now}
}

func (l *limiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.global.start) > l.globalWin {
		l.global = window{start: now}
	}
	if l.global.n >= l.globalMax {
		return true
	}
	w := l.per[key]
	if w == nil || now.Sub(w.start) > l.perWin {
		return false
	}
	return w.n >= l.perMax
}

func (l *limiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.per) > 10000 {
		l.per = map[string]*window{}
	}
	w := l.per[key]
	if w == nil || now.Sub(w.start) > l.perWin {
		w = &window{start: now}
		l.per[key] = w
	}
	w.n++
	if now.Sub(l.global.start) > l.globalWin {
		l.global = window{start: now}
	}
	l.global.n++
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- Request context ----

type ctxKey int

const (
	keyRemote ctxKey = iota
	keyGrant
	keyToken
)

// isRemote reports whether a request arrived over Tailscale (Funnel or tailnet).
func isRemote(r *http.Request) bool { v, _ := r.Context().Value(keyRemote).(bool); return v }

func markRemote(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), keyRemote, true)))
	})
}

// isIngress reports a request proxied by Home Assistant's ingress (already authenticated by HA).
func isIngress(r *http.Request) bool {
	return r.Header.Get("X-Ingress-Path") != "" && clientIP(r) == "172.30.32.2"
}

// ---- JSON helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// apiError writes {"error": code, "message": text}.
func apiError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		apiError(w, http.StatusBadRequest, "bad_request", err.Error())
		return false
	}
	return true
}

// ---- Authentication ----

// requestToken reads the bearer token from the Authorization header or ?token= (needed by
// WebSockets, image views and video players, which can't set headers).
func requestToken(r *http.Request) string {
	if a := r.Header.Get("Authorization"); len(a) > 7 && strings.EqualFold(a[:7], "bearer ") {
		return strings.TrimSpace(a[7:])
	}
	return r.URL.Query().Get("token")
}

func grantFrom(r *http.Request) *grant { g, _ := r.Context().Value(keyGrant).(*grant); return g }

// tokenQuery is "?token=…" when the request authenticated by query parameter, so URLs the Hub
// hands back (VOD playlists) keep working for players that can't send headers.
func tokenQuery(r *http.Request) string {
	if t := r.URL.Query().Get("token"); t != "" {
		return "?token=" + t
	}
	return ""
}

// authed wraps a v1 handler: valid, unexpired, unrevoked token required; check (optional)
// enforces role permissions.
func (h *hub) authed(check func(*grant) error, fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		g, err := h.grants.authenticate(requestToken(r))
		if err != nil {
			code := "unauthorized"
			switch {
			case errors.Is(err, errRevoked):
				code = "revoked"
			case errors.Is(err, errExpired):
				code = "expired"
			}
			msg := err.Error()
			if code == "unauthorized" {
				msg = "This phone isn't paired with the Hub."
			}
			apiError(w, http.StatusUnauthorized, code, msg)
			return
		}
		if check != nil {
			if err := check(g); err != nil {
				apiError(w, http.StatusForbidden, "forbidden", err.Error())
				return
			}
		}
		fn(w, r.WithContext(context.WithValue(r.Context(), keyGrant, g)))
	}
}

var (
	needManager = func(g *grant) error {
		if !g.manager() {
			return errOwnerOnly
		}
		return nil
	}
	needRecordings = func(g *grant) error {
		if !g.canRecordings() {
			return errors.New("this access doesn't include recordings")
		}
		return nil
	}
	needPTZ = func(g *grant) error {
		if !g.canPTZ() {
			return errors.New("this access can't move cameras")
		}
		return nil
	}
	needPush = func(g *grant) error {
		if !g.canPush() {
			return errors.New("this access doesn't include alerts")
		}
		return nil
	}
)
