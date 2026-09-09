/**
 * VOICE ACTIVITY DETECTION  —  the machinery behind barge-in (item 03)
 *
 * Deliberately dependency-free: RMS energy against an adaptive noise floor.
 * This is not as good as Silero, and it does not need to be — its only job in
 * Phase 1 is answering "is a human talking right now" well enough to stop
 * playback and to close a turn on silence.
 *
 * The floor falls fast and rises slowly, so walking into a noisy room raises
 * the bar within a second or two while a brief lull does not make it
 * hair-trigger. Item 44 replaces these constants with values measured against
 * the real rooms during onboarding.
 */

export interface VadOptions {
  /** How far above the noise floor counts as speech. */
  speechFactor?: number;
  /** Consecutive speech frames before we believe it. 3 frames = 60 ms. */
  onsetFrames?: number;
  /** Consecutive quiet frames before a turn is over. 40 frames = 800 ms. */
  hangoverFrames?: number;
}

export interface VadEvents {
  onSpeechStart?: () => void;
  onSpeechEnd?: (durationMs: number) => void;
}

export class Vad {
  private floor = 0.005;
  private speaking = false;
  private speechRun = 0;
  private quietRun = 0;
  private startedAt = 0;

  private readonly speechFactor: number;
  private readonly onsetFrames: number;
  private readonly hangoverFrames: number;
  private events: VadEvents;

  constructor(events: VadEvents = {}, opts: VadOptions = {}) {
    this.events = events;
    this.speechFactor = opts.speechFactor ?? 3.0;
    this.onsetFrames = opts.onsetFrames ?? 3;
    this.hangoverFrames = opts.hangoverFrames ?? 40;
  }

  /** True while a human appears to be talking. Read this to decide barge-in. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Current noise floor, 0..1. Onboarding B2 reports this to the user. */
  get noiseFloor(): number {
    return this.floor;
  }

  /** Feed one frame of s16le mono PCM. */
  push(pcm: Buffer): void {
    const level = rms(pcm);
    const threshold = Math.max(this.floor * this.speechFactor, 0.012);
    const loud = level > threshold;

    if (loud) {
      this.speechRun++;
      this.quietRun = 0;
    } else {
      this.quietRun++;
      this.speechRun = 0;
      // Adapt only on quiet frames, so speech itself never raises the floor.
      // Down fast, up slow.
      const rate = level < this.floor ? 0.3 : 0.02;
      this.floor = this.floor * (1 - rate) + level * rate;
    }

    if (!this.speaking && this.speechRun >= this.onsetFrames) {
      this.speaking = true;
      this.startedAt = Date.now();
      this.events.onSpeechStart?.();
    } else if (this.speaking && this.quietRun >= this.hangoverFrames) {
      this.speaking = false;
      this.events.onSpeechEnd?.(Date.now() - this.startedAt);
    }
  }

  reset(): void {
    this.speaking = false;
    this.speechRun = 0;
    this.quietRun = 0;
  }
}

/** Root mean square of s16le PCM, normalised to 0..1. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
