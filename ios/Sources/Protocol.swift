import Foundation

/// The wire protocol, mirroring src/bridge/protocol.ts.
///
/// This file and that one have to agree exactly. If you change one, change the
/// other in the same commit — the seam between them is the whole reason the
/// backend never had to learn what a pair of glasses is.
enum BinaryTag: UInt8 {
    /// device -> server: 16 kHz mono s16le microphone audio
    case micPcm = 0x01
    /// device -> server: JPEG still, answering a captureFrame request
    case frameJpeg = 0x02
    /// server -> device: audio to play
    case ttsAudio = 0x10
}

/// Audio format for the whole pipeline. Fixed on both sides; the client
/// resamples to meet it rather than negotiating.
enum AudioFormat {
    static let sampleRate: Double = 16_000
    static let channels: UInt32 = 1
}

// MARK: - device -> server

/// Hand-rolled rather than Codable because every message has a different shape
/// and a `t`-tagged enum encoder is more ceremony than the six cases justify.
enum ClientMessage {
    case hello(label: String, frames: Bool, battery: Double?)
    case wake(at: Int64)
    case endOfSpeech(at: Int64)
    case bargeIn(at: Int64)
    case transcript(text: String, final: Bool, at: Int64)
    case frameError(reason: String)
    case battery(level: Double)
    case playbackDone(interrupted: Bool)
    case pong(at: Int64)

    var json: [String: Any] {
        switch self {
        case let .hello(label, frames, battery):
            return [
                "t": "hello",
                "label": label,
                "capabilities": [
                    "audioIn": true,
                    "audioOut": true,
                    "frames": frames,
                    "display": true,
                ],
                "battery": battery as Any,
                // No wake word yet: the talk button is the trigger. Porcupine
                // needs an access key and a binary dependency, and the first
                // build wants neither.
                "wake": "push-to-talk",
            ]
        case let .wake(at):
            return ["t": "wake", "at": at, "source": "push-to-talk"]
        case let .endOfSpeech(at):
            return ["t": "endOfSpeech", "at": at]
        case let .bargeIn(at):
            return ["t": "bargeIn", "at": at]
        case let .transcript(text, final, at):
            return ["t": "transcript", "text": text, "final": final, "at": at]
        case let .frameError(reason):
            return ["t": "frameError", "reason": reason]
        case let .battery(level):
            return ["t": "battery", "level": level]
        case let .playbackDone(interrupted):
            return ["t": "playbackDone", "interrupted": interrupted]
        case let .pong(at):
            return ["t": "pong", "at": at]
        }
    }
}

// MARK: - server -> device

enum ServerMessage {
    case ready(personaName: String, greeting: String)
    case captureFrame(reason: String)
    case speakBegin(mime: String, utteranceId: String)
    case speakEnd(utteranceId: String)
    case speakCancel(utteranceId: String)
    case state(phase: String, detail: String?)
    case heard(text: String, final: Bool)
    case said(text: String)
    case notice(level: String, text: String)
    case ping(at: Int64)
    /// Anything this build does not know about. Ignored rather than fatal, so an
    /// older app keeps working against a newer server.
    case unknown(String)

    static func parse(_ data: Data) -> ServerMessage? {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dict = object as? [String: Any],
            let t = dict["t"] as? String
        else { return nil }

        switch t {
        case "ready":
            let persona = dict["persona"] as? [String: Any] ?? [:]
            return .ready(
                personaName: persona["name"] as? String ?? "Jarvis",
                greeting: persona["greeting"] as? String ?? ""
            )
        case "captureFrame":
            return .captureFrame(reason: dict["reason"] as? String ?? "")
        case "speakBegin":
            return .speakBegin(
                mime: dict["mime"] as? String ?? "audio/mpeg",
                utteranceId: dict["utteranceId"] as? String ?? ""
            )
        case "speakEnd":
            return .speakEnd(utteranceId: dict["utteranceId"] as? String ?? "")
        case "speakCancel":
            return .speakCancel(utteranceId: dict["utteranceId"] as? String ?? "")
        case "state":
            return .state(
                phase: dict["phase"] as? String ?? "idle",
                detail: dict["detail"] as? String
            )
        case "heard":
            return .heard(
                text: dict["text"] as? String ?? "",
                final: dict["final"] as? Bool ?? false
            )
        case "said":
            return .said(text: dict["text"] as? String ?? "")
        case "notice":
            return .notice(
                level: dict["level"] as? String ?? "info",
                text: dict["text"] as? String ?? ""
            )
        case "ping":
            return .ping(at: (dict["at"] as? NSNumber)?.int64Value ?? 0)
        default:
            return .unknown(t)
        }
    }
}

func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
