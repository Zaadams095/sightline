/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'app-intent',
  name: 'SightlineIntents',
  // OpenURLIntent (open the app at a camera) needs iOS 18.
  deploymentTarget: '18.0',
  entitlements: {
    'com.apple.security.application-groups': [...new Set(config.ios.entitlements['com.apple.security.application-groups'])],
  },
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
  },
});
