package wgtunnel

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Local-network discovery for the "Find my cameras" setup screen. Plain TCP connects only:
// no multicast, so it needs nothing beyond iOS's Local Network permission.

// LocalSubnets returns the phone's private IPv4 /24 networks as JSON, e.g. ["192.168.1.0/24"].
func LocalSubnets() string {
	seen := map[string]bool{}
	var out []string
	ifaces, _ := net.Interfaces()
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
			cidr := net.IPv4(ip[0], ip[1], ip[2], 0).String() + "/24"
			if !seen[cidr] {
				seen[cidr] = true
				out = append(out, cidr)
			}
		}
	}
	b, _ := json.Marshal(out)
	if out == nil {
		return "[]"
	}
	return string(b)
}

// ScanSubnet tries every host in a /24 on each port (comma-separated) and returns the open
// "ip:port" pairs as JSON, sorted.
func ScanSubnet(cidr string, ports string, timeoutMs int) string {
	_, ipn, err := net.ParseCIDR(cidr)
	if err != nil || ipn.IP.To4() == nil {
		return "[]"
	}
	base := ipn.IP.To4()
	var portList []int
	for _, p := range strings.Split(ports, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && n > 0 && n < 65536 {
			portList = append(portList, n)
		}
	}
	type job struct{ addr string }
	jobs := make(chan job)
	var mu sync.Mutex
	var open []string
	var wg sync.WaitGroup
	timeout := time.Duration(timeoutMs) * time.Millisecond
	for w := 0; w < 64; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				c, err := net.DialTimeout("tcp", j.addr, timeout)
				if err != nil {
					continue
				}
				c.Close()
				mu.Lock()
				open = append(open, j.addr)
				mu.Unlock()
			}
		}()
	}
	for host := 1; host < 255; host++ {
		ip := net.IPv4(base[0], base[1], base[2], byte(host)).String()
		for _, p := range portList {
			jobs <- job{net.JoinHostPort(ip, strconv.Itoa(p))}
		}
	}
	close(jobs)
	wg.Wait()
	sort.Strings(open)
	b, _ := json.Marshal(open)
	if open == nil {
		return "[]"
	}
	return string(b)
}

// HTTPProbe GETs rawURL directly (self-signed certs allowed, no redirects) and returns JSON
// {status, server, auth, body (first 4 KB), error} for fingerprinting a device's brand.
func HTTPProbe(rawURL string, timeoutMs int) string {
	type result struct {
		Status int    `json:"status"`
		Server string `json:"server"`
		Auth   string `json:"auth"`
		Body   string `json:"body"`
		Error  string `json:"error,omitempty"`
	}
	client := &http.Client{
		Timeout:       time.Duration(timeoutMs) * time.Millisecond,
		Transport:     &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec // fingerprinting LAN devices
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	var r result
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, rawURL, nil)
	if err == nil {
		var resp *http.Response
		resp, err = client.Do(req)
		if err == nil {
			defer resp.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			r.Status = resp.StatusCode
			r.Server = resp.Header.Get("Server")
			r.Auth = resp.Header.Get("WWW-Authenticate")
			r.Body = string(body)
		}
	}
	if err != nil {
		r.Error = err.Error()
	}
	b, _ := json.Marshal(r)
	return string(b)
}
