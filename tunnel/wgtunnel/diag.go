package wgtunnel

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"
)

// Diagnostics: same checks as Probe / the gateway, but returning the actual error text so
// the app can show *why* a connection failed (refused, no route, timeout, TLS, ...).

// ProbeError returns "" when host:port accepts a TCP connection, otherwise the dial error.
func ProbeError(hostport string, viaTunnel bool, timeoutMs int) string {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	c, err := dial(ctx, "tcp", hostport, viaTunnel)
	if err != nil {
		return err.Error()
	}
	c.Close()
	return ""
}

// HTTPCheck GETs rawURL (self-signed certs allowed) and returns "HTTP <status>" or the error.
func HTTPCheck(rawURL string, viaTunnel bool, timeoutMs int) string {
	client := &http.Client{
		Timeout: time.Duration(timeoutMs) * time.Millisecond,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return dial(ctx, network, addr, viaTunnel)
			},
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // diagnostics only
		},
	}
	resp, err := client.Get(rawURL)
	if err != nil {
		return err.Error()
	}
	resp.Body.Close()
	return fmt.Sprintf("HTTP %d", resp.StatusCode)
}
