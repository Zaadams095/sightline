package wgtunnel

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A route is a loopback listener (127.0.0.1:<port>) that reverse-proxies every request
// to one upstream system. Paths map 1:1, so HLS playlists with absolute paths still work.
type route struct {
	target    *url.URL
	viaTunnel atomic.Bool
	transport *http.Transport
	server    *http.Server

	// Frigate auth: the gateway logs in and injects a Bearer token.
	authMu   sync.Mutex
	user     string
	pass     string
	token    string
	tokenExp time.Time
}

var (
	routesMu sync.Mutex
	routes   = map[int]*route{}
)

// AddRoute starts a loopback proxy to target (e.g. "https://192.168.1.10:8971") and
// returns its local port. authKind is "" (none), "frigate" (JWT login), "basic", or "http"
// (answers Basic/Digest challenges automatically: Hikvision, Dahua, Amcrest, ONVIF...).
func AddRoute(target string, viaTunnel bool, insecureTLS bool, authKind, user, pass string) (int, error) {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return 0, fmt.Errorf("invalid target URL %q", target)
	}
	r := &route{target: u, user: user, pass: pass}
	r.viaTunnel.Store(viaTunnel)
	r.transport = &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dial(ctx, network, addr, r.viaTunnel.Load())
		},
		TLSClientConfig:       &tls.Config{InsecureSkipVerify: insecureTLS}, //nolint:gosec // user opted in for self-signed NVR certs
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		ForceAttemptHTTP2:     false,
	}

	proxy := &httputil.ReverseProxy{
		Transport:     proxyTransport(r.transport, authKind, user, pass),
		FlushInterval: -1, // stream immediately (live video, websockets)
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(u)
			pr.Out.Host = u.Host
			// Requests come from our own loopback clients; drop browser-origin headers so
			// Frigate's CSRF / origin checks see a plain API client.
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Referer")
			// Frigate auth is the gateway's Bearer token; other brands keep their own session
			// cookies (UniFi, Blue Iris), which must pass through.
			if authKind == "frigate" {
				pr.Out.Header.Del("Cookie")
			}
			if pr.Out.Method != http.MethodGet && pr.Out.Method != http.MethodHead {
				pr.Out.Header.Set("X-CSRF-TOKEN", "1")
			}
			switch authKind {
			case "frigate":
				if tok := r.bearer(pr.Out.Context()); tok != "" {
					pr.Out.Header.Set("Authorization", "Bearer "+tok)
				}
			case "basic":
				if user != "" {
					pr.Out.SetBasicAuth(user, pass)
				}
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			if resp.StatusCode == http.StatusUnauthorized && authKind == "frigate" {
				r.clearToken()
			}
			if authKind == "frigate" {
				resp.Header.Del("Set-Cookie")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
			http.Error(w, "gateway: "+err.Error(), http.StatusBadGateway)
		},
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	r.server = &http.Server{Handler: proxy, ReadHeaderTimeout: 10 * time.Second}
	port := ln.Addr().(*net.TCPAddr).Port

	routesMu.Lock()
	routes[port] = r
	routesMu.Unlock()
	go r.server.Serve(ln) //nolint:errcheck // returns on RemoveRoute
	return port, nil
}

// SetRouteViaTunnel switches a route between direct (LAN) and tunnel dialing.
func SetRouteViaTunnel(port int, viaTunnel bool) {
	routesMu.Lock()
	r := routes[port]
	routesMu.Unlock()
	if r != nil && r.viaTunnel.Swap(viaTunnel) != viaTunnel {
		r.transport.CloseIdleConnections()
	}
}

// RemoveRoute stops a route's listener.
func RemoveRoute(port int) {
	routesMu.Lock()
	r := routes[port]
	delete(routes, port)
	routesMu.Unlock()
	if r != nil {
		r.server.Close()
		r.transport.CloseIdleConnections()
	}
}

// Login forces a Frigate login on a route and returns "" or an error message.
// Used during onboarding to give the user a clear "wrong password" result.
func Login(port int) string {
	routesMu.Lock()
	r := routes[port]
	routesMu.Unlock()
	if r == nil {
		return "unknown route"
	}
	r.clearToken()
	if _, err := r.login(context.Background()); err != nil {
		return err.Error()
	}
	return ""
}

func closeIdleAll() {
	routesMu.Lock()
	defer routesMu.Unlock()
	for _, r := range routes {
		r.transport.CloseIdleConnections()
	}
}

func (r *route) clearToken() {
	r.authMu.Lock()
	r.token = ""
	r.authMu.Unlock()
}

// bearer returns a valid token, logging in when missing or within 5 minutes of expiry.
// Frigate never refreshes Bearer tokens, so the gateway re-logs in on its own.
func (r *route) bearer(ctx context.Context) string {
	r.authMu.Lock()
	tok, exp := r.token, r.tokenExp
	r.authMu.Unlock()
	if tok != "" && time.Until(exp) > 5*time.Minute {
		return tok
	}
	tok, err := r.login(ctx)
	if err != nil {
		return ""
	}
	return tok
}

func (r *route) login(ctx context.Context) (string, error) {
	r.authMu.Lock()
	defer r.authMu.Unlock()
	if r.token != "" && time.Until(r.tokenExp) > 5*time.Minute {
		return r.token, nil
	}
	if r.user == "" {
		return "", nil // unauthenticated port (5000)
	}
	body, _ := json.Marshal(map[string]string{"user": r.user, "password": r.pass})
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.target.JoinPath("/api/login").String(), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Transport: r.transport}).Do(req)
	if err != nil {
		return "", fmt.Errorf("cannot reach server: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return "", fmt.Errorf("wrong username or password")
	case http.StatusTooManyRequests:
		return "", fmt.Errorf("too many login attempts, try again later")
	case http.StatusNotFound:
		return "", nil // auth disabled on this Frigate
	default:
		return "", fmt.Errorf("login failed: HTTP %d", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if strings.HasSuffix(c.Name, "_token") || c.Name == "frigate_token" {
			r.token = c.Value
			r.tokenExp = jwtExpiry(c.Value)
			return r.token, nil
		}
	}
	return "", fmt.Errorf("login succeeded but no token was returned")
}

// jwtExpiry reads the exp claim without verifying the signature (the server does that).
func jwtExpiry(tok string) time.Time {
	parts := strings.Split(tok, ".")
	if len(parts) == 3 {
		if b, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
			var c struct {
				Exp int64 `json:"exp"`
			}
			if json.Unmarshal(b, &c) == nil && c.Exp > 0 {
				return time.Unix(c.Exp, 0)
			}
		}
	}
	return time.Now().Add(1 * time.Hour)
}
