package wgtunnel

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A strict Digest server (like Hikvision/Dahua); also checks POST bodies survive the retry
// and that session cookies pass through for non-Frigate routes.
func TestGatewayDigestAuth(t *testing.T) {
	const realm, nonce, user, pass = "Login to ABC", "n0nc3", "admin", "s3cret"
	md := func(s string) string { h := md5.Sum([]byte(s)); return hex.EncodeToString(h[:]) }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Digest ") {
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Digest realm="%s", qop="auth", nonce="%s", opaque="op"`, realm, nonce))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		p := parseAuthParams(strings.TrimPrefix(auth, "Digest "))
		ha1 := md(user + ":" + realm + ":" + pass)
		ha2 := md(r.Method + ":" + p["uri"])
		want := md(ha1 + ":" + nonce + ":" + p["nc"] + ":" + p["cnonce"] + ":auth:" + ha2)
		if p["response"] != want || p["opaque"] != "op" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc"})
		b, _ := io.ReadAll(r.Body)
		fmt.Fprintf(w, "ok %s %s cookie=%s", r.URL.Path, b, r.Header.Get("Cookie"))
	}))
	defer srv.Close()

	port, err := AddRoute(srv.URL, false, false, "http", user, pass)
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(port)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	for i := 0; i < 2; i++ { // the second request reuses the cached challenge
		resp, err := http.Get(base + "/ISAPI/System/deviceInfo")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != "ok /ISAPI/System/deviceInfo  cookie=" {
			t.Fatalf("GET %d: %d %q", i, resp.StatusCode, b)
		}
		if resp.Header.Get("Set-Cookie") == "" {
			t.Error("Set-Cookie should pass through for non-Frigate routes")
		}
	}

	req, _ := http.NewRequest(http.MethodPost, base+"/cgi-bin/x", strings.NewReader("payload"))
	req.Header.Set("Cookie", "session=abc")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "ok /cgi-bin/x payload cookie=session=abc" {
		t.Fatalf("POST: %q", b)
	}
}

func TestParseAuthParams(t *testing.T) {
	p := parseAuthParams(`realm="a, b", qop="auth,auth-int", nonce=abc, algorithm=MD5`)
	if p["realm"] != "a, b" || p["qop"] != "auth,auth-int" || p["nonce"] != "abc" || p["algorithm"] != "MD5" {
		t.Errorf("%v", p)
	}
}
