package wgtunnel

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

type serveResult struct {
	Port  int      `json:"port"`
	Hosts []string `json:"hosts"`
	Error string   `json:"error"`
}

type fetchResult struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
	Error  string `json:"error"`
}

func startTestTransfer(t *testing.T, token, payload string, ttl int) serveResult {
	t.Helper()
	old := lanHostsFn
	lanHostsFn = func() []string { return []string{"127.0.0.1"} }
	t.Cleanup(func() { lanHostsFn = old; TransferStop() })
	var r serveResult
	if err := json.Unmarshal([]byte(TransferServe(token, payload, ttl)), &r); err != nil || r.Error != "" || r.Port == 0 {
		t.Fatalf("serve: %v %+v", err, r)
	}
	return r
}

func fetch(t *testing.T, url string) fetchResult {
	t.Helper()
	var r fetchResult
	if err := json.Unmarshal([]byte(TransferFetch(url, 2000)), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestTransferServesOnce(t *testing.T) {
	token := "0123456789abcdef0123456789abcdef"
	r := startTestTransfer(t, token, "sealed-bundle", 60)
	base := fmt.Sprintf("http://127.0.0.1:%d", r.Port)

	if got := fetch(t, base+"/move/wrong"); got.Status != 404 {
		t.Fatalf("wrong token: %+v", got)
	}
	got := fetch(t, base+"/move/"+token)
	if got.Status != 200 || got.Body != "sealed-bundle" {
		t.Fatalf("first fetch: %+v", got)
	}
	var st map[string]bool
	_ = json.Unmarshal([]byte(TransferStatus()), &st)
	if !st["served"] {
		t.Fatalf("status after fetch: %v", st)
	}
	// Second use: refused, and the listener closes shortly after.
	if again := fetch(t, base+"/move/"+token); again.Status == 200 {
		t.Fatalf("served twice: %+v", again)
	}
	time.Sleep(800 * time.Millisecond)
	if after := fetch(t, base+"/move/"+token); after.Error == "" {
		t.Fatalf("still listening: %+v", after)
	}
	_ = json.Unmarshal([]byte(TransferStatus()), &st)
	if st["active"] {
		t.Fatal("transfer still active")
	}
}

func TestTransferExpires(t *testing.T) {
	token := "fedcba9876543210fedcba9876543210"
	r := startTestTransfer(t, token, "x", 1)
	time.Sleep(1300 * time.Millisecond)
	if got := fetch(t, fmt.Sprintf("http://127.0.0.1:%d/move/%s", r.Port, token)); got.Status == 200 {
		t.Fatalf("served after expiry: %+v", got)
	}
}

func TestTransferClosesAfterGuessing(t *testing.T) {
	token := "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"
	r := startTestTransfer(t, token, "x", 60)
	base := fmt.Sprintf("http://127.0.0.1:%d", r.Port)
	for i := 0; i < transferMaxBadRequests; i++ {
		fetch(t, fmt.Sprintf("%s/move/guess%d", base, i))
	}
	time.Sleep(300 * time.Millisecond)
	if got := fetch(t, base+"/move/"+token); got.Status == 200 {
		t.Fatalf("served after brute force: %+v", got)
	}
}

func TestTransferRejectsBadInput(t *testing.T) {
	var r serveResult
	_ = json.Unmarshal([]byte(TransferServe("short", "x", 60)), &r)
	if r.Error == "" {
		t.Fatal("accepted a short token")
	}
	for _, u := range []string{"https://192.168.1.2/move/x", "http://8.8.8.8/move/x", "http://example.com/move/x", "::"} {
		if got := fetch(t, u); got.Error == "" {
			t.Fatalf("fetched %q", u)
		}
	}
}

func TestDeriveKey(t *testing.T) {
	salt := base64.StdEncoding.EncodeToString([]byte("salt"))
	if DeriveKey("passwd", salt, 1) != "" {
		t.Fatal("accepted a 4-byte salt")
	}
	salt8 := base64.StdEncoding.EncodeToString([]byte("saltsalt"))
	k := DeriveKey("password", salt8, 1000)
	raw, err := base64.StdEncoding.DecodeString(k)
	if err != nil || len(raw) != 32 {
		t.Fatalf("key %q", k)
	}
	if DeriveKey("password", salt8, 1000) != k || DeriveKey("password2", salt8, 1000) == k {
		t.Fatal("not deterministic / not passcode-dependent")
	}
	// Same as Node's crypto.pbkdf2Sync('password', 'saltsalt', 1000, 32, 'sha256'); the app test
	// checks the identical vector so both sides agree on the file format.
	if got := hex.EncodeToString(raw); got != "135f7a66144fcf0fb003ce048f31f024ed5cbff30525d3ba0bfb3199479362a6" {
		t.Fatalf("PBKDF2 vector mismatch: %s", got)
	}
	if DeriveKey("", salt8, 1000) != "" || DeriveKey("p", "!!", 1000) != "" || DeriveKey("p", salt8, 0) != "" {
		t.Fatal("accepted bad input")
	}
}
