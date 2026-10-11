Pod::Spec.new do |s|
  s.name           = 'SightlineVision'
  s.version        = '0.1.0'
  s.summary        = 'On-device face / vehicle feature prints and plate text for familiar faces (Apple Vision; nothing leaves the phone)'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.9'
  s.source_files = '*.swift'
  s.frameworks = 'Vision', 'CoreGraphics', 'ImageIO', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
