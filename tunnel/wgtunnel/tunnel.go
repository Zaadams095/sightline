// Package wgtunnel runs a userspace WireGuard tunnel inside the app process and a
// loopback HTTP gateway that routes camera traffic either directly (home Wi-Fi) or
// through the tunnel. No system VPN / NetworkExtension is involved.
//
// The exported API is gomobile-compatible (ints, strings, bools, errors only).
package wgtunnel

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

var (
	mu   sync.RWMutex
	dev  *device.Device
	tnet *netstack.Net
)

// StartTunnel brings up the WireGuard tunnel from a wg-quick style config.
// Calling it while a tunnel is running replaces the running tunnel.
func StartTunnel(conf string) error {
	cfg, err := parseWgQuick(conf)
	if err != nil {
		return err
	}
	tunDev, n, err := netstack.CreateNetTUN(cfg.addresses, cfg.dns, cfg.mtu)
	if err != nil {
		return fmt.Errorf("create netstack: %w", err)
	}
	d := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg: "))
	if err := d.IpcSet(cfg.uapi); err != nil {
		d.Close()
		return fmt.Errorf("apply config: %w", err)
	}
	if err := d.Up(); err != nil {
		d.Close()
		return fmt.Errorf("bring up: %w", err)
	}

	mu.Lock()
	old := dev
	dev, tnet = d, n
	mu.Unlock()
	if old != nil {
		old.Close()
	}
	closeIdleAll()
	return nil
}

// StopTunnel tears the tunnel down. Routes that use it fail until it is restarted.
func StopTunnel() {
	mu.Lock()
	d := dev
	dev, tnet = nil, nil
	mu.Unlock()
	if d != nil {
		d.Close()
	}
	closeIdleAll()
}

// TunnelStatus returns JSON: {"running":bool,"lastHandshake":unixSec,"rx":bytes,"tx":bytes}.
func TunnelStatus() string {
	mu.RLock()
	d := dev
	mu.RUnlock()
	st := struct {
		Running       bool  `json:"running"`
		LastHandshake int64 `json:"lastHandshake"`
		Rx            int64 `json:"rx"`
		Tx            int64 `json:"tx"`
	}{}
	if d != nil {
		st.Running = true
		if uapi, err := d.IpcGet(); err == nil {
			sc := bufio.NewScanner(strings.NewReader(uapi))
			for sc.Scan() {
				k, v, _ := strings.Cut(sc.Text(), "=")
				n, _ := strconv.ParseInt(v, 10, 64)
				switch k {
				case "last_handshake_time_sec":
					st.LastHandshake = n
				case "rx_bytes":
					st.Rx += n
				case "tx_bytes":
					st.Tx += n
				}
			}
		}
	}
	b, _ := json.Marshal(st)
	return string(b)
}

// ValidateConfig parses a wg-quick config without starting anything; returns "" if valid.
func ValidateConfig(conf string) string {
	if _, err := parseWgQuick(conf); err != nil {
		return err.Error()
	}
	return ""
}

// Probe reports whether host:port accepts a TCP connection within timeoutMs, either
// directly or through the tunnel. Used to decide between LAN and tunnel routing.
func Probe(hostport string, viaTunnel bool, timeoutMs int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	c, err := dial(ctx, "tcp", hostport, viaTunnel)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

var errNoTunnel = errors.New("tunnel is not running")

func dial(ctx context.Context, network, addr string, viaTunnel bool) (net.Conn, error) {
	if !viaTunnel {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	mu.RLock()
	n := tnet
	mu.RUnlock()
	if n == nil {
		return nil, errNoTunnel
	}
	return n.DialContext(ctx, network, addr)
}
