/**
 * THE DEVICE CONTRACT  —  build sheet item 06
 *
 * Everything above this line is device-agnostic. Everything below it is a
 * specific pair of eyes and ears. Three interfaces, and no more:
 *
 *   AudioSource   16 kHz mono PCM frames, pushed as they arrive
 *   FrameSource   still images, pulled on demand (never streamed)
 *   AudioSink     PCM or encoded audio out, interruptible mid-utterance
 *
 * Today these are implemented by a browser page over a WebSocket. In Phase 7
 * an iOS app implements the same three against Meta's Device Access Toolkit.
 * If a change to this file is needed to make the glasses work, that is a
 * design failure here — not there.
 *
 * Two rules that exist because of the hardware, not the software:
 *
 *  1. FrameSource is PULL, never push. Ray-Ban Meta Gen 1 has ~4 hours of
 *     battery and a 720p/30fps Bluetooth ceiling. Continuous video is a
 *     luxury this device cannot afford, so the contract does not offer it.
 *  2. AudioSink.stop() must take effect in tens of milliseconds, not at the
 *     end of the current sentence. Barge-in (item 03) is built on this.
 */

/** Immutable audio format for the whole pipeline. Resampling happens in the
 *  adapter, so nothing above this layer ever thinks about sample rates. */
export const AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  /** 16-bit signed little-endian. */
  bitDepth: 16,
  /** 20 ms at 16 kHz = 320 samples = 640 bytes. Matches what VAD and wake
   *  word engines expect, so no reframing is needed downstream. */
  frameSamples: 320,
} as const;

export type DeviceKind = "browser-bridge" | "glasses" | "mock";

export interface DeviceInfo {
  kind: DeviceKind;
  /** Human name for logs and the session banner. */
  label: string;
  /** What this device can actually do. The capability probe (onboarding A5)
   *  reads this and refuses to promise features the hardware lacks. */
  capabilities: {
    audioIn: boolean;
    audioOut: boolean;
    frames: boolean;
    /** Gen 1 has no display. Never assume this is true. */
    display: boolean;
    /** Reported battery 0..1, or null if the device does not say. */
    battery: number | null;
  };
}

/** A chunk of microphone audio. */
export interface AudioChunk {
  /** Raw PCM, AUDIO.bitDepth / AUDIO.sampleRate / AUDIO.channels. */
  pcm: Buffer;
  /** Device clock, ms since epoch, when this chunk was captured. Used for
   *  latency accounting — do not substitute Date.now() on arrival. */
  capturedAt: number;
}

/** A still image pulled from the device camera. */
export interface Frame {
  bytes: Buffer;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  capturedAt: number;
}

export interface AudioSource {
  /** Begin delivering chunks. Resolves once audio is actually flowing. */
  start(onChunk: (chunk: AudioChunk) => void): Promise<void>;
  stop(): Promise<void>;
  readonly active: boolean;
}

export interface FrameSource {
  /**
   * Pull a single still. Rejects rather than hangs when the device cannot
   * oblige (out of range, camera busy, battery budget exhausted).
   *
   * `reason` is recorded against the frame budget so the capture governor
   * (item 19) can later tell you where the battery went.
   */
  capture(reason: string): Promise<Frame>;
  readonly available: boolean;
}

export interface AudioSink {
  /**
   * Speak. Resolves when playback finishes, or immediately when interrupted
   * by stop() — check the resolved value to tell the two apart.
   */
  play(audio: Buffer, mime: string): Promise<{ interrupted: boolean }>;
  /** Cut playback now. Must be effective within ~50 ms for barge-in to feel
   *  right. Safe to call when nothing is playing. */
  stop(): Promise<void>;
  readonly speaking: boolean;
}

/** What the rest of the program is handed instead of a device. */
export interface Device {
  info: DeviceInfo;
  audioIn: AudioSource;
  audioOut: AudioSink;
  camera: FrameSource;
  /** Fires when the device goes away (unpaired, tab closed, out of range). */
  onDisconnect(handler: () => void): void;
  close(): Promise<void>;
}

/** Produces devices as they connect. The bridge server is one of these; a
 *  future iOS transport is another, and the loop cannot tell them apart.
 *
 *  Generic in the device type so a transport can hand back something wider than
 *  `Device` (its own control channel, say) without the loop ever seeing it. */
export interface DeviceProvider<D extends Device = Device> {
  readonly name: string;
  listen(onDevice: (device: D) => void): Promise<void>;
  close(): Promise<void>;
}
