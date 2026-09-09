import AVFoundation
import Speech

/// On-device speech recognition and synthesis.
///
/// Both are free and built into iOS, which is the whole reason this client needs
/// no API keys of its own. It matches the server's STT_PROVIDER=browser and
/// TTS_PROVIDER=client paths: the device sends text up and speaks text back
/// down, so no audio has to cross the wire for a normal turn.
///
/// `requiresOnDeviceRecognition` is set wherever the language supports it. It is
/// a little less accurate than Apple's servers and it means the audio never
/// leaves the phone, which for something you wear seems the right trade.
final class SpeechRecognizer {
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
        ?? SFSpeechRecognizer(locale: Locale(identifier: "en_GB"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var onPartial: ((String) -> Void)?
    var onFinal: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private(set) var listening = false
    private var lastText = ""

    static func requestPermission(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { done(status == .authorized) }
        }
    }

    var available: Bool { recognizer?.isAvailable ?? false }

    func start() {
        guard !listening, let recognizer, recognizer.isAvailable else {
            onError?("Speech recognition is not available on this device.")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request
        lastText = ""
        listening = true

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                self.lastText = text
                DispatchQueue.main.async {
                    if result.isFinal {
                        self.onFinal?(text)
                    } else {
                        self.onPartial?(text)
                    }
                }
            }
            if error != nil, self.listening {
                // A recognition error mid-utterance still leaves us whatever was
                // heard so far, which is usually the whole sentence.
                DispatchQueue.main.async { self.finishWithLastText() }
            }
        }
    }

    /// Feed the same PCM already being streamed to the server.
    func append(_ buffer: AVAudioPCMBuffer) {
        request?.append(buffer)
    }

    func stop() {
        guard listening else { return }
        listening = false
        request?.endAudio()
        // Give the recogniser a moment to emit its own final result before
        // forcing one; cutting it off here loses the last word.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.finishWithLastText()
        }
    }

    private func finishWithLastText() {
        task?.cancel()
        task = nil
        request = nil
        let text = lastText
        lastText = ""
        if !text.isEmpty { onFinal?(text) }
    }
}

/// Speaks the `said` messages when TTS_PROVIDER=client.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    var onFinished: ((Bool) -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    func say(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice()
        // Slightly above default: the stock rate sounds sluggish in a sentence
        // you are waiting on.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
        synth.speak(utterance)
    }

    /// Barge-in. `.immediate` cuts mid-word, which is what interrupting means.
    func stop() {
        guard synth.isSpeaking else { return }
        synth.stopSpeaking(at: .immediate)
    }

    var isSpeaking: Bool { synth.isSpeaking }

    /// Prefer a premium or enhanced voice when the user has downloaded one —
    /// the difference between those and the compact default is most of the gap
    /// between this and a paid voice.
    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let language = Locale.preferredLanguages.first ?? "en-GB"
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix(String(language.prefix(2)))
        }
        if #available(iOS 16.0, *) {
            if let premium = candidates.first(where: { $0.quality == .premium }) { return premium }
        }
        if let enhanced = candidates.first(where: { $0.quality == .enhanced }) { return enhanced }
        return candidates.first ?? AVSpeechSynthesisVoice(language: language)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinished?(false)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinished?(true)
    }
}
