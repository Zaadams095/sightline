Pod::Spec.new do |s|
  s.name           = 'Ask'
  s.version        = '0.1.0'
  s.summary        = 'On-device questions about camera events (Apple Foundation Models) and on-device speech input'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'Speech', 'AVFoundation'
  # iOS 26 and later only. Weak, so the app still launches on iOS 17/18, where the code that
  # uses it is never reached (everything is behind #available(iOS 26.0, *)).
  s.weak_frameworks = 'FoundationModels'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
