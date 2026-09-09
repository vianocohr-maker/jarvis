/**
 * PERSONA ENGINE  —  build sheet item 07
 *
 * Its name, its voice, and how much it says before shutting up. Persisted to
 * disk so onboarding (stage B3) writes it once and every session reads it.
 *
 * Verbosity is deliberately a small enum rather than a slider: item 42 will
 * switch between these automatically from motion data, and it can only do
 * that if the levels are discrete and named.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export type Verbosity = "terse" | "normal" | "full";

export interface Persona {
  name: string;
  /** Spoken once when a device connects. */
  greeting: string;
  verbosity: Verbosity;
  /** Free text folded into the system prompt — accent, manner, quirks. */
  manner: string;
  voice: { provider: "sapi" | "elevenlabs"; id: string; rate: number };
}

export const DEFAULT_PERSONA: Persona = {
  name: "Jarvis",
  greeting: "Online.",
  verbosity: "terse",
  manner:
    "Dry, economical, faintly formal. You do not pad, flatter, or announce " +
    "what you are about to do. When you do not know, you say so in four words.",
  voice: { provider: "sapi", id: "", rate: 1 },
};

const VERBOSITY_RULES: Record<Verbosity, string> = {
  terse:
    "Answer in one or two sentences. The user is walking or busy. No preamble, " +
    "no restating the question, no offering follow-ups. If a number or a name " +
    "answers it, say only that.",
  normal:
    "Answer in two to four sentences. Enough context to be useful, no lists " +
    "unless the answer genuinely is one.",
  full:
    "Answer thoroughly. The user is sitting down and wants the detail, " +
    "including caveats and what you are unsure about.",
};

export function systemPrompt(p: Persona, extra?: string): string {
  return [
    `You are ${p.name}, a voice assistant. Everything you say is spoken aloud, ` +
      `so write for the ear: no markdown, no bullet points, no code blocks, ` +
      `no emoji, no parentheticals. Spell out symbols and units.`,
    p.manner,
    VERBOSITY_RULES[p.verbosity],
    `If asked to look at something and you have not been given an image, say ` +
      `so plainly rather than guessing at what is in front of the user.`,
    extra ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function load(dataDir: string): Persona {
  const path = join(dataDir, "persona.json");
  if (!existsSync(path)) return { ...DEFAULT_PERSONA };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Persona>;
    return { ...DEFAULT_PERSONA, ...raw, voice: { ...DEFAULT_PERSONA.voice, ...raw.voice } };
  } catch {
    return { ...DEFAULT_PERSONA };
  }
}

export function save(dataDir: string, p: Persona): void {
  const path = join(dataDir, "persona.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(p, null, 2), "utf8");
}
