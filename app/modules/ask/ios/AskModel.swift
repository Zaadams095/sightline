import Foundation

#if canImport(FoundationModels)
import FoundationModels

/// Apple's on-device model (Foundation Models framework). iOS 26+, Apple Intelligence on.
///
/// Guided generation uses a schema built at run time (DynamicGenerationSchema) rather than a
/// fixed @Generable type, because the allowed values are the user's own camera names, the
/// names their recorder recognizes and their zones: the model can only pick from those, so it
/// can't invent a camera. The app checks every value again anyway (src/ask/engine.ts).
@available(iOS 26.0, *)
enum AskModel {
  static func availability() -> String {
    let model = SystemLanguageModel.default
    if case .unavailable(let reason) = model.availability {
      switch reason {
      case .deviceNotEligible: return "device"
      case .appleIntelligenceNotEnabled: return "disabled"
      case .modelNotReady: return "notReady"
      @unknown default: return "unavailable"
      }
    }
    return model.supportsLocale(Locale.current) ? "available" : "language"
  }

  /// What the app allows the model to choose from (see PlanContext in src/ask/engine.ts).
  struct PlanContext: Decodable {
    let cameras: [String]
    let names: [String]
    let places: [String]
    let things: [String]
    let kinds: [String]
    let times: [String]
    let parts: [String]
    let now: String
  }

  static func plan(question: String, contextJSON: String) async throws -> String {
    let ctx = try JSONDecoder().decode(PlanContext.self, from: Data(contextJSON.utf8))

    func choice(_ name: String, _ values: [String]) -> DynamicGenerationSchema {
      DynamicGenerationSchema(name: name, description: nil, anyOf: values)
    }
    func list(_ name: String, _ values: [String], max: Int) -> DynamicGenerationSchema {
      DynamicGenerationSchema(arrayOf: choice(name, values), minimumElements: 0, maximumElements: max)
    }

    var properties: [DynamicGenerationSchema.Property] = [
      DynamicGenerationSchema.Property(
        name: "kind",
        description: "yesno for did/was/is/any questions, count for how many, when for when/what time, who for who, list for show/find/what happened",
        schema: choice("Kind", ctx.kinds)
      ),
      DynamicGenerationSchema.Property(
        name: "things",
        description: "What the question is about. Empty or anything if it doesn't say.",
        schema: list("Thing", ctx.things, max: 3)
      ),
    ]
    if !ctx.cameras.isEmpty {
      properties.append(DynamicGenerationSchema.Property(
        name: "cameras",
        description: "Cameras the question names or clearly means. Empty means all cameras.",
        schema: list("Camera", ctx.cameras, max: 4)
      ))
    }
    if !ctx.names.isEmpty {
      properties.append(DynamicGenerationSchema.Property(
        name: "people",
        description: "Known people the question names. Empty if none.",
        schema: list("Person", ctx.names, max: 4)
      ))
    }
    if !ctx.places.isEmpty {
      properties.append(DynamicGenerationSchema.Property(
        name: "places",
        description: "Areas the question names, only if one matches. Usually empty.",
        schema: list("Place", ctx.places, max: 3)
      ))
    }
    properties.append(DynamicGenerationSchema.Property(
      name: "time",
      description: "When. Use past week if the question doesn't say.",
      schema: choice("Time", ctx.times)
    ))
    properties.append(DynamicGenerationSchema.Property(
      name: "partOfDay",
      description: "A time of day the question asks about on any day, else any.",
      schema: choice("PartOfDay", ctx.parts)
    ))

    let root = DynamicGenerationSchema(
      name: "CameraSearch",
      description: "A search over the person's own home camera recordings",
      properties: properties
    )
    let schema = try GenerationSchema(root: root, dependencies: [])
    let instructions = """
      You turn a question about the person's own home security cameras into a search. \
      Choose only from the allowed values. It is now \(ctx.now). \
      "Anyone", "someone", "kids", "visitors" mean person. "Delivery driver" means delivery. \
      "Cars", "trucks" mean vehicle.
      """
    let session = LanguageModelSession(instructions: instructions)
    let response = try await session.respond(to: question, schema: schema)
    return response.content.jsonString
  }

  static func answer(question: String, facts: String) async throws -> String {
    let instructions = """
      You answer questions about the person's own home security cameras in plain, friendly \
      English, in one or two short sentences. Use only the facts you are given. Never add \
      times, numbers, names, cameras or details that are not in the facts. Do not mention \
      facts, drafts or recordings data.
      """
    let session = LanguageModelSession(instructions: instructions)
    let prompt = "Question: \(question)\n\nFacts:\n\(facts)\n\nAnswer:"
    let response = try await session.respond(to: prompt)
    return response.content
  }
}
#endif
