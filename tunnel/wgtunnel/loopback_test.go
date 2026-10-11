package wgtunnel

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The loopback gateway must refuse other web pages (Origin) and DNS-rebinding (Host), keep
// session cookies to itself, and still serve our own requests.
func TestGatewayLoopbackGuards(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "secret"})
		fmt.Fprint(w, "ok")
	}))
	defer upstream.Close()
	port, err := AddRoute(upstream.URL, false, false, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(port)
	base := fmt.Sprintf("http://127.0.0.1:%d/x", port)

	do := func(mod func(*http.Request)) (*http.Response, string) {
		req, _ := http.NewRequest(http.MethodGet, base, nil)
		mod(req)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	if resp, body := do(func(*http.Request) {}); resp.StatusCode != 200 || body != "ok" {
		t.Fatalf("own request: %d %q", resp.StatusCode, body)
	} else if resp.Header.Get("Set-Cookie") != "" {
		t.Error("session cookies must not reach the phone's shared cookie store")
	}
	if resp, _ := do(func(r *http.Request) { r.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", port)) }); resp.StatusCode != 200 {
		t.Errorf("own player origin rejected: %d", resp.StatusCode)
	}
	if resp, _ := do(func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }); resp.StatusCode != http.StatusForbidden {
		t.Errorf("foreign origin allowed: %d", resp.StatusCode)
	}
	if resp, _ := do(func(r *http.Request) { r.Host = "evil.example:" + strings.Split(base, ":")[2][:len(fmt.Sprint(port))] }); resp.StatusCode != http.StatusForbidden {
		t.Errorf("rebinding host allowed: %d", resp.StatusCode)
	}
}
