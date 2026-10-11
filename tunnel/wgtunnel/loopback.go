package wgtunnel

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
)

// Loopback listeners carry the user's camera credentials, so they only serve requests that
// genuinely come from this app: the Host must be the loopback address itself (blocks DNS
// rebinding), and a browser Origin, when present, must be this listener's own origin (our
// WebView player) — never another web page.

func loopbackHost(host string, port int) bool {
	p := strconv.Itoa(port)
	return host == "127.0.0.1:"+p || host == "localhost:"+p || host == "[::1]:"+p
}

func loopbackOrigin(origin string, port int) bool {
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && loopbackHost(u.Host, port)
}

// guardLoopback wraps a handler with the Host/Origin checks above.
func guardLoopback(port int, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !loopbackHost(r.Host, port) || !loopbackOrigin(r.Header.Get("Origin"), port) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// connSet tracks a server's live connections (including hijacked WebSockets, which
// http.Server.Close leaves open) so removing a route really stops its streams.
type connSet struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

func newConnSet() *connSet { return &connSet{conns: map[net.Conn]struct{}{}} }

func (s *connSet) track(c net.Conn, state http.ConnState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch state {
	case http.StateNew, http.StateHijacked:
		s.conns[c] = struct{}{}
	case http.StateClosed:
		delete(s.conns, c)
	}
}

func (s *connSet) add(c net.Conn) {
	s.mu.Lock()
	s.conns[c] = struct{}{}
	s.mu.Unlock()
}

func (s *connSet) remove(c net.Conn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func (s *connSet) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.Close()
	}
	s.conns = map[net.Conn]struct{}{}
}
