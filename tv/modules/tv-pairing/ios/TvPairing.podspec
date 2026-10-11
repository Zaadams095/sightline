Pod::Spec.new do |s|
  s.name           = 'TvPairing'
  s.version        = '0.1.0'
  s.summary        = 'Local-network pairing with the Sightline iPhone app, QR codes and keychain storage for the TV app'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :tvos => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'Network', 'CoreImage', 'Security', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
