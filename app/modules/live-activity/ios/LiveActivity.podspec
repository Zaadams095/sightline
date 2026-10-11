Pod::Spec.new do |s|
  s.name           = 'LiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'Starts, updates and ends the doorbell / camera event Live Activity'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.9'
  s.source_files = '*.swift'
  s.frameworks = 'ActivityKit', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
