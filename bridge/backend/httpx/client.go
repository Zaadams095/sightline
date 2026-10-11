// Package httpx is the shared HTTP plumbing for brand backends talking to LAN devices
// (recorders, cameras): Basic + Digest auth negotiated automatically, self-signed HTTPS
// accepted, sensible timeouts, and errors that read plainly on the setup page.
//
//	c := httpx.New(cfg.URL, cfg.Username, cfg.Password)
//	var info deviceInfo
//	err := c.GetXML(ctx, "/ISAPI/System/deviceInfo", &info)
//	resp, err := c.Stream(ctx, "/ISAPI/…/download", hdr) // media: no overall timeout
package httpx

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Default timeouts. API calls are small; media streams only bound the wait for headers.
const (
	DefaultTimeout = 10 * time.Second
	dialTimeout    = 5 * time.Second
	headerTimeout  = 20 * time.Second
	maxBody        = 32 << 20
)

// Client talks to one device at Base.
type Client struct {
	// Base is the device's URL without a trailing slash ("http://192.168.1.64").
	Base string
	// API is for small requests: it times out after Timeout (DefaultTimeout).
	API *http.Client
	// Media is for recordings and other long downloads: no overall timeout.
	Media *http.Client
	// Header is added to every request (e.g. a session cookie or token).
	Header http.Header
}

// Option customizes New.
type Option func(*options)

type options struct {
	timeout   time.Duration
	strictTLS bool
}

// WithTimeout changes the API client's overall timeout.
func WithTimeout(d time.Duration) Option { return func(o *options) { o.timeout = d } }

// WithStrictTLS verifies HTTPS certificates (cloud services). LAN devices use self-signed
// certificates, so verification is off by default.
func WithStrictTLS() Option { return func(o *options) { o.strictTLS = true } }

// New makes a client for the device at base. With a username, Basic or Digest auth is
// answered automatically (whichever the device asks for).
func New(base, user, pass string, opts ...Option) *Client {
	o := options{timeout: DefaultTimeout}
	for _, f := range opts {
		f(&o)
	}
	rt := Transport(user, pass, !o.strictTLS)
	return &Client{
		Base:   strings.TrimRight(base, "/"),
		API:    &http.Client{Transport: rt, Timeout: o.timeout},
		Media:  &http.Client{Transport: rt},
		Header: http.Header{},
	}
}

// Transport is the RoundTripper New uses: LAN-friendly dialing, optional self-signed TLS, and
// Basic/Digest auth when user is set. Use it directly for go2rtc/WebSocket helpers.
func Transport(user, pass string, insecureTLS bool) http.RoundTripper {
	base := &http.Transport{
		Proxy:                 nil, // LAN devices: never through a proxy
		DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   dialTimeout,
		ResponseHeaderTimeout: headerTimeout,
		IdleConnTimeout:       60 * time.Second,
		MaxIdleConnsPerHost:   4,
		TLSClientConfig:       &tls.Config{InsecureSkipVerify: insecureTLS}, //nolint:gosec // LAN devices use self-signed certificates
	}
	if user == "" {
		return base
	}
	return &authTransport{base: base, user: user, pass: pass}
}

// URL joins Base and a path ("/ISAPI/…" or "cgi-bin/…?x=1").
func (c *Client) URL(path string) string {
	if path == "" || strings.HasPrefix(path, "/") {
		return c.Base + path
	}
	return c.Base + "/" + path
}

// NewRequest builds a request to Base+path with the client's Header.
func (c *Client) NewRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.URL(path), body)
	if err != nil {
		return nil, err
	}
	for k, v := range c.Header {
		req.Header[k] = append([]string(nil), v...)
	}
	return req, nil
}

// Do sends a request with the API client and turns 4xx/5xx answers into a *StatusError
// (body closed). On success the caller closes resp.Body.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	return check(c.API.Do(req))
}

func check(resp *http.Response, err error) (*http.Response, error) {
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		return nil, &StatusError{Code: resp.StatusCode, Body: string(b)}
	}
	return resp, nil
}

// Get fetches path with the API client (see Do).
func (c *Client) Get(ctx context.Context, path string) (*http.Response, error) {
	req, err := c.NewRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	return c.Do(req)
}

// GetBytes fetches a small body (snapshots, thumbnails) and its Content-Type.
func (c *Client) GetBytes(ctx context.Context, path string) ([]byte, string, error) {
	resp, err := c.Get(ctx, path)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	return b, resp.Header.Get("Content-Type"), err
}

// GetJSON fetches path and decodes JSON into out.
func (c *Client) GetJSON(ctx context.Context, path string, out any) error {
	return c.DoJSON(ctx, http.MethodGet, path, nil, out)
}

// DoJSON sends in (if not nil) as JSON and decodes the answer into out (if not nil).
func (c *Client) DoJSON(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = strings.NewReader(string(b))
	}
	req, err := c.NewRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(out); err != nil {
		return fmt.Errorf("%w: %v", ErrBadAnswer, err)
	}
	return nil
}

// GetXML fetches path and decodes XML into out (Hikvision ISAPI, ONVIF).
func (c *Client) GetXML(ctx context.Context, path string, out any) error {
	return c.DoXML(ctx, http.MethodGet, path, nil, out)
}

// DoXML sends body (if not empty) as XML and decodes the answer into out (if not nil).
func (c *Client) DoXML(ctx context.Context, method, path string, body []byte, out any) error {
	var rd io.Reader
	if len(body) > 0 {
		rd = strings.NewReader(string(body))
	}
	req, err := c.NewRequest(ctx, method, path, rd)
	if err != nil {
		return err
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/xml")
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		return nil
	}
	if err := xml.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(out); err != nil {
		return fmt.Errorf("%w: %v", ErrBadAnswer, err)
	}
	return nil
}

// Stream fetches media with the Media client (no overall timeout, ctx still applies),
// passing the player's Range/If-Range/conditional headers from hdr through. The response is
// returned as-is (including 4xx) so the Hub can relay it; the caller closes the body.
func (c *Client) Stream(ctx context.Context, path string, hdr http.Header) (*http.Response, error) {
	req, err := c.NewRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	CopyRangeHeaders(req.Header, hdr)
	return c.Media.Do(req)
}

// CopyRangeHeaders copies the headers a media player uses for partial requests.
func CopyRangeHeaders(dst, src http.Header) {
	for _, k := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := src.Get(k); v != "" {
			dst.Set(k, v)
		}
	}
}
