package wgtunnel

import (
	"bufio"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

// wgConfig is the subset of a wg-quick .conf that a client tunnel needs.
type wgConfig struct {
	addresses []netip.Addr
	dns       []netip.Addr
	mtu       int
	uapi      string
	endpoint  string
}

// parseWgQuick converts a wg-quick style config into wireguard-go's UAPI format.
func parseWgQuick(text string) (*wgConfig, error) {
	cfg := &wgConfig{mtu: 1280}
	var uapi strings.Builder
	section := ""
	sawPeer := false

	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexAny(line, "#;"); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(strings.Trim(line, "[]"))
			if section == "peer" {
				sawPeer = true
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("invalid line: %q", line)
		}
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)

		switch section {
		case "interface":
			switch k {
			case "privatekey":
				h, err := keyHex(v)
				if err != nil {
					return nil, fmt.Errorf("PrivateKey: %w", err)
				}
				fmt.Fprintf(&uapi, "private_key=%s\n", h)
			case "address":
				for _, a := range splitList(v) {
					p, err := netip.ParsePrefix(a)
					if err != nil {
						addr, err2 := netip.ParseAddr(a)
						if err2 != nil {
							return nil, fmt.Errorf("Address %q: %w", a, err)
						}
						cfg.addresses = append(cfg.addresses, addr)
						continue
					}
					cfg.addresses = append(cfg.addresses, p.Addr())
				}
			case "dns":
				for _, d := range splitList(v) {
					if addr, err := netip.ParseAddr(d); err == nil {
						cfg.dns = append(cfg.dns, addr)
					} // search domains are ignored
				}
			case "mtu":
				n, err := strconv.Atoi(v)
				if err != nil {
					return nil, fmt.Errorf("MTU: %w", err)
				}
				// Only ever lower it: configs made for routers often say 1420, which cellular
				// networks can silently drop once packets get big (video stalls while small
				// requests still work). 1280 fits every path.
				if n >= 576 && n < cfg.mtu {
					cfg.mtu = n
				}
			}
		case "peer":
			switch k {
			case "publickey":
				h, err := keyHex(v)
				if err != nil {
					return nil, fmt.Errorf("PublicKey: %w", err)
				}
				fmt.Fprintf(&uapi, "public_key=%s\n", h)
			case "presharedkey":
				h, err := keyHex(v)
				if err != nil {
					return nil, fmt.Errorf("PresharedKey: %w", err)
				}
				fmt.Fprintf(&uapi, "preshared_key=%s\n", h)
			case "endpoint":
				ep, err := resolveEndpoint(v)
				if err != nil {
					return nil, fmt.Errorf("Endpoint: %w", err)
				}
				cfg.endpoint = ep
				fmt.Fprintf(&uapi, "endpoint=%s\n", ep)
			case "allowedips":
				for _, a := range splitList(v) {
					fmt.Fprintf(&uapi, "allowed_ip=%s\n", a)
				}
			case "persistentkeepalive":
				fmt.Fprintf(&uapi, "persistent_keepalive_interval=%s\n", v)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(cfg.addresses) == 0 {
		return nil, fmt.Errorf("config has no [Interface] Address")
	}
	if !sawPeer || cfg.endpoint == "" {
		return nil, fmt.Errorf("config has no [Peer] with an Endpoint")
	}
	cfg.uapi = uapi.String()
	return cfg, nil
}

func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func keyHex(b64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	if len(b) != 32 {
		return "", fmt.Errorf("key must be 32 bytes, got %d", len(b))
	}
	return hex.EncodeToString(b), nil
}

// resolveEndpoint turns "host:port" (DDNS names included) into "ip:port" as UAPI requires.
func resolveEndpoint(v string) (string, error) {
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		return "", err
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return net.JoinHostPort(host, port), nil
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("cannot resolve %s: %v", host, err)
	}
	// Prefer IPv4: most home WireGuard servers listen on v4 behind NAT.
	for _, ip := range ips {
		if ip.To4() != nil {
			return net.JoinHostPort(ip.String(), port), nil
		}
	}
	return net.JoinHostPort(ips[0].String(), port), nil
}
