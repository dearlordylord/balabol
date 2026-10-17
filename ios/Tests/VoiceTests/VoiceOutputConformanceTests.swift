import Foundation
import XCTest

@testable import Voice

final class VoiceOutputConformanceTests: XCTestCase {
  func testModelGeneratedTracesMatchRealOutputReducerAtEveryStep() throws {
    for url in try VoiceITFCorpus.files(prefix: "output-") {
      let trace = try JSONDecoder().decode(VoiceITFDocument.self, from: Data(contentsOf: url))
      guard trace.vars.count == 4, Set(trace.vars) == ["commands", "event", "previous", "state"],
        !trace.states.isEmpty
      else {
        throw VoiceITFError.invalid("trace variables or empty states")
      }
      let mapping = VoiceOutputITFMapping()
      var state = VoiceOutputState()
      for (index, frame) in trace.states.enumerated() {
        let fields = try ITFValue.record(frame.values).record([
          "commands", "event", "previous", "state",
        ])
        let input: VoiceOutputEvent? = try fields["event"]!.optional(mapping.event)
        let previous = try mapping.project(state)
        let result: VoiceOutputStep
        if let input {
          guard index > 0 else { throw VoiceITFError.invalid("initial event") }
          result = transitionVoiceOutput(state, input)
        } else {
          guard index == 0 else { throw VoiceITFError.invalid("missing event") }
          result = VoiceOutputStep(state: state, commands: [])
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

enum VoiceITFCorpus {
  static func files(prefix: String) throws -> [URL] {
    let override = ProcessInfo.processInfo.environment["BALABOL_QUINT_TRACE_DIR"]
    let root: URL
    if let override {
      root = URL(fileURLWithPath: override, isDirectory: true)
    } else {
      guard let bundled = Bundle.module.url(forResource: "OutputConformance", withExtension: nil)
      else {
        throw VoiceITFError.invalid("missing bundled corpus")
      }
      root = bundled
    }
    let files = try FileManager.default.contentsOfDirectory(
      at: root, includingPropertiesForKeys: nil
    )
    .filter { $0.lastPathComponent.hasSuffix(".itf.json") }
    guard !files.isEmpty,
      files.allSatisfy({
        $0.lastPathComponent.hasPrefix("output-") || $0.lastPathComponent.hasPrefix("preparation-")
      })
    else {
      throw VoiceITFError.invalid("empty corpus or unrecognized ITF filename")
    }
    let selected = files.filter { $0.lastPathComponent.hasPrefix(prefix) }.sorted {
      $0.lastPathComponent < $1.lastPathComponent
    }
    guard !selected.isEmpty else { throw VoiceITFError.invalid("missing \(prefix) traces") }
    return selected
  }
}
