package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
)

var verbRE = regexp.MustCompile(`%[-+# 0]*[0-9]*(?:\.[0-9]+)?[a-zA-Z%]`)

func verbs(f string) []string {
	var out []string
	for _, v := range verbRE.FindAllString(f, -1) {
		if v != "%%" {
			out = append(out, v)
		}
	}
	return out
}

func TestMessagesComplete(t *testing.T) {
	for key, m := range messages {
		for _, l := range langs {
			f, ok := m[l]
			if !ok || strings.TrimSpace(f) == "" {
				t.Errorf("%s: missing %s", key, l)
				continue
			}
			if got, want := verbs(f), verbs(m["en"]); !slices.Equal(got, want) {
				t.Errorf("%s/%s: verbs %v, English has %v", key, l, got, want)
			}
		}
		for l := range m {
			if !slices.Contains(langs, l) {
				t.Errorf("%s: unexpected language %q", key, l)
			}
		}
	}
	for _, table := range []map[string][7]string{weekdayNames} {
		for _, l := range langs[1:] {
			if _, ok := table[l]; !ok {
				t.Errorf("weekdays: missing %s", l)
			}
		}
	}
	for _, l := range langs[1:] {
		if _, ok := monthNames[l]; !ok {
			t.Errorf("months: missing %s", l)
		}
	}
	// English object labels must read exactly as the old capitalize-and-unsnake rule did.
	for key, m := range messages {
		if o, ok := strings.CutPrefix(key, "obj."); ok {
			if want := strings.ToUpper(o[:1]) + strings.ReplaceAll(o[1:], "_", " "); m["en"] != want {
				t.Errorf("%s: English %q, old output %q", key, m["en"], want)
			}
		}
	}
}

func TestNormLang(t *testing.T) {
	for in, want := range map[string]string{
		"": "en", "en": "en", "en-US": "en", "EN_gb": "en", "ja": "en", "klingon": "en",
		"es": "es", "es-MX": "es", "es_419": "es", "ES": "es",
		"fr": "fr", "fr-CA": "fr", "de": "de", "de-AT": "de",
		"pt": "pt-BR", "pt-BR": "pt-BR", "pt_BR": "pt-BR", "pt-PT": "pt-BR", "pt-br": "pt-BR",
	} {
		if got := normLang(in); got != want {
			t.Errorf("normLang(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTrFallback(t *testing.T) {
	if got := tr("ja", "alert.package", "Porch"); got != "Package delivered · Porch" {
		t.Errorf("unknown lang: %q", got)
	}
	if got := tr("es-MX", "alert.package", "Porch"); got != "Paquete entregado · Porch" {
		t.Errorf("regional lang: %q", got)
	}
	if got := tr("de", "no.such.key"); got != "no.such.key" {
		t.Errorf("unknown key: %q", got)
	}
	messages["test.onlyEnglish"] = map[string]string{"en": "Hello %s"}
	defer delete(messages, "test.onlyEnglish")
	if got := tr("fr", "test.onlyEnglish", "Zach"); got != "Hello Zach" {
		t.Errorf("missing language: %q", got)
	}
	if got := tr("fr", "health.storage.title", 95); got != "Le stockage de l’enregistreur est plein à 95 %" {
		t.Errorf("percent: %q", got)
	}
	if got := objectLabel("de", "garbage_can"); got != "Garbage can" {
		t.Errorf("unknown object: %q", got)
	}
}

func TestBuildMessageEnglishUnchanged(t *testing.T) {
	ev := backend.Event{ID: "r", Camera: "front", Start: 100, Objects: []string{"person", "license_plate"}, Zones: []string{"front_yard"}}
	for _, l := range []string{"", "en", "en-US", "ja"} {
		m := buildMessage(device{Lang: l, CameraNames: map[string]string{"front": "Front Door"}}, ev)
		if m.Title != "Person & License plate · Front Door" || m.Body != "In front yard" {
			t.Errorf("lang %q: %q / %q", l, m.Title, m.Body)
		}
	}
	m := buildMessage(device{}, backend.Event{ID: "r", Camera: "front"})
	if m.Title != "Motion · front" || m.Body != "" {
		t.Errorf("motion: %q / %q", m.Title, m.Body)
	}
}

func TestBuildMessageLocalized(t *testing.T) {
	type want struct{ objs, body, motion, ring, pkg, names string }
	cases := map[string]want{
		"es":    {"Persona y Coche · Front Door", "En front yard", "Movimiento · Front Door", "Hay alguien en la puerta · Front Door", "Paquete entregado · Front Door", "Zach y Bob · Front Door"},
		"fr":    {"Personne et Voiture · Front Door", "Dans front yard", "Mouvement · Front Door", "Quelqu’un est à la porte · Front Door", "Colis livré · Front Door", "Zach et Bob · Front Door"},
		"de":    {"Person & Auto · Front Door", "In front yard", "Bewegung · Front Door", "Jemand ist an der Tür · Front Door", "Paket zugestellt · Front Door", "Zach & Bob · Front Door"},
		"pt-BR": {"Pessoa e Carro · Front Door", "Em front yard", "Movimento · Front Door", "Tem alguém na porta · Front Door", "Encomenda entregue · Front Door", "Zach e Bob · Front Door"},
	}
	for l, w := range cases {
		d := device{Lang: l, CameraNames: map[string]string{"front": "Front Door"}}
		ev := func(objs ...string) backend.Event {
			return backend.Event{ID: "r", Camera: "front", Start: 100, Objects: objs}
		}
		objs := ev("person", "car")
		objs.Zones = []string{"front_yard"}
		if m := buildMessage(d, objs); m.Title != w.objs || m.Body != w.body {
			t.Errorf("%s objects: %q / %q", l, m.Title, m.Body)
		}
		if m := buildMessage(d, ev()); m.Title != w.motion {
			t.Errorf("%s motion: %q", l, m.Title)
		}
		if m := buildMessage(d, ev("person", "doorbell")); m.Title != w.ring || m.CategoryID != "doorbell-ring" {
			t.Errorf("%s ring: %q", l, m.Title)
		}
		if m := buildMessage(d, ev("package")); m.Title != w.pkg {
			t.Errorf("%s package: %q", l, m.Title)
		}
		named := ev("person")
		named.SubLabels = []string{"Zach", "Bob"}
		if m := buildMessage(d, named); m.Title != w.names {
			t.Errorf("%s names: %q", l, m.Title)
		}
	}
}

// One event, two phones in different languages: each gets its own text.
func TestOnEventPerDeviceLanguage(t *testing.T) {
	base := device{PushToken: "ExponentPushToken[x]", DefaultRule: rule{Enabled: true}, CameraNames: map[string]string{"front": "Front Door"}}
	en, de := base, base
	en.ID, de.ID, de.Lang = "en", "de", "de"
	e, p := newTestEngine(t, en)
	_ = e.store.put(de)
	e.OnEvent(backend.Event{ID: "r1", Camera: "front", Start: 100, Objects: []string{"dog"}})
	got := map[string]bool{}
	for _, m := range p.sent {
		got[m.Title] = true
	}
	if len(p.sent) != 2 || !got["Dog · Front Door"] || !got["Hund · Front Door"] {
		t.Fatalf("sent %+v", p.sent)
	}
}

func TestHealthPerDeviceLanguage(t *testing.T) {
	s, _ := openStore(t.TempDir())
	hp := healthPrefs{Enabled: true, StoragePct: 90}
	_ = s.put(device{ID: "a", PushToken: "ExponentPushToken[a]", Health: hp})
	_ = s.put(device{ID: "b", PushToken: "ExponentPushToken[b]", Health: hp, Lang: "de", CameraNames: map[string]string{"front": "Haustür"}})
	_ = s.put(device{ID: "c", PushToken: "ExponentPushToken[c]", Health: hp, Lang: "fr"})
	p := &fakePusher{}
	h := &healthMonitor{label: "Frigate", store: s, pusher: p, active: map[string]bool{}}
	h.evaluateHealth(backend.Health{Offline: []string{"front"}, Storage: []backend.Storage{{Path: "/media", UsedPct: 95, FreeGB: 12.5}}}, nil)
	byTo := map[string][]string{}
	for _, m := range p.sent {
		byTo[m.To] = append(byTo[m.To], m.Title+" | "+m.Body)
	}
	want := map[string][]string{
		"ExponentPushToken[a]": {"front is offline | No video from this camera.", "Recorder storage is 95% full | 12.5 GB free on /media."},
		"ExponentPushToken[b]": {"Haustür ist offline | Diese Kamera sendet kein Video.", "Der Speicher des Rekorders ist zu 95 % voll | Noch 12,5 GB frei auf /media."},
		"ExponentPushToken[c]": {"front est hors ligne | Aucune vidéo de cette caméra.", "Le stockage de l’enregistreur est plein à 95 % | 12,5 Go libres sur /media."},
	}
	for to, w := range want {
		if !slices.Equal(byTo[to], w) {
			t.Errorf("%s: got %q, want %q", to, byTo[to], w)
		}
	}

	p.sent = nil
	h.active = map[string]bool{}
	h.failures = 2
	h.evaluateHealth(backend.Health{}, errors.New("connection refused"))
	for _, m := range p.sent {
		if m.To == "ExponentPushToken[b]" && (m.Title != "Frigate antwortet nicht" || m.Body != "Sightline erreicht es gerade nicht (connection refused).") {
			t.Errorf("de down: %+v", m)
		}
		if m.To == "ExponentPushToken[a]" && (m.Title != "Frigate isn't responding" || m.Body != "connection refused") {
			t.Errorf("en down: %+v", m)
		}
	}
}

func TestCheckinLocalized(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	st = observeCheckin(c, st, cEv("a", cAt(2026, 10, 1, 21, 15)-20, "kitchen"), cAt(2026, 10, 1, 21, 15), chicago)
	byTime := map[string][2]string{
		"es":    {"Aún no hay actividad en casa de Mom hoy", "Son las 10:00. La última actividad en Kitchen fue ayer a las 21:15."},
		"fr":    {"Aucune activité chez Mom pour l’instant aujourd’hui", "Il est 10:00. Dernière activité sur Kitchen : hier à 21:15."},
		"de":    {"Heute noch keine Aktivität bei Mom", "Es ist 10:00 Uhr. Kitchen war zuletzt gestern um 21:15 aktiv."},
		"pt-BR": {"Ainda nenhuma atividade na casa de Mom hoje", "São 10:00. A última atividade em Kitchen foi ontem às 21:15."},
	}
	for l, w := range byTime {
		n, _ := dueCheckin(l, c, st, cAt(2026, 10, 2, 10, 0), false, chicago)
		if len(n) != 1 || n[0].Title != w[0] || n[0].Body != w[1] {
			t.Errorf("%s by-time: %+v", l, n)
		}
	}

	// Quiet spell of 1.5 hours (French singular below 2, decimal comma) and the summary.
	q := momCheckin()
	q.ByTime, q.SummaryTime, q.QuietLimitHours = "", "", 1.5
	qs := observeCheckin(q, checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}, cEv("a", cAt(2026, 10, 2, 8, 30)-20, "kitchen"), cAt(2026, 10, 2, 8, 30), chicago)
	quiet := map[string]string{
		"en":    "No activity at Mom’s for 1.5 hours",
		"es":    "Sin actividad en casa de Mom desde hace 1,5 horas",
		"fr":    "Aucune activité chez Mom depuis 1,5 heure",
		"de":    "Keine Aktivität bei Mom seit 1,5 Stunden",
		"pt-BR": "Nenhuma atividade na casa de Mom há 1,5 horas",
	}
	for l, w := range quiet {
		n, _ := dueCheckin(l, q, qs, cAt(2026, 10, 2, 10, 0), false, chicago)
		if len(n) != 1 || n[0].Title != w {
			t.Errorf("%s quiet: %+v", l, n)
		}
	}

	s := momCheckin()
	s.Who, s.ByTime, s.QuietLimitHours = "", "", 0
	ss := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	for i, id := range []string{"a", "b", "c"} {
		ss = observeCheckin(s, ss, cEv(id, cAt(2026, 10, 2, 7, 42+i), "kitchen"), cAt(2026, 10, 2, 9, 0), chicago)
	}
	n, _ := dueCheckin("de", s, ss, cAt(2026, 10, 2, 20, 0), false, chicago)
	if len(n) != 1 || n[0].Title != "Alles normal zu Hause" || n[0].Body != "Erste Aktivität um 07:42 · heute 3 Ereignisse." {
		t.Errorf("de summary: %+v", n)
	}
	n, _ = dueCheckin("en", s, ss, cAt(2026, 10, 2, 20, 0), false, chicago)
	if len(n) != 1 || n[0].Title != "All normal at home" || n[0].Body != "First activity 7:42 AM · 3 moments today." {
		t.Errorf("en summary: %+v", n)
	}
	// Nothing seen yet on either camera: "Kitchen or Hallway" in each language.
	none := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	if got := checkinLastText("es", momCheckin(), none, cAt(2026, 10, 2, 10, 0), chicago); got != "Sightline no ha visto a nadie en Kitchen o Hallway desde que empezó a vigilar." {
		t.Errorf("es not seen: %q", got)
	}
}

func TestWhenTextLocalized(t *testing.T) {
	now := cAt(2026, 10, 7, 12, 0)
	cases := map[string][3]string{
		"es":    {"hoy a las 09:05", "el lunes a las 00:00", "el 20 de septiembre a las 18:00"},
		"fr":    {"aujourd’hui à 09:05", "lundi à 00:00", "le 20 septembre à 18:00"},
		"de":    {"heute um 09:05", "am Montag um 00:00", "am 20. September um 18:00"},
		"pt-BR": {"hoje às 09:05", "segunda-feira às 00:00", "em 20 de setembro às 18:00"},
	}
	for l, w := range cases {
		got := [3]string{
			whenText(l, cAt(2026, 10, 7, 9, 5), now, chicago),
			whenText(l, cAt(2026, 10, 5, 0, 0), now, chicago),
			whenText(l, cAt(2026, 9, 20, 18, 0), now, chicago),
		}
		if got != w {
			t.Errorf("%s: %q", l, got)
		}
	}
}

func TestTestPushLocalized(t *testing.T) {
	p := &fakePusher{}
	_ = sendTestPush(t.Context(), p, device{PushToken: "x", Lang: "pt-BR"})
	_ = sendTestPush(t.Context(), p, device{PushToken: "y"})
	if p.sent[0].Title != "Os alertas instantâneos estão funcionando" || p.sent[1].Title != "Instant Alerts are working" {
		t.Errorf("sent %+v", p.sent)
	}
}

// `lang` is stored with the device; records saved before it existed load as English.
func TestDeviceLangStored(t *testing.T) {
	dir := t.TempDir()
	old := `{"old":{"id":"old","pushToken":"ExponentPushToken[o]","timezone":"UTC"}}`
	if err := os.WriteFile(filepath.Join(dir, "devices.json"), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if d, _ := s.get("old"); d.Lang != "" || normLang(d.Lang) != "en" {
		t.Errorf("old record lang = %q", d.Lang)
	}
	var d device
	if err := json.Unmarshal([]byte(`{"pushToken":"ExponentPushToken[n]","lang":"fr"}`), &d); err != nil || d.Lang != "fr" {
		t.Fatalf("decode: %v %q", err, d.Lang)
	}
	d.ID = "new"
	_ = s.put(d)
	s2, _ := openStore(dir)
	if got, _ := s2.get("new"); got.Lang != "fr" {
		t.Errorf("reloaded lang = %q", got.Lang)
	}
}
