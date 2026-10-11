package reolink

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend/httpx"
)

// The Reolink API is JSON over POST /cgi-bin/api.cgi?cmd=<first command>&token=<token>, with a
// token from the Login command (no HTTP auth). Devices allow only a few sessions, so there is
// one token per backend, renewed before its lease ends and re-obtained at most once at a time.

const (
	// renewMargin: renew this long before the lease runs out (reolink_aio uses 300 s too).
	renewMargin = 5 * time.Minute
	apiTimeout  = 25 * time.Second // Search over several days can be slow
	maxReply    = 16 << 20
)

var (
	errNotReolink = &Error{"that address answered, but it doesn't look like a Reolink device. Check the address", httpx.ErrBadAnswer}
	errHTTPSOnly  = &Error{"this Reolink device only accepts secure connections. Type the address with https:// in front", nil}
)

type loginCall struct {
	done chan struct{}
	tok  string
	err  error
}

type client struct {
	hc         *httpx.Client
	user, pass string
	now        func() time.Time

	mu      sync.Mutex
	tok     string
	expires time.Time
	login   *loginCall
}

func newClient(base, user, pass string) *client {
	if user == "" {
		user = "admin"
	}
	// No HTTP auth: the API signs in with its own Login command.
	return &client{hc: httpx.New(base, "", "", httpx.WithTimeout(apiTimeout)), user: user, pass: pass, now: time.Now}
}

// post sends a batch of commands with a token and returns one item per command.
func (c *client) post(ctx context.Context, cmds []command, token string) ([]item, error) {
	body, err := json.Marshal(cmds)
	if err != nil {
		return nil, err
	}
	req, err := c.hc.NewRequest(ctx, http.MethodPost, "/cgi-bin/api.cgi?cmd="+url.QueryEscape(cmds[0].Cmd)+"&token="+url.QueryEscape(token), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusMultipleChoices {
		// Login over http on a device that only allows https (reolink_aio notes this too).
		return nil, errHTTPSOnly
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxReply))
	if err != nil {
		return nil, err
	}
	return parseReply(raw)
}

// parseReply reads a response body. Reolink answers JSON with content-type text/html.
func parseReply(raw []byte) ([]item, error) {
	var items []item
	if err := json.Unmarshal(bytes.TrimSpace(raw), &items); err != nil {
		return nil, errNotReolink
	}
	return items, nil
}

// doLogin signs in and returns the token and its lease.
func (c *client) doLogin(ctx context.Context) (string, time.Duration, error) {
	items, err := c.post(ctx, []command{cmd("Login", map[string]any{
		"User": map[string]any{"Version": "0", "userName": c.user, "password": c.pass},
	})}, "null")
	if err != nil {
		return "", 0, err
	}
	var it *item
	for i := range items {
		if items[i].Cmd == "Login" || it == nil {
			it = &items[i]
		}
	}
	if !it.ok() {
		return "", 0, commandError(it)
	}
	var v struct {
		Token struct {
			Name      string `json:"name"`
			LeaseTime num    `json:"leaseTime"`
		} `json:"Token"`
	}
	if json.Unmarshal(it.Value, &v) != nil || v.Token.Name == "" {
		return "", 0, &Error{"the Reolink device sent an unexpected sign-in reply", httpx.ErrBadAnswer}
	}
	lease := time.Duration(v.Token.LeaseTime) * time.Second
	if lease <= 0 {
		lease = time.Hour
	}
	return v.Token.Name, lease, nil
}

// startLoginLocked starts a sign-in, or joins the one in progress: concurrent callers share
// one sign-in, so a burst of requests never opens several sessions. c.mu must be held.
func (c *client) startLoginLocked() *loginCall {
	if c.login != nil {
		return c.login
	}
	call := &loginCall{done: make(chan struct{})}
	c.login = call
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), apiTimeout)
		tok, lease, err := c.doLogin(ctx)
		cancel()
		c.mu.Lock()
		if err == nil {
			c.tok, c.expires = tok, c.now().Add(lease)
		}
		call.tok, call.err = tok, err
		c.login = nil
		c.mu.Unlock()
		close(call.done)
	}()
	return call
}

func wait(ctx context.Context, call *loginCall) (string, error) {
	select {
	case <-call.done:
		return call.tok, call.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// token is a valid token: the current one, or a new sign-in when it's missing or about to expire.
func (c *client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.tok != "" && c.expires.Sub(c.now()) > renewMargin {
		t := c.tok
		c.mu.Unlock()
		return t, nil
	}
	call := c.startLoginLocked()
	c.mu.Unlock()
	return wait(ctx, call)
}

// relogin: the device rejected used ("please login first"). Sign in again only if used is
// still the current token; if another request already replaced it, reuse that one.
func (c *client) relogin(ctx context.Context, used string) (string, error) {
	c.mu.Lock()
	if c.login == nil && c.tok != "" && c.tok != used && c.expires.After(c.now()) {
		t := c.tok
		c.mu.Unlock()
		return t, nil
	}
	call := c.startLoginLocked()
	c.mu.Unlock()
	return wait(ctx, call)
}

// drop forgets the current token (the device ended the session, e.g. after SetNetPort) and
// closes it in case the firmware didn't, so it doesn't hold one of the few session slots.
func (c *client) drop() {
	c.mu.Lock()
	old := c.tok
	c.tok = ""
	c.mu.Unlock()
	if old != "" {
		c.logout(old)
	}
}

// logout ends a session, best effort, in the background.
func (c *client) logout(token string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, _ = c.post(ctx, []command{cmd("Logout", nil)}, token)
	}()
}

// api sends commands in one request and returns one item per command, signing in again once
// when the device says "please login first".
func (c *client) api(ctx context.Context, cmds ...command) ([]item, error) {
	used, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	items, err := c.post(ctx, cmds, used)
	if err != nil {
		return nil, err
	}
	if anyExpired(items) {
		tok, err := c.relogin(ctx, used)
		if err != nil {
			return nil, err
		}
		if items, err = c.post(ctx, cmds, tok); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func anyExpired(items []item) bool {
	for i := range items {
		if loginExpired(&items[i]) {
			return true
		}
	}
	return false
}

// one sends one command and returns its value, or a plain error.
func (c *client) one(ctx context.Context, cm command) (json.RawMessage, error) {
	items, err := c.api(ctx, cm)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, commandError(nil)
	}
	if !items[0].ok() {
		return nil, commandError(&items[0])
	}
	return items[0].Value, nil
}

// media fetches a GET URL that carries the token (Snap, Download, Playback), with the Media
// client when stream is set. Errors come back as JSON with status 200; a rejected token is
// renewed once. pathFor builds the path for a token.
func (c *client) media(ctx context.Context, pathFor func(token string) string, hdr http.Header, stream bool) (*http.Response, error) {
	used, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		var resp *http.Response
		if stream {
			resp, err = c.hc.Stream(ctx, pathFor(used), hdr)
		} else {
			resp, err = c.hc.Get(ctx, pathFor(used))
		}
		if err != nil {
			return nil, err
		}
		if !isJSONReply(resp) {
			return resp, nil
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		items, perr := parseReply(raw)
		if perr != nil || len(items) == 0 {
			return nil, errNotReolink
		}
		if loginExpired(&items[0]) && attempt == 0 {
			if used, err = c.relogin(ctx, used); err != nil {
				return nil, err
			}
			continue
		}
		return nil, commandError(&items[0])
	}
}

// isJSONReply: the device answered a media request with a command result (an error), not media.
func isJSONReply(resp *http.Response) bool {
	if resp.StatusCode != http.StatusOK {
		return false
	}
	ct := resp.Header.Get("Content-Type")
	return bytes.HasPrefix([]byte(ct), []byte("text/")) || bytes.Contains([]byte(ct), []byte("json"))
}
