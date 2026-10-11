Pod::Spec.new do |s|
  s.name           = 'WgTunnel'
  s.version        = '0.1.0'
  s.summary        = 'In-process WireGuard tunnel and loopback gateway'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Built from ../../tunnel by scripts/build-tunnel-ios.sh (runs in the EAS pre-install hook).
  s.vendored_frameworks = 'Wgtunnel.xcframework'
  # Only our Swift; a recursive glob would also pick up the xcframework's per-slice headers.
  s.source_files = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
