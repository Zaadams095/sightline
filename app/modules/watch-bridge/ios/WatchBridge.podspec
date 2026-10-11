Pod::Spec.new do |s|
  s.name           = 'WatchBridge'
  s.version        = '0.1.0'
  s.summary        = 'WatchConnectivity link between the app and the Sightline Apple Watch app'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'WatchConnectivity', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
