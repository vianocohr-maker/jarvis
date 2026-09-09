import SwiftUI

/// Deliberately plain. The interesting surface of this thing is your voice, and
/// a screen you have to look at defeats the point of wearing it.
struct ContentView: View {
    @EnvironmentObject var model: SessionModel
    @State private var editingAddress = false

    var body: some View {
        VStack(spacing: 18) {
            header

            Spacer()

            Text(model.heard.isEmpty ? " " : model.heard)
                .font(.title3)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal)

            Text(model.lastSaid)
                .font(.title2.weight(.medium))
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal)

            Spacer()

            talkButton

            if let first = model.notices.first {
                Text(first)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }

            footer
        }
        .padding()
        .onAppear { model.begin() }
        .sheet(isPresented: $editingAddress) { addressSheet }
    }

    private var header: some View {
        HStack {
            Circle()
                .fill(statusColour)
                .frame(width: 10, height: 10)
            Text(statusText)
                .font(.subheadline)
            Spacer()
            Button {
                editingAddress = true
            } label: {
                Image(systemName: "gearshape")
            }
        }
    }

    /// Hold to talk. A press-and-hold rather than a toggle because it makes the
    /// end of your turn unambiguous — no waiting on silence detection, and no
    /// way to leave the microphone open by accident.
    private var talkButton: some View {
        Circle()
            .fill(model.talking ? Color.red : Color.accentColor)
            .frame(width: 148, height: 148)
            .overlay {
                VStack(spacing: 6) {
                    Image(systemName: model.talking ? "waveform" : "mic.fill")
                        .font(.system(size: 40))
                    Text(model.talking ? "Listening" : "Hold to talk")
                        .font(.caption)
                }
                .foregroundStyle(.white)
            }
            .scaleEffect(model.talking ? 1.06 : 1)
            .animation(.easeOut(duration: 0.12), value: model.talking)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !model.talking { model.startTalking() } }
                    .onEnded { _ in model.stopTalking() }
            )
            .disabled(model.status != .online)
            .opacity(model.status == .online ? 1 : 0.4)
    }

    private var footer: some View {
        HStack(spacing: 14) {
            Label(model.phase, systemImage: "circle.dashed")
            if let detail = model.detail { Text(detail) }
            Spacer()
            Label(model.route, systemImage: "speaker.wave.2")
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }

    private var addressSheet: some View {
        NavigationStack {
            Form {
                Section("Bridge address") {
                    TextField("192.168.1.10:8787", text: $model.serverAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Text("The computer running `npm start`, on the same network. "
                         + "Its address is printed when the server boots.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        model.connect()
                        editingAddress = false
                    }
                }
            }
        }
    }

    private var statusColour: Color {
        switch model.status {
        case .online: return .green
        case .connecting: return .orange
        case .offline: return .red
        }
    }

    private var statusText: String {
        switch model.status {
        case .online: return model.personaName
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        }
    }
}
