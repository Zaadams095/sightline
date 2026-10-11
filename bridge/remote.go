//go:build !notsnet

package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

// tsRemote runs an embedded Tailscale node. State lives in DATA_DIR/tailscale, so after the
// one-time sign-in it reconnects on its own after restarts.
type tsRemote struct {
	h *hub

	mu      sync.Mutex
	st      remoteStatus
	cancel  context.CancelFunc
	srv     *tsnet.Server
	httpSrv *http.Server
	done    chan struct{}
}

func newRemote(h *hub) remoteAccess {
	if !h.cfg.remote {
		return offRemote{reason: "Remote access is turned off in the Hub's settings (REMOTE_ACCESS=off)."}
	}
	return &tsRemote{h: h, st: remoteStatus{State: "off"}}
}

func (t *tsRemote) available() bool { return true }

func (t *tsRemote) status() remoteStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.st
}

func (t *tsRemote) set(st remoteStatus) {
	t.mu.Lock()
	changed := t.st != st
	t.st = st
	t.mu.Unlock()
	if changed {
		switch st.State {
		case "needs-login":
			if st.LoginURL != "" {
				log.Printf("Remote access: sign in to Tailscale at %s", st.LoginURL)
			}
		case "needs-funnel":
			log.Printf("Remote access: %s %s", st.Message, st.EnableURL)
		case "running":
			log.Printf("Remote access is on: %s", st.URL)
		case "error":
			log.Printf("Remote access: %s", st.Message)
		}
	}
}

func (t *tsRemote) dir() string { return filepath.Join(t.h.cfg.dataDir, "tailscale") }

func (t *tsRemote) enable() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.cancel = cancel
	t.done = make(chan struct{})
	t.srv = &tsnet.Server{
		Dir:      t.dir(),
		Hostname: t.h.cfg.tsHostname,
		Logf:     func(string, ...any) {}, // tsnet's backend logs are very chatty
		UserLogf: func(format string, args ...any) {
			// tsnet prints the login URL here too; the setup page shows it.
			if !strings.Contains(format, "AuthLoop") && !strings.Contains(format, "TS_AUTHKEY") {
				log.Printf("tailscale: "+format, args...)
			}
		},
	}
	t.st = remoteStatus{State: "starting"}
	go t.run(ctx, t.srv, t.done)
}

func (t *tsRemote) disable(forget bool) {
	t.mu.Lock()
	cancel, srv, httpSrv, done := t.cancel, t.srv, t.httpSrv, t.done
	t.cancel, t.srv, t.httpSrv, t.done = nil, nil, nil, nil
	t.st = remoteStatus{State: "off"}
	t.mu.Unlock()
	if cancel == nil {
		if forget {
			_ = os.RemoveAll(t.dir())
		}
		return
	}
	if forget && srv != nil {
		if lc, err := srv.LocalClient(); err == nil {
			ctx, c := context.WithTimeout(context.Background(), 5*time.Second)
			_ = lc.Logout(ctx)
			c()
		}
	}
	cancel()
	if httpSrv != nil {
		_ = httpSrv.Close()
	}
	if srv != nil {
		_ = srv.Close()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}
	if forget {
		_ = os.RemoveAll(t.dir())
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

// run walks the node through sign-in → Funnel permission → serving, reporting each step.
func (t *tsRemote) run(ctx context.Context, srv *tsnet.Server, done chan struct{}) {
	defer close(done)
	if err := os.MkdirAll(t.dir(), 0o700); err != nil {
		t.set(remoteStatus{State: "error", Message: err.Error()})
		return
	}
	if err := srv.Start(); err != nil {
		t.set(remoteStatus{State: "error", Message: "Couldn't start Tailscale: " + err.Error()})
		return
	}
	lc, err := srv.LocalClient()
	if err != nil {
		t.set(remoteStatus{State: "error", Message: err.Error()})
		return
	}
	var lastQuery time.Time
	var enableURL string
	for ctx.Err() == nil {
		st, err := lc.StatusWithoutPeers(ctx)
		if err != nil {
			t.set(remoteStatus{State: "starting"})
			if !sleepCtx(ctx, 2*time.Second) {
				return
			}
			continue
		}
		switch st.BackendState {
		case "NeedsLogin":
			t.set(remoteStatus{State: "needs-login", LoginURL: st.AuthURL})
		case "NeedsMachineAuth":
			t.set(remoteStatus{State: "needs-login", Message: "Approve this Hub in the Tailscale admin console (Machines)."})
		case "Running":
			if err := ipn.CheckFunnelAccess(443, st.Self); err != nil {
				// Ask Tailscale for the link that turns on HTTPS + Funnel for this tailnet.
				if time.Since(lastQuery) > 15*time.Second {
					lastQuery = time.Now()
					if qf, qerr := lc.QueryFeature(ctx, "funnel"); qerr == nil && qf != nil && !qf.Complete {
						enableURL = qf.URL
					}
				}
				t.set(remoteStatus{State: "needs-funnel", EnableURL: enableURL,
					Message: "One more step: allow this Hub to have a public link."})
				break
			}
			ln, err := srv.ListenFunnel("tcp", ":443")
			if err != nil {
				t.set(remoteStatus{State: "error", Message: "Couldn't open the public link: " + err.Error()})
				if !sleepCtx(ctx, 10*time.Second) {
					return
				}
				continue
			}
			url := "https://" + strings.TrimSuffix(st.Self.DNSName, ".")
			hs := &http.Server{Handler: t.h.remoteHandler(t.h.lanHandler), ReadHeaderTimeout: 10 * time.Second}
			t.mu.Lock()
			t.httpSrv = hs
			t.mu.Unlock()
			t.set(remoteStatus{State: "running", URL: url})
			err = hs.Serve(ln)
			if ctx.Err() != nil {
				return
			}
			if !errors.Is(err, http.ErrServerClosed) {
				t.set(remoteStatus{State: "error", Message: "The public link stopped: " + err.Error()})
			}
		default:
			t.set(remoteStatus{State: "starting"})
		}
		if !sleepCtx(ctx, 2*time.Second) {
			return
		}
	}
}
