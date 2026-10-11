/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-service',
  name: 'NotificationService',
  deploymentTarget: '17.1',
  frameworks: ['CryptoKit'],
  entitlements: {
    // Same App Group as the app, used to share the bridge secret through the keychain.
    'com.apple.security.application-groups': [...new Set(config.ios.entitlements['com.apple.security.application-groups'])],
  },
  // Not read by @bacons/apple-targets 5 (it has no infoPlist option): the real keys are in
  // this folder's Info.plist, which the plugin uses as-is. Keep the two in sync.
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
    // The bridge is a plain-HTTP LAN address.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  },
});
