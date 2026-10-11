package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Push text in the phone's language. The app sends `lang` with its device registration
// ("en", "es", "fr", "de", "pt-BR"); older apps send nothing and get English. English strings
// are exactly what the Hub always sent. Tone: plain, warm, short (es tú, fr vous, de du,
// pt-BR você), matching app/src/i18n.

// langs are the languages every message must have (the app's locales).
var langs = []string{"en", "es", "fr", "de", "pt-BR"}

// normLang folds a language tag to one of langs: "pt", "pt-PT", "pt_BR" → "pt-BR";
// "es-MX" → "es"; unknown or empty → "en".
func normLang(tag string) string {
	t := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(tag, "_", "-")))
	base, _, _ := strings.Cut(t, "-")
	switch base {
	case "es", "fr", "de":
		return base
	case "pt":
		return "pt-BR"
	}
	return "en"
}

// messages: key → language → fmt format string. Every key has every language, with the same
// sequence of % verbs (checked by TestMessagesComplete).
var messages = map[string]map[string]string{
	// ---- event alerts (engine.go buildMessage) ----
	"alert.title": {
		"en": "%s · %s", "es": "%s · %s", "fr": "%s · %s", "de": "%s · %s", "pt-BR": "%s · %s",
	},
	"alert.zones": {
		"en": "In %s", "es": "En %s", "fr": "Dans %s", "de": "In %s", "pt-BR": "Em %s",
	},
	"alert.doorbell": {
		"en":    "Someone's at the door · %s",
		"es":    "Hay alguien en la puerta · %s",
		"fr":    "Quelqu’un est à la porte · %s",
		"de":    "Jemand ist an der Tür · %s",
		"pt-BR": "Tem alguém na porta · %s",
	},
	"alert.package": {
		"en":    "Package delivered · %s",
		"es":    "Paquete entregado · %s",
		"fr":    "Colis livré · %s",
		"de":    "Paket zugestellt · %s",
		"pt-BR": "Encomenda entregue · %s",
	},
	// Joins recognized names or object labels: "Zach & Bob", "Persona y Coche".
	"list.and": {
		"en": "%s & %s", "es": "%s y %s", "fr": "%s et %s", "de": "%s & %s", "pt-BR": "%s e %s",
	},
	// "Kitchen, Hallway or Porch".
	"list.or": {
		"en": "%s or %s", "es": "%s o %s", "fr": "%s ou %s", "de": "%s oder %s", "pt-BR": "%s ou %s",
	},

	// ---- object labels (mirror app/src/i18n/*/common.ts objects) ----
	"obj.person":        {"en": "Person", "es": "Persona", "fr": "Personne", "de": "Person", "pt-BR": "Pessoa"},
	"obj.people":        {"en": "People", "es": "Personas", "fr": "Personnes", "de": "Personen", "pt-BR": "Pessoas"},
	"obj.car":           {"en": "Car", "es": "Coche", "fr": "Voiture", "de": "Auto", "pt-BR": "Carro"},
	"obj.vehicle":       {"en": "Vehicle", "es": "Vehículo", "fr": "Véhicule", "de": "Fahrzeug", "pt-BR": "Veículo"},
	"obj.truck":         {"en": "Truck", "es": "Camión", "fr": "Camion", "de": "Lkw", "pt-BR": "Caminhão"},
	"obj.bus":           {"en": "Bus", "es": "Autobús", "fr": "Bus", "de": "Bus", "pt-BR": "Ônibus"},
	"obj.motorcycle":    {"en": "Motorcycle", "es": "Moto", "fr": "Moto", "de": "Motorrad", "pt-BR": "Moto"},
	"obj.bicycle":       {"en": "Bicycle", "es": "Bicicleta", "fr": "Vélo", "de": "Fahrrad", "pt-BR": "Bicicleta"},
	"obj.package":       {"en": "Package", "es": "Paquete", "fr": "Colis", "de": "Paket", "pt-BR": "Encomenda"},
	"obj.animal":        {"en": "Animal", "es": "Animal", "fr": "Animal", "de": "Tier", "pt-BR": "Animal"},
	"obj.dog":           {"en": "Dog", "es": "Perro", "fr": "Chien", "de": "Hund", "pt-BR": "Cachorro"},
	"obj.cat":           {"en": "Cat", "es": "Gato", "fr": "Chat", "de": "Katze", "pt-BR": "Gato"},
	"obj.bird":          {"en": "Bird", "es": "Pájaro", "fr": "Oiseau", "de": "Vogel", "pt-BR": "Pássaro"},
	"obj.horse":         {"en": "Horse", "es": "Caballo", "fr": "Cheval", "de": "Pferd", "pt-BR": "Cavalo"},
	"obj.deer":          {"en": "Deer", "es": "Ciervo", "fr": "Cerf", "de": "Reh", "pt-BR": "Cervo"},
	"obj.bear":          {"en": "Bear", "es": "Oso", "fr": "Ours", "de": "Bär", "pt-BR": "Urso"},
	"obj.fox":           {"en": "Fox", "es": "Zorro", "fr": "Renard", "de": "Fuchs", "pt-BR": "Raposa"},
	"obj.raccoon":       {"en": "Raccoon", "es": "Mapache", "fr": "Raton laveur", "de": "Waschbär", "pt-BR": "Guaxinim"},
	"obj.squirrel":      {"en": "Squirrel", "es": "Ardilla", "fr": "Écureuil", "de": "Eichhörnchen", "pt-BR": "Esquilo"},
	"obj.rabbit":        {"en": "Rabbit", "es": "Conejo", "fr": "Lapin", "de": "Hase", "pt-BR": "Coelho"},
	"obj.face":          {"en": "Face", "es": "Cara", "fr": "Visage", "de": "Gesicht", "pt-BR": "Rosto"},
	"obj.license_plate": {"en": "License plate", "es": "Matrícula", "fr": "Plaque d’immatriculation", "de": "Kennzeichen", "pt-BR": "Placa"},
	"obj.doorbell":      {"en": "Doorbell", "es": "Timbre", "fr": "Sonnette", "de": "Türklingel", "pt-BR": "Campainha"},
	"obj.motion":        {"en": "Motion", "es": "Movimiento", "fr": "Mouvement", "de": "Bewegung", "pt-BR": "Movimento"},

	// ---- health (health.go) ----
	"health.down.title": {
		"en":    "%s isn't responding",
		"es":    "%s no responde",
		"fr":    "%s ne répond pas",
		"de":    "%s antwortet nicht",
		"pt-BR": "%s não está respondendo",
	},
	// The argument is the technical error (English, from the recorder or network).
	"health.down.body": {
		"en":    "%s",
		"es":    "Sightline no logra conectarse (%s).",
		"fr":    "Sightline n’arrive pas à le joindre (%s).",
		"de":    "Sightline erreicht es gerade nicht (%s).",
		"pt-BR": "O Sightline não consegue se conectar (%s).",
	},
	"health.offline.title": {
		"en":    "%s is offline",
		"es":    "%s está desconectada",
		"fr":    "%s est hors ligne",
		"de":    "%s ist offline",
		"pt-BR": "%s está offline",
	},
	"health.offline.body": {
		"en":    "No video from this camera.",
		"es":    "Esta cámara no envía vídeo.",
		"fr":    "Aucune vidéo de cette caméra.",
		"de":    "Diese Kamera sendet kein Video.",
		"pt-BR": "Esta câmera não está enviando vídeo.",
	},
	"health.disk.title": {
		"en":    "%s has stopped working",
		"es":    "%s ha dejado de funcionar",
		"fr":    "%s ne fonctionne plus",
		"de":    "%s funktioniert nicht mehr",
		"pt-BR": "%s parou de funcionar",
	},
	"health.disk.body": {
		"en":    "The recorder can't save video to this disk (%s). Check it in the recorder's storage settings.",
		"es":    "El grabador no puede guardar vídeo en este disco (%s). Revísalo en los ajustes de almacenamiento del grabador.",
		"fr":    "L’enregistreur ne peut plus enregistrer de vidéo sur ce disque (%s). Vérifiez-le dans les réglages de stockage de l’enregistreur.",
		"de":    "Der Rekorder kann auf dieser Festplatte kein Video speichern (%s). Sieh in den Speichereinstellungen des Rekorders nach.",
		"pt-BR": "O gravador não consegue salvar vídeo neste disco (%s). Confira nas configurações de armazenamento do gravador.",
	},
	"health.storage.title": {
		"en":    "Recorder storage is %d%% full",
		"es":    "El almacenamiento del grabador está al %d%%",
		"fr":    "Le stockage de l’enregistreur est plein à %d %%",
		"de":    "Der Speicher des Rekorders ist zu %d %% voll",
		"pt-BR": "O armazenamento do gravador está %d%% cheio",
	},
	// First argument: free space, already formatted for the language ("12.5" / "12,5").
	"health.storage.body": {
		"en":    "%s GB free on %s.",
		"es":    "Quedan %s GB libres en %s.",
		"fr":    "%s Go libres sur %s.",
		"de":    "Noch %s GB frei auf %s.",
		"pt-BR": "%s GB livres em %s.",
	},

	// ---- end-to-end sealed pushes (seal.go) ----
	// The only text Apple, Google and Expo see for phones that decrypt alerts themselves. The
	// phone replaces it with the real title ("Person · Front Door") before showing it; these
	// only appear if that fails, so they must say nothing about cameras, people or places.
	"sealed.activity": {
		"en":    "Activity on your cameras",
		"es":    "Actividad en tus cámaras",
		"fr":    "Activité sur vos caméras",
		"de":    "Aktivität bei deinen Kameras",
		"pt-BR": "Atividade nas suas câmeras",
	},
	"sealed.doorbell": {
		"en": "Doorbell", "es": "Timbre", "fr": "Sonnette", "de": "Türklingel", "pt-BR": "Campainha",
	},
	"sealed.checkin": {
		"en":    "Family check-in update",
		"es":    "Novedades de un aviso familiar",
		"fr":    "Nouvelles de la veille familiale",
		"de":    "Neues von einem Familien-Check-in",
		"pt-BR": "Novidades do acompanhamento da família",
	},
	"sealed.hub": {
		"en":    "Your Sightline Hub needs a look",
		"es":    "Tu Sightline Hub necesita un vistazo",
		"fr":    "Votre Sightline Hub a besoin d’un coup d’œil",
		"de":    "Dein Sightline Hub braucht einen Blick",
		"pt-BR": "Seu Sightline Hub precisa de atenção",
	},
	"sealed.body": {
		"en":    "Open Sightline to see more.",
		"es":    "Abre Sightline para ver más.",
		"fr":    "Ouvrez Sightline pour en savoir plus.",
		"de":    "Öffne Sightline, um mehr zu sehen.",
		"pt-BR": "Abra o Sightline para ver mais.",
	},

	// ---- test push (main.go sendTestPush) ----
	"test.title": {
		"en":    "Instant Alerts are working",
		"es":    "Las Alertas instantáneas funcionan",
		"fr":    "Les Alertes instantanées fonctionnent",
		"de":    "Sofort-Meldungen funktionieren",
		"pt-BR": "Os alertas instantâneos estão funcionando",
	},
	"test.body": {
		"en":    "You'll get notifications here the moment a camera sees something.",
		"es":    "Recibirás alertas aquí en cuanto una cámara vea algo.",
		"fr":    "Vous serez prévenu ici dès qu’une caméra verra quelque chose.",
		"de":    "Du bekommst hier sofort Bescheid, wenn eine Kamera etwas sieht.",
		"pt-BR": "Você vai receber alertas aqui assim que uma câmera vir algo.",
	},

	// ---- family check-ins (checkins.go) ----
	// Where: "at Mom’s" / "en casa de Mamá" / "chez Maman" / "bei Mama" / "na casa de Mãe".
	// English gets the possessive already made ("Mom’s", "James’").
	"checkin.at.who": {
		"en": "at %s", "es": "en casa de %s", "fr": "chez %s", "de": "bei %s", "pt-BR": "na casa de %s",
	},
	"checkin.at.place": {
		"en": "at %s", "es": "en %s", "fr": "à %s", "de": "in %s", "pt-BR": "em %s",
	},
	"checkin.at.home": {
		"en": "at home", "es": "en casa", "fr": "à la maison", "de": "zu Hause", "pt-BR": "em casa",
	},
	"checkin.byTime.title": {
		"en":    "No activity %s yet today",
		"es":    "Aún no hay actividad %s hoy",
		"fr":    "Aucune activité %s pour l’instant aujourd’hui",
		"de":    "Heute noch keine Aktivität %s",
		"pt-BR": "Ainda nenhuma atividade %s hoje",
	},
	"checkin.byTime.body": {
		"en":    "It’s %s. %s",
		"es":    "Son las %s. %s",
		"fr":    "Il est %s. %s",
		"de":    "Es ist %s Uhr. %s",
		"pt-BR": "São %s. %s",
	},
	// Second argument: "6 hours" (checkin.hours.*).
	"checkin.quiet.title": {
		"en":    "No activity %s for %s",
		"es":    "Sin actividad %s desde hace %s",
		"fr":    "Aucune activité %s depuis %s",
		"de":    "Keine Aktivität %s seit %s",
		"pt-BR": "Nenhuma atividade %s há %s",
	},
	"checkin.hours.one": {
		"en": "%s hour", "es": "%s hora", "fr": "%s heure", "de": "%s Stunde", "pt-BR": "%s hora",
	},
	"checkin.hours.other": {
		"en": "%s hours", "es": "%s horas", "fr": "%s heures", "de": "%s Stunden", "pt-BR": "%s horas",
	},
	"checkin.normal.title": {
		"en":    "All normal %s",
		"es":    "Todo normal %s",
		"fr":    "Tout est normal %s",
		"de":    "Alles normal %s",
		"pt-BR": "Tudo normal %s",
	},
	// "First activity 7:42 AM · 3 moments today."
	"checkin.normal.body": {
		"en":    "First activity %s · %s today.",
		"es":    "Primera actividad a las %s · %s hoy.",
		"fr":    "Première activité à %s · %s aujourd’hui.",
		"de":    "Erste Aktivität um %s · heute %s.",
		"pt-BR": "Primeira atividade às %s · %s hoje.",
	},
	"checkin.moments.one": {
		"en": "%d moment", "es": "%d momento", "fr": "%d moment", "de": "%d Ereignis", "pt-BR": "%d momento",
	},
	"checkin.moments.other": {
		"en": "%d moments", "es": "%d momentos", "fr": "%d moments", "de": "%d Ereignisse", "pt-BR": "%d momentos",
	},
	"checkin.none.title": {
		"en":    "No activity %s today",
		"es":    "Sin actividad %s hoy",
		"fr":    "Aucune activité %s aujourd’hui",
		"de":    "Heute keine Aktivität %s",
		"pt-BR": "Nenhuma atividade %s hoje",
	},
	// "Kitchen was last active yesterday at 9:15 PM."
	"checkin.lastActive": {
		"en":    "%s was last active %s.",
		"es":    "La última actividad en %s fue %s.",
		"fr":    "Dernière activité sur %s : %s.",
		"de":    "%s war zuletzt %s aktiv.",
		"pt-BR": "A última atividade em %s foi %s.",
	},
	"checkin.notSeen": {
		"en":    "Sightline hasn’t seen anyone on %s since it started watching.",
		"es":    "Sightline no ha visto a nadie en %s desde que empezó a vigilar.",
		"fr":    "Sightline n’a vu personne sur %s depuis le début de la surveillance.",
		"de":    "Sightline hat seit Beginn der Überwachung niemanden auf %s gesehen.",
		"pt-BR": "O Sightline não viu ninguém em %s desde que começou a monitorar.",
	},
	"checkin.notSeenAny": {
		"en":    "Sightline hasn’t seen anyone on the cameras since it started watching.",
		"es":    "Sightline no ha visto a nadie en las cámaras desde que empezó a vigilar.",
		"fr":    "Sightline n’a vu personne sur les caméras depuis le début de la surveillance.",
		"de":    "Sightline hat seit Beginn der Überwachung niemanden auf den Kameras gesehen.",
		"pt-BR": "O Sightline não viu ninguém nas câmeras desde que começou a monitorar.",
	},
	// Appended to a "no activity" body (keep the leading space).
	"checkin.verifyFailed": {
		"en":    " Sightline couldn’t reach the recorder to double-check.",
		"es":    " Sightline no pudo contactar con el grabador para comprobarlo.",
		"fr":    " Sightline n’a pas pu joindre l’enregistreur pour vérifier.",
		"de":    " Sightline konnte den Rekorder nicht erreichen, um nachzusehen.",
		"pt-BR": " O Sightline não conseguiu falar com o gravador para confirmar.",
	},

	// ---- when (clock.go whenText); the last argument is the time ----
	"when.today": {
		"en": "today at %s", "es": "hoy a las %s", "fr": "aujourd’hui à %s", "de": "heute um %s", "pt-BR": "hoje às %s",
	},
	"when.yesterday": {
		"en": "yesterday at %s", "es": "ayer a las %s", "fr": "hier à %s", "de": "gestern um %s", "pt-BR": "ontem às %s",
	},
	// First argument: the weekday name (weekdayNames).
	"when.weekday": {
		"en": "on %s at %s", "es": "el %s a las %s", "fr": "%s à %s", "de": "am %s um %s", "pt-BR": "%s às %s",
	},
	// First argument: the date (dateText): "Oct 3", "3 de octubre", "3 octobre", "3. Oktober".
	"when.date": {
		"en": "on %s at %s", "es": "el %s a las %s", "fr": "le %s à %s", "de": "am %s um %s", "pt-BR": "em %s às %s",
	},
}

var weekdayNames = map[string][7]string{
	"es":    {"domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"},
	"fr":    {"dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"},
	"de":    {"Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"},
	"pt-BR": {"domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"},
}

var monthNames = map[string][12]string{
	"es":    {"enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"},
	"fr":    {"janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"},
	"de":    {"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"},
	"pt-BR": {"janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"},
}

// tr formats message key in lang, falling back to English for an unknown language or a
// language missing the key, and to the key itself for an unknown key.
func tr(lang, key string, args ...any) string {
	m, ok := messages[key]
	if !ok {
		return key
	}
	f, ok := m[normLang(lang)]
	if !ok {
		f = m["en"]
	}
	if len(args) == 0 {
		return strings.ReplaceAll(f, "%%", "%")
	}
	return fmt.Sprintf(f, args...)
}

// isOne picks the singular form: n == 1, or 0 ≤ n < 2 in French.
func isOne(lang string, n float64) bool {
	if normLang(lang) == "fr" {
		return n >= 0 && n < 2
	}
	return n == 1
}

// trCount uses key+".one" or key+".other".
func trCount(lang, key string, n float64, arg any) string {
	if isOne(lang, n) {
		return tr(lang, key+".one", arg)
	}
	return tr(lang, key+".other", arg)
}

// decimalText formats v with prec decimals ("-1" = shortest), with a decimal comma outside English.
func decimalText(lang string, v float64, prec int) string {
	format := byte('f')
	if prec < 0 {
		format = 'g'
	}
	s := strconv.FormatFloat(v, format, prec, 64)
	if normLang(lang) != "en" {
		s = strings.Replace(s, ".", ",", 1)
	}
	return s
}

// clockTextIn is "9:15 PM" in English, "21:15" elsewhere.
func clockTextIn(lang string, h, m int) string {
	if normLang(lang) == "en" {
		return clockText(h, m)
	}
	return fmt.Sprintf("%02d:%02d", h, m)
}

// dateText is "Oct 3" / "3 de octubre" / "3 octobre" / "3. Oktober" / "3 de outubro".
func dateText(lang string, t time.Time) string {
	l := normLang(lang)
	switch l {
	case "en":
		return fmt.Sprintf("%s %d", t.Month().String()[:3], t.Day())
	case "fr":
		return fmt.Sprintf("%d %s", t.Day(), monthNames[l][t.Month()-1])
	case "de":
		return fmt.Sprintf("%d. %s", t.Day(), monthNames[l][t.Month()-1])
	}
	return fmt.Sprintf("%d de %s", t.Day(), monthNames[l][t.Month()-1])
}

func weekdayText(lang string, d time.Weekday) string {
	if names, ok := weekdayNames[normLang(lang)]; ok {
		return names[d]
	}
	return d.String()
}

// objectLabel is a detected object's name for people: "Person", "Persona", "License plate".
// Labels the table doesn't know read as in English ("garbage_can" → "Garbage can").
func objectLabel(lang, o string) string {
	if _, ok := messages["obj."+o]; ok {
		return tr(lang, "obj."+o)
	}
	if o == "" {
		return o
	}
	return strings.ToUpper(o[:1]) + strings.ReplaceAll(o[1:], "_", " ")
}

// joinAnd is "A & B & C" (English), "A y B y C" (Spanish), ...
func joinAnd(lang string, items []string) string {
	out := ""
	for i, s := range items {
		if i == 0 {
			out = s
			continue
		}
		out = tr(lang, "list.and", out, s)
	}
	return out
}

// joinOr is "A, B or C".
func joinOr(lang string, items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return tr(lang, "list.or", strings.Join(items[:len(items)-1], ", "), items[len(items)-1])
}
