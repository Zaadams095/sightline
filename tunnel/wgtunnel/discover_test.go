package wgtunnel

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScanAndProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Digest realm="Login to ABC123"`)
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte("nope"))
	}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	var open []string
	if err := json.Unmarshal([]byte(ScanSubnet("127.0.0.0/24", port+",1", 300)), &open); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range open {
		if a == "127.0.0.1:"+port {
			found = true
		}
	}
	if !found {
		t.Fatalf("scan did not find test server: %v", open)
	}

	var res struct {
		Status int
		Auth   string
		Body   string
	}
	if err := json.Unmarshal([]byte(HTTPProbe(srv.URL+"/cgi-bin/magicBox.cgi", 2000)), &res); err != nil {
		t.Fatal(err)
	}
	if res.Status != 401 || !strings.Contains(res.Auth, "Login to") || res.Body != "nope" {
		t.Errorf("probe = %+v", res)
	}
	if ScanSubnet("not-a-cidr", "80", 100) != "[]" {
		t.Error("bad CIDR should return []")
	}
	var subnets []string
	if err := json.Unmarshal([]byte(LocalSubnets()), &subnets); err != nil {
		t.Errorf("LocalSubnets not JSON: %v", err)
	}
}
