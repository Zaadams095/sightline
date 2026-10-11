package httpx

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// digestServer checks RFC 7616 Digest answers like a Hikvision/Dahua device does.
func digestServer(t *testing.T, user, pass, algorithm string, challenges *atomic.Int32) http.HandlerFunc {
	const realm, nonce = "IP Camera(C1234)", "4e6f6e63652d31"
	newHash := md5.New
	if strings.HasPrefix(algorithm, "SHA-256") {
		newHash = sha256.New
	}
	sum := func(s string) string {
		var h hash.Hash = newHash()
		h.Write([]byte(s))
		return hex.EncodeToString(h.Sum(nil))
	}
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Digest ")
		if !ok {
			challenges.Add(1)
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Digest realm="%s", qop="auth,auth-int", nonce="%s", algorithm=%s, opaque="xyz"`, realm, nonce, algorithm))
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		p := parseAuthParams(auth)
		ha1 := sum(user + ":" + realm + ":" + pass)
		ha2 := sum(r.Method + ":" + r.URL.RequestURI())
		want := sum(ha1 + ":" + nonce + ":" + p["nc"] + ":" + p["cnonce"] + ":auth:" + ha2)
		if p["response"] != want || p["uri"] != r.URL.RequestURI() || p["opaque"] != "xyz" || p["username"] != user {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, `{"ok":true,"method":%q,"body":%q}`, r.Method, body)
	}
}

func TestDigestAuth(t *testing.T) {
	for _, alg := range []string{"MD5", "SHA-256"} {
		t.Run(alg, func(t *testing.T) {
			var challenges atomic.Int32
			srv := httptest.NewServer(digestServer(t, "admin", "s3cret!", alg, &challenges))
			defer srv.Close()
			c := New(srv.URL, "admin", "s3cret!")
			ctx := context.Background()
			for i := 0; i < 3; i++ {
				var out struct {
					OK     bool   `json:"ok"`
					Method string `json:"method"`
					Body   string `json:"body"`
				}
				if err := c.DoJSON(ctx, http.MethodPost, "/ISAPI/x?a=1", map[string]int{"n": i}, &out); err != nil {
					t.Fatal(err)
				}
				if !out.OK || out.Method != "POST" || out.Body != fmt.Sprintf(`{"n":%d}`, i) {
					t.Fatalf("answer = %+v", out)
				}
			}
			// The challenge is learned once, then requests are authorized up front.
			if n := challenges.Load(); n != 1 {
				t.Errorf("challenged %d times, want 1", n)
			}
			// Wrong password → ErrAuth, explained plainly.
			_, err := New(srv.URL, "admin", "nope").Get(ctx, "/")
			if !errors.Is(err, ErrAuth) || !strings.Contains(Explain(err).Error(), "password is wrong") {
				t.Errorf("wrong password: %v", err)
			}
		})
	}
}

func TestBasicAuthAndSelfSignedTLS(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "viewer" || p != "pw" {
			w.Header().Set("WWW-Authenticate", `Basic realm="NVR"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Header.Get("Range") != "" {
			w.Header().Set("Content-Range", "bytes 0-1/4")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "mp")
			return
		}
		_, _ = io.WriteString(w, "<Info><Model>DS-7608</Model></Info>")
	}))
	defer srv.Close()
	c := New(srv.URL, "viewer", "pw")
	var info struct {
		Model string `xml:"Model"`
	}
	if err := c.GetXML(context.Background(), "/ISAPI/System/deviceInfo", &info); err != nil || info.Model != "DS-7608" {
		t.Fatalf("GetXML = %+v, %v", info, err)
	}
	resp, err := c.Stream(context.Background(), "/clip.mp4", http.Header{"Range": {"bytes=0-1"}})
	if err != nil || resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("Stream = %v, %v", resp, err)
	}
	resp.Body.Close()
	// Strict TLS refuses the self-signed certificate.
	if _, err := New(srv.URL, "viewer", "pw", WithStrictTLS()).Get(context.Background(), "/"); err == nil {
		t.Error("strict TLS accepted a self-signed certificate")
	}
}

func TestStatusErrors(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	_, err := New(srv.URL, "", "").Get(context.Background(), "/nope")
	if !errors.Is(err, backend.ErrNotFound) {
		t.Errorf("404 = %v", err)
	}
	if Unreachable(err) {
		t.Error("an HTTP answer isn't unreachable")
	}
}

func TestExplainNetworkErrors(t *testing.T) {
	// A port with nothing listening.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	_, err := New("http://"+addr, "", "").Get(context.Background(), "/")
	if !Unreachable(err) || !strings.Contains(Explain(err).Error(), "nothing answered") {
		t.Errorf("refused: %v → %v", err, Explain(err))
	}
	// Timeout.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(300 * time.Millisecond) }))
	defer slow.Close()
	_, err = New(slow.URL, "", "", WithTimeout(50*time.Millisecond)).Get(context.Background(), "/")
	if !Unreachable(err) || !strings.Contains(Explain(err).Error(), "didn't answer in time") {
		t.Errorf("timeout: %v → %v", err, Explain(err))
	}
	// HTTPS spoken to a plain HTTP port.
	plain := httptest.NewServer(http.NotFoundHandler())
	defer plain.Close()
	_, err = New(strings.Replace(plain.URL, "http://", "https://", 1), "", "").Get(context.Background(), "/")
	if !Unreachable(err) || !strings.Contains(Explain(err).Error(), "http://") {
		t.Errorf("https to http: %v → %v", err, Explain(err))
	}
	// Unknown errors pass through; nil stays nil.
	other := errors.New("brand-specific problem")
	if Explain(other) != other || Explain(nil) != nil {
		t.Error("Explain changed an unrelated error")
	}
}

func TestParseAuthParams(t *testing.T) {
	p := parseAuthParams(`realm="a, b", nonce=abc, qop="auth,auth-int", stale=FALSE`)
	if p["realm"] != "a, b" || p["nonce"] != "abc" || p["qop"] != "auth,auth-int" || p["stale"] != "FALSE" {
		t.Errorf("params = %v", p)
	}
}
