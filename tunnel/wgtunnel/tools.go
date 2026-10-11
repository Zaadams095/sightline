//go:build tools

package wgtunnel

// Keeps golang.org/x/mobile in go.mod; `gomobile bind` needs it at build time.
import _ "golang.org/x/mobile/bind"
