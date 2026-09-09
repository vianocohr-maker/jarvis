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

import type { ImageMime } from "../adapters/types.ts";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

/** What a tool looks like to a model. Mirrors the registry, minus the code. */
export interface ToolSpec {
  name: string;
  description: string;
  params: Record<
    string,
    { type: "string" | "number" | "boolean"; description: string; enum?: string[]; required?: boolean }
  >;
}

/**
 * What the caller does with a tool the model asked for. Returning `halt` stops
 * generation — used when an action needs a spoken yes first, so the model does
 * not carry on narrating as though the thing already happened.
 */
export type ToolOutcome = { summary: string } | { halt: string };

export interface ThinkOptions {
  system: string;
  history: Message[];
  /** Optional image for a look-at-this turn. */
  image?: { bytes: Buffer; mime: ImageMime };
  /** Tools the model may call this turn. Omit for a plain conversational turn. */
  tools?: ToolSpec[];
  /** Runs a tool the model asked for and returns what to tell it. */
  runTool?: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  /** Fired once, on the very first token — the number that decides how it feels. */
  onFirstToken?: () => void;
  /** Fired per complete sentence, ready to speak. */
  onSentence: (sentence: string) => void;
  /** Fired when a tool is about to run, so the loop can say "checking…". */
  onToolStart?: (name: string) => void;
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
