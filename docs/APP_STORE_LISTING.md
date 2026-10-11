# App Store listing

Everything to paste into App Store Connect for Sightline, in English, Spanish, French, German
and Portuguese (Brazil), plus the answers to Apple's questionnaires and the reasoning behind
them. Researched October 2026; Apple changes these forms often, so re-check anything marked
"verify".

Every length-limited field is in a block like the one below, followed by its count. Check them
all (and rewrite the counts after an edit) with:

```powershell
node scripts/check-listing.mjs          # fails if any field is too long or a count is stale
node scripts/check-listing.mjs --fix    # rewrites the "↳" count lines
```

Limits ([App Store Connect: platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information),
[App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)):
name 30 characters, subtitle 30, promotional text 170, description 4,000, What's New 4,000,
keywords **100 bytes** (not characters: an accented letter like "é" or "ü" takes 2 bytes).

Contents:

1. [Name](#1-name)
2. [Categories](#2-categories)
3. [URLs](#3-urls)
4. [English (U.S.)](#4-english-us)
5. [Spanish](#5-spanish-mexico-and-spain)
6. [French](#6-french-france-and-canada)
7. [German](#7-german)
8. [Portuguese (Brazil)](#8-portuguese-brazil)
9. [Keywords and brand names](#9-keywords-and-brand-names)
10. [Age rating](#10-age-rating)
11. [App Privacy ("nutrition label")](#11-app-privacy-nutrition-label)
12. [Export compliance (encryption)](#12-export-compliance-encryption)
13. [App Review information](#13-app-review-information)
14. [Screenshots](#14-screenshots)
15. [Decisions for you](#15-decisions-for-you)

---

## 1. Name

App names on the App Store are unique, and an app name is reserved as soon as any developer
creates an app record with it, even if the app never ships. A search in October 2026 found
*Sight Line for Roadworks*, *Sightline Float* and *ICF Sightline Mobile App* live, but no app
called just "Sightline"; it may still be reserved. "Sightline" is also used by several
companies (payments, research, IT monitoring), so a descriptive suffix helps both search and
distinctness.

**Recommendation:** `Sightline: Home Cameras` (23). It keeps the brand, adds the two words
people search for, and reads naturally. The name on the Home Screen stays "Sightline"
(`expo.name` in `app.json`), which is independent of the App Store name.

Fallbacks if it's taken (try them in App Store Connect → My Apps → + → New App, in this order):

| Name | Characters |
| --- | --- |
| Sightline: Home Cameras | 23 |
| Sightline Camera Viewer | 23 |
| Sightline – Security Cameras | 28 |
| Sightline: Private Cameras | 26 |
| Sightline Cam | 13 |

Each language gets its own name (below); the "Sightline" part stays the same everywhere.

## 2. Categories

- **Primary: Utilities.** Apple has no Security or Smart Home category. Viewer and NVR apps for
  self-hosted cameras overwhelmingly sit in Utilities, which is where people browse for tools
  that work with hardware they own, and it matches what the app is: a tool, not content.
- **Secondary: Lifestyle.** Home and family features (doorbell, family check-ins, Home & Away)
  and where many consumer home-security apps are filed, so it widens discovery to people who
  don't think of themselves as "technical". Productivity was considered and rejected: it's
  about documents and work, and Sightline would be out of place there.

Content rights: "Does your app contain, show, or access third-party content?" → **No.** The
app shows the user's own camera video; the demo footage is original (drawn from shapes, see
`docs/APP_REVIEW.md`).

## 3. URLs

Publish `site/` first (see `site/README.md`). With the recommended separate public repo:

| Field | URL |
| --- | --- |
| Privacy Policy URL (required) | `https://zaadams095.github.io/sightline-site/privacy.html` |
| Support URL (required) | `https://zaadams095.github.io/sightline-site/support.html` |
| Marketing URL (optional) | `https://zaadams095.github.io/sightline-site/` |

Guideline 5.1.1(i) also requires a link to the privacy policy **inside the app**, "in an easily
accessible manner". The app doesn't have one yet; add a "Privacy policy" row (for example in
Settings → Privacy) that opens the URL above.

---

## 4. English (U.S.)

### Name

```text name en 30
Sightline: Home Cameras
```
↳ 23 / 30 characters

### Subtitle

Indexed for search, so it carries the words people type ("NVR", "CCTV") that aren't in the name.

```text subtitle en 30
Private viewer for NVR & CCTV
```
↳ 29 / 30 characters

### Promotional text

Can be changed any time without a new build. No brand names here (see section 9).

```text promo en 170
All the cameras you already own, in one private app. Watch live, find any moment and get alerts that learn what matters. No account. No cloud. Your video stays yours.
```
↳ 166 / 170 characters

### Description

```text description en 4000
Your cameras. Your network. Sightline is one simple, private app for the security cameras and recorders you already own, whatever the brand. Watch live, find any moment and get alerts, straight from your own system. No account. No cloud. Your video goes from your cameras to your phone.

WORKS WITH WHAT YOU HAVE
Frigate, Reolink, Hikvision, Annke, Dahua, Amcrest, Lorex, Swann, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder and Scrypted, plus TP-Link Tapo, Wyze, eufy, EZVIZ, Imou and any ONVIF or RTSP camera. Sightline finds cameras on your Wi-Fi and walks you through your brand step by step. No technical setup.

WATCH LIVE
• All your cameras on one screen, from every brand
• Full screen with zoom; move pan-tilt-zoom cameras and jump to presets
• Talk through doorbells and cameras that support it, and switch on lights or sirens
• When the doorbell rings, live video fills the screen, on iPhone and Apple Watch

FIND ANY MOMENT
• Recordings and events on a simple timeline
• Ask in plain words, like "When did the package arrive?" Answered on your iPhone
• Follow a person or car from camera to camera
• Watch a whole day as a time-lapse in seconds
• Save moments, share clips, or export a signed evidence package for police or insurance

ALERTS THAT LEARN
• Choose the cameras and what matters: people, cars, packages, animals, the doorbell
• Draw alert zones right on the live picture
• Tap "Not important" and Sightline quiets similar alerts. It also ignores rain, wind and headlights
• Home & Away: fewer alerts while you're home
• Family check-ins: know that a loved one's day has started
• Find out when a camera goes offline

FAMILIAR FACES & VEHICLES (OPTIONAL)
Name family members and your car so alerts say who's there. Recognition happens only on your iPhone, and you can delete it any time.

PRIVATE BY DESIGN
• No sign-up, no ads, no analytics, no tracking
• Camera passwords stay in your iPhone's Keychain. Settings back up to your own iCloud
• Lock the app with Face ID
• Away from home, built-in WireGuard connects only to your own cameras
• Share a clip with neighbors with faces and license plates blurred automatically

SIGHTLINE HUB (OPTIONAL, FREE)
Add the free Sightline Hub, an add-on for Home Assistant or a small app for a NAS or always-on computer, for alerts within a second, viewing from anywhere without changing your router, and sharing with family with access you can limit or take back. It runs in your home, on your hardware.

EVERYWHERE YOU ARE
iPhone, iPad with a wall display mode, Apple Watch, Apple TV, Live Activities, widgets and Siri. In English, Spanish, French, German and Portuguese, with large text throughout.

No cameras handy? Tap "Try it with sample cameras" to explore every feature.

Some features need a Sightline Hub or a camera that supports them. Cameras that only stream through their maker's cloud can't be shown. Product names are trademarks of their owners; Sightline is not affiliated with or endorsed by any camera maker.
```
↳ 3001 / 4000 characters

### Keywords

No camera brands here (section 9). No words from the name or subtitle (they're indexed already).

```text keywords en 100b
security,surveillance,rtsp,onvif,dvr,doorbell,ptz,recorder,monitor,motion,alert,poe,webcam,nanny
```
↳ 96 / 100 bytes

### What's New

For the first App Store release this field is optional (Apple hides it on version 1.0); keep
the text for 1.0.1. For TestFlight builds (0.2.0) paste the second block into **What to Test**.

```text whatsnew-1.0 en 4000
Welcome to Sightline: one private app for the cameras you already own.
• Every major brand, found on your Wi-Fi and set up step by step
• Live view, recordings, search and alerts that learn
• Optional Sightline Hub for instant alerts, remote viewing and sharing
• Now in Spanish, French, German and Portuguese, with large text everywhere
```
↳ 337 / 4000 characters

```text whatsnew-0.2 en 4000
Sightline now speaks Spanish, French, German and Portuguese, and supports large text everywhere. Please try: the brand guides when adding a camera, alerts on your real cameras, and Settings → Help → Report a problem if anything looks wrong. No cameras? Tap "Try it with sample cameras".
```
↳ 286 / 4000 characters

### Screenshot captions (English)

See section 14 for the screens. Kept to about 30 characters so they read at thumbnail size.

```text caption-1 en 40
All your cameras. One private app.
```
↳ 34 / 40 characters

```text caption-2 en 40
Zoom, move and talk back
```
↳ 24 / 40 characters

```text caption-3 en 40
Find any moment in seconds
```
↳ 26 / 40 characters

```text caption-4 en 40
Just ask: “Did a package come?”
```
↳ 31 / 40 characters

```text caption-5 en 40
Alerts that learn what matters
```
↳ 30 / 40 characters

```text caption-6 en 40
Never miss the doorbell
```
↳ 23 / 40 characters

```text caption-7 en 40
Every camera on your map
```
↳ 24 / 40 characters

```text caption-8 en 40
Works with the cameras you own
```
↳ 30 / 40 characters

```text caption-9 en 40
No account. No cloud.
```
↳ 21 / 40 characters

```text caption-10 en 40
Quieter alerts when you're home
```
↳ 31 / 40 characters

---

## 5. Spanish (Mexico and Spain)

Fill in **Spanish (Mexico)**: in the U.S. storefront Apple also indexes Spanish (Mexico)
keywords, so this localization doubles as extra U.S. keywords. Copy the same text into
**Spanish (Spain)** (Spain-specific wording is close enough; "timbre" and "grabador" are
understood in both).

```text name es 30
Sightline: Cámaras de casa
```
↳ 26 / 30 characters

```text subtitle es 30
Videovigilancia privada y NVR
```
↳ 29 / 30 characters

```text promo es 170
Todas tus cámaras en una sola app privada. Mira en vivo, encuentra cualquier momento y recibe alertas que aprenden. Sin cuenta. Sin nube. Tu video es solo tuyo.
```
↳ 160 / 170 characters

```text description es 4000
Tus cámaras. Tu red. Sightline es una app sencilla y privada para las cámaras de seguridad y grabadores que ya tienes, sea cual sea la marca. Mira en vivo, encuentra cualquier momento y recibe alertas directamente desde tu propio sistema. Sin cuenta. Sin nube. El video va de tus cámaras a tu teléfono.

FUNCIONA CON LO QUE YA TIENES
Frigate, Reolink, Hikvision, Annke, Dahua, Amcrest, Lorex, Swann, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder y Scrypted, además de TP-Link Tapo, Wyze, eufy, EZVIZ, Imou y cualquier cámara ONVIF o RTSP. Sightline encuentra las cámaras en tu Wi-Fi y te guía paso a paso según tu marca. Sin configuraciones técnicas.

EN VIVO
• Todas tus cámaras en una pantalla, de cualquier marca
• Pantalla completa con zoom; mueve cámaras PTZ y usa posiciones guardadas
• Habla por el timbre o la cámara si lo permite, y enciende luces o sirenas
• Cuando suena el timbre, el video en vivo llena la pantalla, en el iPhone y el Apple Watch

ENCUENTRA CUALQUIER MOMENTO
• Grabaciones y eventos en una línea de tiempo sencilla
• Pregunta con tus palabras: "¿A qué hora llegó el paquete?" Se responde en tu iPhone
• Sigue a una persona o un auto de cámara en cámara
• Mira un día entero en segundos con el time-lapse
• Guarda momentos, comparte clips o exporta un paquete de pruebas firmado para la policía o el seguro

ALERTAS QUE APRENDEN
• Elige las cámaras y lo que importa: personas, autos, paquetes, animales, el timbre
• Dibuja zonas de alerta sobre la imagen en vivo
• Toca "No es importante" y Sightline silencia alertas parecidas. También ignora la lluvia, el viento y los faros
• En casa y fuera: menos alertas mientras estás en casa
• Avisos familiares: entérate de que el día de un ser querido ya empezó
• Entérate cuando una cámara se desconecta

ROSTROS Y VEHÍCULOS CONOCIDOS (OPCIONAL)
Ponle nombre a tu familia y a tu auto para que las alertas digan quién está ahí. El reconocimiento ocurre solo en tu iPhone y puedes borrarlo cuando quieras.

PRIVADA DESDE EL DISEÑO
• Sin registro, sin anuncios, sin analíticas, sin rastreo
• Las contraseñas de las cámaras se quedan en el Llavero de tu iPhone. Los ajustes se respaldan en tu propio iCloud
• Bloquea la app con Face ID
• Fuera de casa, WireGuard integrado se conecta solo a tus propias cámaras
• Comparte un clip con los vecinos con rostros y placas difuminados automáticamente

SIGHTLINE HUB (OPCIONAL Y GRATIS)
Agrega el Sightline Hub gratuito, un complemento para Home Assistant o una pequeña app para un NAS o una computadora siempre encendida, y obtén alertas en un segundo, acceso desde cualquier lugar sin tocar tu router y la opción de compartir con tu familia con permisos que puedes limitar o retirar. Funciona en tu casa, en tu propio equipo.

DONDE ESTÉS
iPhone, iPad con modo de pantalla de pared, Apple Watch, Apple TV, Actividades en vivo, widgets y Siri. En español, inglés, francés, alemán y portugués, con texto grande en toda la app.

¿No tienes cámaras a mano? Toca "Probar con cámaras de ejemplo" para explorar todas las funciones.

Algunas funciones necesitan un Sightline Hub o una cámara compatible. Las cámaras que solo transmiten a través de la nube de su fabricante no se pueden mostrar. Los nombres de productos son marcas de sus respectivos dueños; Sightline no está afiliada ni respaldada por ningún fabricante de cámaras.
```
↳ 3348 / 4000 characters

```text keywords es 100b
seguridad,cctv,rtsp,onvif,dvr,timbre,ptz,grabador,monitor,movimiento,alertas,vigilancia,ip-cam
```
↳ 94 / 100 bytes

```text whatsnew-1.0 es 4000
Te damos la bienvenida a Sightline: una app privada para las cámaras que ya tienes.
• Todas las marcas principales, encontradas en tu Wi-Fi y configuradas paso a paso
• En vivo, grabaciones, búsqueda y alertas que aprenden
• Sightline Hub opcional para alertas al instante, acceso remoto y compartir
• Ahora en español, francés, alemán y portugués, con texto grande en toda la app
```
↳ 380 / 4000 characters

Captions (Spanish):

```text caption-1 es 40
Todas tus cámaras. Una app privada.
```
↳ 35 / 40 characters

```text caption-2 es 40
Acerca, mueve y habla
```
↳ 21 / 40 characters

```text caption-3 es 40
Encuentra cualquier momento
```
↳ 27 / 40 characters

```text caption-4 es 40
Pregunta: “¿Llegó un paquete?”
```
↳ 30 / 40 characters

```text caption-5 es 40
Alertas que aprenden
```
↳ 20 / 40 characters

```text caption-6 es 40
Nunca te pierdas el timbre
```
↳ 26 / 40 characters

```text caption-7 es 40
Todas las cámaras en tu plano
```
↳ 29 / 40 characters

```text caption-8 es 40
Funciona con tus cámaras
```
↳ 24 / 40 characters

```text caption-9 es 40
Sin cuenta. Sin nube.
```
↳ 21 / 40 characters

```text caption-10 es 40
Menos alertas cuando estás en casa
```
↳ 34 / 40 characters

> The descriptions quote two in-app buttons ("Try it with sample cameras", "Not important").
> Each language uses the exact label from `app/src/i18n/<lang>/onboarding.ts` and `alerts.ts`
> as of October 2026; if those strings change, update the descriptions too.

---

## 6. French (France and Canada)

Fill in **French (France)**; copy to **French (Canada)** if you add it (Canada indexes both
English and French).

```text name fr 30
Sightline : caméras maison
```
↳ 26 / 30 characters

```text subtitle fr 30
Visionneuse privée NVR et IP
```
↳ 28 / 30 characters

```text promo fr 170
Toutes vos caméras dans une seule app privée. Regardez en direct, retrouvez chaque instant et recevez des alertes qui apprennent. Sans compte. Sans cloud.
```
↳ 154 / 170 characters

```text description fr 4000
Vos caméras. Votre réseau. Sightline est une app simple et privée pour les caméras de sécurité et enregistreurs que vous avez déjà, quelle que soit la marque. Regardez en direct, retrouvez chaque instant et recevez des alertes, directement depuis votre propre système. Sans compte. Sans cloud. La vidéo va de vos caméras à votre téléphone.

COMPATIBLE AVEC CE QUE VOUS AVEZ
Frigate, Reolink, Hikvision, Annke, Dahua, Amcrest, Lorex, Swann, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder et Scrypted, ainsi que TP-Link Tapo, Wyze, eufy, EZVIZ, Imou et toute caméra ONVIF ou RTSP. Sightline trouve les caméras sur votre Wi-Fi et vous guide pas à pas selon votre marque. Aucune configuration technique.

EN DIRECT
• Toutes vos caméras sur un seul écran, toutes marques confondues
• Plein écran avec zoom ; orientez les caméras motorisées et utilisez les positions enregistrées
• Parlez par la sonnette ou la caméra quand elle le permet, allumez lumières ou sirène
• Quand on sonne, la vidéo en direct s'affiche en plein écran, sur l'iPhone et l'Apple Watch

RETROUVEZ CHAQUE INSTANT
• Enregistrements et événements sur une frise simple
• Posez votre question avec vos mots : « Quand le colis est-il arrivé ? » La réponse est calculée sur votre iPhone
• Suivez une personne ou une voiture d'une caméra à l'autre
• Revoyez une journée entière en accéléré en quelques secondes
• Gardez des moments, partagez des extraits ou exportez un dossier de preuves signé pour la police ou l'assurance

DES ALERTES QUI APPRENNENT
• Choisissez les caméras et ce qui compte : personnes, voitures, colis, animaux, la sonnette
• Dessinez des zones d'alerte directement sur l'image en direct
• Touchez « Pas important » et Sightline calme les alertes semblables. La pluie, le vent et les phares sont aussi ignorés
• Maison et absence : moins d'alertes quand vous êtes chez vous
• Nouvelles de la famille : sachez que la journée d'un proche a bien commencé
• Soyez prévenu quand une caméra se déconnecte

VISAGES ET VÉHICULES CONNUS (FACULTATIF)
Donnez un nom aux membres de la famille et à votre voiture pour que les alertes disent qui est là. La reconnaissance se fait uniquement sur votre iPhone, et vous pouvez tout effacer à tout moment.

PRIVÉE PAR CONCEPTION
• Pas d'inscription, pas de publicité, pas de statistiques, pas de pistage
• Les mots de passe des caméras restent dans le trousseau de votre iPhone. Les réglages sont sauvegardés dans votre propre iCloud
• Verrouillez l'app avec Face ID
• Hors de chez vous, WireGuard intégré se connecte uniquement à vos propres caméras
• Partagez un extrait avec vos voisins, visages et plaques floutés automatiquement

SIGHTLINE HUB (FACULTATIF ET GRATUIT)
Ajoutez le Sightline Hub gratuit, un module pour Home Assistant ou une petite app pour un NAS ou un ordinateur toujours allumé : alertes en une seconde, accès de partout sans toucher à votre box, et partage avec la famille avec des accès que vous pouvez limiter ou retirer. Il fonctionne chez vous, sur votre matériel.

PARTOUT OÙ VOUS ÊTES
iPhone, iPad avec un mode écran mural, Apple Watch, Apple TV, Activités en direct, widgets et Siri. En français, anglais, espagnol, allemand et portugais, avec du texte agrandi partout.

Pas de caméra sous la main ? Touchez « Essayer avec des caméras de démo » pour découvrir toutes les fonctions.

Certaines fonctions nécessitent un Sightline Hub ou une caméra compatible. Les caméras qui ne diffusent que par le cloud de leur fabricant ne peuvent pas être affichées. Les noms de produits sont des marques de leurs propriétaires ; Sightline n'est affiliée à aucun fabricant de caméras ni approuvée par eux.
```
↳ 3645 / 4000 characters

```text keywords fr 100b
sécurité,vidéosurveillance,cctv,rtsp,onvif,dvr,sonnette,ptz,enregistreur,alerte,mouvement,alarme
```
↳ 99 / 100 bytes

```text whatsnew-1.0 fr 4000
Bienvenue dans Sightline : une app privée pour les caméras que vous avez déjà.
• Toutes les grandes marques, trouvées sur votre Wi-Fi et configurées pas à pas
• Direct, enregistrements, recherche et alertes qui apprennent
• Sightline Hub facultatif pour les alertes instantanées, l'accès à distance et le partage
• Désormais en espagnol, français, allemand et portugais, avec du texte agrandi partout
```
↳ 400 / 4000 characters

Captions (French):

```text caption-1 fr 40
Toutes vos caméras. Une app privée.
```
↳ 35 / 40 characters

```text caption-2 fr 40
Zoomez, orientez, parlez
```
↳ 24 / 40 characters

```text caption-3 fr 40
Retrouvez chaque instant
```
↳ 24 / 40 characters

```text caption-4 fr 40
Demandez : « Un colis est arrivé ? »
```
↳ 36 / 40 characters

```text caption-5 fr 40
Des alertes qui apprennent
```
↳ 26 / 40 characters

```text caption-6 fr 40
Ne ratez plus la sonnette
```
↳ 25 / 40 characters

```text caption-7 fr 40
Toutes vos caméras sur un plan
```
↳ 30 / 40 characters

```text caption-8 fr 40
Compatible avec vos caméras
```
↳ 27 / 40 characters

```text caption-9 fr 40
Sans compte. Sans cloud.
```
↳ 24 / 40 characters

```text caption-10 fr 40
Moins d'alertes quand vous êtes là
```
↳ 34 / 40 characters

---

## 7. German

```text name de 30
Sightline: Kameras zu Hause
```
↳ 27 / 30 characters

```text subtitle de 30
Überwachungskameras ohne Cloud
```
↳ 30 / 30 characters

```text promo de 170
Alle Ihre Kameras in einer privaten App. Live ansehen, jeden Moment wiederfinden und Hinweise bekommen, die dazulernen. Ohne Konto. Ihr Video bleibt Ihres.
```
↳ 155 / 170 characters

```text description de 4000
Ihre Kameras. Ihr Netzwerk. Sightline ist eine einfache, private App für die Überwachungskameras und Rekorder, die Sie schon haben, egal von welcher Marke. Live ansehen, jeden Moment wiederfinden und Hinweise bekommen, direkt von Ihrem eigenen System. Ohne Konto. Ohne Cloud. Das Video geht von Ihren Kameras auf Ihr Telefon.

FUNKTIONIERT MIT IHREN GERÄTEN
Frigate, Reolink, Hikvision, Annke, Dahua, Amcrest, Lorex, Swann, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder und Scrypted, dazu TP-Link Tapo, Wyze, eufy, EZVIZ, Imou und jede ONVIF- oder RTSP-Kamera. Sightline findet die Kameras in Ihrem WLAN und führt Sie Schritt für Schritt durch die Einrichtung Ihrer Marke. Ganz ohne Technikkenntnisse.

LIVE
• Alle Kameras auf einem Bildschirm, markenübergreifend
• Vollbild mit Zoom; schwenkbare Kameras steuern und gespeicherte Positionen abrufen
• Über Türklingel oder Kamera sprechen, wenn sie es unterstützt, und Licht oder Sirene einschalten
• Klingelt es, füllt das Livebild den Bildschirm, auf iPhone und Apple Watch

JEDEN MOMENT WIEDERFINDEN
• Aufnahmen und Ereignisse auf einer einfachen Zeitleiste
• Einfach fragen: „Wann kam das Paket?“ Beantwortet auf Ihrem iPhone
• Eine Person oder ein Auto von Kamera zu Kamera verfolgen
• Einen ganzen Tag in Sekunden als Zeitraffer ansehen
• Momente merken, Clips teilen oder ein signiertes Beweispaket für Polizei oder Versicherung exportieren

HINWEISE, DIE DAZULERNEN
• Kameras und Wichtiges auswählen: Personen, Autos, Pakete, Tiere, die Klingel
• Hinweisbereiche direkt aufs Livebild zeichnen
• Auf „Nicht wichtig“ tippen, und Sightline meldet Ähnliches seltener. Regen, Wind und Scheinwerfer filtert es ebenfalls heraus
• Zuhause & unterwegs: weniger Hinweise, wenn Sie daheim sind
• Familien-Check-ins: wissen, dass der Tag eines lieben Menschen begonnen hat
• Bescheid bekommen, wenn eine Kamera offline geht

BEKANNTE GESICHTER & FAHRZEUGE (OPTIONAL)
Geben Sie Familienmitgliedern und Ihrem Auto einen Namen, damit Hinweise sagen, wer da ist. Die Erkennung läuft nur auf Ihrem iPhone, und Sie können alles jederzeit löschen.

PRIVAT VON GRUND AUF
• Keine Anmeldung, keine Werbung, keine Analyse, kein Tracking
• Kamera-Passwörter bleiben im Schlüsselbund Ihres iPhone. Einstellungen werden in Ihrer eigenen iCloud gesichert
• App mit Face ID sperren
• Unterwegs verbindet das integrierte WireGuard nur mit Ihren eigenen Kameras
• Clips mit Nachbarn teilen, Gesichter und Kennzeichen automatisch verpixelt

SIGHTLINE HUB (OPTIONAL, KOSTENLOS)
Mit dem kostenlosen Sightline Hub, einem Add-on für Home Assistant oder einer kleinen App für NAS oder Dauer-PC, kommen Hinweise in einer Sekunde, Sie sehen Ihre Kameras von überall ohne Änderungen am Router und teilen mit der Familie, mit Zugriffen, die Sie begrenzen oder entziehen können. Er läuft bei Ihnen zu Hause, auf Ihrer Hardware.

ÜBERALL DABEI
iPhone, iPad mit Wanddisplay-Modus, Apple Watch, Apple TV, Live-Aktivitäten, Widgets und Siri. Auf Deutsch, Englisch, Spanisch, Französisch und Portugiesisch, mit großer Schrift überall.

Keine Kamera zur Hand? Tippen Sie auf „Mit Beispielkameras ausprobieren“ und entdecken Sie alle Funktionen.

Manche Funktionen brauchen einen Sightline Hub oder eine Kamera, die sie unterstützt. Kameras, die nur über die Cloud ihres Herstellers senden, können nicht angezeigt werden. Produktnamen sind Marken ihrer jeweiligen Inhaber; Sightline ist mit keinem Kamerahersteller verbunden und wird von keinem unterstützt.
```
↳ 3477 / 4000 characters

```text keywords de 100b
sicherheit,videoüberwachung,cctv,rtsp,onvif,nvr,dvr,türklingel,ptz,rekorder,alarm,bewegung,ip-cam
```
↳ 99 / 100 bytes

```text whatsnew-1.0 de 4000
Willkommen bei Sightline: eine private App für die Kameras, die Sie schon haben.
• Alle großen Marken, im WLAN gefunden und Schritt für Schritt eingerichtet
• Live, Aufnahmen, Suche und Hinweise, die dazulernen
• Optionaler Sightline Hub für sofortige Hinweise, Fernzugriff und Teilen
• Jetzt auf Spanisch, Französisch, Deutsch und Portugiesisch, mit großer Schrift überall
```
↳ 373 / 4000 characters

Captions (German):

```text caption-1 de 40
Alle Kameras. Eine private App.
```
↳ 31 / 40 characters

```text caption-2 de 40
Zoomen, schwenken, sprechen
```
↳ 27 / 40 characters

```text caption-3 de 40
Jeden Moment schnell finden
```
↳ 27 / 40 characters

```text caption-4 de 40
Fragen: „Kam ein Paket?“
```
↳ 24 / 40 characters

```text caption-5 de 40
Hinweise, die dazulernen
```
↳ 24 / 40 characters

```text caption-6 de 40
Kein Klingeln mehr verpassen
```
↳ 28 / 40 characters

```text caption-7 de 40
Alle Kameras auf Ihrem Plan
```
↳ 27 / 40 characters

```text caption-8 de 40
Passt zu Ihren Kameras
```
↳ 22 / 40 characters

```text caption-9 de 40
Ohne Konto. Ohne Cloud.
```
↳ 23 / 40 characters

```text caption-10 de 40
Ruhiger, wenn Sie zu Hause sind
```
↳ 31 / 40 characters

---

## 8. Portuguese (Brazil)

```text name pt-BR 30
Sightline: Câmeras de casa
```
↳ 26 / 30 characters

```text subtitle pt-BR 30
Visualizador privado de NVR
```
↳ 27 / 30 characters

```text promo pt-BR 170
Todas as suas câmeras em um só app privado. Veja ao vivo, encontre qualquer momento e receba alertas que aprendem. Sem conta. Sem nuvem. Seu vídeo é só seu.
```
↳ 156 / 170 characters

```text description pt-BR 4000
Suas câmeras. Sua rede. O Sightline é um app simples e privado para as câmeras de segurança e gravadores que você já tem, de qualquer marca. Veja ao vivo, encontre qualquer momento e receba alertas direto do seu próprio sistema. Sem conta. Sem nuvem. O vídeo vai das suas câmeras para o seu celular.

FUNCIONA COM O QUE VOCÊ JÁ TEM
Frigate, Reolink, Hikvision, Annke, Dahua, Amcrest, Lorex, Swann, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder e Scrypted, além de TP-Link Tapo, Wyze, eufy, EZVIZ, Imou e qualquer câmera ONVIF ou RTSP. O Sightline encontra as câmeras no seu Wi-Fi e mostra o passo a passo da sua marca. Sem configuração técnica.

AO VIVO
• Todas as câmeras em uma tela, de qualquer marca
• Tela cheia com zoom; mova câmeras PTZ e use posições salvas
• Fale pela campainha ou pela câmera quando ela permitir, e acenda luzes ou sirenes
• Quando a campainha toca, o vídeo ao vivo ocupa a tela, no iPhone e no Apple Watch

ENCONTRE QUALQUER MOMENTO
• Gravações e eventos em uma linha do tempo simples
• Pergunte do seu jeito: "Que horas chegou a encomenda?" A resposta é calculada no seu iPhone
• Acompanhe uma pessoa ou um carro de câmera em câmera
• Veja um dia inteiro em segundos com o time-lapse
• Salve momentos, compartilhe clipes ou exporte um pacote de provas assinado para a polícia ou o seguro

ALERTAS QUE APRENDEM
• Escolha as câmeras e o que importa: pessoas, carros, encomendas, animais, a campainha
• Desenhe zonas de alerta direto na imagem ao vivo
• Toque em "Não importante" e o Sightline silencia alertas parecidos. Chuva, vento e faróis também são ignorados
• Em casa e fora: menos alertas enquanto você está em casa
• Check-ins da família: saiba que o dia de quem você ama já começou
• Saiba quando uma câmera fica offline

ROSTOS E VEÍCULOS CONHECIDOS (OPCIONAL)
Dê nome às pessoas da família e ao seu carro para que os alertas digam quem está lá. O reconhecimento acontece só no seu iPhone, e você pode apagar tudo quando quiser.

PRIVADO DESDE A ORIGEM
• Sem cadastro, sem anúncios, sem análises, sem rastreamento
• As senhas das câmeras ficam nas Chaves do seu iPhone. Os ajustes têm backup no seu próprio iCloud
• Bloqueie o app com o Face ID
• Fora de casa, o WireGuard integrado conecta só às suas próprias câmeras
• Compartilhe um clipe com os vizinhos com rostos e placas desfocados automaticamente

SIGHTLINE HUB (OPCIONAL E GRATUITO)
Adicione o Sightline Hub gratuito, um complemento para o Home Assistant ou um pequeno app para NAS ou computador sempre ligado, e tenha alertas em um segundo, acesso de qualquer lugar sem mexer no roteador e compartilhamento com a família, com acessos que você pode limitar ou retirar. Ele funciona na sua casa, no seu próprio equipamento.

ONDE VOCÊ ESTIVER
iPhone, iPad com modo de tela de parede, Apple Watch, Apple TV, Atividades ao Vivo, widgets e Siri. Em português, inglês, espanhol, francês e alemão, com texto grande em todo o app.

Sem câmeras à mão? Toque em "Experimentar com câmeras de exemplo" para conhecer todos os recursos.

Alguns recursos precisam de um Sightline Hub ou de uma câmera compatível. Câmeras que só transmitem pela nuvem do fabricante não podem ser exibidas. Os nomes de produtos são marcas de seus respectivos donos; o Sightline não é afiliado nem endossado por nenhum fabricante de câmeras.
```
↳ 3314 / 4000 characters

```text keywords pt-BR 100b
segurança,monitoramento,cctv,rtsp,onvif,dvr,campainha,ptz,gravador,alerta,movimento,vigilância
```
↳ 96 / 100 bytes

```text whatsnew-1.0 pt-BR 4000
Boas-vindas ao Sightline: um app privado para as câmeras que você já tem.
• Todas as principais marcas, encontradas no seu Wi-Fi e configuradas passo a passo
• Ao vivo, gravações, busca e alertas que aprendem
• Sightline Hub opcional para alertas instantâneos, acesso remoto e compartilhamento
• Agora em espanhol, francês, alemão e português, com texto grande em todo o app
```
↳ 374 / 4000 characters

Captions (Portuguese):

```text caption-1 pt-BR 40
Todas as câmeras. Um app privado.
```
↳ 33 / 40 characters

```text caption-2 pt-BR 40
Zoom, movimento e conversa
```
↳ 26 / 40 characters

```text caption-3 pt-BR 40
Encontre qualquer momento
```
↳ 25 / 40 characters

```text caption-4 pt-BR 40
Pergunte: “Chegou encomenda?”
```
↳ 29 / 40 characters

```text caption-5 pt-BR 40
Alertas que aprendem
```
↳ 20 / 40 characters

```text caption-6 pt-BR 40
Nunca perca a campainha
```
↳ 23 / 40 characters

```text caption-7 pt-BR 40
Todas as câmeras no seu mapa
```
↳ 28 / 40 characters

```text caption-8 pt-BR 40
Funciona com suas câmeras
```
↳ 25 / 40 characters

```text caption-9 pt-BR 40
Sem conta. Sem nuvem.
```
↳ 21 / 40 characters

```text caption-10 pt-BR 40
Menos alertas quando está em casa
```
↳ 33 / 40 characters

---

## 9. Keywords and brand names

**Rule.** Guideline 2.3.7: "don't try to pack any of your metadata with trademarked terms,
popular app names, pricing information, or other irrelevant phrases just to game the system."
App Store Connect's keyword field help is stricter still: keywords must be more than two
characters, shouldn't repeat the app or company name, and **names of other apps or companies
aren't allowed** ([App Store Connect help](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)).

**So:**

- **No camera brands in keywords** (Frigate, Reolink, Hikvision, UniFi…). It's a common
  rejection reason, Apple can silently strip them, and some of those makers have their own apps,
  which makes it look like riding on their name. The keyword lines above contain no brands.
- **Brands in the description are fine** when they're a factual compatibility list, which is
  exactly what users need to know. Keep them in one "works with" list, don't repeat them, and
  keep the trademark sentence at the end. Leave them out of the name, subtitle, promotional
  text and screenshots' large captions (a brand list in the "works with" screenshot is OK in
  small print, matching the app's own brand picker).
- **Protocols and standards** (`rtsp`, `onvif`, `poe`, `ptz`, `cctv`, `nvr`, `dvr`) describe what
  the app does and are the words enthusiasts search for. ONVIF is also the name of the standards
  body; it's widely used generically and low risk, but if a reviewer objects, swap it for
  `ipcam`.
- **Don't use "WireGuard" as a keyword.** It's a registered trademark; mentioning it in the
  description to explain the feature is fine.
- Words already in the name or subtitle are indexed automatically; the check script warns if a
  keyword repeats them. Apple also matches singular/plural, so one form is enough.
- Spanish (Mexico) keywords are indexed in the U.S. store as well, which is another reason to
  fill that localization in.

---

## 10. Age rating

App Store Connect → App Information → Age Rating. The questionnaire was rebuilt in 2025–2026
(new 13+, 16+ and 18+ tiers; the new answers were required from January 31, 2026, and the
social-media questions from September 2026)
([Apple: age ratings values and definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions)).

| Section | Question | Answer | Why |
| --- | --- | --- | --- |
| In-App Controls | Parental Controls | No | |
| | Age Assurance | No | |
| Capabilities | Unrestricted Web Access | **No** | The only web views are fixed help pages (GitHub install guide) in Safari View Controller; no browser. |
| | User-Generated Content | **No** | The video is the user's own private cameras, shown only to them and people they personally invite. Nothing is published or discoverable. |
| | Social Media | No | No feed, profiles or discovery. |
| | Messaging and Chat | **No** | Talk sends the user's voice to their own camera's speaker; it isn't person-to-person messaging. |
| | Advertising | No | |
| Mature Themes | Profanity or Crude Humor | None | |
| | Horror/Fear Themes | None | Security video, but no horror content; the samples are drawn shapes. |
| | Alcohol, Tobacco, or Drug Use or References | None | |
| Medical or Wellness | Medical or Treatment Information | None | Family check-ins are about activity on a camera, not health. |
| | Health or Wellness Topics | No | |
| Sexuality or Nudity | all three | None | |
| Violence | all four | None | |
| Chance-Based Activities | Gambling | No | |
| | Simulated Gambling, Contests | None | |
| | Loot Boxes | No | |

**Result: 4+.** Also: *Made for Kids* → No. Any future feature that lets people publish clips
publicly (for example a neighborhood feed) would change "User-Generated Content" and "Social
Media".

---

## 11. App Privacy ("nutrition label")

App Store Connect → App Privacy. Apple's definitions
([App privacy details](https://developer.apple.com/app-store/app-privacy-details/)):

- **"Collect"** means "transmitting data off the device in a way that allows you and/or your
  third-party partners to access it for a period longer than what is necessary to service the
  transmitted request in real time."
- "Data that is processed only on device is not 'collected'."
- **Third-party partners** are "analytics tools, advertising networks, third-party SDKs, or other
  external vendors whose code you've added to your app." Expo's SDKs (`expo-notifications`,
  `expo-updates`) are in the app, so Expo counts.
- Data the user's own equipment receives (cameras, recorder, their Hub) and data in the user's
  own iCloud are not accessible to the developer or a partner, so they're not "collected".

### Data type by data type

| Data | Leaves the phone? | Collected (Apple's sense)? | Reasoning |
| --- | --- | --- | --- |
| Video, pictures, audio (Talk) | To the user's own cameras/Hub only | **No** | Never reaches us or a partner. |
| Push notification text (camera name, detected objects, recognized names) | Hub → Expo → APNs/FCM, **end-to-end encrypted** (`bridge/seal.go`); only generic text ("Activity on your cameras") is readable | **No** (see below) | Partners only see ciphertext they can't open; thumbnail is encrypted too. Older Hubs/apps still send readable text, which Expo doesn't store "longer than it takes to deliver" ([Expo FAQ](https://docs.expo.dev/push-notifications/faq/)). |
| Push token + Expo installation ID | App → Expo (only when a Hub is added) | **Yes, probably: Identifiers → Device ID** | Expo keeps the token mapping for as long as the token is used, so pushes can be routed. That's longer than real time, by a partner whose SDK is in the app. |
| EAS Update installation ID ("EAS client ID") | App → Expo, every launch, every user | **Yes, probably: Identifiers → Device ID** | A random, stable per-install ID kept by Expo to count updated users for billing ([Expo: EAS client ID](https://docs.expo.dev/eas/observe/reference/client-id/)). |
| Home location | Rounded (0.1°) to the user's Hub; exact to own iCloud | **No** | Neither place is accessible to us or a partner. |
| Familiar faces & vehicles | Never | **No** | On-device only. |
| Ask / speech | Never | **No** | On-device model and on-device speech only. |
| Problem reports (Report a problem) | Only when the user taps Send in Mail/share sheet | **Optional to disclose** (see below) | |
| Crash logs via Apple ("Share With App Developers") | Apple → developer | **No** (Apple's own system) | Collected by Apple under the user's iOS setting, not by code in the app. |
| iCloud backup / Keychain | User's own iCloud | **No** | Not accessible to us. |

### The two judgment calls

**1. Push text through Expo.** Current Hubs and apps encrypt the alert text end to end
(`bridge/seal.go`): Expo, Apple and Google only see generic text ("Activity on your cameras") and
ciphertext, so there's nothing readable to collect. A Hub or app that hasn't been updated still
sends readable text, but Expo holds it only in memory and queues until it's handed to
Apple/Google, which is Apple's "necessary to service the transmitted request in real time"
carve-out. (Apple's own APNs is the platform, not a partner.) **Recommendation: don't declare
push contents**; the privacy policy (section 4) explains both cases.

**2. Identifiers held by Expo.** Both the push token mapping and the EAS client ID are random
installation identifiers that a partner keeps beyond real time. They're not linked to a person,
not used for tracking, and only used to make the app work. Apple's "Device ID" type covers
"device-level IDs", and the conservative reading is that these count.

**Recommendation: declare one data type:**

- **Identifiers → Device ID**
  - Used for: **App Functionality** (only)
  - Linked to the user's identity: **No**
  - Used for tracking: **No**

That changes the label from "Data Not Collected" to "Data Not Linked to You: Identifiers". It's
honest, it's what Expo-based apps commonly declare, and it can't be held against you later.
The alternative, "Data Not Collected", is defensible only if you treat Expo's IDs as operational
plumbing outside the definition; it's the better marketing badge but the weaker position. If
you want "Data Not Collected" without the debate, remove the cause: turn off EAS Update in
release builds (`updates.enabled: false` or `checkAutomatically: "NEVER"`, at the cost of
over-the-air fixes) and keep push (needed for the Hub) as the only Expo flow, then re-decide.

**Problem reports.** Emailed reports meet all four of Apple's "optional disclosure" criteria:
not used for tracking or advertising; infrequent and not part of primary functionality; the
user types it in, can read it all first, sees their own email address as the sender and chooses
to send each time. **Recommendation: don't declare.** If you'd rather be maximal, add
*Diagnostics → Crash Data* and *Other Data → Customer Support*, App Functionality, **Linked**
(the email address identifies the sender), not tracking.

**Tracking:** No. No App Tracking Transparency prompt needed.

**Privacy manifest.** Apple also requires a `PrivacyInfo.xcprivacy` declaring "required reason"
APIs (UserDefaults, file timestamps, system boot time, disk space). Expo generates one from
`ios.privacyManifests` in `app.json`; after the next build, check App Store Connect's email for
"ITMS-91053: Missing API declaration" and add the reasons it lists. Its collected-data section
should match the label above.

---

## 12. Export compliance (encryption)

### What the app contains

- **WireGuard** in the app's own code (`tunnel/`, Go: ChaCha20-Poly1305, Curve25519, BLAKE2s),
  used to reach the user's own cameras away from home.
- **TLS** for HTTPS to the Hub and cameras: mostly Apple's networking stack, plus Go's TLS inside
  the tunnel module.
- AES-GCM for the encrypted alert thumbnails, the phone-transfer bundle and backup files.

All are published, standard algorithms (IETF RFCs or openly published). None is proprietary.
This is **not** exempt as "encryption only within Apple's operating system", so the current
`"ITSAppUsesNonExemptEncryption": false` in `app.json` is **wrong** and should change.

### US export law (EAR), in practice

- An app like this is a **mass-market** encryption item, **ECCN 5D992.c**, exported under
  License Exception ENC / mass market (EAR §740.17(b)(1)). It doesn't fit the "Note 4"
  decontrol (its job is receiving and showing data over a network) or the
  authentication-only exemption (WireGuard encrypts the video).
- **Annual self-classification report: most likely not required any more.** BIS's rule of
  March 29, 2021 removed the self-classification reporting requirement for most mass-market
  items (5A992.c/5D992.c), which includes apps distributed through app stores, as long as they
  use standard cryptography
  ([Thompson Hine](https://www.thompsonhine.com/publications/bis-eliminates-most-mass-market-encryption-reporting-obligations),
  [Venable](https://www.venable.com/insights/publications/2021/03/export-administration-rules-are-revised-to-elim),
  [BIS encryption guidance](https://www.bis.gov/learn-support/encryption-controls)). Older blog
  posts telling app developers to file a February 1 report predate that rule. No CCATS is
  needed either (that's for proprietary crypto).
- Practical step: write a one-page self-classification memo for your records (product,
  algorithms, "5D992.c, mass market, §740.17(b)(1), standard cryptography, no report required
  per the March 2021 rule") and keep it with the release documents. If you want certainty, ask
  BIS (free) or an export lawyer; this note isn't legal advice.
- The Hub is open-source "publicly available" encryption source code using standard crypto;
  after the 2021 rule it doesn't need the old email notification to BIS either.

### App Store Connect questions

Apple's flow ([Overview of export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance),
[Export compliance documentation](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/)):

| Question | Answer |
| --- | --- |
| Does your app use encryption? | **Yes** |
| What type of encryption algorithms does your app implement? | **Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system** |
| Is your app going to be available on the App Store in France? | **Your decision** (below) |

Documentation Apple requires for "standard algorithms not provided by Apple's OS": **only the
French encryption declaration, and only if you distribute in France.** No US document.

**France.** France requires a declaration to ANSSI for importing/supplying encryption used for
confidentiality. Two choices:

1. **File it** (recommended before or soon after launch): ANSSI's
   [cryptology declaration](https://cyber.gouv.fr/controle-reglementaire-sur-la-cryptographie-les-formulaires) form (in French, sent by email to the address on that page;
   free; plan for about a month). Upload the acknowledgment in App Store Connect → App
   Information → App Encryption Documentation. Apple then gives a code for
   `ITSEncryptionExportComplianceCode`.
2. **Launch without France** (Pricing and Availability → untick France), and add it once the
   declaration is done. Easiest for a first release; French-speaking users in Canada, Belgium,
   Switzerland etc. are unaffected.

### What to set (recommendation; `app.json` not changed here)

```json
"infoPlist": {
  "ITSAppUsesNonExemptEncryption": true
}
```

and, once Apple approves the French documentation:

```json
"ITSEncryptionExportComplianceCode": "<code from App Store Connect>"
```

With `true` and no code, App Store Connect asks the encryption questions for each new build
(TestFlight shows "Missing Compliance" until you answer; it takes a minute). Setting `false` to
skip that would be an inaccurate declaration, and you, not Apple, are liable for it.

---

## 13. App Review information

Sign-in required: **No.** Contact: your name, phone and email. Attach a short screen recording
(optional but helpful) of Demo mode and of a real camera if you can.

Notes (paste into **App Review Information → Notes**; this merges `docs/APP_REVIEW.md`):

```text review-notes en 4000
Sightline shows video from security cameras and recorders that people already own and run at home (Frigate, Reolink, Hikvision, Dahua/Amcrest/Lorex, UniFi Protect, Blue Iris, ONVIF cameras and more). There is no account, no sign-in and no server of ours.

HOW TO REVIEW WITHOUT CAMERAS
On the first screen, under "No cameras handy?", tap "Try it with sample cameras". This adds five built-in sample cameras (Front Door doorbell, Driveway, Backyard, Garage, Living Room) with sample video and a week of sample events. It works offline and sends nothing anywhere. Sample cameras are marked SAMPLE.
1. Live tab: all cameras play at once. Tap one for full screen.
2. Driveway: tap "Move camera" and hold the arrows or zoom, or tap a preset.
3. Recordings tab: events (person, package, car, dog, doorbell). Tap one to watch; drag the timeline to scrub.
4. Recordings > Search: try "package", "dog in the yard" or "Sam".
5. A star saves a moment; the share button exports the clip.
6. Map tab: the sample cameras on a property map.
7. Notifications: when asked "See what an alert looks like?", tap "Send one" (or Settings > Sample cameras > Send a sample alert). One sample alert arrives a few seconds later. The app never sends sample alerts on its own.
To leave: Settings > Sample cameras > Remove sample cameras.
Two-way Talk and lights/siren need a real camera that supports them, so the samples don't show them.

BUILT-IN WIREGUARD (GUIDELINE 5.4)
Sightline is not a VPN app and offers no VPN service. Away from home, people can reach their own cameras through a WireGuard server they already run at home (for example on their router). This is implemented inside the app's own process: it carries only Sightline's own connections to the user's cameras. It does not use NetworkExtension or NEVPNManager, installs no VPN profile, and does not route any other traffic on the device. There is no server of ours involved; the user enters or scans their own configuration in Settings > Away from home.

LOCATION (ALWAYS)
Only for the optional "Home & Away" feature (Settings > Home & Away), which quiets alerts while the user is home. Off by default. When the user turns it on, the app explains why, asks for When In Use and then Always, saves home once and uses iOS region monitoring to learn arrivals and departures. It does not track location continuously. Declining keeps every other feature working.

BACKGROUND MODES
- Background fetch / processing: built-in alerts check the user's cameras for new events and show local notifications.
- Remote notifications: instant alerts from the user's own optional Sightline Hub, with a notification service extension that decrypts the attached thumbnail.
- Time-sensitive notifications: used only for doorbell rings and missed family check-ins.

OTHER PERMISSIONS
Local Network: to find and reach cameras at home (not needed for the samples). Camera: only to scan QR codes. Microphone: only while holding Talk or speaking a question to Ask. Speech recognition: on-device only. Photos: picking a map picture or photos of people to recognize. Face ID: optional app lock.

Optional Sightline Hub: free software the user runs on their own hardware (Home Assistant add-on or Docker) for instant alerts, remote access and sharing. Not needed for review.
```
↳ 3286 / 4000 characters

Apple's limit for the Notes field is 4,000 characters (verify in App Store Connect).

---

## 14. Screenshots

### Sizes (verified October 2026)

From [Apple: screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/):

| Display | Required? | Accepted portrait sizes | Devices to capture on |
| --- | --- | --- | --- |
| **iPhone 6.9"** | **Yes** (or 6.5" instead) | 1320 × 2868, 1290 × 2796, 1260 × 2736 | iPhone 16/17/18 Pro Max (1320 × 2868), iPhone Air (1260 × 2736), 15/16 Plus or 14/15 Pro Max (1290 × 2796) |
| iPhone 6.5" | Only if no 6.9" set | 1284 × 2778, 1242 × 2688 | |
| **iPad 13"** | **Yes**, because `supportsTablet` is true | 2064 × 2752 or 2048 × 2732 | iPad Pro 13" (M4/M5), iPad Air 13" |

1 to 10 screenshots per size and language, PNG or JPEG, no transparency. Smaller iPhone and
iPad sizes are scaled from these automatically. Landscape is allowed (2868 × 1320 and
2752 × 2064); the iPad wall display looks best in landscape.

**Capturing on Windows:** take them on real devices (Side button + Volume Up gives the exact
native size), or run the iOS Simulator on a GitHub Actions macOS runner with a Demo-mode build
(`xcrun simctl boot "iPhone 17 Pro Max"`, `xcrun simctl status_bar booted override --time 9:41
--batteryState charged --batteryLevel 100`, `xcrun simctl io booted screenshot shot.png`) and
download the artifacts. Then add the caption and background in any image editor (Figma, Canva,
or a small HTML template), keeping the exact pixel size.

### Plan (all in Demo mode, dark appearance, status bar at 9:41 with full battery)

Order matters: the first three show in search results.

| # | Screen | How to get there | Caption key |
| --- | --- | --- | --- |
| 1 | Live tab, all five sample cameras | Try it with sample cameras → Live | caption-1 |
| 2 | Driveway full screen with the move pad open | Live → Driveway → Move camera | caption-2 |
| 3 | Recordings tab with the timeline and event list | Recordings | caption-3 |
| 4 | Search / Ask answering "package" | Recordings → Search → "package" | caption-4 |
| 5 | Lock Screen or banner with a sample alert (person + thumbnail), or the "What Sightline learned" screen | Settings → Sample cameras → Send a sample alert, lock the phone | caption-5 |
| 6 | Doorbell full-screen ring | Open the doorbell sample alert, or a Front Door doorbell event | caption-6 |
| 7 | Map tab | Map | caption-7 |
| 8 | Brand picker ("Pick your camera brand") | Settings → Add a recorder or camera → Pick your camera brand | caption-8 |
| 9 | Welcome screen ("Your cameras. Your network.") or Settings → Privacy | First launch | caption-9 |
| 10 | Home & Away screen | Settings → Home & Away | caption-10 |

On iPad, use the same order but show #1 as the wall display (Settings → Wall display) in
landscape. Take each language's screenshots with the app switched to that language (Settings →
language) so the UI matches the caption; demo camera names may stay in English if they aren't
translated. Avoid real addresses, faces or license plates (the samples have none).

---

## 15. Decisions for you

1. **App name**: "Sightline: Home Cameras" or a fallback (section 1).
2. **Support email** for the website, privacy policy and `SUPPORT_EMAIL` in `app/src/config.ts`.
3. **Where the site lives**: a separate public `sightline-site` repo (recommended), the future
   public Hub repo, or paying for Pages on the private repo (`site/README.md`).
4. **App Privacy label**: declare "Identifiers → Device ID (not linked, app functionality)"
   (recommended) or "Data Not Collected", possibly after turning off EAS Update (section 11).
5. **France**: file the ANSSI declaration or launch without France (section 12), and set
   `ITSAppUsesNonExemptEncryption` to `true`.
6. **Apple TV in the description**: keep "Apple TV" only if the tvOS app ships under the same
   App Store record at launch; otherwise remove it from all five descriptions.
7. **Price**: not covered here (free/paid/in-app purchase). Guideline 2.3.7 keeps prices out of
   the name, subtitle and screenshots either way.
