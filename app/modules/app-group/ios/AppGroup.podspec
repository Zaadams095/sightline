Pod::Spec.new do |s|
  s.name           = 'AppGroup'
  s.version        = '0.1.0'
  s.summary        = 'Shares files with the widget / App Intents extensions and reloads widgets'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '17.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'WidgetKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
