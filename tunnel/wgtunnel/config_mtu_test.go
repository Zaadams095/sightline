package wgtunnel

import (
	"strings"
	"testing"
)

func TestMTUNeverRaisedAboveMobileSafe(t *testing.T) {
	const base = "[Interface]\nPrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=\nAddress = 10.8.0.2/32\nMTU_LINE\n[Peer]\nPublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=\nEndpoint = 203.0.113.1:51820\nAllowedIPs = 10.0.0.0/24\n"
	for line, want := range map[string]int{"": 1280, "MTU = 1420": 1280, "MTU = 1200": 1200, "MTU = 100": 1280} {
		cfg, err := parseWgQuick(strings.Replace(base, "MTU_LINE", line, 1))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if cfg.mtu != want {
			t.Errorf("%q: mtu = %d, want %d", line, cfg.mtu, want)
		}
	}
}
