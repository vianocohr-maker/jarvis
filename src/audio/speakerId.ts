/**
 * VOICE IDENTITY  —  build sheet item 04
 *
 * The point of this is not security, it is not answering the television. A
 * proper voiceprint is a neural embedding, and that is a Phase 2 dependency
 * (Picovoice Eagle, or an ONNX speaker model). Until then this ships an honest
 * interface with a spectral heuristic behind it, and a mode that admits when
 * it is not really filtering.
 *
 * Written this way on purpose: the loop calls accepts() from day one, so when
 * a real embedder lands nothing above this file changes.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type IdMode = "off" | "heuristic";

interface Print {
  /** Mean spectral centroid and its spread across the enrolment samples. */
  centroid: number;
  spread: number;
  samples: number;
}

export class SpeakerId {
  private print: Print | null = null;
  private path: string;
  readonly mode: IdMode;

  constructor(dataDir: string, mode: IdMode = "heuristic") {
    this.path = join(dataDir, "voiceprint.json");
    this.mode = mode;
    if (existsSync(this.path)) {
      try {
        this.print = JSON.parse(readFileSync(this.path, "utf8")) as Print;
      } catch {
        this.print = null;
      }
    }
  }

  get enrolled(): boolean {
    return this.print !== null;
  }

  /** Onboarding B1 feeds three spoken sentences through this. */
  enroll(samples: Buffer[]): void {
    const cs = samples.map(centroid).filter((c) => c > 0);
    if (!cs.length) return;
    const mean = cs.reduce((a, b) => a + b, 0) / cs.length;
    const variance = cs.reduce((a, c) => a + (c - mean) ** 2, 0) / cs.length;
    this.print = {
      centroid: mean,
      spread: Math.max(Math.sqrt(variance), mean * 0.12),
      samples: cs.length,
    };
    writeFileSync(this.path, JSON.stringify(this.print, null, 2), "utf8");
  }

  /**
   * Should we answer this? Returns true when unenrolled or off — failing open
   * is correct here, because refusing to answer its owner is a worse failure
   * than occasionally answering the radio.
   */
  accepts(pcm: Buffer): { ok: boolean; why: string } {
    if (this.mode === "off") return { ok: true, why: "identity check off" };
    if (!this.print) return { ok: true, why: "no voiceprint enrolled yet" };
    const c = centroid(pcm);
    if (c <= 0) return { ok: true, why: "sample too short to judge" };
    const z = Math.abs(c - this.print.centroid) / this.print.spread;
    return z <= 2.5
      ? { ok: true, why: `matches voiceprint, z=${z.toFixed(2)}` }
      : { ok: false, why: `does not match voiceprint, z=${z.toFixed(2)}` };
  }
}

/**
 * Energy-gated zero-crossing rate — a crude proxy for where a voice sits,
 * computed without an FFT dependency. It separates two adults in the same room
 * maybe half the time, which is exactly why this is called a heuristic and the
 * mode that uses it fails open.
 */
function centroid(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n < 400) return 0;
  let crossings = 0;
  let energy = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 1; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    energy += Math.abs(s) / 32768;
    prev = s;
  }
  if (energy / n < 0.005) return 0;
  return (crossings / n) * 8000;
}
