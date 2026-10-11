import AVFoundation
import ExpoModulesCore
import Speech

/// The Ask screen's mic button. Speech is recognized on the iPhone only
/// (`requiresOnDeviceRecognition`); when the phone can't do that for its language, it refuses
/// rather than sending audio to a server, and the app suggests typing instead.
final class SpeechListener {
  /// (text so far, finished, error message or nil)
  var onUpdate: ((String, Bool, String?) -> Void)?

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var tapInstalled = false
  private var timeout: DispatchWorkItem?
  /// Longest a question can be spoken for before listening stops by itself.
  private let maxSeconds = 20.0

  static func isSupported() -> Bool {
    guard let recognizer = SFSpeechRecognizer() else { return false }
    return recognizer.supportsOnDeviceRecognition
  }

  func start() async throws {
    let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
    }
    guard speech == .authorized else {
      throw Exception(name: "SpeechDenied", description: "Speech recognition is turned off for Sightline. You can turn it on in Settings, or type your question.")
    }
    let mic = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
      AVAudioApplication.requestRecordPermission { c.resume(returning: $0) }
    }
    guard mic else {
      throw Exception(name: "MicDenied", description: "Sightline can't use the microphone. You can allow it in Settings, or type your question.")
    }
    guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else {
      throw Exception(name: "SpeechNotOnDevice", description: "This iPhone can't understand speech in your language without sending it to a server, so Sightline doesn't listen. Please type your question.")
    }
    guard recognizer.isAvailable else {
      throw Exception(name: "SpeechUnavailable", description: "Speech recognition isn't ready right now. Please type your question.")
    }

    cancel()

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
    try session.setActive(true, options: .notifyOthersOnDeactivation)

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      deactivateSession()
      throw Exception(name: "NoMicrophone", description: "No microphone is available.")
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.taskHint = .search
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true
    engine.prepare()
    do {
      try engine.start()
    } catch {
      cleanup()
      throw error
    }
    self.request = request

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      if let result {
        let done = result.isFinal
        self.onUpdate?(result.bestTranscription.formattedString, done, nil)
        if done { self.cleanup() }
      } else if let error {
        self.onUpdate?("", true, error.localizedDescription)
        self.cleanup()
      }
    }

    let stopLater = DispatchWorkItem { [weak self] in self?.finish() }
    timeout = stopLater
    DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds, execute: stopLater)
  }

  /// Stops the microphone; the recognizer then delivers its final text.
  func finish() {
    stopAudio()
    request?.endAudio()
  }

  /// Stops everything without waiting for a result.
  func cancel() {
    task?.cancel()
    cleanup()
  }

  private func stopAudio() {
    if engine.isRunning { engine.stop() }
    if tapInstalled {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
  }

  private func cleanup() {
    stopAudio()
    timeout?.cancel()
    timeout = nil
    request = nil
    task = nil
    deactivateSession()
  }

  private func deactivateSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
