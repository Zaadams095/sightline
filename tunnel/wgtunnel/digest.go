package wgtunnel

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"net/http"
	"strings"
	"sync"
)

// authTransport answers HTTP auth challenges for NVRs and cameras: Digest (Hikvision, Dahua,
// Amcrest, most ONVIF devices) or Basic. A request goes out without credentials first; on a
// 401 challenge it's retried with the right Authorization header. The challenge is cached so
// later requests are authorized up front.
type authTransport struct {
	base       http.RoundTripper
	user, pass string

	mu     sync.Mutex
	digest map[string]string // parsed challenge params
	nc     int
	basic  bool
}

const maxReplayBody = 1 << 20

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil && req.Body != http.NoBody {
		b, err := io.ReadAll(io.LimitReader(req.Body, maxReplayBody))
		req.Body.Close()
		if err != nil {
			return nil, err
		}
		body = b
	}
	attempt := func(withAuth bool) (*http.Response, error) {
		r := req.Clone(req.Context())
		if body != nil {
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		if withAuth {
			t.authorize(r)
		}
		return t.base.RoundTrip(r)
	}

	t.mu.Lock()
	primed := t.digest != nil || t.basic
	t.mu.Unlock()

	resp, err := attempt(primed)
	if err != nil || resp.StatusCode != http.StatusUnauthorized || t.user == "" {
		return resp, err
	}
	if !t.learn(resp.Header.Values("WWW-Authenticate")) {
		return resp, nil
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	return attempt(true)
}

// learn records the server's challenge; false if there's no scheme we can answer.
func (t *authTransport) learn(headers []string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, h := range headers {
		if params, ok := strings.CutPrefix(h, "Digest "); ok {
			t.digest = parseAuthParams(params)
			t.nc = 0
			return true
		}
	}
	for _, h := range headers {
		if strings.HasPrefix(h, "Basic") {
			t.basic = true
			return true
		}
	}
	return false
}

func (t *authTransport) authorize(r *http.Request) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.digest == nil {
		if t.basic {
			r.SetBasicAuth(t.user, t.pass)
		}
		return
	}
	d := t.digest
	t.nc++
	newHash := md5.New
	if strings.EqualFold(strings.TrimSuffix(d["algorithm"], "-sess"), "SHA-256") {
		newHash = sha256.New
	}
	sum := func(s string) string {
		var h hash.Hash = newHash()
		h.Write([]byte(s))
		return hex.EncodeToString(h.Sum(nil))
	}
	uri := r.URL.RequestURI()
	raw := make([]byte, 8)
	rand.Read(raw)
	cnonce := hex.EncodeToString(raw)
	nc := fmt.Sprintf("%08x", t.nc)

	ha1 := sum(t.user + ":" + d["realm"] + ":" + t.pass)
	if strings.HasSuffix(strings.ToLower(d["algorithm"]), "-sess") {
		ha1 = sum(ha1 + ":" + d["nonce"] + ":" + cnonce)
	}
	ha2 := sum(r.Method + ":" + uri)
	qop := ""
	for _, q := range strings.Split(d["qop"], ",") {
		if strings.TrimSpace(q) == "auth" {
			qop = "auth"
		}
	}
	response := sum(ha1 + ":" + d["nonce"] + ":" + ha2)
	if qop != "" {
		response = sum(ha1 + ":" + d["nonce"] + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2)
	}
	parts := []string{
		fmt.Sprintf(`username="%s"`, t.user),
		fmt.Sprintf(`realm="%s"`, d["realm"]),
		fmt.Sprintf(`nonce="%s"`, d["nonce"]),
		fmt.Sprintf(`uri="%s"`, uri),
		fmt.Sprintf(`response="%s"`, response),
	}
	if alg := d["algorithm"]; alg != "" {
		parts = append(parts, "algorithm="+alg)
	}
	if op := d["opaque"]; op != "" {
		parts = append(parts, fmt.Sprintf(`opaque="%s"`, op))
	}
	if qop != "" {
		parts = append(parts, "qop="+qop, "nc="+nc, fmt.Sprintf(`cnonce="%s"`, cnonce))
	}
	r.Header.Set("Authorization", "Digest "+strings.Join(parts, ", "))
}

// parseAuthParams parses `realm="x", nonce="y", qop="auth,auth-int"` (quoted values may hold commas).
func parseAuthParams(s string) map[string]string {
	out := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " ,")
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			break
		}
		key := strings.ToLower(strings.TrimSpace(s[:eq]))
		s = s[eq+1:]
		var val string
		if strings.HasPrefix(s, `"`) {
			end := strings.IndexByte(s[1:], '"')
			if end < 0 {
				val, s = s[1:], ""
			} else {
				val, s = s[1:end+1], s[end+2:]
			}
		} else if end := strings.IndexByte(s, ','); end >= 0 {
			val, s = s[:end], s[end:]
		} else {
			val, s = s, ""
		}
		out[key] = strings.TrimSpace(val)
	}
	return out
}

// proxyTransport adds automatic Basic/Digest handling for authKind "http".
func proxyTransport(base http.RoundTripper, authKind, user, pass string) http.RoundTripper {
	if authKind == "http" && user != "" {
		return &authTransport{base: base, user: user, pass: pass}
	}
	return base
}
