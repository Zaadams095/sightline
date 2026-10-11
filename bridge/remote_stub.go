//go:build notsnet

package main

// Built with -tags notsnet: a smaller binary without Tailscale (no remote access).
func newRemote(*hub) remoteAccess {
	return offRemote{reason: "This Hub was built without remote access."}
}
