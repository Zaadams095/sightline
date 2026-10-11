package wgtunnel

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A UniFi OS-style console: login sets a Secure session cookie and returns a CSRF token.
// The gateway must replay the cookie upstream (iOS won't send Secure cookies to the plain-HTTP
// loopback) and must pass the client's CSRF token through untouched.
func TestGatewaySessionCookieAndCSRF(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			if r.Header.Get("X-Csrf-Token") != "" {
				http.Error(w, "unexpected csrf on login", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "TOKEN", Value: "jwt", Path: "/", Secure: true, HttpOnly: true})
			w.Header().Set("X-Csrf-Token", "tok")
			fmt.Fprint(w, "{}")
		case "/snapshot":
			if c, err := r.Cookie("TOKEN"); err != nil || c.Value != "jwt" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Fprint(w, "jpeg")
		case "/move":
			if c, err := r.Cookie("TOKEN"); err != nil || c.Value != "jwt" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Fprintf(w, "csrf=%s", r.Header.Get("X-Csrf-Token"))
		}
	}))
	defer srv.Close()

	port, err := AddRoute(srv.URL, false, true, "http", "admin", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(port)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	get := func(method, path, csrf string) (int, string) {
		req, _ := http.NewRequest(method, base+path, strings.NewReader(""))
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	if code, _ := get(http.MethodGet, "/snapshot", ""); code != http.StatusUnauthorized {
		t.Fatalf("before login: %d", code)
	}
	if code, body := get(http.MethodPost, "/api/auth/login", ""); code != http.StatusOK {
		t.Fatalf("login: %d %s", code, body)
	}
	// No Cookie header from the client: the gateway supplies the session.
	if code, body := get(http.MethodGet, "/snapshot", ""); code != http.StatusOK || body != "jpeg" {
		t.Fatalf("snapshot: %d %q", code, body)
	}
	if code, body := get(http.MethodPost, "/move", "tok"); code != http.StatusOK || body != "csrf=tok" {
		t.Fatalf("move: %d %q", code, body)
	}
}
