Pod::Spec.new do |s|
  s.name           = 'MetricKitReports'
  s.version        = '0.1.0'
  s.summary        = 'Keeps the crash and hang reports iOS delivers through MetricKit, for user-sent problem reports'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.9'
  s.source_files = '*.swift'
  s.frameworks = 'MetricKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
