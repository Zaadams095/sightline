package wgtunnel

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Phone-to-phone transfer ("Transfer to another phone"). The old phone serves one
// already-encrypted bundle on the home Wi-Fi; the new phone scans a QR code holding the
// address, a path token and the one-time key, fetches the bundle once and decrypts it.
// The bundle is opaque here: encryption happens in the app (AES-GCM, key only in the QR).
//
// Limits: one bundle at a time, served at most once, gone after ttlSec, and the listener
// closes after too many wrong-path requests.

const (
	transferMaxBadRequests = 20
	transferMaxBody        = 16 << 20
)

type transferServer struct {
	srv     *http.Server
	timer   *time.Timer
	served  bool
	bad     int
	expires time.Time
}

var (
	transferMu  sync.Mutex
	transferCur *transferServer
)

// TransferServe starts serving payload once at http://<host>:<port>/move/<token> on every
// private IPv4 address and returns JSON {"port":n,"hosts":["192.168.1.23"],"error":""}.
// Wi-Fi (en0) addresses come first. Replaces any transfer already running.
func TransferServe(token, payload string, ttlSec int) string {
	type result struct {
		Port  int      `json:"port"`
		Hosts []string `json:"hosts"`
		Error string   `json:"error,omitempty"`
	}
	fail := func(msg string) string {
		b, _ := json.Marshal(result{Hosts: []string{}, Error: msg})
		return string(b)
	}
	TransferStop()
	if len(token) < 16 || payload == "" || ttlSec <= 0 {
		return fail("invalid transfer")
	}
	hosts := lanHostsFn()
	if len(hosts) == 0 {
		return fail("This phone isn’t on Wi-Fi.")
	}
	ln, err := net.Listen("tcp4", ":0")
	if err != nil {
		return fail(err.Error())
	}

	ts := &transferServer{expires: time.Now().Add(time.Duration(ttlSec) * time.Second)}
	want := "/move/" + token
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		transferMu.Lock()
		ok := r.Method == http.MethodGet && subtle.ConstantTimeCompare([]byte(r.URL.Path), []byte(want)) == 1
		if !ok {
			ts.bad++
			tooMany := ts.bad >= transferMaxBadRequests
			transferMu.Unlock()
			http.NotFound(w, r)
			if tooMany {
				go stopTransfer(ts)
			}
			return
		}
		if ts.served || time.Now().After(ts.expires) {
			transferMu.Unlock()
			http.Error(w, "gone", http.StatusGone)
			return
		}
		ts.served = true
		transferMu.Unlock()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, payload)
		// One use: close once this response has gone out.
		go func() {
			time.Sleep(500 * time.Millisecond)
			stopTransfer(ts)
		}()
	})
	ts.srv = &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}

	transferMu.Lock()
	transferCur = ts
	ts.timer = time.AfterFunc(time.Duration(ttlSec)*time.Second, func() { stopTransfer(ts) })
	transferMu.Unlock()
	go func() { _ = ts.srv.Serve(ln) }()

	b, _ := json.Marshal(result{Port: ln.Addr().(*net.TCPAddr).Port, Hosts: hosts})
	return string(b)
}

// TransferStatus returns JSON {"active":bool,"served":bool} for the running transfer.
func TransferStatus() string {
	transferMu.Lock()
	defer transferMu.Unlock()
	active, served := false, false
	if transferCur != nil {
		active = true
		served = transferCur.served
	}
	b, _ := json.Marshal(map[string]bool{"active": active, "served": served})
	return string(b)
}

// TransferStop stops the running transfer, if any.
func TransferStop() {
	transferMu.Lock()
	ts := transferCur
	transferMu.Unlock()
	if ts != nil {
		stopTransfer(ts)
	}
}

func stopTransfer(ts *transferServer) {
	transferMu.Lock()
	if transferCur == ts {
		transferCur = nil
	}
	if ts.timer != nil {
		ts.timer.Stop()
	}
	transferMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ts.srv.Shutdown(ctx); err != nil {
		_ = ts.srv.Close()
	}
}

// TransferFetch GETs a transfer URL on the local network and returns JSON
// {"status":200,"body":"…","error":""}. Only plain http to private addresses.
func TransferFetch(rawURL string, timeoutMs int) string {
	type result struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
		Error  string `json:"error,omitempty"`
	}
	var r result
	err := func() error {
		u, err := url.Parse(rawURL)
		if err != nil {
			return err
		}
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || ip == nil || !(ip.IsPrivate() || ip.IsLoopback()) {
			return errBadTransferURL
		}
		client := &http.Client{
			Timeout:       time.Duration(timeoutMs) * time.Millisecond,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		resp, err := client.Get(u.String())
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, transferMaxBody))
		if err != nil {
			return err
		}
		r.Status = resp.StatusCode
		r.Body = string(body)
		return nil
	}()
	if err != nil {
		r.Error = err.Error()
	}
	b, _ := json.Marshal(r)
	return string(b)
}

type transferError string

func (e transferError) Error() string { return string(e) }

const errBadTransferURL = transferError("not a local transfer address")

// DeriveKey stretches a backup-file passcode into a 32-byte AES key with
// PBKDF2-HMAC-SHA256 and returns it base64-encoded ("" on bad input).
func DeriveKey(passcode, saltB64 string, iterations int) string {
	salt, err := base64.StdEncoding.DecodeString(saltB64)
	if err != nil || len(salt) < 8 || iterations < 1 || passcode == "" {
		return ""
	}
	key, err := pbkdf2.Key(sha256.New, passcode, salt, iterations, 32)
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(key)
}

// lanHostsFn is swapped in tests (CI machines may have no private address).
var lanHostsFn = lanHosts

// lanHosts lists the phone's private IPv4 addresses, Wi-Fi first (see localaddr.go).
func lanHosts() []string {
	var out []string
	for _, a := range localAddrs() {
		out = append(out, a.ip.String())
	}
	if len(out) > 3 {
		out = out[:3]
	}
	return out
}
