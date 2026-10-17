import Foundation

struct PlannerFixtureFailure: Error { let message: String }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw PlannerFixtureFailure(message: message) }
}
let french = RenderPlanVoice(id: "fixture.fr", actualLocale: "fr-FR")
let russian = RenderPlanVoice(id: "fixture.ru", actualLocale: "ru-RU")
let english = RenderPlanVoice(id: "fixture.en", actualLocale: "en-US")
func plan(
  _ text: String, defaultVoice: RenderPlanVoice = french,
  estimate: @escaping (String) -> RenderLanguageEstimate? = AppleRenderPlanner.estimateLanguage
) throws -> RenderPlan {
  let voices = [french, russian, english]
  return try AppleRenderPlanner(
    request: RenderPlanRequest(text: text, voiceId: defaultVoice.id, allowedVoices: voices),
    installedLocale: { id in voices.first(where: { $0.id == id })?.actualLocale },
    estimate: estimate
  ).plan(text)
}
func rejects(_ operation: () throws -> Void, _ message: String) throws {
  do { try operation() } catch is RenderPlanningError { return }
  throw PlannerFixtureFailure(message: message)
}
@main struct PlannerFixtures {
  static func main() throws {
    let text = "Votre code est : синий маяк сорок два. Je le garde en mémoire."
    let rendered = try plan(text)
    try expect(
      rendered.runs.map(\.voiceId) == [french.id, russian.id, french.id],
      "Mixed French quote must use FR/RU/FR voices")
    try expect(
      rendered.runs.map(\.text).joined().utf16.elementsEqual(text.utf16),
      "All original text must be conserved")
    let englishText = "Your code is: синий маяк сорок два. I will remember it."
    let englishRuns = try plan(englishText, defaultVoice: english)
    try expect(
      englishRuns.runs.map(\.voiceId) == [english.id, russian.id, english.id],
      "Mixed English quote must use EN/RU/EN voices")
    let unicode = "  💙 «Cafe\u{301}: синий маяк сорок два!» 👩‍💻 Done.\n"
    let unicodePlan = try plan(unicode)
    try expect(
      Array(unicodePlan.runs.map(\.text).joined().utf16) == Array(unicode.utf16),
      "Emoji, combining marks, quotes and whitespace must remain exact")
    for text in ["синій маяк сорок два", "син фар четиридесет и две"] {
      try rejects({ _ = try plan(text) }, "Unconfigured UK/BG must not be forced into Russian")
    }
    for name in ["Sol", "Luna", "Sol / Luna 42"] {
      let names = try plan(
        "Привет. " + name, defaultVoice: russian,
        estimate: { text in
          text.contains("Привет")
            ? RenderLanguageEstimate(language: "ru", confidence: 0.99)
            : RenderLanguageEstimate(language: "es", confidence: 0.99)
        })
      try expect(
        names.runs.allSatisfy({ $0.voiceId == russian.id }),
        "Ambiguous Sol/Luna proper names must retain RU voice")
    }
    let frenchInsertion = try plan("Привет. Votre code est ici. Пока.", defaultVoice: russian)
    try expect(
      frenchInsertion.runs.map(\.voiceId) == [russian.id, french.id, russian.id],
      "Confident FR insertion in RU reply must use configured FR voice")
    let sameScript = try plan("Bonjour. Hello Sol Luna.")
    try expect(
      sameScript.runs.count == 1 && sameScript.runs[0].voiceId == french.id,
      "Same-script Latin must retain requested voice")
    let misclassifiedRussian = try plan(
      "Привет, мир", defaultVoice: russian,
      estimate: { _ in RenderLanguageEstimate(language: "bg", confidence: 0.99) })
    try expect(
      misclassifiedRussian.runs.allSatisfy({ $0.voiceId == russian.id }),
      "Confident same-script misclassification must not override the requested voice")
    let shortRussian = try plan("код", defaultVoice: russian, estimate: { _ in nil })
    try expect(
      shortRussian.runs[0].voiceId == russian.id,
      "Uncertain same-script monolingual input must retain default")
    try rejects(
      { _ = try plan("код", estimate: { _ in nil }) },
      "Uncertain foreign script must fail explicitly")
    for text in ["42 — 💙\n", "  ", "«»"] {
      let neutral = try plan(text)
      try expect(
        neutral.runs.count == 1 && neutral.runs[0].text == text,
        "Neutral-only input must be preserved")
    }
    let request = RenderPlanRequest(
      text: text, voiceId: french.id, allowedVoices: [french, russian])
    try rejects(
      { _ = try AppleRenderPlanner(request: request, installedLocale: { _ in "en-US" }) },
      "Installed locale mismatch must fail")
    try rejects({ _ = try plan(String(repeating: "x", count: 801)) }, "Oversized input must fail")
    print("Apple render planner fixtures passed")

  }
}
