import AVFoundation
import SwiftUI

@main
struct JarvisApp: App {
    @StateObject private var model = SessionModel()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
        }
    }
}

/// Everything the UI needs, and the only place the pieces are joined.
///
/// The rule this file follows: the phone decides nothing about the conversation.
/// It captures, transcribes, sends, and speaks what it is told. Turn-taking,
/// barge-in and identity all live on the server, so a second client — the
/// browser today, glasses later — behaves identically without reimplementing
/// any of it.
@MainActor
final class SessionModel: ObservableObject {
    @Published var status: BridgeClient.Status = .offline
    @Published var phase = "idle"
    @Published var detail: String?
    @Published var heard = ""
    @Published var lastSaid = ""
    @Published var notices: [String] = []
    @Published var personaName = "Jarvis"
    @Published var talking = false
    @Published var route = "—"

    /// Plain UserDefaults rather than @AppStorage: that wrapper is built for
    /// Views, and inside an ObservableObject it silently stops publishing.
    ///
    /// The initialiser is a static call rather than an inline expression so the
    /// following brace cannot be mistaken for a trailing closure.
    @Published var serverAddress: String = SessionModel.storedAddress() {
        didSet { UserDefaults.standard.set(serverAddress, forKey: Self.addressKey) }
    }

    private static let addressKey = "serverAddress"

    private static func storedAddress() -> String {
        UserDefaults.standard.string(forKey: addressKey) ?? "192.168.1.10:8787"
    }

    private let bridge = BridgeClient()
    private let capture = AudioCapture()
    private let recognizer = SpeechRecognizer()
    private let speaker = Speaker()
    private let playback = AudioPlayback()

    private var micPermission = false
    private var speechPermission = false

    init() {
        bridge.onStatus = { [weak self] in self?.status = $0 }
        bridge.onMessage = { [weak self] in self?.handle($0) }
        bridge.onAudio = { [weak self] in self?.playback.append($0) }

        capture.onPcm = { [weak self] pcm in
            // The server wants the audio even when the phone is transcribing:
            // it drives voice-activity detection and the speaker check.
            self?.bridge.send(tag: .micPcm, payload: pcm)
        }

        recognizer.onPartial = { [weak self] text in
            self?.heard = text
            self?.bridge.send(.transcript(text: text, final: false, at: nowMillis()))
        }
        recognizer.onFinal = { [weak self] text in
            self?.heard = text
            self?.bridge.send(.transcript(text: text, final: true, at: nowMillis()))
        }
        recognizer.onError = { [weak self] message in
            self?.note("stt: \(message)")
        }

        speaker.onFinished = { [weak self] interrupted in
            self?.bridge.send(.playbackDone(interrupted: interrupted))
        }
        playback.onFinished = { [weak self] interrupted in
            self?.bridge.send(.playbackDone(interrupted: interrupted))
        }
    }

    // MARK: lifecycle

    func begin() {
        SpeechRecognizer.requestPermission { [weak self] granted in
            self?.speechPermission = granted
            if !granted { self?.note("Speech recognition permission denied.") }
        }
        AVAudioApplicationCompat.requestRecordPermission { [weak self] granted in
            self?.micPermission = granted
            if !granted { self?.note("Microphone permission denied.") }
        }
        do {
            try AudioSession.configure()
            route = AudioSession.currentRoute()
        } catch {
            note("Audio session failed: \(error.localizedDescription)")
        }
        connect()
    }

    func connect() {
        bridge.connect(to: serverAddress)
    }

    func disconnect() {
        bridge.disconnect()
    }

    // MARK: talking

    func startTalking() {
        guard status == .online else { return }
        guard micPermission, speechPermission else {
            note("Grant microphone and speech permission first.")
            return
        }

        // Talking over it is an interruption, not a queued request.
        if speaker.isSpeaking || playback.isPlaying {
            speaker.stop()
            playback.cancel()
            bridge.send(.bargeIn(at: nowMillis()))
        }

        talking = true
        heard = ""
        bridge.send(.wake(at: nowMillis()))

        recognizer.start()
        do {
            try capture.start()
        } catch {
            note(error.localizedDescription)
            talking = false
        }
        route = AudioSession.currentRoute()
    }

    func stopTalking() {
        guard talking else { return }
        talking = false
        capture.stop()
        recognizer.stop()
        bridge.send(.endOfSpeech(at: nowMillis()))
    }

    // MARK: server messages

    private func handle(_ message: ServerMessage) {
        switch message {
        case let .ready(name, greeting):
            personaName = name
            if !greeting.isEmpty { lastSaid = greeting }

        case let .state(phase, detail):
            self.phase = phase
            self.detail = detail

        case let .heard(text, _):
            heard = text

        case let .said(text):
            lastSaid = text
            speaker.say(text)

        case let .notice(level, text):
            note("\(level): \(text)")

        case .speakBegin:
            playback.begin()

        case .speakEnd:
            playback.end()

        case .speakCancel:
            playback.cancel()
            speaker.stop()

        case let .captureFrame(reason):
            // No camera in this build. Saying so is better than silence — the
            // server turns it into an honest spoken answer.
            _ = reason
            bridge.send(.frameError(reason: "This client has no camera yet."))

        case .ping, .pong, .unknown:
            break
        }
    }

    private func note(_ text: String) {
        notices.insert(text, at: 0)
        if notices.count > 6 { notices.removeLast() }
    }
}

/// requestRecordPermission moved in iOS 17 and the old one is deprecated;
/// this keeps both paths without scattering #available through the model.
enum AVAudioApplicationCompat {
    static func requestRecordPermission(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        }
    }
}
