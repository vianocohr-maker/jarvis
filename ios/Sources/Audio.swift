import AVFoundation
import UIKit

func UIDeviceLabel() -> String {
    "\(UIDevice.current.name) (\(UIDevice.current.systemName) \(UIDevice.current.systemVersion))"
}

func batteryLevel() -> Double? {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let level = UIDevice.current.batteryLevel
    return level < 0 ? nil : Double(level)
}

/// Microphone capture, resampled to the 16 kHz mono s16le the pipeline expects.
///
/// iOS will not hand you 16 kHz. The hardware runs at 44.1 or 48 kHz, and on
/// Bluetooth it changes underneath you when the route switches — which is
/// exactly what happens when the glasses connect. So the tap format is read at
/// install time, never assumed, and an AVAudioConverter does the rest.
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    /// Called with 16 kHz mono s16le, roughly every 20 ms. This is what the
    /// server receives.
    var onPcm: ((Data) -> Void)?

    /// The same audio, untouched, in whatever format the hardware chose.
    /// SFSpeechRecognizer wants this rather than the resampled bytes — it does
    /// its own conversion and rejects a format it did not ask for.
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?

    private(set) var running = false

    func start() throws {
        guard !running else { return }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw NSError(
                domain: "Jarvis", code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "The microphone is not available. Another app may be using it."]
            )
        }

        guard let target = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: AudioFormat.sampleRate,
            channels: AVAudioChannelCount(AudioFormat.channels),
            interleaved: true
        ) else { throw NSError(domain: "Jarvis", code: 2) }

        outputFormat = target
        converter = AVAudioConverter(from: inputFormat, to: target)

        // Buffer size is a request, not a promise — the tap delivers what the
        // hardware gives, and the converter copes.
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) {
            [weak self] buffer, _ in
            guard let self else { return }
            self.onBuffer?(buffer)
            self.convert(buffer)
        }

        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        running = false
    }

    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard
            let converter,
            let outputFormat,
            let onPcm
        else { return }

        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return
        }

        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            // Hand the input over exactly once; a second yes would replay it.
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }

        guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return }
        let byteCount = Int(out.frameLength) * MemoryLayout<Int16>.size
        onPcm(Data(bytes: channel[0], count: byteCount))
    }
}

/// Playback of server-rendered speech, and the audio session both directions share.
///
/// `.playAndRecord` with `.allowBluetooth` is what routes through the glasses:
/// without it iOS quietly falls back to the phone's own microphone while still
/// playing out of the headset, which sounds like the app half working.
enum AudioSession {
    static func configure() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        try session.setPreferredSampleRate(AudioFormat.sampleRate)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// What the audio is actually coming out of, for the status line.
    static func currentRoute() -> String {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        return outputs.first?.portName ?? "unknown"
    }

    static func isBluetooth() -> Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains {
            [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE].contains($0.portType)
        }
    }
}

/// Plays encoded audio pushed from the server (ElevenLabs, SAPI and friends).
/// Unused while TTS_PROVIDER=client, but the protocol allows it and a client
/// that cannot honour half the protocol is a trap for whoever changes the
/// server next.
final class AudioPlayback: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var pending = Data()
    var onFinished: ((Bool) -> Void)?

    func begin() { pending = Data() }

    func append(_ chunk: Data) { pending.append(chunk) }

    func end() {
        guard !pending.isEmpty else { onFinished?(false); return }
        do {
            let player = try AVAudioPlayer(data: pending)
            player.delegate = self
            self.player = player
            player.play()
        } catch {
            onFinished?(false)
        }
        pending = Data()
    }

    /// Barge-in depends on this landing immediately, not at the end of the
    /// current utterance.
    func cancel() {
        guard let player, player.isPlaying else { return }
        player.stop()
        self.player = nil
        onFinished?(true)
    }

    var isPlaying: Bool { player?.isPlaying ?? false }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        self.player = nil
        onFinished?(false)
    }
}
