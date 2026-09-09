/**
 * THE BRAIN INTERFACE
 *
 * One shape, several backends — which model answers should be a line in .env,
 * not a rewrite. Every backend must do the same four things:
 *
 *   stream          so the first sentence is spoken while the rest is written
 *   accept images   so "look at this" works
 *   abort           so barge-in stops generation, not just playback
 *   report vision   so a visual turn can refuse early instead of lying
 */

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ThinkOptions {
  system: string;
  history: Message[];
  /** Optional image for a look-at-this turn. */
  image?: { bytes: Buffer; mime: "image/jpeg" | "image/png" };
  /** Fired once, on the very first token — the number that decides how it feels. */
  onFirstToken?: () => void;
  /** Fired per complete sentence, ready to speak. */
  onSentence: (sentence: string) => void;
  signal?: AbortSignal;
}

export interface Brain {
  readonly name: string;
  readonly model: string;
  /** False for text-only backends. A visual turn checks this and says so. */
  readonly vision: boolean;
  /** Roughly what a turn costs, for the banner. "free" is a real answer. */
  readonly cost: "free" | "metered";
  /** Returns the complete text, having already emitted it sentence by sentence. */
  think(prompt: string, opts: ThinkOptions): Promise<string>;
}
