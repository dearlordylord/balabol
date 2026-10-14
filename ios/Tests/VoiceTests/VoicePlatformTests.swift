import Foundation
import Testing

@testable import Voice

struct VoicePlatformTests {
  private func active(muted: Bool = false) -> VoiceState {
    var state = VoiceState()
    _ = state.transition(.start)
    _ = state.transition(.permission(state.generation, true))
    let session = UUID()
    _ = state.transition(.bootstrapped(state.generation, session, UUID()))
    _ = state.transition(.connected(state.generation, session, false))
    if muted {
      _ = state.transition(.mute)
      _ = state.transition(.muted(state.generation, true))
    }
    return state
  }
  @Test func queuedPlatformNotificationCannotCrossCaptureOrObservationLifetime() {
    var epoch = VoicePlatformEpoch()
    let queued = epoch.identity
    #expect(epoch.accepts(queued))
    epoch.advance(to: UUID())
    let muted = epoch.identity
    epoch.advance(to: UUID())
    #expect(!epoch.accepts(queued))
    #expect(!epoch.accepts(muted))
    #expect(epoch.accepts(epoch.identity))
  }
  @Test func producerClosureKeepsUnknownAdmissionAndRejectsWrongScope() {
    var state = active()
    let session = state.sessionId!
    let incarnation = state.backendIncarnationId!
    let input = UUID()
    let association = VoiceAdmissionAssociation(
      backendIncarnationId: incarnation, sessionId: session, deliveryId: input)
    state.associations[input] = association
    state.admissions[input] = .checking(deliveryId: input, text: "Handed speech")
    state.utterances = [input]
    let revision = state.checkpointRevision
    _ = state.transition(.platform(.interrupted))
    _ = state.transition(.producerUnavailable(UUID(), incarnation))
    _ = state.transition(.producerUnavailable(session, UUID()))
    #expect(state.drainingSession == session)
    _ = state.transition(.sealFailed(session))
    #expect(state.capture == .paused && state.drainingSession == session)
    _ = state.transition(.producerUnavailable(session, incarnation))
    #expect(state.drainingSession == nil)
    #expect(state.pendingAssociations == [association])
    #expect(state.checkpointRevision == revision)
    #expect(state.admissions[input] == .checking(deliveryId: input, text: "Handed speech"))
    _ = state.transition(.resume)
    #expect(state.startMuted && state.capture == .resuming)
  }
  @Test func onlyExactSchemaValid404SuppliesProducerClosureEvidence() {
    let valid = Data(#"{"error":{"code":"SessionNotFound","message":""}}"#.utf8)
    #expect(HTTPVoiceControl.isProducerClosure(statusCode: 404, data: valid))
    for code in [200, 400, 401, 403, 500, 503] {
      #expect(!HTTPVoiceControl.isProducerClosure(statusCode: code, data: valid))
    }
    let malformed = [
      #"{"error":{"code":"SessionNotFound"}}"#,
      #"{"error":{"code":"SessionNotFound","message":null}}"#,
      #"{"error":{"code":"sessionnotfound","message":"missing"}}"#,
      #"{"error":{"code":"Unavailable","message":"SessionNotFound"}}"#,
      "<html>SessionNotFound</html>",
    ]
    for body in malformed {
      #expect(!HTTPVoiceControl.isProducerClosure(statusCode: 404, data: Data(body.utf8)))
    }
    let oversized = Data(
      (#"{"error":{"code":"SessionNotFound","message":""# + String(repeating: "x", count: 1001)
        + #""}}"#).utf8)
    #expect(!HTTPVoiceControl.isProducerClosure(statusCode: 404, data: oversized))
  }
  @Test func interruptionPreservesIntentAndRequiresExplicitResume() {
    var state = active(muted: true)
    let old = state.generation
    _ = state.transition(.platform(.interrupted))
    #expect(state.capture == .paused)
    #expect(state.wantsListening && state.wantsMuted)
    #expect(state.generation > old)
    _ = state.transition(.platform(.resumeRecommended(false)))
    #expect(state.capture == .paused)
    #expect(state.canResume)
    _ = state.transition(.resume)
    #expect(state.capture == .resuming)
    #expect(state.startMuted)
  }
  @Test func endWhilePausedRejectsLatePlatformAndConnectedEvents() {
    var state = active()
    let old = state.generation
    _ = state.transition(.platform(.interrupted))
    _ = state.transition(.end)
    _ = state.transition(.ended(state.generation))
    _ = state.transition(.platform(.resumeRecommended(true)))
    _ = state.transition(.connected(old, UUID(), false))
    _ = state.transition(.resume)
    #expect(state.capture == .ended)
    #expect(!state.wantsListening)
  }
  @Test func routeAndResetNeverAutomaticallyResume() {
    var state = active()
    _ = state.transition(.platform(.routeChanged(privateOutputRemoved: false)))
    #expect(state.capture == .listening)
    _ = state.transition(.platform(.routeChanged(privateOutputRemoved: true)))
    #expect(state.capture == .paused)
    _ = state.transition(.platform(.servicesReset))
    #expect(state.capture == .paused)
    _ = state.transition(.resume)
    let attempt = state.generation
    _ = state.transition(.failed(attempt, .capture))
    #expect(state.capture == .paused)
    #expect(state.canResume)
  }
  @Test func servicesLossFencesOldMuteAndRetry() {
    var state = active()
    let old = state.generation
    _ = state.transition(.platform(.servicesLost))
    _ = state.transition(.muted(old, false))
    _ = state.transition(.retryReady(old))
    #expect(state.capture == .paused)
    #expect(state.wantsListening)
  }
}
