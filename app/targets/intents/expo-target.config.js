/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'app-intent',
  name: 'SightlineIntents',
  // The plugin builds app-intent targets for iOS 17.0 regardless of deploymentTarget;
  // iOS 18-only APIs are gated with @available in Intents.swift.
  entitlements: {
    'com.apple.security.application-groups': [...new Set(config.ios.entitlements['com.apple.security.application-groups'])],
  },
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
  },
});
