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
