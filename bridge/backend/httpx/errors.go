package httpx

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"syscall"

	"github.com/zachadams/sightline/bridge/backend"
)

var (
	// ErrAuth: the device rejected the username or password (any 401 matches it).
	ErrAuth = errors.New("the username or password is wrong")
	// ErrBadAnswer: the device answered with something we couldn't read.
	ErrBadAnswer = errors.New("the device answered, but not in a way the Hub understands (is this the right kind of device?)")
)

const httpsAdvice = "that port expects a secure connection. Type the address with https:// instead"

// StatusError is an HTTP error answer. errors.Is matches ErrAuth for 401 and
// backend.ErrNotFound for 404.
type StatusError struct {
	Code int
	Body string // first 2 KB, for brand-specific parsing
}

func (e *StatusError) Error() string {
	switch {
	case e.Code == http.StatusUnauthorized:
		return ErrAuth.Error()
	case e.Code == http.StatusForbidden:
		return "the device refused: this user isn't allowed to do that (give it more permissions on the device)"
	case e.Code == http.StatusNotFound:
		return "the device doesn't have that (HTTP 404); check that this is the right kind of device"
	case e.Code == http.StatusBadRequest && strings.Contains(strings.ToLower(e.Body), "https"):
		return httpsAdvice
	case e.Code >= 500:
		return fmt.Sprintf("the device had an internal problem (HTTP %d); try again, or restart it", e.Code)
	}
	return fmt.Sprintf("the device answered with an error (HTTP %d)", e.Code)
}

func (e *StatusError) Is(target error) bool {
	switch target {
	case ErrAuth:
		return e.Code == http.StatusUnauthorized
	case backend.ErrNotFound:
		return e.Code == http.StatusNotFound
	}
	return false
}

// plainError is a plain-language explanation that still unwraps to the original error.
type plainError struct {
	msg string
	err error
}

func (e *plainError) Error() string { return e.msg }
func (e *plainError) Unwrap() error { return e.err }

// Explain rewrites network and HTTP errors as plain sentence fragments for the setup page and
// status lines ("nothing answered at that address. Check …"). Other errors are returned
// unchanged; nil stays nil. errors.Is/As still see the original error.
func Explain(err error) error {
	if err == nil {
		return nil
	}
	var pe *plainError
	if errors.As(err, &pe) {
		return err
	}
	msg := explain(err)
	if msg == "" {
		return err
	}
	return &plainError{msg: msg, err: err}
}

func explain(err error) string {
	var se *StatusError
	var dnsErr *net.DNSError
	text := strings.ToLower(err.Error())
	switch {
	case errors.As(err, &se):
		return se.Error()
	case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
		return "it didn't answer in time. Check the address, and that the device is turned on and on the same network as the Hub"
	case errors.Is(err, context.Canceled):
		return "the request was cancelled"
	case errors.As(err, &dnsErr):
		return "that name wasn't found on your network. Try the device's IP address instead (like 192.168.1.64)"
	case errors.Is(err, syscall.ECONNREFUSED) || strings.Contains(text, "connection refused") || strings.Contains(text, "actively refused"):
		return "nothing answered at that address and port. Check the port number, or leave it out to use the usual one"
	case errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) ||
		strings.Contains(text, "no route to host") || strings.Contains(text, "network is unreachable") || strings.Contains(text, "host is down"):
		return "that address can't be reached from the Hub. Check it's typed right and that the device is on the same network"
	case errors.Is(err, syscall.ECONNRESET) || strings.Contains(text, "connection reset") || strings.Contains(text, "forcibly closed"):
		return "the device hung up. Check the port number (some devices use a different one for this)"
	case strings.Contains(text, "server gave http response to https client") || strings.Contains(text, "first record does not look like a tls handshake"):
		return "that address doesn't use a secure connection. Type it with http:// instead of https://"
	case strings.Contains(text, "malformed http response"):
		return httpsAdvice
	case isCertError(err):
		return "the device's security certificate couldn't be used"
	case errors.Is(err, ErrAuth), errors.Is(err, ErrBadAnswer):
		return err.Error()
	}
	return ""
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func isCertError(err error) bool {
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	return errors.As(err, &ua) || errors.As(err, &hn) || errors.As(err, &ci)
}

// Unreachable reports a network-level failure (nothing answered, timeout, wrong protocol):
// the setup page then tries the brand's next default port.
func Unreachable(err error) bool {
	if err == nil {
		return false
	}
	var se *StatusError
	if errors.As(err, &se) || errors.Is(err, ErrAuth) || errors.Is(err, ErrBadAnswer) {
		return false
	}
	var dnsErr *net.DNSError
	var opErr *net.OpError
	text := strings.ToLower(err.Error())
	return errors.Is(err, context.DeadlineExceeded) || isTimeout(err) || errors.As(err, &dnsErr) || errors.As(err, &opErr) ||
		errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) ||
		strings.Contains(text, "connection refused") || strings.Contains(text, "tls handshake") ||
		strings.Contains(text, "http response to https client") || strings.Contains(text, "malformed http response") ||
		strings.Contains(text, "eof")
}
