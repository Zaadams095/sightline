Pod::Spec.new do |s|
  s.name           = 'Redact'
  s.version        = '0.1.0'
  s.summary        = 'Blurs faces and license plates in photos and videos on device (Vision + Core Image)'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'CoreImage', 'Vision'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
