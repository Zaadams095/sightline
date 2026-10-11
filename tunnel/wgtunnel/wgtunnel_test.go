package wgtunnel

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testConf = `
# Exported from UniFi
[Interface]
PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=
Address = 10.6.0.2/32, fd00::2/128
DNS = 192.168.1.1, home.lan

[Peer]
PublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=
PresharedKey = /UwcSPg38hW/D9Y3tcS1FOV0K1wuURMbS0sesJEP5ak=
AllowedIPs = 192.168.1.0/24, 10.6.0.0/24
Endpoint = 203.0.113.7:51820
PersistentKeepalive = 25
`

func TestParseWgQuick(t *testing.T) {
	cfg, err := parseWgQuick(testConf)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.addresses) != 2 || cfg.addresses[0].String() != "10.6.0.2" {
		t.Errorf("addresses = %v", cfg.addresses)
	}
	if len(cfg.dns) != 1 || cfg.dns[0].String() != "192.168.1.1" {
		t.Errorf("dns = %v (search domain should be ignored)", cfg.dns)
	}
	for _, want := range []string{
		"private_key=c809f3e5317e9575c9b5ed78b638b7ce530dabe85ddab614220241801ddf0669\n",
		"endpoint=203.0.113.7:51820\n",
		"allowed_ip=192.168.1.0/24\n",
		"allowed_ip=10.6.0.0/24\n",
		"persistent_keepalive_interval=25\n",
	} {
		if !strings.Contains(cfg.uapi, want) {
			t.Errorf("uapi missing %q\n%s", want, cfg.uapi)
		}
	}
}

func TestParseWgQuickErrors(t *testing.T) {
	cases := map[string]string{
		"no address":  "[Interface]\nPrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\n[Peer]\nEndpoint = 1.2.3.4:1\n",
		"no peer":     "[Interface]\nAddress = 10.0.0.2/32\n",
		"bad key":     "[Interface]\nPrivateKey = nope\nAddress = 10.0.0.2/32\n",
		"garbage":     "hello world",
	}
	for name, conf := range cases {
		if ValidateConfig(conf) == "" {
			t.Errorf("%s: expected error", name)
		}
	}
}

func fakeJWT(exp time.Time) string {
	payload, _ := json.Marshal(map[string]any{"sub": "admin", "exp": exp.Unix()})
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// A fake Frigate: /api/login sets the cookie, everything else requires the Bearer token.
func TestGatewayFrigateAuth(t *testing.T) {
	tok := fakeJWT(time.Now().Add(24 * time.Hour))
	logins := 0
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/login":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["user"] != "admin" || body["password"] != "pw" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			logins++
			http.SetCookie(w, &http.Cookie{Name: "frigate_token", Value: tok})
		default:
			if r.Header.Get("Authorization") != "Bearer "+tok {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if r.Method == http.MethodPost && r.Header.Get("X-CSRF-TOKEN") == "" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			fmt.Fprintf(w, "ok %s", r.URL.Path)
		}
	}))
	defer upstream.Close()

	port, err := AddRoute(upstream.URL, false, true, "frigate", "admin", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(port)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	for i := 0; i < 3; i++ {
		resp, err := http.Get(base + "/api/config")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(b) != "ok /api/config" {
			t.Fatalf("GET: %d %q", resp.StatusCode, b)
		}
	}
	if logins != 1 {
		t.Errorf("expected token reuse, got %d logins", logins)
	}

	resp, err := http.Post(base+"/api/reviews/viewed", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("POST without CSRF header handling: %d", resp.StatusCode)
	}

	bad, err := AddRoute(upstream.URL, false, true, "frigate", "admin", "wrong")
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(bad)
	if msg := Login(bad); msg != "wrong username or password" {
		t.Errorf("Login(bad) = %q", msg)
	}
}

func TestTunnelRouteWithoutTunnelFails(t *testing.T) {
	StopTunnel()
	if Probe("127.0.0.1:1", true, 200) {
		t.Error("probe via stopped tunnel should fail")
	}
	if !strings.Contains(TunnelStatus(), `"running":false`) {
		t.Error(TunnelStatus())
	}
}
