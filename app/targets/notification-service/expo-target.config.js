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
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
    // The bridge is a plain-HTTP LAN address.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  },
});
