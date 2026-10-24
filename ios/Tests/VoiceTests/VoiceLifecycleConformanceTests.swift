import Foundation
import XCTest

@testable import Voice

final class VoiceLifecycleConformanceTests: XCTestCase {
  func testGeneratedLifecycleTracesMatchActualComposedTransition() throws {
    for url in try VoiceITFCorpus.files(prefix: "lifecycle-") {
      let trace = try JSONDecoder().decode(VoiceITFDocument.self, from: Data(contentsOf: url))
      let mapping = VoiceLifecycleITFMapping()
      var state = try mapping.initial()
      for (index, frame) in trace.states.enumerated() {
        let fields = try ITFValue.record(frame.values).record([
          "commands", "event", "previous", "state",
        ])
        let event: ITFValue? = try fields["event"]!.optional { $0 }
        let previous = try mapping.project(state)
        let step: VoiceTransition
        if let event {
          guard index > 0 else { throw VoiceITFError.invalid("initial lifecycle event") }
          step = try mapping.apply(event, state: state)
        } else {
          guard index == 0 else { throw VoiceITFError.invalid("missing lifecycle event") }
          step = VoiceTransition(state: state, commands: [])
        }
        let actual = try mapping.project(step.state)
        let commands = try mapping.commands(step.commands, state: step.state)
        guard previous == fields["previous"], actual == fields["state"],
          commands == fields["commands"]
        else {
          XCTFail(
            "CONFORMANCE_DIVERGENCE \(url.lastPathComponent) step=\(index) event=\(fields["event"]!) previous=\(previous) actual=\(actual) expected=\(fields["state"]!) commands=\(commands) expectedCommands=\(fields["commands"]!)"
          )
          return
        }
        state = step.state
      }
    }
  }
}
