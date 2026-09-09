# The glasses adapter (Phase 7)

Empty on purpose. When the Mac arrives, this is the only directory that needs
new code, and the contract it has to satisfy is already written down in
`../types.ts`.

## What goes here

Nothing, possibly. The iOS app is a separate Swift project — it speaks the
WebSocket protocol in `../../bridge/protocol.ts`, so the *server* side needs no
new adapter at all. The bridge already treats its client as a remote device that
can vanish, whose camera can refuse, and whose clock is not ours.

That was the point of building the stand-in as a browser over a socket rather
than as local mic and webcam calls. Phase 7 is then:

1. A Swift app that opens a WebSocket to this server.
2. `hello` with real capabilities — `frames: true`, `display: false` on Gen 1.
3. Mic audio from the Bluetooth audio session, resampled to 16 kHz mono s16le,
   sent as `micPcm` binary frames.
4. `captureFrame` handled through Meta's Device Access Toolkit photo capture,
   replied to as a `frameJpeg` binary frame.
5. `AVSpeechSynthesizer` for `said` messages, or playback of `ttsAudio` bytes
   when the server renders the voice.
6. Porcupine iOS for the wake word, so audio does not stream until it fires.

If any of that turns out to need a change to `../types.ts` or
`../../bridge/protocol.ts`, the design failed here in Phase 1 — not there.

## What the toolkit will and will not give you

- Camera streaming and photo capture: yes, Gen 1 included. Capped at
  **720p/30fps** over Bluetooth regardless of the sensor.
- Microphone and speakers: **not** through the toolkit. They arrive as a
  standard Bluetooth audio profile, which is a separate code path with its own
  failure modes. This is why onboarding A4 confirms the audio route out loud.
- Display: none on Gen 1. `capabilities.display` must be `false`, and nothing
  in the app may assume otherwise.
- Wake word: you cannot hijack "Hey Meta". You ship your own.

Battery is the constraint that shapes everything: roughly four hours, halved by
sustained streaming. Frames are pulled, never streamed — see the note at the top
of `../types.ts`.
