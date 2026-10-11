package main

import "net/http"

// Remote access: the Hub joins the owner's tailnet with an embedded Tailscale node (tsnet)
// and publishes its API on a public https://<hub>.<tailnet>.ts.net URL with Funnel. TLS
// terminates on the Hub; Tailscale only relays encrypted bytes. See remote.go.

type remoteStatus struct {
	// State: off | starting | needs-login | needs-funnel | running | error | unavailable
	State string
	// LoginURL: one-time Tailscale sign-in link (needs-login).
	LoginURL string
	// EnableURL: Tailscale admin link to allow Funnel/HTTPS for this tailnet (needs-funnel).
	EnableURL string
	// URL: the public Funnel URL (running).
	URL     string
	Message string
}

type remoteAccess interface {
	available() bool
	enable()
	// disable stops remote access; forget also signs the Hub out of Tailscale.
	disable(forget bool)
	status() remoteStatus
}

type offRemote struct{ reason string }

func (o offRemote) available() bool { return false }
func (o offRemote) enable()         {}
func (o offRemote) disable(bool)    {}
func (o offRemote) status() remoteStatus {
	return remoteStatus{State: "unavailable", Message: o.reason}
}

// remoteHandler is what the Funnel listener serves: the v1 API and the invite landing page,
// never the setup page or the legacy bridge API.
func (h *hub) remoteHandler(lan http.Handler) http.Handler {
	return markRemote(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if len(p) >= 4 && p[:4] == "/v1/" || p == "/invite" {
			lan.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
}
