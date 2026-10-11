/**
 * App-wide settings the developer sets once.
 */

/**
 * Where "Report a problem" sends reports (Settings → Help). Reports only leave the phone when
 * the user taps Send in Mail or the share sheet; there is no Sightline server.
 *
 * TODO(developer): set this to the real support address before release. While it is the
 * placeholder, the Report screen still works but says the address isn't set up.
 */
export const SUPPORT_EMAIL = 'support@example.com';

/**
 * The privacy policy and support pages (site/privacy.html, site/support.html), opened from
 * Settings → Privacy → Privacy policy and Settings → Help → Support website. App Review
 * (guideline 5.1.1(i)) wants the privacy policy reachable inside the app.
 *
 * TODO(developer): PLACEHOLDERS until the site is published (site/README.md). These are the
 * addresses docs/APP_STORE_LISTING.md plans; change them here if the site lives elsewhere, and
 * keep them the same as the URLs entered in App Store Connect.
 */
export const PRIVACY_URL = 'https://zaadams095.github.io/sightline-site/privacy.html';
export const SUPPORT_URL = 'https://zaadams095.github.io/sightline-site/support.html';