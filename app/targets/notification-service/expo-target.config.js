/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-service',
  name: 'NotificationService',
  deploymentTarget: '17.1',
  frameworks: ['CryptoKit'],
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
    // The bridge is a plain-HTTP LAN address.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  },
});
