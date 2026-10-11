package onvif

import (
	"crypto/sha1" //nolint:gosec // WS-Security UsernameToken PasswordDigest is defined with SHA-1
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Ported from app/src/systems/onvif-soap.ts (same envelope, digest and parsing rules).

const (
	nsSOAP = "http://www.w3.org/2003/05/soap-envelope"
	nsTDS  = "http://www.onvif.org/ver10/device/wsdl"
	nsTRT  = "http://www.onvif.org/ver10/media/wsdl"
	nsTR2  = "http://www.onvif.org/ver20/media/wsdl"
	nsTPTZ = "http://www.onvif.org/ver20/ptz/wsdl"
	nsTEV  = "http://www.onvif.org/ver10/events/wsdl"
	nsTT   = "http://www.onvif.org/ver10/schema"
	nsWSNT = "http://docs.oasis-open.org/wsn/b-2"
	nsWSA  = "http://www.w3.org/2005/08/addressing"
	nsWSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
	nsWSU  = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"

	passwordDigestType = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest"
	base64BinaryType   = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
)

// ---- WS-Security UsernameToken ----

// passwordDigest = Base64(SHA1(nonce + created + password)), nonce as raw bytes.
func passwordDigest(nonce []byte, created, password string) string {
	h := sha1.New() //nolint:gosec // required by the WS-Security profile
	h.Write(nonce)
	h.Write([]byte(created))
	h.Write([]byte(password))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// onvifTimestamp: ONVIF devices are picky: UTC, whole seconds, trailing Z.
func onvifTimestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func securityHeader(username, password string, nonce []byte, created string) string {
	return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="` + nsWSSE + `" xmlns:wsu="` + nsWSU + `">` +
		`<wsse:UsernameToken>` +
		`<wsse:Username>` + escapeXML(username) + `</wsse:Username>` +
		`<wsse:Password Type="` + passwordDigestType + `">` + passwordDigest(nonce, created, password) + `</wsse:Password>` +
		`<wsse:Nonce EncodingType="` + base64BinaryType + `">` + base64.StdEncoding.EncodeToString(nonce) + `</wsse:Nonce>` +
		`<wsu:Created>` + created + `</wsu:Created>` +
		`</wsse:UsernameToken></wsse:Security>`
}

// envelope is a SOAP 1.2 envelope declaring every namespace the request bodies use.
func envelope(body, header string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	b.WriteString(`<s:Envelope xmlns:s="` + nsSOAP + `" xmlns:tds="` + nsTDS + `" xmlns:trt="` + nsTRT +
		`" xmlns:tr2="` + nsTR2 + `" xmlns:tptz="` + nsTPTZ + `" xmlns:tt="` + nsTT + `" xmlns:tev="` + nsTEV +
		`" xmlns:wsnt="` + nsWSNT + `" xmlns:wsa="` + nsWSA + `">`)
	if header != "" {
		b.WriteString("<s:Header>" + header + "</s:Header>")
	}
	b.WriteString("<s:Body>" + body + "</s:Body></s:Envelope>")
	return b.String()
}

// ---- Request bodies ----

func tok(tag, value string) string { return "<" + tag + ">" + escapeXML(value) + "</" + tag + ">" }

const (
	reqGetSystemDateAndTime = `<tds:GetSystemDateAndTime/>`
	reqGetDeviceInformation = `<tds:GetDeviceInformation/>`
	reqGetServices          = `<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>`
	reqGetCapabilities      = `<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>`
	reqGetNodes             = `<tptz:GetNodes/>`
)

func reqGetProfiles(media2 bool) string {
	if media2 {
		return `<tr2:GetProfiles><tr2:Type>All</tr2:Type></tr2:GetProfiles>`
	}
	return `<trt:GetProfiles/>`
}

func reqGetStreamURI(profile string, media2 bool) string {
	if media2 {
		return `<tr2:GetStreamUri><tr2:Protocol>RTSP</tr2:Protocol>` + tok("tr2:ProfileToken", profile) + `</tr2:GetStreamUri>`
	}
	return `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>` +
		tok("trt:ProfileToken", profile) + `</trt:GetStreamUri>`
}

func reqGetSnapshotURI(profile string, media2 bool) string {
	if media2 {
		return `<tr2:GetSnapshotUri>` + tok("tr2:ProfileToken", profile) + `</tr2:GetSnapshotUri>`
	}
	return `<trt:GetSnapshotUri>` + tok("trt:ProfileToken", profile) + `</trt:GetSnapshotUri>`
}

func reqGetPresets(profile string) string {
	return `<tptz:GetPresets>` + tok("tptz:ProfileToken", profile) + `</tptz:GetPresets>`
}

func reqGotoPreset(profile, preset string) string {
	return `<tptz:GotoPreset>` + tok("tptz:ProfileToken", profile) + tok("tptz:PresetToken", preset) + `</tptz:GotoPreset>`
}

func num(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func reqContinuousMove(profile string, x, y, zoom float64) string {
	v := `<tt:PanTilt x="` + num(x) + `" y="` + num(y) + `"/>`
	if zoom != 0 {
		v = `<tt:Zoom x="` + num(zoom) + `"/>`
	}
	return `<tptz:ContinuousMove>` + tok("tptz:ProfileToken", profile) + `<tptz:Velocity>` + v + `</tptz:Velocity></tptz:ContinuousMove>`
}

func reqStop(profile string) string {
	return `<tptz:Stop>` + tok("tptz:ProfileToken", profile) + `<tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`
}

// ---- Faults ----

type soapFault struct {
	Codes  []string // code and subcode values, local parts only ("Sender", "NotAuthorized")
	Reason string
}

func localPart(q string) string {
	if i := strings.IndexByte(q, ':'); i >= 0 {
		return q[i+1:]
	}
	return q
}

func parseFault(doc *node) *soapFault {
	f := doc.find("Fault")
	if f == nil {
		return nil
	}
	out := &soapFault{}
	if code := f.find("Code"); code != nil {
		for _, v := range code.findAllDeep("Value") {
			out.Codes = append(out.Codes, localPart(v.allText()))
		}
	}
	if legacy := f.textOf("faultcode"); legacy != "" {
		out.Codes = append(out.Codes, localPart(legacy))
	}
	out.Reason = f.textOf("Text")
	if out.Reason == "" {
		out.Reason = f.textOf("faultstring")
	}
	if out.Reason == "" {
		out.Reason = f.textOf("Reason")
	}
	return out
}

// findAllDeep returns every descendant with this local name, nested ones included.
func (n *node) findAllDeep(local string) []*node {
	var out []*node
	for _, c := range n.Children {
		if c.Local == local {
			out = append(out, c)
		}
		out = append(out, c.findAllDeep(local)...)
	}
	return out
}

var (
	authCodeRe   = regexp.MustCompile(`(?i)NotAuthori[sz]ed|FailedAuthentication|InvalidSecurity|Unauthori[sz]ed|FailedCheck`)
	authReasonRe = regexp.MustCompile(`(?i)not authori[sz]ed|unauthori[sz]ed|authenticat|password|credential`)
	unsupportRe  = regexp.MustCompile(`(?i)ActionNotSupported|NotSupported|NoSuchService|NoPTZProfile`)
)

func (f *soapFault) isAuth() bool {
	for _, c := range f.Codes {
		if authCodeRe.MatchString(c) {
			return true
		}
	}
	return authReasonRe.MatchString(f.Reason)
}

func (f *soapFault) unsupported() bool {
	for _, c := range f.Codes {
		if unsupportRe.MatchString(c) {
			return true
		}
	}
	return false
}

// message is a plain-language fragment (no SOAP jargon).
func (f *soapFault) message() string {
	if f.unsupported() {
		return "the camera doesn't support this"
	}
	if f.Reason != "" {
		return "the camera turned down the request (" + f.Reason + ")"
	}
	return "the camera turned down the request"
}

// ---- Responses ----

func parseDeviceName(doc *node) string {
	brand := doc.textOf("Manufacturer")
	model := doc.textOf("Model")
	switch {
	case brand == "":
		return model
	case model == "" || strings.Contains(strings.ToLower(model), strings.ToLower(brand)):
		if model != "" {
			return model
		}
		return brand
	}
	return brand + " " + model
}

// parseSystemTime is the camera's UTC clock, or false when it doesn't report one.
func parseSystemTime(doc *node) (time.Time, bool) {
	utc := doc.find("UTCDateTime")
	if utc == nil {
		return time.Time{}, false
	}
	var v [6]int
	for i, name := range []string{"Year", "Month", "Day", "Hour", "Minute", "Second"} {
		n, err := strconv.Atoi(utc.textOf(name))
		if err != nil {
			return time.Time{}, false
		}
		v[i] = n
	}
	if v[0] < 2000 {
		return time.Time{}, false
	}
	return time.Date(v[0], time.Month(v[1]), v[2], v[3], v[4], v[5], 0, time.UTC), true
}

type serviceAddrs struct {
	Device, Media, Media2, PTZ, Events string
}

// firstAddr: some devices list several addresses (IPv4 and IPv6) separated by spaces.
func firstAddr(s string) string {
	if f := strings.Fields(s); len(f) > 0 {
		return f[0]
	}
	return ""
}

func parseServices(doc *node) serviceAddrs {
	var out serviceAddrs
	for _, s := range doc.findAll("Service") {
		ns := s.textOf("Namespace")
		addr := firstAddr(s.textOf("XAddr"))
		if addr == "" {
			continue
		}
		var dst *string
		switch {
		case strings.HasSuffix(ns, "/ver10/device/wsdl"):
			dst = &out.Device
		case strings.HasSuffix(ns, "/ver10/media/wsdl"):
			dst = &out.Media
		case strings.HasSuffix(ns, "/ver20/media/wsdl"):
			dst = &out.Media2
		case strings.HasSuffix(ns, "/ver20/ptz/wsdl"):
			dst = &out.PTZ
		case strings.HasSuffix(ns, "/ver10/events/wsdl"):
			dst = &out.Events
		}
		if dst != nil && *dst == "" {
			*dst = addr
		}
	}
	return out
}

func parseCapabilities(doc *node) serviceAddrs {
	caps := doc.find("Capabilities")
	if caps == nil {
		return serviceAddrs{}
	}
	addr := func(name string) string {
		if el := caps.find(name); el != nil {
			return firstAddr(el.textOf("XAddr"))
		}
		return ""
	}
	return serviceAddrs{Device: addr("Device"), Media: addr("Media"), PTZ: addr("PTZ"), Events: addr("Events")}
}

type mediaProfile struct {
	Token string
	Name  string
	// SourceToken is the physical video source (sensor / recorder channel); profiles sharing
	// it are one camera. SourceConfig is the video source configuration's own token, which
	// some cameras name in their events instead.
	SourceToken, SourceConfig string
	Encoding                  string
	Width, Height             int
	PTZNode                   string
	HasPTZ                    bool
}

// parseProfiles reads GetProfiles from Media (ver10) or Media2 (ver20).
func parseProfiles(doc *node) []mediaProfile {
	var out []mediaProfile
	for _, p := range doc.findAll("Profiles") {
		token := p.attr("token")
		if token == "" {
			continue
		}
		src := p.find("VideoSourceConfiguration")
		if src == nil {
			src = p.find("VideoSource")
		}
		enc := p.find("VideoEncoderConfiguration")
		if enc == nil {
			enc = p.find("VideoEncoder")
		}
		ptz := p.find("PTZConfiguration")
		if ptz == nil {
			ptz = p.find("PTZ")
		}
		mp := mediaProfile{Token: token, Name: p.textOf("Name")}
		if src != nil {
			mp.SourceToken = src.textOf("SourceToken")
			mp.SourceConfig = src.attr("token")
			if b := src.find("Bounds"); b != nil {
				mp.Width, _ = strconv.Atoi(b.attr("width"))
				mp.Height, _ = strconv.Atoi(b.attr("height"))
			}
		}
		if enc != nil {
			mp.Encoding = strings.ToUpper(enc.textOf("Encoding"))
			if res := enc.find("Resolution"); res != nil {
				if w, err := strconv.Atoi(res.textOf("Width")); err == nil {
					mp.Width = w
				}
				if h, err := strconv.Atoi(res.textOf("Height")); err == nil {
					mp.Height = h
				}
			}
		}
		if ptz != nil {
			mp.HasPTZ = true
			mp.PTZNode = ptz.textOf("NodeToken")
		}
		out = append(out, mp)
	}
	return out
}

// parseURI is the first URI in a GetStreamUri / GetSnapshotUri answer.
func parseURI(doc *node) string { return doc.textOf("Uri") }

type preset struct{ Token, Name string }

func parsePresets(doc *node) []preset {
	var out []preset
	for _, p := range doc.findAll("Preset") {
		t := p.attr("token")
		if t == "" {
			continue
		}
		name := p.textOf("Name")
		if name == "" {
			name = t
		}
		out = append(out, preset{Token: t, Name: name})
	}
	return out
}

type ptzNode struct {
	Token            string
	CanMove, CanZoom bool
}

func parsePTZNodes(doc *node) []ptzNode {
	var out []ptzNode
	for _, n := range doc.findAll("PTZNode") {
		out = append(out, ptzNode{
			Token:   n.attr("token"),
			CanMove: n.find("ContinuousPanTiltVelocitySpace") != nil,
			CanZoom: n.find("ContinuousZoomVelocitySpace") != nil,
		})
	}
	return out
}

// ---- Cameras from profiles ----

type onvifCamera struct {
	// ID is the video source token, made URL-safe (stable per sensor / channel).
	ID        string
	Source    string
	Main, Sub mediaProfile
	// PTZ is the profile used for PTZ commands, when any profile of this source has PTZ.
	PTZ *mediaProfile
	// all profiles of this source (event source matching)
	profiles []mediaProfile
}

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9_.\-]`)

func safeID(s string) string { return unsafeID.ReplaceAllString(s, "_") }

// camerasFromProfiles groups profiles by video source (multi-sensor cameras and ONVIF recorders
// expose one per lens/channel). Main = highest resolution, sub = lowest. MJPEG-only profiles
// are skipped when an H.264/H.265 one exists, since only those can be played live.
func camerasFromProfiles(profiles []mediaProfile) []onvifCamera {
	var order []string
	groups := map[string][]mediaProfile{}
	for _, p := range profiles {
		if _, ok := groups[p.SourceToken]; !ok {
			order = append(order, p.SourceToken)
		}
		groups[p.SourceToken] = append(groups[p.SourceToken], p)
	}
	var out []onvifCamera
	seen := map[string]bool{}
	for _, source := range order {
		list := groups[source]
		var video, streamable []mediaProfile
		for _, p := range list {
			if p.Encoding != "" || p.Width > 0 {
				video = append(video, p)
				if p.Encoding != "JPEG" {
					streamable = append(streamable, p)
				}
			}
		}
		usable := list
		switch {
		case len(streamable) > 0:
			usable = streamable
		case len(video) > 0:
			usable = video
		}
		sorted := append([]mediaProfile(nil), usable...)
		sort.SliceStable(sorted, func(i, j int) bool {
			return sorted[i].Width*sorted[i].Height > sorted[j].Width*sorted[j].Height
		})
		id := source
		if id == "" {
			id = sorted[0].Token
		}
		id = safeID(id)
		for base, n := id, 2; seen[id]; n++ {
			id = fmt.Sprintf("%s_%d", base, n)
		}
		seen[id] = true
		c := onvifCamera{ID: id, Source: source, Main: sorted[0], Sub: sorted[len(sorted)-1], profiles: list}
		for _, cand := range [][]mediaProfile{sorted, list} {
			if c.PTZ != nil {
				break
			}
			for i := range cand {
				if cand[i].HasPTZ {
					p := cand[i]
					c.PTZ = &p
					break
				}
			}
		}
		out = append(out, c)
	}
	return out
}

// ---- Addresses ----

var xaddrRe = regexp.MustCompile(`(?i)^[a-z][\w+.-]*://[^/?#]*([^#]*)`)

// xaddrPath keeps only the path (and query) of an XAddr: cameras report their own idea of
// their address, which often isn't the one the Hub reaches them at.
func xaddrPath(xaddr, fallback string) string {
	if xaddr == "" {
		return fallback
	}
	path := ""
	if m := xaddrRe.FindStringSubmatch(xaddr); m != nil {
		path = m[1]
	} else if strings.HasPrefix(xaddr, "/") {
		path = xaddr
	}
	if path == "" || path == "/" {
		return fallback
	}
	return path
}

func isPrivateV4(ip net.IP) bool {
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	return ip4.IsPrivate() || (ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127)
}

// shouldRewriteHost says whether a host the camera reported should be replaced by the address
// the user typed. Cameras often report loopback, link-local or internal addresses (or their LAN
// IP when reached through a hostname or port forward). A different private IP on the same
// subnet is kept: ONVIF recorders can hand out their cameras' own addresses.
func shouldRewriteHost(reported, configured string) bool {
	r := strings.ToLower(strings.Trim(reported, "[]"))
	c := strings.ToLower(strings.Trim(configured, "[]"))
	if r == c {
		return false
	}
	if r == "" || r == "localhost" || r == "0.0.0.0" || r == "::" || r == "::1" || strings.HasPrefix(r, "fe80:") {
		return true
	}
	rip := net.ParseIP(r)
	if rip == nil || rip.To4() == nil {
		if rip != nil {
			return true // other IPv6: use what the user typed
		}
		return !strings.Contains(r, ".") // bare names like "ipcam" don't resolve
	}
	if rip.IsLoopback() || rip.IsLinkLocalUnicast() {
		return true
	}
	cip := net.ParseIP(c)
	if cip == nil || !isPrivateV4(cip) {
		return true // reached by hostname / public address
	}
	r4, c4 := rip.To4(), cip.To4()
	return !(r4[0] == c4[0] && r4[1] == c4[1] && r4[2] == c4[2])
}

// withHost replaces u's host, keeping its port.
func withHost(u *url.URL, host string) {
	if p := u.Port(); p != "" {
		u.Host = net.JoinHostPort(strings.Trim(host, "[]"), p)
		return
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	u.Host = host
}

// streamURL makes a camera-reported RTSP URL usable by the Hub: pointed at the configured host
// when the reported one isn't reachable, with the login in it.
func streamURL(uri, configuredHost, username, password string) string {
	u, err := url.Parse(strings.TrimSpace(uri))
	if err != nil || u.Host == "" {
		return uri
	}
	if configuredHost != "" && shouldRewriteHost(u.Hostname(), configuredHost) {
		withHost(u, configuredHost)
	}
	if username != "" {
		u.User = url.UserPassword(username, password)
	}
	return u.String()
}

// snapshotURL resolves a camera-reported snapshot URI against the configured base URL.
func snapshotURL(uri string, base *url.URL) string {
	uri = strings.TrimSpace(uri)
	if uri == "" {
		return ""
	}
	if strings.HasPrefix(uri, "/") {
		return strings.TrimRight(base.String(), "/") + uri
	}
	u, err := url.Parse(uri)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return uri
	}
	if shouldRewriteHost(u.Hostname(), base.Hostname()) {
		withHost(u, base.Hostname())
	}
	return u.String()
}
