import Foundation
import XCTest

@testable import Voice

final class VoicePreparationConformanceTests: XCTestCase {
  func testModelGeneratedTracesMatchRealPreparationBoundaryAtEveryStep() throws {
    for url in try VoiceITFCorpus.files(prefix: "preparation-") {
      let trace = try JSONDecoder().decode(VoiceITFDocument.self, from: Data(contentsOf: url))
      guard trace.vars.count == 4, Set(trace.vars) == ["commands", "event", "previous", "state"],
        !trace.states.isEmpty
      else {
        throw VoiceITFError.invalid("trace variables or empty states")
      }
      let mapping = VoicePreparationITFMapping()
      var state = try mapping.initial()
      for (index, frame) in trace.states.enumerated() {
        let fields = try ITFValue.record(frame.values).record([
          "commands", "event", "previous", "state",
        ])
        let event: ITFValue? = try fields["event"]!.optional { $0 }
        let previous = try mapping.project(state)
        let result: VoiceTransition
        if let event {
          guard index > 0 else { throw VoiceITFError.invalid("initial event") }
          result = try mapping.apply(event, state: state)
        } else {
          guard index == 0 else { throw VoiceITFError.invalid("missing event") }
          result = unchangedVoice(state)
        }
        let actual = try mapping.project(result.state)
        let commands = try mapping.project(result.commands, state: result.state)
        guard previous == fields["previous"], actual == fields["state"],
          commands == fields["commands"]
        else {
          XCTFail(
            "CONFORMANCE_DIVERGENCE \(url.lastPathComponent) step=\(index) event=\(fields["event"]!) previous=\(previous) actual=\(actual) expected=\(fields["state"]!) commands=\(commands) expectedCommands=\(fields["commands"]!)"
          )
          return
        }
        state = result.state
      }
    }
  }
}
