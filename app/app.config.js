// app.json is the source of truth; this only adds what can't be static there.
//
// Android push (FCM) needs the Firebase project's google-services.json. It's set only when
// it exists, so builds without it (the GitHub compile check, a fresh checkout) still work,
// just without push on Android. Where it comes from, in order:
//  1. GOOGLE_SERVICES_JSON: an EAS "file" environment variable (EAS gives the file's path),
//     which keeps it out of git (see docs/ANDROID.md);
//  2. app/google-services.json on this computer (git-ignored), for local builds.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile = fromEnv && fs.existsSync(fromEnv) ? fromEnv : fs.existsSync(local) ? './google-services.json' : undefined;
  if (!googleServicesFile) return config;
  return { ...config, android: { ...config.android, googleServicesFile } };
};
