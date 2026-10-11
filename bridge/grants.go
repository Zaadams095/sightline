package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Access grants (docs/HUB_API.md "Grants"). Every token the Hub accepts belongs to a grant:
// the owner's phones get role "owner" at pairing; everyone else gets a grant created by an
// owner (or a "full" guest) and redeemed through a one-time invite code. Only SHA-256 hashes
// of tokens and invite codes are stored.

const (
	roleOwner     = "owner"
	roleFull      = "full"
	roleHousehold = "household"
	roleTemporary = "temporary"
	roleLive      = "live"

	inviteTTL       = 7 * 24 * time.Hour
	tombstoneTTL    = 30 * 24 * time.Hour
	lastUsedFlushAt = 10 * time.Minute
)

var guestRoles = []string{roleFull, roleHousehold, roleTemporary, roleLive}

// cameraSet is "all" or a list of Hub camera IDs.
type cameraSet struct {
	All bool
	IDs []string
}

func (c cameraSet) MarshalJSON() ([]byte, error) {
	if c.All {
		return []byte(`"all"`), nil
	}
	if c.IDs == nil {
		return []byte(`[]`), nil
	}
	return json.Marshal(c.IDs)
}

func (c *cameraSet) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		if s != "all" {
			return errors.New(`cameras must be "all" or a list of camera IDs`)
		}
		*c = cameraSet{All: true}
		return nil
	}
	var ids []string
	if err := json.Unmarshal(b, &ids); err != nil {
		return errors.New(`cameras must be "all" or a list of camera IDs`)
	}
	*c = cameraSet{IDs: ids}
	return nil
}

func (c cameraSet) has(id string) bool { return c.All || slices.Contains(c.IDs, id) }

// recWindow is "all", "none", or {from, to} (unix seconds, inclusive).
type recWindow struct {
	Mode     string // "all" | "none" | "window"
	From, To int64
}

func (w recWindow) MarshalJSON() ([]byte, error) {
	if w.Mode == "window" {
		return json.Marshal(map[string]int64{"from": w.From, "to": w.To})
	}
	if w.Mode == "" {
		return []byte(`"none"`), nil
	}
	return json.Marshal(w.Mode)
}

func (w *recWindow) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		if s != "all" && s != "none" {
			return errors.New(`recordings must be "all", "none" or {"from","to"}`)
		}
		*w = recWindow{Mode: s}
		return nil
	}
	var o struct {
		From *int64 `json:"from"`
		To   *int64 `json:"to"`
	}
	if err := json.Unmarshal(b, &o); err != nil || o.From == nil || o.To == nil || *o.To <= *o.From {
		return errors.New(`recordings window needs "from" < "to" (unix seconds)`)
	}
	*w = recWindow{Mode: "window", From: *o.From, To: *o.To}
	return nil
}

// clamp narrows [after, before] to the window. ok is false when nothing is left.
func (w recWindow) clamp(after, before float64) (float64, float64, bool) {
	switch w.Mode {
	case "all":
		return after, before, before > after || before == 0
	case "window":
		if after < float64(w.From) {
			after = float64(w.From)
		}
		if before == 0 || before > float64(w.To) {
			before = float64(w.To)
		}
		return after, before, before > after
	}
	return 0, 0, false
}

type invite struct {
	CodeHash  string `json:"codeHash"`
	ExpiresAt int64  `json:"expiresAt"`
}

type grant struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Role       string    `json:"role"`
	Cameras    cameraSet `json:"cameras"`
	Recordings recWindow `json:"recordings"`
	ExpiresAt  *int64    `json:"expiresAt"`
	CreatedAt  int64     `json:"createdAt"`
	CreatedBy  string    `json:"createdBy,omitempty"`
	LastUsedAt int64     `json:"lastUsedAt,omitempty"`
	// Hashes of the tokens issued for this grant (one per phone that redeemed/paired).
	TokenHashes []string `json:"tokenHashes"`
	Invites     []invite `json:"invites,omitempty"`
	RevokedAt   int64    `json:"revokedAt,omitempty"`
}

func (g *grant) expired(now time.Time) bool { return g.ExpiresAt != nil && now.Unix() >= *g.ExpiresAt }
func (g *grant) active(now time.Time) bool  { return g.RevokedAt == 0 && !g.expired(now) }

// manager: may create, list and revoke grants (owner-equivalent).
func (g *grant) manager() bool { return g.Role == roleOwner || g.Role == roleFull }

// canRecordings: may see events, thumbnails and recordings at all.
func (g *grant) canRecordings() bool {
	return g.Role != roleLive && g.Recordings.Mode != "none" && g.Recordings.Mode != ""
}

// canPTZ: may move cameras.
func (g *grant) canPTZ() bool {
	return g.Role == roleOwner || g.Role == roleFull || g.Role == roleHousehold
}

// canPush: may register a phone for alerts.
func (g *grant) canPush() bool { return g.Role != roleLive }

// grantView is the public JSON shape (docs/HUB_API.md).
type grantView struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Role          string    `json:"role"`
	Cameras       cameraSet `json:"cameras"`
	Recordings    recWindow `json:"recordings"`
	ExpiresAt     *int64    `json:"expiresAt"`
	CreatedAt     int64     `json:"createdAt"`
	LastUsedAt    int64     `json:"lastUsedAt,omitempty"`
	Devices       int       `json:"devices"`
	PendingInvite bool      `json:"pendingInvite"`
}

func (g *grant) view(now time.Time) grantView {
	pending := false
	for _, inv := range g.Invites {
		if inv.ExpiresAt > now.Unix() {
			pending = true
		}
	}
	return grantView{
		ID: g.ID, Name: g.Name, Role: g.Role, Cameras: g.Cameras, Recordings: g.Recordings,
		ExpiresAt: g.ExpiresAt, CreatedAt: g.CreatedAt, LastUsedAt: g.LastUsedAt,
		Devices: len(g.TokenHashes), PendingInvite: pending,
	}
}

var (
	errNoToken     = errors.New("missing token")
	errBadToken    = errors.New("unknown token")
	errRevoked     = errors.New("access was removed")
	errExpired     = errors.New("access has ended")
	errBadInvite   = errors.New("that invite code isn't valid (it may have been used already)")
	errNotFound    = errors.New("not found")
	errOwnerOnly   = errors.New("only the owner can do that")
	errInviteGrant = errors.New("this access can't be re-invited")
)

type grantStore struct {
	path string
	now  func() time.Time

	mu       sync.RWMutex
	grants   map[string]*grant
	byHash   map[string]string // token hash -> grant id
	dirtyUse bool
	lastSave time.Time
}

type grantFile struct {
	Grants []*grant `json:"grants"`
}

func openGrants(dir string) (*grantStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &grantStore{path: filepath.Join(dir, "grants.json"), now: time.Now, grants: map[string]*grant{}, byHash: map[string]string{}}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var f grantFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("grants.json: %w", err)
	}
	for _, g := range f.Grants {
		s.grants[g.ID] = g
		for _, h := range g.TokenHashes {
			s.byHash[h] = g.ID
		}
	}
	return s, nil
}

func (s *grantStore) saveLocked() error {
	now := s.now()
	f := grantFile{Grants: make([]*grant, 0, len(s.grants))}
	for id, g := range s.grants {
		// Forget tombstones after a while (until then a revoked token gets a clear 401).
		if g.RevokedAt > 0 && now.Sub(time.Unix(g.RevokedAt, 0)) > tombstoneTTL {
			for _, h := range g.TokenHashes {
				delete(s.byHash, h)
			}
			delete(s.grants, id)
			continue
		}
		f.Grants = append(f.Grants, g)
	}
	slices.SortFunc(f.Grants, func(a, b *grant) int { return int(a.CreatedAt - b.CreatedAt) })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	s.dirtyUse = false
	s.lastSave = now
	return writeFileAtomic(s.path, b)
}

// writeFileAtomic writes via a temp file + rename, like the device store.
func writeFileAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return b
}

func newID(prefix string) string { return prefix + hex.EncodeToString(randomBytes(8)) }

// newToken returns a 32-byte random bearer token and its storage hash.
func newToken() (token, hash string) {
	token = "slh_" + base64.RawURLEncoding.EncodeToString(randomBytes(32))
	return token, hashSecret(token)
}

func hashSecret(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// Invite codes: 10 characters from an alphabet without look-alikes, shown as XXXXX-XXXXX.
const inviteAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func newInviteCode() string {
	b := randomBytes(10)
	out := make([]byte, 0, 11)
	for i, c := range b {
		if i == 5 {
			out = append(out, '-')
		}
		out = append(out, inviteAlphabet[int(c)%len(inviteAlphabet)])
	}
	return string(out)
}

func normalizeInvite(code string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || r == ' ' {
			return -1
		}
		if r >= 'a' && r <= 'z' {
			return r - 32
		}
		return r
	}, code)
}

// authenticate resolves a bearer token to its grant.
func (s *grantStore) authenticate(token string) (*grant, error) {
	if token == "" {
		return nil, errNoToken
	}
	h := hashSecret(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byHash[h]
	if !ok {
		return nil, errBadToken
	}
	g := s.grants[id]
	if g == nil {
		return nil, errBadToken
	}
	now := s.now()
	if g.RevokedAt > 0 {
		return nil, errRevoked
	}
	if g.expired(now) {
		return nil, errExpired
	}
	if now.Unix()-g.LastUsedAt > 60 {
		g.LastUsedAt = now.Unix()
		s.dirtyUse = true
		if now.Sub(s.lastSave) > lastUsedFlushAt {
			_ = s.saveLocked()
		}
	}
	cp := *g
	return &cp, nil
}

// get returns a copy of a grant (including revoked ones).
func (s *grantStore) get(id string) *grant {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if g := s.grants[id]; g != nil {
		cp := *g
		return &cp
	}
	return nil
}

func (s *grantStore) list() []grantView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := s.now()
	out := []grantView{}
	for _, g := range s.grants {
		if g.RevokedAt == 0 {
			out = append(out, g.view(now))
		}
	}
	slices.SortFunc(out, func(a, b grantView) int { return int(a.CreatedAt - b.CreatedAt) })
	return out
}

func (s *grantStore) hasOwner() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, g := range s.grants {
		if g.Role == roleOwner && g.RevokedAt == 0 && len(g.TokenHashes) > 0 {
			return true
		}
	}
	return false
}

// addOwner registers a newly paired phone as an owner and returns its token.
func (s *grantStore) addOwner(device string) (string, *grant, error) {
	token, hash := newToken()
	if device == "" {
		device = "Owner's phone"
	}
	g := &grant{
		ID: newID("own_"), Name: device, Role: roleOwner,
		Cameras: cameraSet{All: true}, Recordings: recWindow{Mode: "all"},
		CreatedAt: s.now().Unix(), TokenHashes: []string{hash},
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants[g.ID] = g
	s.byHash[hash] = g.ID
	cp := *g
	return token, &cp, s.saveLocked()
}

// create adds a guest grant with a one-time invite code (returned in clear text once).
func (s *grantStore) create(g *grant, createdBy string) (string, *grant, error) {
	now := s.now()
	g.ID = newID("g_")
	g.CreatedAt = now.Unix()
	g.CreatedBy = createdBy
	g.TokenHashes = []string{}
	code := newInviteCode()
	g.Invites = []invite{{CodeHash: hashSecret(normalizeInvite(code)), ExpiresAt: inviteExpiry(g, now)}}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants[g.ID] = g
	cp := *g
	return code, &cp, s.saveLocked()
}

func inviteExpiry(g *grant, now time.Time) int64 {
	exp := now.Add(inviteTTL).Unix()
	if g.ExpiresAt != nil && *g.ExpiresAt < exp {
		exp = *g.ExpiresAt
	}
	return exp
}

// reinvite issues a fresh invite code for an existing guest grant (e.g. a second phone).
func (s *grantStore) reinvite(id string) (string, *grant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.grants[id]
	now := s.now()
	if g == nil || !g.active(now) {
		return "", nil, errNotFound
	}
	if g.Role == roleOwner {
		return "", nil, errInviteGrant
	}
	code := newInviteCode()
	kept := g.Invites[:0]
	for _, inv := range g.Invites {
		if inv.ExpiresAt > now.Unix() {
			kept = append(kept, inv)
		}
	}
	g.Invites = append(kept, invite{CodeHash: hashSecret(normalizeInvite(code)), ExpiresAt: inviteExpiry(g, now)})
	cp := *g
	return code, &cp, s.saveLocked()
}

// redeem exchanges a one-time invite code for a long-lived guest token.
func (s *grantStore) redeem(code string) (string, *grant, error) {
	want := hashSecret(normalizeInvite(code))
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for _, g := range s.grants {
		for i, inv := range g.Invites {
			if subtle.ConstantTimeCompare([]byte(inv.CodeHash), []byte(want)) != 1 {
				continue
			}
			if inv.ExpiresAt <= now.Unix() || !g.active(now) {
				return "", nil, errBadInvite
			}
			token, hash := newToken()
			g.Invites = append(g.Invites[:i], g.Invites[i+1:]...)
			g.TokenHashes = append(g.TokenHashes, hash)
			g.LastUsedAt = now.Unix()
			s.byHash[hash] = g.ID
			cp := *g
			return token, &cp, s.saveLocked()
		}
	}
	return "", nil, errBadInvite
}

// revoke disables a grant immediately. Its tokens keep answering 401 "revoked" for a while.
func (s *grantStore) revoke(id string) (*grant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.grants[id]
	if g == nil || g.RevokedAt > 0 {
		return nil, errNotFound
	}
	g.RevokedAt = s.now().Unix()
	g.Invites = nil
	cp := *g
	return &cp, s.saveLocked()
}

// flush persists last-used times (called periodically and at shutdown).
func (s *grantStore) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dirtyUse {
		_ = s.saveLocked()
	}
}
