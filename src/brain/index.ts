/**
 * Picks a brain from configuration, and refuses to start on a combination that
 * cannot work — a missing key, or an unknown backend name — rather than failing
 * mid-sentence on the first question.
 */

import { gemini } from "./providers/gemini.ts";
import { anthropic } from "./providers/anthropic.ts";
import { openAiCompatible, COMPAT_PRESETS } from "./providers/openaiCompat.ts";
import type { Brain } from "./types.ts";

export type { Brain, Message, ThinkOptions } from "./types.ts";

export interface BrainConfig {
  provider: string;
  model: string;
  apiKey: string;
  /** Only for openai-compatible backends whose host is not a known preset. */
  baseUrl?: string;
  /** Whether the chosen model can see. Presets carry a sensible default. */
  vision?: boolean;
}

/** Free-tier defaults, so naming a provider is enough to get something working. */
const DEFAULT_MODEL: Record<string, string> = {
  gemini: "gemini-2.5-flash",
  claude: "claude-opus-5",
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  cerebras: "llama-3.3-70b",
  lmstudio: "local-model",
  ollama: "llama3.2",
};

/** Which presets can see images. Wrong here means silently ignored pictures. */
const PRESET_VISION: Record<string, boolean> = {
  groq: true, // llama-4-scout is multimodal
  openrouter: false, // depends entirely on the model; opt in explicitly
  cerebras: false,
  lmstudio: false, // true only if you loaded a vision model, e.g. a VL variant
  ollama: false, // true for llava / qwen2-vl and friends
};

export function makeBrain(c: BrainConfig): Brain {
  const provider = c.provider.toLowerCase();
  const model = c.model || DEFAULT_MODEL[provider] || "";

  if (provider === "gemini") {
    if (!c.apiKey) {
      throw new Error(
        "BRAIN=gemini needs GEMINI_API_KEY. It is free and takes a minute: " +
          "https://aistudio.google.com/apikey  (no credit card)",
      );
    }
    return gemini(c.apiKey, model);
  }

  if (provider === "claude" || provider === "anthropic") {
    if (!c.apiKey) throw new Error("BRAIN=claude needs ANTHROPIC_API_KEY (billed separately).");
    return anthropic(c.apiKey, model);
  }

  const preset = COMPAT_PRESETS[provider];
  const baseUrl = c.baseUrl || preset?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `Unknown BRAIN "${c.provider}". Options: gemini, claude, ` +
        `${Object.keys(COMPAT_PRESETS).join(", ")}, or set BRAIN_BASE_URL for anything else.`,
    );
  }

  const remote = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl) === false;
  if (remote && !c.apiKey) {
    throw new Error(`BRAIN=${c.provider} needs BRAIN_API_KEY.`);
  }

  return openAiCompatible({
    label: provider,
    baseUrl,
    model,
    apiKey: c.apiKey,
    vision: c.vision ?? PRESET_VISION[provider] ?? false,
    cost: preset?.cost ?? "metered",
    // Local models on a laptop CPU are slow, not broken.
    timeoutMs: remote ? 60_000 : 300_000,
  });
}
