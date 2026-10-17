import XCTest

@testable import Voice

final class VoiceITFDecoderTests: XCTestCase {
  func testTaggedValuesDecodeWithoutErasingTheirKinds() throws {
    let value = try ITFValue.decode(Data(##"{"tag":"Some","value":{"#bigint":"2"}}"##.utf8))
    XCTAssertEqual(value, .variant("Some", .integer(2)))
    XCTAssertEqual(
      try ITFValue.decode(Data(##"{"#set":[{"#bigint":"1"}]}"##.utf8)), .set([.integer(1)]))
  }

  func testSetOrderIsIrrelevantAndListOrderIsPreserved() {
    XCTAssertEqual(ITFValue.set([.integer(1), .integer(2)]), .set([.integer(2), .integer(1)]))
    XCTAssertNotEqual(
      ITFValue.list([.integer(1), .integer(2)]), .list([.integer(2), .integer(1)]))
  }

  func testMalformedAndAmbiguousBoundaryValuesAreRejected() {
    for json in [
      ##"{"#bigint":"1.5"}"##, ##"{"#bigint":"999999999999999999999"}"##,
      ##"{"tag":"Some"}"##, ##"{"#set":[true,true]}"##, ##"{"#unknown":[]}"##, "1",
    ] {
      XCTAssertThrowsError(try ITFValue.decode(Data(json.utf8)), json)
    }
  }

  func testTraceVariablesAndDomainMappingRejectAmbiguity() throws {
    for json in [
      #"{"vars":["commands","event","previous","state","state"],"states":[{}]}"#,
      #"{"vars":["commands","event","previous","state"],"states":[]}"#,
      #"{"vars":["commands","event","previous","state"],"states":[{"state":true,"VoiceOutputTest::VoiceOutputMachine::state":false}]}"#,
      #"{"vars":["Unknown::commands","event","previous","state"],"states":[{}]}"#,
    ] {
      XCTAssertThrowsError(try JSONDecoder().decode(VoiceITFDocument.self, from: Data(json.utf8)))
    }
    let mapping = VoiceOutputITFMapping()
    XCTAssertThrowsError(try mapping.event(.variant("Unknown", .unit)))
    XCTAssertThrowsError(try mapping.event(.variant("Disconnect", .boolean(true))))
    XCTAssertThrowsError(try mapping.event(.variant("Accept", .integer(3))))
    XCTAssertThrowsError(try mapping.identity(.record(["input": .integer(1)])))
    XCTAssertThrowsError(
      try mapping.event(
        .variant("Cut", .record(["nextInput": .variant("Other", .unit), "pending": .list([])]))))
  }

  func testPreparationRequestsUseGenerationDomainAndPositiveMonotoneIds() throws {
    let mapping = VoicePreparationITFMapping()
    XCTAssertEqual(
      try mapping.request(.record(["generation": .integer(1), "id": .integer(65)])).id, 65)
    XCTAssertThrowsError(
      try mapping.request(.record(["generation": .integer(0), "id": .integer(1)])))
    XCTAssertThrowsError(
      try mapping.request(.record(["generation": .integer(3), "id": .integer(1)])))
    XCTAssertThrowsError(
      try mapping.request(.record(["generation": .integer(1), "id": .integer(0)])))
  }

  func testManifestProjectionRejectsInvalidOrUnexpectedPhysicalRouting() throws {
    let mapping = VoiceOutputITFMapping()
    let ids = mapping.identities
    let validAudio = VoiceAudioManifest.SourceAudio(
      encoding: "pcm-s16le", sampleRateHz: 24000, channels: 1)
    let invalidAudio = VoiceAudioManifest.SourceAudio(
      encoding: "pcm-s16le", sampleRateHz: 16000, channels: 1)
    let fixtures: [(String, Int, VoiceAudioManifest.SourceAudio)] = [
      ("TR_fixture", 1, invalidAudio), ("", 1, validAudio),
      ("TR_other", 1, validAudio), ("TR_fixture", 2, validAudio),
    ]
    for (track, publisher, audio) in fixtures {
      let manifest = try VoiceAudioManifest(
        sessionId: ids.uuid(.session, 1), responseId: ids.uuid(.response, 1),
        inputDeliveryId: ids.uuid(.input, 1), outputEpoch: ids.uuid(.epoch, 1),
        publisherIdentity: ids.uuid(.publisher, publisher), trackSid: track, sourceAudio: audio)
      XCTAssertThrowsError(
        try mapping.project(manifest),
        "track=\(track) publisher=\(publisher) rate=\(audio.sampleRateHz)")
      XCTAssertThrowsError(try mapping.project([.prepare(manifest)], state: VoiceOutputState()))
    }
  }

  func testSelectedOutputProjectionRejectsUnexpectedManifestRouting() throws {
    let mapping = VoiceOutputITFMapping()
    let abstract = ITFValue.record([
      "identity": .record(["input": .integer(1), "response": .integer(1), "epoch": .integer(1)]),
      "status": .variant("Playing", .unit), "manifest": .boolean(true), "session": .integer(1),
    ])
    let original = try mapping.output(abstract)
    var wire = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
    var manifest = try XCTUnwrap(wire["manifest"] as? [String: Any])
    manifest["trackSid"] = "TR_other"
    wire["manifest"] = manifest
    wire["error"] = NSNull()
    let wrong = try JSONDecoder().decode(
      VoiceOutput.self, from: JSONSerialization.data(withJSONObject: wire))
    XCTAssertThrowsError(try mapping.project(wrong))
    XCTAssertThrowsError(try mapping.project(VoiceOutputState(current: wrong)))
  }

  func testSymbolicIdentitiesAreStableDistinctAndBounded() throws {
    let mapper = VoiceITFIdentities()
    XCTAssertEqual(try mapper.uuid(.input, 1), try mapper.uuid(.input, 1))
    XCTAssertNotEqual(try mapper.uuid(.input, 1), try mapper.uuid(.response, 1))
    XCTAssertNotEqual(try mapper.uuid(.epoch, 1), try mapper.uuid(.epoch, 2))
    XCTAssertEqual(try mapper.symbol(.response, mapper.uuid(.response, 2)), 2)
    XCTAssertThrowsError(try mapper.uuid(.input, 0))
    XCTAssertThrowsError(try mapper.uuid(.input, 3))
    XCTAssertThrowsError(try mapper.symbol(.input, mapper.uuid(.response, 1)))
  }
}
