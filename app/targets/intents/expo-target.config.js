/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'app-intent',
  name: 'SightlineIntents',
  // The plugin builds app-intent targets for iOS 17.0 regardless of deploymentTarget;
  // iOS 18-only APIs are gated with @available in Intents.swift.
  entitlements: {
    'com.apple.security.application-groups': [...new Set(config.ios.entitlements['com.apple.security.application-groups'])],
  },
  // Not read by @bacons/apple-targets 5 (it has no infoPlist option): the real keys are in
  // this folder's Info.plist, which the plugin uses as-is. Keep the two in sync.
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
  },
});
