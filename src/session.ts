/**
 * SESSION & CONNECTION MANAGER  —  build sheet item 08
 *
 * Tracks one connected device and degrades out loud. The rule this enforces:
 * when something is wrong the user hears about it, because a voice assistant
 * that silently stops working is worse than one that admits it is broken.
 */

import type { Device } from "./adapters/types.ts";

export type Phase = "idle" | "listening" | "thinking" | "speaking";

export interface SessionEvents {
  onPhase?: (phase: Phase, detail?: string) => void;
  onNotice?: (level: "info" | "warn" | "error", text: string) => void;
  onGone?: () => void;
}

/** Below this, the capture governor (item 19) will start refusing frames. */
const LOW_BATTERY = 0.15;

export class Session {
  readonly device: Device;
  readonly startedAt = Date.now();
  private _phase: Phase = "idle";
  private events: SessionEvents;
  private warnedLowBattery = false;
  private turns = 0;

  constructor(device: Device, events: SessionEvents = {}) {
    this.device = device;
    this.events = events;
    device.onDisconnect(() => {
      this.notice("warn", `${device.info.label} disconnected.`);
      this.events.onGone?.();
    });
  }

  get phase(): Phase {
    return this._phase;
  }

  setPhase(phase: Phase, detail?: string): void {
    if (this._phase === phase) return;
    this._phase = phase;
    this.events.onPhase?.(phase, detail);
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.events.onNotice?.(level, text);
  }

  countTurn(): number {
    return ++this.turns;
  }

  /** Called whenever the device reports battery. Warns once, not every time. */
  observeBattery(level: number): void {
    if (level <= LOW_BATTERY && !this.warnedLowBattery) {
      this.warnedLowBattery = true;
      this.notice("warn", `Battery at ${Math.round(level * 100)} percent. Camera use will be limited.`);
    }
    if (level > LOW_BATTERY + 0.1) this.warnedLowBattery = false;
  }

  /**
   * Ask the device for a still, but never let a broken camera hang a turn.
   * Returns null and speaks the reason rather than throwing into the loop.
   */
  async tryCapture(reason: string, timeoutMs = 4000) {
    if (!this.device.info.capabilities.frames || !this.device.camera.available) {
      this.notice("warn", "No camera on this device.");
      return null;
    }
    try {
      return await Promise.race([
        this.device.camera.capture(reason),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("camera timed out")), timeoutMs),
        ),
      ]);
    } catch (err) {
      this.notice("warn", `Could not get a picture: ${(err as Error).message}`);
      return null;
    }
  }

  banner(): string {
    const c = this.device.info.capabilities;
    const bits = [
      c.audioIn ? "mic" : null,
      c.audioOut ? "speaker" : null,
      c.frames ? "camera" : null,
      c.display ? "display" : "no display",
      c.battery !== null ? `battery ${Math.round(c.battery * 100)}%` : null,
    ].filter(Boolean);
    return `${this.device.info.label} [${this.device.info.kind}] — ${bits.join(", ")}`;
  }
}
