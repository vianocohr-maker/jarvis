import Foundation

/// The socket to the bridge.
///
/// Reconnects on its own, because a phone in a pocket loses Wi-Fi constantly and
/// an assistant that needs a manual reconnect is one you stop using. Backoff is
/// capped so it does not end up minutes behind when the network comes back.
final class BridgeClient: NSObject {
    enum Status: Equatable {
        case offline
        case connecting
        case online
    }

    private var task: URLSessionWebSocketTask?
    private lazy var session: URLSession = {
        URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }()

    private var url: URL?
    private var reconnectAttempt = 0
    private var deliberatelyClosed = false

    var onStatus: ((Status) -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    var onAudio: ((Data) -> Void)?

    private(set) var status: Status = .offline {
        didSet { if status != oldValue { onStatus?(status) } }
    }

    // MARK: connect

    func connect(to address: String) {
        // Accept "192.168.1.10:8787", "ws://…", or "http://…" — people paste all
        // three, and refusing two of them is a bad first five minutes.
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "ws://" + text }
        text = text.replacingOccurrences(of: "http://", with: "ws://")
        text = text.replacingOccurrences(of: "https://", with: "wss://")
        guard var components = URLComponents(string: text) else { return }
        if components.path.isEmpty || components.path == "/" { components.path = "/ws" }
        guard let resolved = components.url else { return }

        url = resolved
        deliberatelyClosed = false
        openSocket()
    }

    func disconnect() {
        deliberatelyClosed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        status = .offline
    }

    private func openSocket() {
        guard let url else { return }
        status = .connecting
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive()
    }

    // MARK: send

    func send(_ message: ClientMessage) {
        guard
            status == .online,
            let data = try? JSONSerialization.data(withJSONObject: message.json),
            let text = String(data: data, encoding: .utf8)
        else { return }
        task?.send(.string(text)) { _ in }
    }

    /// Binary frames carry a one-byte tag so they never need a matching JSON
    /// message — see BinaryTag.
    func send(tag: BinaryTag, payload: Data) {
        guard status == .online else { return }
        var framed = Data([tag.rawValue])
        framed.append(payload)
        task?.send(.data(framed)) { _ in }
    }

    // MARK: receive

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    if let data = text.data(using: .utf8),
                       let parsed = ServerMessage.parse(data) {
                        DispatchQueue.main.async { self.handle(parsed) }
                    }
                case let .data(data):
                    self.handleBinary(data)
                @unknown default:
                    break
                }
                self.receive()

            case .failure:
                DispatchQueue.main.async { self.dropped() }
            }
        }
    }

    private func handle(_ message: ServerMessage) {
        // Keepalives are answered here rather than bothering the UI with them.
        if case let .ping(at) = message {
            send(.pong(at: at))
            return
        }
        onMessage?(message)
    }

    private func handleBinary(_ data: Data) {
        guard let first = data.first, first == BinaryTag.ttsAudio.rawValue else { return }
        onAudio?(data.dropFirst())
    }

    private func dropped() {
        status = .offline
        task = nil
        guard !deliberatelyClosed else { return }

        reconnectAttempt += 1
        let delay = min(pow(1.6, Double(reconnectAttempt)), 20)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.deliberatelyClosed, self.status == .offline else { return }
            self.openSocket()
        }
    }
}

extension BridgeClient: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol proto: String?
    ) {
        DispatchQueue.main.async {
            self.reconnectAttempt = 0
            self.status = .online
            // The server will not treat this as a device until it says hello.
            self.send(.hello(label: UIDeviceLabel(), frames: false, battery: batteryLevel()))
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        DispatchQueue.main.async { self.dropped() }
    }
}
