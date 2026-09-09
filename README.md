# Jarvis

A personal voice assistant for Ray-Ban Meta Gen 1. The brain runs here; the
glasses are a peripheral.

**Phase 1 of 7 — the spine.** The voice loop works today with a browser as the
stand-in device. Nothing in this phase needs the glasses, an iPhone, or a Mac.

Full plan: [the build sheet](https://claude.ai/code/artifact/73201acc-f7d2-4c00-9b62-12fcd5bcabb6).

## Run it

```bash
npm install
cp .env.example .env
```

Put an Anthropic API key in `.env` — that is the only one required. Then:

```bash
npm start
```

Open <http://localhost:8787>, allow the microphone and camera, and **hold Space**
to talk. Try "what is the capital of France", then "look at this and tell me
what you see".

No hardware handy? Drive it from a terminal instead:

```bash
node scripts/mock-device.ts "look at this and tell me what you see"
```

## What works

| # | Feature | Notes |
|---|---------|-------|
| 01 | Wake word | Push-to-talk today. Add `PICOVOICE_ACCESS_KEY` for "Hey Jarvis" |
| 02 | Streaming voice loop | Sentence-chunked, so speech starts before the answer is finished |
| 03 | Barge-in | Talk over it and generation *and* playback stop |
| 04 | Voice identity | Interface + heuristic; fails open until a real embedder lands |
| 05 | Conversation mode | 8-second follow-up window, no wake word needed |
| 06 | Device adapter layer | `src/adapters/types.ts` — the contract |
| 07 | Persona engine | `data/persona.json`, drives voice and verbosity |
| 08 | Session manager | Battery, capabilities, disconnects, camera timeouts |

Latency is reported per turn against an 800 ms budget:

```
turn 3  wake 1ms -> stt 294ms -> llmFirstToken 340ms -> tts 88ms  = 723ms
```

## Architecture

```
device (browser now, iPhone in Phase 7)
  │  WebSocket — src/bridge/protocol.ts
  ▼
bridge  ──▶  Device { audioIn, audioOut, camera }
  │            src/adapters/types.ts
  ▼
VoiceLoop  ──▶  STT ──▶ Brain (Claude) ──▶ TTS
  src/brain/loop.ts
```

The one decision everything rests on is **item 06**: three interfaces —
`AudioSource`, `FrameSource`, `AudioSink` — between the capture hardware and
everything above it. The browser implements them over a socket today. In Phase 7
an iOS app implements the same three against Meta's Device Access Toolkit, and
nothing above that line changes. See `src/adapters/glasses/README.md`.

Two rules in that contract come from the hardware, not from taste:

- **Frames are pulled, never streamed.** Gen 1 has ~4 hours of battery and a
  720p/30fps Bluetooth ceiling. A frame is spent only when the words ask for one
  — see `VISUAL_CUES` in `src/brain/loop.ts`.
- **`AudioSink.stop()` must land in tens of milliseconds.** Barge-in is built on
  it, and barge-in is what makes the difference between a demo and something you
  still use in a month.

## Configuration

Everything lives in `.env`; see `.env.example` for the full list.

**Speech in** — `STT_PROVIDER=browser` (free, uses the client's own recognition,
noticeably worse in noise and absent on iOS) or `deepgram` (~$0.0043/min, much
better latency). Switch to Deepgram before Phase 2.

**Speech out** — `TTS_PROVIDER=client` (the device speaks it, zero setup and
zero round trip), `sapi` (Windows voices, offline, rendered here), or
`elevenlabs` (the one you will actually want).

**Wake word** — leave `PICOVOICE_ACCESS_KEY` blank for push-to-talk. It runs on
the *client* by design, so audio does not cross the wire until it fires. That
matters little on a laptop and a great deal on a battery.

## Layout

```
src/
  adapters/types.ts        the contract — read this first
  adapters/bridge/         WebSocket transport, turns a client into a Device
  adapters/glasses/        empty; Phase 7 notes live here
  bridge/protocol.ts       the wire format iOS will speak
  audio/                   VAD, ring buffer, voice identity
  stt/  tts/               providers behind one interface each
  brain/llm.ts             streaming Claude, sentence-chunked, abortable
  brain/loop.ts            the state machine
  session.ts  persona.ts  telemetry.ts  config.ts
public/index.html          the stand-in device
scripts/mock-device.ts     a device that is not there
```

## Not in Phase 1

Memory, tools, and manners are Phases 3, 4 and 5 — this thing has no
recollection of yesterday and cannot do anything except talk. That is on
purpose; the loop had to feel right first.
