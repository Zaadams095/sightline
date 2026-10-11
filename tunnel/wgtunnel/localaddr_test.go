package wgtunnel

import (
	"net"
	"testing"
)

// Android 11+: net.Interfaces is blocked, so the addresses come from the app.
func TestLocalAddressesFromPlatform(t *testing.T) {
	oldIf, oldTargets := interfaceAddrsFn, routeProbeTargets
	interfaceAddrsFn = func() []localAddr { return nil }
	routeProbeTargets = nil
	t.Cleanup(func() {
		interfaceAddrsFn, routeProbeTargets = oldIf, oldTargets
		SetLocalAddresses("")
	})

	if got := LocalSubnets(); got != "[]" {
		t.Fatalf("no sources: LocalSubnets = %s", got)
	}

	SetLocalAddresses("192.168.4.23/24, 8.8.8.8, fe80::1/64, junk, 10.1.2.3, 192.168.4.23")
	if got := LocalSubnets(); got != `["192.168.4.0/24","10.1.2.0/24"]` {
		t.Errorf("LocalSubnets = %s", got)
	}
	if got := lanHosts(); len(got) != 2 || got[0] != "192.168.4.23" || got[1] != "10.1.2.3" {
		t.Errorf("lanHosts = %v", got)
	}

	// Platform (Wi-Fi) addresses come before other interfaces.
	interfaceAddrsFn = func() []localAddr {
		return []localAddr{{ip: net.IPv4(172, 20, 0, 5).To4()}, {ip: net.IPv4(192, 168, 4, 23).To4(), wifi: true}}
	}
	SetLocalAddresses("10.1.2.3/16")
	if got := lanHosts(); len(got) != 3 || got[0] != "10.1.2.3" || got[1] != "192.168.4.23" || got[2] != "172.20.0.5" {
		t.Errorf("lanHosts order = %v", got)
	}

	SetLocalAddresses("")
	interfaceAddrsFn = func() []localAddr { return nil }
	if got := lanHosts(); len(got) != 0 {
		t.Errorf("cleared: lanHosts = %v", got)
	}
}
