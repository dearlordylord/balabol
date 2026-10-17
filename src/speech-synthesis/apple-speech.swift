import AVFoundation
import Foundation
import Darwin

struct Request: Decodable {
    let text: String
    let voiceId: String
    let outputPath: String
}
struct Voice: Encodable {
    let id: String
    let actualLocale: String
}
struct Receipt: Encodable {
    let voiceId: String
    let actualLocale: String
    let frames: Int64
    let sampleRate: Double
    let completed: Bool
}
// The callback owns this buffer until the synchronous main-queue handoff returns.
final class BufferHandoff: @unchecked Sendable {
    let buffer: AVAudioBuffer
    init(_ buffer: AVAudioBuffer) { self.buffer = buffer }
}
@MainActor
final class Writer: NSObject, AVSpeechSynthesizerDelegate {
    let synthesizer = AVSpeechSynthesizer()
    let request: Request
    let voice: AVSpeechSynthesisVoice
    var file: AVAudioFile?
    var frames: Int64 = 0
    var rate: Double = 0
    var eos = false
    var finished = false
    var stopped = false
    var termination: DispatchSourceSignal?

    init(request: Request, voice: AVSpeechSynthesisVoice) {
        self.request = request
        self.voice = voice
        super.init()
        synthesizer.delegate = self
    }
    func start() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.cancel() }
        source.resume()
        termination = source
        let utterance = AVSpeechUtterance(string: request.text)
        utterance.voice = voice
        synthesizer.write(utterance) { [weak self] buffer in
            let handoff = BufferHandoff(buffer)
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.accept(handoff.buffer) }
            } else {
                DispatchQueue.main.sync { self?.accept(handoff.buffer) }
            }
        }
    }
    func cancel() {
        stopped = true
        synthesizer.stopSpeaking(at: .immediate)
        file = nil
        exit(2)
    }
    func accept(_ buffer: AVAudioBuffer) {
        guard !stopped, let pcm = buffer as? AVAudioPCMBuffer else { return }
        if pcm.frameLength == 0 {
            eos = true
            complete()
            return
        }
        guard !eos else { fail("InvalidAudio") }
        do {
            if file == nil {
                rate = pcm.format.sampleRate
                file = try AVAudioFile(forWriting: URL(fileURLWithPath: request.outputPath),
                                       settings: pcm.format.settings,
                                       commonFormat: pcm.format.commonFormat,
                                       interleaved: pcm.format.isInterleaved)
            }
            frames += Int64(pcm.frameLength)
            guard rate > 0, Double(frames) / rate <= 60 else { fail("InvalidAudio") }
            try file?.write(from: pcm)
        } catch { fail("SynthesisWriteFailed") }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                      didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { [weak self] in
            self?.finished = true
            self?.complete()
        }
    }
    func complete() {
        guard eos, finished, !stopped else { return }
        guard frames > 0 else { fail("InvalidAudio") }
        stopped = true
        file = nil
        emit(Receipt(voiceId: voice.identifier, actualLocale: voice.language,
                     frames: frames, sampleRate: rate, completed: true))
        exit(0)
    }
}
struct FailureReceipt: Encodable { let reason: String }
func fail(_ reason: String = "NativeProcessFailed") -> Never {
    if let data = try? JSONEncoder().encode(FailureReceipt(reason: reason)) {
        FileHandle.standardOutput.write(data)
    }
    exit(1)
}
func emit<T: Encodable>(_ value: T) {
    guard let data = try? JSONEncoder().encode(value) else { fail() }
    FileHandle.standardOutput.write(data)
}
@main
struct Main {
    @MainActor static func main() {
        if CommandLine.arguments == [CommandLine.arguments[0], "--voices"] {
            emit(AVSpeechSynthesisVoice.speechVoices().map { Voice(id: $0.identifier, actualLocale: $0.language) })
            return
        }
        let planning = CommandLine.arguments == [CommandLine.arguments[0], "--plan"]
        let data = FileHandle.standardInput.readData(ofLength: planning ? 32769 : 16385)
        if planning {
            guard data.count <= 32768,
                  let request = try? JSONDecoder().decode(RenderPlanRequest.self, from: data) else { fail("InvalidSynthesisRequest") }
            do {
                let planner = try AppleRenderPlanner(request: request, installedLocale: {
                    AVSpeechSynthesisVoice(identifier: $0)?.language
                })
                emit(try planner.plan(request.text))
            } catch let error as RenderPlanningError {
                switch error {
                case .invalidRequest: fail("InvalidSynthesisRequest")
                case .missingInstalledVoice: fail("MissingVoice")
                case .uncertainLanguage: fail("UncertainLanguage")
                case .unsupportedLanguage: fail("UnsupportedLanguage")
                }
            } catch { fail("SynthesisPlanFailed") }
            return
        }
        guard data.count <= 16384,
              let request = try? JSONDecoder().decode(Request.self, from: data),
              !request.text.isEmpty, request.text.utf16.count <= 800,
              request.outputPath.hasPrefix("/"),
              let voice = AVSpeechSynthesisVoice(identifier: request.voiceId) else { fail("InvalidSynthesisRequest") }
        let writer = Writer(request: request, voice: voice)
        writer.start()
        withExtendedLifetime(writer) { RunLoop.main.run() }
    }
}
