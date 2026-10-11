package wgtunnel

import (
	"net"
	"strings"
	"sync"
)

// The phone's own private IPv4 addresses, for discovery (LocalSubnets) and the
// phone-to-phone transfer server (lanHosts).
//
// iOS: net.Interfaces works. Android 11+: apps may not read netlink, so net.Interfaces
// returns an error there. The Android module then passes the addresses it gets from
// ConnectivityManager/LinkProperties through SetLocalAddresses, and as a last resort we
// ask the kernel which source address it would use to reach common home ranges (a UDP
// "connect" sends no packets).

type localAddr struct {
	ip   net.IP // 4-byte form
	wifi bool   // Wi-Fi / Ethernet: listed first
}

var (
	platformMu    sync.Mutex
	platformAddrs []localAddr
)

// SetLocalAddresses records the phone's addresses as reported by the OS, as a
// comma-separated list of "ip" or "ip/prefix", Wi-Fi first. "" clears it.
// Only the Android module calls it; on iOS the list stays empty.
func SetLocalAddresses(list string) {
	var out []localAddr
	for _, s := range strings.Split(list, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if i := strings.IndexByte(s, '/'); i >= 0 {
			s = s[:i]
		}
		ip := net.ParseIP(s).To4()
		if ip == nil || !ip.IsPrivate() {
			continue
		}
		out = append(out, localAddr{ip: ip, wifi: true})
	}
	platformMu.Lock()
	platformAddrs = out
	platformMu.Unlock()
}

// routeProbeTargets are typical home-network gateways; dialing UDP to them makes the kernel
// pick the outgoing address without sending anything.
var routeProbeTargets = []string{"192.168.0.1:9", "192.168.1.1:9", "10.0.0.1:9", "172.16.0.1:9"}

// interfaceAddrsFn is swapped in tests to simulate Android's blocked netlink.
var interfaceAddrsFn = interfaceAddrs

func interfaceAddrs() []localAddr {
	var out []localAddr
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			// en0 = iPhone Wi-Fi; wlan*/eth* = Android Wi-Fi/Ethernet.
			n := ifc.Name
			wifi := strings.HasPrefix(n, "en0") || strings.HasPrefix(n, "wlan") || strings.HasPrefix(n, "eth")
			out = append(out, localAddr{ip: ip, wifi: wifi})
		}
	}
	return out
}

func routeAddrs() []localAddr {
	var out []localAddr
	for _, t := range routeProbeTargets {
		c, err := net.Dial("udp4", t)
		if err != nil {
			continue
		}
		if ua, ok := c.LocalAddr().(*net.UDPAddr); ok {
			if ip := ua.IP.To4(); ip != nil && ip.IsPrivate() {
				out = append(out, localAddr{ip: ip})
			}
		}
		c.Close()
	}
	return out
}

// localAddrs merges every source, Wi-Fi first, without duplicates.
func localAddrs() []localAddr {
	platformMu.Lock()
	all := append([]localAddr(nil), platformAddrs...)
	platformMu.Unlock()
	all = append(all, interfaceAddrsFn()...)
	if len(all) == 0 {
		all = routeAddrs()
	}
	seen := map[string]bool{}
	var wifi, other []localAddr
	for _, a := range all {
		k := a.ip.String()
		if seen[k] {
			continue
		}
		seen[k] = true
		if a.wifi {
			wifi = append(wifi, a)
		} else {
			other = append(other, a)
		}
	}
	return append(wifi, other...)
}
