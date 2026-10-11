package backend

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
)

// The registry lists every brand compiled into the Hub. Each brand package calls Register from
// its init(); bridge/brands.go imports the packages. The Hub's setup page, its startup and its
// probing all go through here, so adding a brand never touches the Hub itself.

// Standard field keys. They map to Config's own fields; any other key is stored in Config.Extra.
const (
	FieldURL          = "url"
	FieldUsername     = "username"
	FieldPassword     = "password"
	FieldMQTTURL      = "mqttUrl"
	FieldMQTTUser     = "mqttUser"
	FieldMQTTPassword = "mqttPassword"
	FieldTopicPrefix  = "topicPrefix"
)

// FieldType says how the setup page shows and cleans a field.
type FieldType string

const (
	// FieldText is plain text (trimmed).
	FieldText FieldType = "text"
	// FieldSecret is a password box (kept exactly as typed).
	FieldSecret FieldType = "secret"
	// FieldAddress is a network address. "192.168.1.10" becomes a URL with the scheme and port
	// filled in (for the "url" field: Descriptor.Scheme/DefaultPorts, otherwise the field's).
	FieldAddress FieldType = "address"
	// FieldNumber is a whole number.
	FieldNumber FieldType = "number"
)

// Field is one input on the setup page's "Add" form for a brand.
type Field struct {
	// Key is a Field* constant or a brand-specific key (stored in Config.Extra).
	Key string
	// Label in plain words ("Password for the recorder").
	Label string
	// Hint is the greyed-out example in the empty box ("192.168.1.64").
	Hint string
	// Help is an optional sentence under the box.
	Help string
	// Type defaults to FieldText (FieldSecret for FieldPassword, FieldAddress for FieldURL).
	Type FieldType
	// Optional fields may be left empty.
	Optional bool
	// Default is used when the box is left empty (and pre-filled).
	Default string
	// Section groups optional extras under a collapsed heading ("More settings").
	Section string
	// Scheme and DefaultPort complete a FieldAddress other than "url" ("tcp", 1883).
	Scheme      string
	DefaultPort int
}

// Descriptor describes one brand to the Hub.
type Descriptor struct {
	// Kind is the stable ID saved in settings ("hikvision"). Lowercase letters, digits, dashes.
	Kind string
	// Label is the plain-language choice on the setup page ("Hikvision recorder or camera").
	Label string
	// Description is an optional line under the label ("Also sold as LTS, Annke, …").
	Description string
	// Fields the setup page asks for, in order (the Hub always asks for an optional name).
	Fields []Field
	// Scheme for the "url" field when none is typed ("http" when empty; port 443 → https).
	Scheme string
	// DefaultPorts are tried in order when the address has no port, until Probe succeeds.
	DefaultPorts []int
	// Order sorts the brand list (lower first, then by Label). Generic choices such as
	// "Other camera (ONVIF)" use 100 to sit at the end.
	Order int
	// New builds the backend. It must not do network I/O.
	New func(Config) (Backend, error)
	// Probe checks the settings before they're saved: reachable, right device, credentials
	// work. Errors must read plainly ("the password is wrong"); network errors are explained
	// by the Hub (httpx.Explain). nil means: New, then list the cameras.
	Probe func(ctx context.Context, cfg Config) error
}

var (
	regMu    sync.RWMutex
	registry = map[string]Descriptor{}
	kindRe   = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

// Register adds a brand. It panics on a bad or duplicate descriptor (a programming error).
func Register(d Descriptor) {
	if !kindRe.MatchString(d.Kind) {
		panic(fmt.Sprintf("backend.Register: bad kind %q", d.Kind))
	}
	if d.Label == "" || d.New == nil {
		panic("backend.Register: " + d.Kind + " needs a Label and New")
	}
	d.Fields = append([]Field(nil), d.Fields...)
	for i, f := range d.Fields {
		if f.Key == "" || f.Label == "" {
			panic(fmt.Sprintf("backend.Register: %s field %d needs a Key and Label", d.Kind, i))
		}
		if f.Type == "" {
			switch f.Key {
			case FieldPassword, FieldMQTTPassword:
				d.Fields[i].Type = FieldSecret
			case FieldURL, FieldMQTTURL:
				d.Fields[i].Type = FieldAddress
			default:
				d.Fields[i].Type = FieldText
			}
		}
	}
	regMu.Lock()
	defer regMu.Unlock()
	if _, dup := registry[d.Kind]; dup {
		panic("backend.Register: " + d.Kind + " registered twice")
	}
	registry[d.Kind] = d
}

// Lookup finds a brand by kind.
func Lookup(kind string) (Descriptor, bool) {
	regMu.RLock()
	defer regMu.RUnlock()
	d, ok := registry[kind]
	return d, ok
}

// Descriptors lists every registered brand in display order.
func Descriptors() []Descriptor {
	regMu.RLock()
	out := make([]Descriptor, 0, len(registry))
	for _, d := range registry {
		out = append(out, d)
	}
	regMu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Label < out[j].Label
	})
	return out
}

// ErrUnknownKind means a saved system's brand isn't compiled into this Hub.
var ErrUnknownKind = errors.New("this Hub version doesn't support that kind of system")

// New builds the backend for a config through the registry.
func New(cfg Config) (Backend, error) {
	d, ok := Lookup(cfg.Kind)
	if !ok {
		return nil, fmt.Errorf("%w (%q)", ErrUnknownKind, cfg.Kind)
	}
	return d.New(cfg)
}

// Probe checks a config through the registry (the descriptor's Probe, or listing cameras).
func Probe(ctx context.Context, cfg Config) error {
	d, ok := Lookup(cfg.Kind)
	if !ok {
		return fmt.Errorf("%w (%q)", ErrUnknownKind, cfg.Kind)
	}
	if d.Probe != nil {
		return d.Probe(ctx, cfg)
	}
	b, err := d.New(cfg)
	if err != nil {
		return err
	}
	_, err = b.Cameras(ctx)
	return err
}
