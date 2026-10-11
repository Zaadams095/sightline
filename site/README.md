# Sightline website (support, privacy, landing page)

Three static pages for the App Store listing. No build step, no JavaScript, no web fonts, no
trackers: just HTML, one stylesheet and the app icon.

| File | What it is |
| --- | --- |
| `index.html` | Landing page (marketing URL) |
| `support.html` | FAQ and contact (support URL, required by App Store Connect) |
| `privacy.html` | Privacy policy (privacy policy URL, required). Source text: `docs/PRIVACY.md` |
| `style.css` | Shared dark theme (navy `#080A14`, accent `#7C5CFF`) |
| `icon.png` | The app icon (`app/assets/images/icon.png`), resized to 256 px |

## Before publishing

1. **Support email.** Search the three HTML files for `REPLACE-ME` (each spot has a
   `SUPPORT_EMAIL` comment next to it) and put in the real address. Use the same address for
   `SUPPORT_EMAIL` in `app/src/config.ts` so "Report a problem" goes there too.
2. **App Store link.** In `index.html`, replace the `#` at the `APP_STORE_URL` comment with
   `https://apps.apple.com/app/id<your app ID>` once the app has one (App Store Connect → App
   Information → Apple ID), and swap the placeholder for Apple's official
   [App Store badge](https://developer.apple.com/app-store/marketing/guidelines/).
3. **Privacy policy.** Edit `docs/PRIVACY.md` first, then copy the change into `privacy.html`
   (they're kept by hand so the page stays plain HTML). Have the policy reviewed (see the note at
   the end of `docs/PRIVACY.md`).
4. Open each page on your phone to check it reads well.

## Publishing with GitHub Pages (free)

GitHub Pages is free for **public** repositories. For a **private** repository it needs a paid
plan (GitHub Pro, Team or Enterprise). The app repository is private, so pick one:

### Option A (recommended): a small public repo just for the site

Nothing else becomes public. From PowerShell, in this folder (`site`):

```powershell
gh repo create sightline-site --public --description "Sightline website"
git init -b main
git add .
git commit -m "Sightline website"
git remote add origin https://github.com/Zaadams095/sightline-site.git
git push -u origin main
gh api -X POST repos/Zaadams095/sightline-site/pages -f "source[branch]=main" -f "source[path]=/"
```

(Without the `gh` CLI: create the repo on github.com, upload these files, then **Settings →
Pages → Build and deployment → Source: Deploy from a branch → Branch: main, / (root) → Save**.)

After a minute or two the site is live at:

- `https://zaadams095.github.io/sightline-site/`

To update it later, copy the changed files from `site/` into that repo and push.

### Option B: combine with the public Hub repository

The Hub (and its Home Assistant add-on) is meant to be public anyway, because Home Assistant
installs add-ons from a public GitHub repository. If you split it into its own public repo,
put these files in a `docs/` folder there (or a `site/` folder with a GitHub Actions Pages
workflow) and choose **Settings → Pages → Branch: main, /docs**. The URLs then become
`https://zaadams095.github.io/<hub-repo>/privacy.html` and so on.

### Option C: make the app repository public

Then **Settings → Pages → Source: GitHub Actions**, and add the "Static HTML" workflow with
`path: site`. Only do this if you're happy for all the app's code to be public.

### Custom domain (optional, later)

If you buy a domain (for example `sightline.app` if available), add a `CNAME` file with the
domain to the published folder, set the DNS records GitHub shows in **Settings → Pages →
Custom domain**, and tick **Enforce HTTPS**. Then update the URLs in App Store Connect.
Changing the privacy policy URL later is fine; just keep the old address working (or
redirecting) for a while.

## URLs for App Store Connect (Option A)

| App Store Connect field | Where | URL |
| --- | --- | --- |
| Privacy Policy URL | App Privacy (per app; localizable) | `https://zaadams095.github.io/sightline-site/privacy.html` |
| Support URL | Version page → App Information section (required) | `https://zaadams095.github.io/sightline-site/support.html` |
| Marketing URL | Version page (optional) | `https://zaadams095.github.io/sightline-site/` |

The same URLs can be used for every language: the pages are in English, which App Review
accepts. The privacy policy URL must work before you submit for review.
