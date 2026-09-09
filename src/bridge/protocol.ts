/**
 * THE WIRE PROTOCOL
 *
 * The browser stand-in speaks this today; the iOS app in Phase 7 speaks the
 * same thing. Keeping it boring and explicit is the point — this is the
 * seam that has to survive a change of client.
 *
 * Text frames carry JSON control messages. Binary frames carry raw PCM
 * (device -> server) or encoded audio (server -> device), tagged by a
 * one-byte header so a binary frame never needs a matching JSON message.
 */

export const BINARY_TAG = {
  /** device -> server: 16 kHz mono s16le microphone audio */
  micPcm: 0x01,
  /** device -> server: JPEG still, in reply to a captureFrame request */
  frameJpeg: 0x02,
  /** server -> device: audio to play (mime declared in the preceding
   *  speakBegin control message) */
  ttsAudio: 0x10,
} as const;

/** device -> server */
export type ClientMessage =
  | {
      t: "hello";
      label: string;
      capabilities: { audioIn: boolean; audioOut: boolean; frames: boolean; display: boolean };
      battery: number | null;
      /** Client-side wake word engine in use, for the session banner. */
      wake: "porcupine" | "push-to-talk" | "none";
    }
  /** Wake word fired, or the user pressed the talk key. Audio follows. */
  | { t: "wake"; at: number; source: "porcupine" | "push-to-talk" }
  /** User released the talk key / client-side VAD saw end of speech. */
  | { t: "endOfSpeech"; at: number }
  /** The user started talking while we were speaking — barge-in (item 03). */
  | { t: "bargeIn"; at: number }
  /** Transcript from client-side recognition, when STT_PROVIDER=browser. */
  | { t: "transcript"; text: string; final: boolean; at: number }
  | { t: "frameError"; reason: string }
  | { t: "battery"; level: number }
  | { t: "playbackDone"; interrupted: boolean }
  | { t: "pong"; at: number };

/** server -> device */
export type ServerMessage =
  | { t: "ready"; persona: { name: string; greeting: string } }
  /** Ask for one still. Reply with a frameJpeg binary frame or frameError. */
  | { t: "captureFrame"; reason: string }
  /** Audio is about to arrive as binary frames. */
  | { t: "speakBegin"; mime: string; utteranceId: string }
  | { t: "speakEnd"; utteranceId: string }
  /** Stop playing immediately and discard buffered audio. */
  | { t: "speakCancel"; utteranceId: string }
  /** For the client to render — what it heard, what it is doing. */
  | { t: "state"; phase: "idle" | "listening" | "thinking" | "speaking"; detail?: string }
  | { t: "heard"; text: string; final: boolean }
  | { t: "said"; text: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "ping"; at: number };

export function encodeBinary(tag: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length + 1);
  out[0] = tag;
  payload.copy(out, 1);
  return out;
}

export function decodeBinary(buf: Buffer): { tag: number; payload: Buffer } | null {
  if (buf.length < 1) return null;
  return { tag: buf[0]!, payload: buf.subarray(1) };
}
