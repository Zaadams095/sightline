package wgtunnel

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func keypair(t *testing.T) (priv, pub []byte) {
	t.Helper()
	priv = make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		t.Fatal(err)
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// Simulates a home WireGuard server with a "Frigate" reachable only inside the tunnel,
// then checks the app-side tunnel + gateway can reach it.
func TestEndToEndThroughTunnel(t *testing.T) {
	srvPriv, srvPub := keypair(t)
	cliPriv, cliPub := keypair(t)
	port := freeUDPPort(t)

	// --- "home router" side ---
	srvTun, srvNet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.9.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	srv := device.NewDevice(srvTun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "srv: "))
	defer srv.Close()
	if err := srv.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=10.9.0.2/32\n",
		hex.EncodeToString(srvPriv), port, hex.EncodeToString(cliPub))); err != nil {
		t.Fatal(err)
	}
	if err := srv.Up(); err != nil {
		t.Fatal(err)
	}
	ln, err := srvNet.ListenTCP(&net.TCPAddr{Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "frigate says hi from %s", r.URL.Path)
	}))

	// --- app side ---
	conf := fmt.Sprintf(`[Interface]
PrivateKey = %s
Address = 10.9.0.2/32

[Peer]
PublicKey = %s
Endpoint = 127.0.0.1:%d
AllowedIPs = 10.9.0.0/24
PersistentKeepalive = 25
`, base64.StdEncoding.EncodeToString(cliPriv), base64.StdEncoding.EncodeToString(srvPub), port)

	if err := StartTunnel(conf); err != nil {
		t.Fatal(err)
	}
	defer StopTunnel()

	if !Probe("10.9.0.1:80", true, 5000) {
		t.Fatal("probe through tunnel failed")
	}
	if Probe("10.9.0.1:80", false, 300) {
		t.Fatal("server should not be reachable without the tunnel")
	}

	gw, err := AddRoute("http://10.9.0.1:80", true, false, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer RemoveRoute(gw)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/config", gw))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "frigate says hi from /api/config" {
		t.Fatalf("body = %q", body)
	}

	st := TunnelStatus()
	if !strings.Contains(st, `"running":true`) || strings.Contains(st, `"lastHandshake":0`) {
		t.Errorf("status after traffic = %s", st)
	}
}
