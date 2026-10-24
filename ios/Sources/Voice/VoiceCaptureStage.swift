import Foundation

internal enum VoiceCaptureStage: String, Codable, Sendable {
  case preparation, preparationRelease, recording, recordingRelease, publication, processor, firstFrame, mute
  static func recordingPreparation(_ enabled: Bool) -> Self { enabled ? .preparation : .preparationRelease }
}
internal struct VoiceCaptureContext: Codable, Equatable, Sendable {
  enum Application: String, Codable, Sendable { case active, inactive, background, unknown }
  let application: Application
  let protectedDataAvailable: Bool
}
internal struct VoiceCaptureDiagnostic: Codable, Equatable, Sendable {
  enum Outcome: String, Codable, Sendable { case began, completed, failed, cancelled }
  enum Domain: String, Codable, Sendable { case osStatus, avFoundation, liveKit, cocoa, posix, other }
  let stage: VoiceCaptureStage
  let context: VoiceCaptureContext
  let outcome: Outcome
  let domain: Domain?
  let code: Int?
  let underlyingDomain: Domain?
  let underlyingCode: Int?

  init(stage: VoiceCaptureStage, context: VoiceCaptureContext, outcome: Outcome, error: (any Error)? = nil) {
    self.stage = stage; self.context = context; self.outcome = outcome
    let native = error.map { $0 as NSError }
    let domain = native.map { Self.domain($0.domain) }
    self.domain = domain
    self.code = domain == .other ? nil : native?.code
    let underlying = native?.userInfo[NSUnderlyingErrorKey] as? NSError
    let underlyingDomain = underlying.map { Self.domain($0.domain) }
    self.underlyingDomain = underlyingDomain
    self.underlyingCode = underlyingDomain == .other ? nil : underlying?.code
  }
  private static func domain(_ value: String) -> Domain {
    switch value {
    case NSOSStatusErrorDomain: .osStatus
    case "AVFoundationErrorDomain": .avFoundation
    case "io.livekit.swift-sdk": .liveKit
    case NSCocoaErrorDomain: .cocoa
    case NSPOSIXErrorDomain: .posix
    default: .other
    }
  }
}

/// The native adapter reports the precise failing phase before projecting its public failure.
@MainActor internal func performVoiceCaptureStage<Value>(
  _ stage: VoiceCaptureStage, context: () -> VoiceCaptureContext,
  record: (VoiceCaptureDiagnostic) -> Void,
  operation: () async throws -> Value
) async throws -> Value {
  record(VoiceCaptureDiagnostic(stage: stage, context: context(), outcome: .began))
  do {
    try Task.checkCancellation()
    let value = try await operation()
    try Task.checkCancellation()
    record(VoiceCaptureDiagnostic(stage: stage, context: context(), outcome: .completed))
    return value
  } catch {
    if error is CancellationError || Task.isCancelled {
      record(VoiceCaptureDiagnostic(stage: stage, context: context(), outcome: .cancelled))
      throw CancellationError()
    }
    record(VoiceCaptureDiagnostic(stage: stage, context: context(), outcome: .failed, error: error))
    throw VoiceFailure.capture
  }
}
