import ExpoModulesCore

/// "Ask your cameras", native side. Two jobs, both on the device:
///
/// 1. Apple's on-device language model (Foundation Models, iOS 26+ with Apple Intelligence)
///    turns a question into a structured search (`plan`), and later phrases a short answer
///    from facts the app found (`answer`). The model never sees video or the event list: the
///    app runs the search itself over its brand-neutral event index (src/ask/engine.ts).
/// 2. On-device speech recognition for the mic button (`startListening`), refusing to run
///    when the phone would have to send audio to a server.
///
/// On iOS 17/18, or without Apple Intelligence, `availability()` says why and the app uses its
/// rule-based parser instead.
public class AskModule: Module {
  private let listener = SpeechListener()

  public func definition() -> ModuleDefinition {
    Name("Ask")

    Events("onSpeech")

    OnCreate {
      self.listener.onUpdate = { [weak self] text, isFinal, error in
        self?.sendEvent("onSpeech", ["text": text, "final": isFinal, "error": error ?? ""])
      }
    }

    OnDestroy {
      self.listener.cancel()
    }

    /// "available", or why not: "os" (older iOS), "device", "disabled", "notReady",
    /// "language" (Apple Intelligence doesn't support the phone's language), "unavailable".
    Function("availability") { () -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return AskModel.availability()
      }
      #endif
      return "os"
    }

    /// Question → JSON search plan (guided generation, values limited to what the app offers).
    AsyncFunction("plan") { (question: String, contextJSON: String) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return try await AskModel.plan(question: question, contextJSON: contextJSON)
      }
      #endif
      throw Exception(name: "AskUnavailable", description: "Apple Intelligence isn't available on this iPhone.")
    }

    /// Facts the app found → one or two friendly sentences.
    AsyncFunction("answer") { (question: String, facts: String) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return try await AskModel.answer(question: question, facts: facts)
      }
      #endif
      throw Exception(name: "AskUnavailable", description: "Apple Intelligence isn't available on this iPhone.")
    }

    /// Whether speech can be recognized on this iPhone, in its language, without a server.
    Function("speechAvailable") { () -> Bool in
      SpeechListener.isSupported()
    }

    /// Asks for permission the first time, then listens; text arrives as onSpeech events.
    AsyncFunction("startListening") { () async throws in
      try await self.listener.start()
    }

    /// Stops listening; the final text still arrives as an onSpeech event.
    Function("stopListening") {
      self.listener.finish()
    }
  }
}
