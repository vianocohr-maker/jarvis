/**
 * A fixed-size PCM ring buffer, so when the wake word fires we still have the
 * quarter-second before it. Without this pre-roll the transcriber loses the
 * first syllable of the sentence and you spend a week blaming the STT.
 */

export class PcmRing {
  private buf: Buffer;
  private write = 0;
  private filled = 0;

  constructor(bytes: number) {
    this.buf = Buffer.alloc(bytes);
  }

  push(chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.write] = chunk[i]!;
      this.write = (this.write + 1) % this.buf.length;
      if (this.filled < this.buf.length) this.filled++;
    }
  }

  /** Everything currently held, oldest first. */
  drain(): Buffer {
    if (this.filled === 0) return Buffer.alloc(0);
    if (this.filled < this.buf.length) return Buffer.from(this.buf.subarray(0, this.write));
    return Buffer.concat([
      Buffer.from(this.buf.subarray(this.write)),
      Buffer.from(this.buf.subarray(0, this.write)),
    ]);
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
  }
}
