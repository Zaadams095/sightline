Pod::Spec.new do |s|
  s.name           = 'CloudBackup'
  s.version        = '0.1.0'
  s.summary        = 'iCloud key-value backup, iCloud Keychain secrets and QR codes for moving to a new phone'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'Security', 'CoreImage', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
