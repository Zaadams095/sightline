package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

func TestScrubDiag(t *testing.T) {
	cases := []struct{ in, mustNot, want string }{
		{`Get "http://admin:hunter2@192.168.1.20:80/ISAPI/System": timeout`, "hunter2", "http://<redacted>"},
		{"dial rtsp://user:pass@10.0.0.5:554/Streaming/101 failed", "pass@", "rtsp://<redacted>"},
		{"admin:secret@cam.local refused", "secret", "<credentials>@<host>"},
		{"dial tcp 192.168.1.64:443: connect: connection refused", "192.168", "<ip>"},
		{"dial tcp [fe80::1%en0]:80: no route", "fe80", "<ip>"},
		{"host 2001:db8:85a3::8a2e:370:7334 down", "2001:db8", "<ip>"},
		{"contact me at grandma@example.com", "grandma@", "<email>"},
		{"no such host frigate.duckdns.org", "duckdns", "<host>"},
		{"login failed: password=hunter2&user=admin", "hunter2", "password=<redacted>"},
		{"Authorization: Bearer abc.def.ghi", "abc.def", "<redacted>"},
		{"Bearer abc123secret", "abc123", "Bearer <redacted>"},
		{"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl expired", "eyJhbGci", "<token>"},
		{"key aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY2z= rejected", "aB3dE5", "<token>"},
		{"mac 00-1A-2B-3C-4D-5E seen", "1A-2B", "<mac>"},
		{"Front Door camera failed", "Front Door", "<name>"},
		{`{"token": "s3cr3t"}`, "s3cr3t", "<redacted>"},
	}
	for _, c := range cases {
		got := scrubDiag(c.in, "front door", "ab")
		if strings.Contains(got, c.mustNot) || !strings.Contains(got, c.want) {
			t.Errorf("scrubDiag(%q) = %q; must not contain %q, want %q", c.in, got, c.mustNot, c.want)
		}
	}
	// Plain words, times and versions survive.
	for _, keep := range []string{"the device didn't answer at 12:30:45", "Hub 0.3.0 had a problem (HTTP 500)"} {
		if got := scrubDiag(keep); got != keep {
			t.Errorf("scrubDiag(%q) = %q, want unchanged", keep, got)
		}
	}
}

func TestErrCategory(t *testing.T) {
	cases := map[string]error{
		"auth-401":    &httpx.StatusError{Code: 401},
		"http-500":    &httpx.StatusError{Code: 500},
		"timeout":     context.DeadlineExceeded,
		"refused":     errors.New("dial tcp 1.2.3.4:80: connect: connection refused"),
		"dns":         errors.New("dial tcp: lookup nvr: no such host"),
		"unreachable": errors.New("connect: no route to host"),
		"tls":         errors.New("x509: certificate signed by unknown authority"),
		"other":       errors.New("something odd"),
	}
	for want, err := range cases {
		if got := errCategory(err); got != want {
			t.Errorf("errCategory(%v) = %q, want %q", err, got, want)
		}
	}
}

func TestDiagLogRingAndScrub(t *testing.T) {
	d := newDiagLog()
	d.now = func() time.Time { return time.Unix(1000, 0) }
	// Expected outcomes are not errors worth reporting.
	d.add("frigate", "live", backend.ErrNotFound)
	d.add("frigate", "live", fmt.Errorf("wrapped: %w", backend.ErrUnsupported))
	d.add("frigate", "live", context.Canceled)
	if n := len(d.list()); n != 0 {
		t.Fatalf("expected outcomes recorded: %d", n)
	}
	// Repeats fold into one entry with a count.
	for range 3 {
		d.add("hikvision", "snapshot", errors.New("Get http://admin:pw@192.168.1.9/x: connection refused"), "admin", "pw")
	}
	l := d.list()
	if len(l) != 1 || l[0].Count != 3 || l[0].Category != "refused" || l[0].Brand != "hikvision" {
		t.Fatalf("entries = %+v", l)
	}
	if strings.Contains(l[0].Detail, "192.168") || strings.Contains(l[0].Detail, "admin") {
		t.Fatalf("detail not scrubbed: %q", l[0].Detail)
	}
	// Bounded.
	for i := range diagMax + 20 {
		d.add("reolink", "events", fmt.Errorf("error %d", i))
	}
	if n := len(d.list()); n != diagMax {
		t.Fatalf("len = %d, want %d", n, diagMax)
	}
	if long := truncate(strings.Repeat("é", 300), diagDetailMax); len(long) > diagDetailMax+len("…") {
		t.Fatalf("truncate too long: %d", len(long))
	}
}

func TestDiagnosticsEndpointOwnerOnly(t *testing.T) {
	th := newTestHub(t)
	th.h.diag.add("frigate", "live", errors.New("dial tcp 192.168.1.5:8971: i/o timeout"))
	var out struct {
		Systems []diagSystem `json:"systems"`
		Errors  []diagEntry  `json:"errors"`
	}
	th.call(t, th.tokens[roleOwner], "GET", "/v1/diagnostics", nil, http.StatusOK, &out)
	if len(out.Errors) != 1 || out.Errors[0].Category != "timeout" || strings.Contains(out.Errors[0].Detail, "192.168") {
		t.Fatalf("errors = %+v", out.Errors)
	}
	if len(out.Systems) != 2 {
		t.Fatalf("systems = %+v", out.Systems)
	}
	for _, role := range []string{roleFull, roleHousehold, roleTemporary, roleLive} {
		th.call(t, th.tokens[role], "GET", "/v1/diagnostics", nil, http.StatusForbidden, nil)
	}
	th.call(t, "", "GET", "/v1/diagnostics", nil, http.StatusUnauthorized, nil)
}
