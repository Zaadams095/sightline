/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-service',
  name: 'NotificationService',
  deploymentTarget: '17.1',
  frameworks: ['CryptoKit'],
  // App Group entitlement is mirrored from app.json by the plugin.
  infoPlist: {
    SightlineAppGroup: config.ios.infoPlist.SightlineAppGroup,
    // The bridge is a plain-HTTP LAN address.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  },
});
