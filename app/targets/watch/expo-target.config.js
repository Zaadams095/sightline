/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// Apple Watch app (SwiftUI), embedded in the iPhone app and installed with it.
// Bundle id: <app bundle id>.watch. Data comes from the phone over WatchConnectivity
// (app/modules/watch-bridge + app/src/watch/sync.ts); see docs/APPLE_WATCH_TV.md.
module.exports = () => ({
  type: 'watch',
  name: 'SightlineWatch',
  displayName: 'Sightline',
  deploymentTarget: '10.0',
  icon: '../../assets/images/icon.png',
  colors: {
    $accent: '#7C5CFF',
  },
});
