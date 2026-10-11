package onvif

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// plainError is a plain-language error that still matches a sentinel with errors.Is.
type plainError struct {
	msg  string
	kind error
}

func (e *plainError) Error() string { return e.msg }
func (e *plainError) Unwrap() error { return e.kind }

// errFault is the kind of plain errors made from a SOAP fault that isn't about the login.
var errFault = errors.New("onvif fault")

const maxAnswer = 4 << 20

// skewWarning is how far off the camera's clock may be before a login failure mentions it.
const skewWarning = 5 * time.Minute

// soapClient sends ONVIF SOAP requests: HTTP Basic/Digest through httpx, plus a WS-Security
// UsernameToken timed by the camera's own clock.
type soapClient struct {
	user, pass string

	mu      sync.Mutex
	skew    time.Duration // camera clock minus ours
	noWSSE  bool          // the camera rejected WS-Security but takes the HTTP login alone
	skewSet bool
}

type callOpts struct {
	noAuth bool
	header string // extra SOAP header elements (WS-Addressing for events)
}

func (s *soapClient) setSkew(d time.Duration) {
	s.mu.Lock()
	s.skew, s.skewSet = d, true
	s.mu.Unlock()
}

func (s *soapClient) clockOffset() (time.Duration, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.skew, s.skewSet
}

// call posts one request and returns the parsed answer, or a plain-language error. Network
// errors are returned as they are (the Hub explains them).
func (s *soapClient) call(ctx context.Context, c *httpx.Client, path, body string, o callOpts) (*node, error) {
	s.mu.Lock()
	wsse := !o.noAuth && !s.noWSSE && s.user != ""
	skew := s.skew
	s.mu.Unlock()

	doc, fault, err := s.post(ctx, c, path, body, o.header, wsse, skew)
	if err != nil {
		return nil, err
	}
	if fault == nil {
		return doc, nil
	}
	if fault.isAuth() && wsse {
		// Some cameras reject WS-Security (often a strict clock check) but accept the HTTP
		// login on its own.
		doc2, fault2, err2 := s.post(ctx, c, path, body, o.header, false, skew)
		if err2 == nil && fault2 == nil {
			s.mu.Lock()
			s.noWSSE = true
			s.mu.Unlock()
			return doc2, nil
		}
		if err2 != nil && !errors.Is(err2, httpx.ErrAuth) {
			return nil, err2
		}
		if fault2 != nil && !fault2.isAuth() {
			return nil, &plainError{msg: fault2.message(), kind: errFault}
		}
		return nil, s.authError()
	}
	if fault.isAuth() {
		return nil, s.authError()
	}
	return nil, &plainError{msg: fault.message(), kind: errFault}
}

func (s *soapClient) post(ctx context.Context, c *httpx.Client, path, body, extraHeader string, wsse bool, skew time.Duration) (*node, *soapFault, error) {
	header := extraHeader
	if wsse {
		nonce := make([]byte, 16)
		_, _ = rand.Read(nonce)
		header = securityHeader(s.user, s.pass, nonce, onvifTimestamp(time.Now().Add(skew))) + header
	}
	req, err := c.NewRequest(ctx, http.MethodPost, path, strings.NewReader(envelope(body, header)))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/soap+xml; charset=utf-8")
	resp, err := c.API.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer))
	if err != nil {
		return nil, nil, err
	}
	isEnvelope := bytes.Contains(raw, []byte("Envelope"))
	var doc *node
	if isEnvelope {
		doc, err = parseXML(raw)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: %v", httpx.ErrBadAnswer, err)
		}
		if f := parseFault(doc); f != nil {
			return nil, f, nil
		}
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, nil, s.authError()
	case resp.StatusCode >= 500 && isEnvelope:
		return nil, nil, &httpx.StatusError{Code: resp.StatusCode}
	case resp.StatusCode >= 400 || !isEnvelope:
		// A web page, a 404 or a "method not allowed": something answered, but not ONVIF.
		return nil, nil, errNotONVIF
	}
	return doc, nil, nil
}

var errNotONVIF = &plainError{
	msg: "no ONVIF camera answered at this address. Turn on ONVIF in the camera's settings " +
		"(some cameras also need an ONVIF user there), or add its ONVIF port to the address " +
		"(often 8000, 2020 or 8899, like 192.168.1.70:2020)",
	kind: httpx.ErrWrongService,
}

// authError explains a rejected login, mentioning the camera's clock when it's far off: ONVIF
// logins are time-stamped and many cameras refuse them when the clocks disagree.
func (s *soapClient) authError() error {
	msg := "the camera turned down the username or password. Use the camera's own login; " +
		"some cameras need a separate ONVIF user, added in the camera's settings"
	if skew, ok := s.clockOffset(); ok && skew.Abs() > skewWarning {
		msg = fmt.Sprintf("the camera turned down the login, and its clock is %s off. "+
			"Set the camera's date and time (turn on automatic time in its settings), then try again. "+
			"If it still fails, check the username and password", roughDuration(skew.Abs()))
	}
	return &plainError{msg: msg, kind: httpx.ErrAuth}
}

func roughDuration(d time.Duration) string {
	switch {
	case d >= 48*time.Hour:
		return fmt.Sprintf("about %d days", int(math.Round(d.Hours()/24)))
	case d >= 90*time.Minute:
		return fmt.Sprintf("about %d hours", int(math.Round(d.Hours())))
	}
	return fmt.Sprintf("about %d minutes", int(math.Round(d.Minutes())))
}

// unsupported maps "the camera doesn't support this" faults to backend.ErrUnsupported.
func unsupported(err error) error {
	var pe *plainError
	if errors.As(err, &pe) && pe.kind == errFault && strings.Contains(pe.msg, "doesn't support") {
		return fmt.Errorf("%w: %s", backend.ErrUnsupported, pe.msg)
	}
	return err
}
