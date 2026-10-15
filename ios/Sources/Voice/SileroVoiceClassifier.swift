import CryptoKit
import Foundation
import OnnxRuntimeBindings

internal struct VoiceActivityModelInfo: Decodable {
  let version: String
  let revision: String
  let filename: String
  let sha256: String
  let bytes: Int
  let sampleRateHz: Int
  let windowSamples: Int
  let contextSamples: Int
  let speechThreshold: Double
}

internal actor SileroVoiceClassifier: VoiceActivityClassifier {
  private let environment: ORTEnv
  private let session: ORTSession
  private var context = [Float](repeating: 0, count: 64)
  private var state = [Float](repeating: 0, count: 256)

  init(modelURL: URL, manifestURL: URL) throws {
    let info = try JSONDecoder().decode(
      VoiceActivityModelInfo.self, from: Data(contentsOf: manifestURL))
    let model = try Data(contentsOf: modelURL, options: .mappedIfSafe)
    guard info.version == "v6.2.3", info.revision == "5cd7945676eb32225748052e2e6a0580e4686a08",
      info.bytes == 2_327_524, model.count == info.bytes,
      info.sha256 == "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
      SHA256.hash(data: model).map({ String(format: "%02x", $0) }).joined() == info.sha256,
      info.sampleRateHz == 16000, info.windowSamples == 512, info.contextSamples == 64,
      info.speechThreshold == 0.5
    else { throw VoiceActivityError.modelUnavailable }
    let environment = try ORTEnv(loggingLevel: .error)
    let options = try ORTSessionOptions()
    try options.setIntraOpNumThreads(1)
    try options.setLogSeverityLevel(.error)
    self.environment = environment
    self.session = try ORTSession(
      env: environment, modelPath: modelURL.path, sessionOptions: options)
  }
  static func bundled() throws -> SileroVoiceClassifier {
    guard let model = Bundle.main.url(forResource: "silero-v6.2.3", withExtension: "onnx"),
      let manifest = Bundle.main.url(forResource: "activity-model", withExtension: "json")
    else { throw VoiceActivityError.modelUnavailable }
    return try Self(modelURL: model, manifestURL: manifest)
  }
  func reset() {
    context = [Float](repeating: 0, count: 64)
    state = [Float](repeating: 0, count: 256)
  }
  func probability(_ frame: [Float]) throws -> Float {
    guard frame.count == 512, frame.allSatisfy({ $0.isFinite && abs($0) <= 1 }) else {
      throw VoiceActivityError.invalidFrame
    }
    let input = context + frame
    let inputTensor = try tensor(input, shape: [1, 576])
    let stateTensor = try tensor(state, shape: [2, 1, 128])
    var rate: Int64 = 16000
    let rateTensor = try ORTValue(
      tensorData: NSMutableData(bytes: &rate, length: 8), elementType: .int64, shape: [])
    let outputs = try session.run(
      withInputs: ["input": inputTensor, "state": stateTensor, "sr": rateTensor],
      outputNames: ["output", "stateN"], runOptions: nil)
    guard let probabilityValue = outputs["output"], let stateValue = outputs["stateN"] else {
      throw VoiceActivityError.inference
    }
    let probabilities = try floats(probabilityValue, count: 1)
    let nextState = try floats(stateValue, count: 256)
    guard let probability = probabilities.first, probability.isFinite,
      (0...1).contains(probability),
      nextState.allSatisfy({ $0.isFinite })
    else { throw VoiceActivityError.invalidProbability }
    context = Array(frame.suffix(64))
    state = nextState
    return probability
  }
  private func tensor(_ values: [Float], shape: [NSNumber]) throws -> ORTValue {
    let data = values.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress, length: $0.count) }
    return try ORTValue(tensorData: data, elementType: .float, shape: shape)
  }
  private func floats(_ value: ORTValue, count: Int) throws -> [Float] {
    let data = try value.tensorData() as Data
    guard data.count == count * MemoryLayout<Float>.size else { throw VoiceActivityError.inference }
    return data.withUnsafeBytes { bytes in
      (0..<count).map {
        bytes.loadUnaligned(fromByteOffset: $0 * MemoryLayout<Float>.size, as: Float.self)
      }
    }
  }
}
