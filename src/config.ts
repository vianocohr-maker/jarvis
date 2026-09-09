import { fileURLToPath } from "node:url";

/** Settings, read once at boot. Missing required values fail loudly here
 *  rather than three layers down mid-conversation. */

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in, then run again.`,
    );
  }
  return v.trim();
}

function opt(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export type SttProvider = "deepgram" | "browser";
export type TtsProvider = "client" | "sapi" | "elevenlabs";

export const config = {
  port: Number(opt("PORT", "8787")),
  model: opt("MODEL", "claude-opus-5"),
  anthropicKey: req("ANTHROPIC_API_KEY"),

  stt: {
    provider: opt("STT_PROVIDER", "browser") as SttProvider,
    deepgramKey: opt("DEEPGRAM_API_KEY"),
  },

  tts: {
    provider: opt("TTS_PROVIDER", "client") as TtsProvider,
    elevenLabsKey: opt("ELEVENLABS_API_KEY"),
    elevenLabsVoice: opt("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
  },

  /** Handed to the client; the wake word runs there so audio does not stream
   *  until it fires. Blank means push-to-talk. */
  picovoiceKey: opt("PICOVOICE_ACCESS_KEY"),

  /** Item 05: how long conversation mode stays open after an answer. */
  followUpWindowMs: 8_000,

  dataDir: fileURLToPath(new URL("../data/", import.meta.url)),
} as const;

export function validate(): string[] {
  const warnings: string[] = [];
  if (config.stt.provider === "deepgram" && !config.stt.deepgramKey) {
    warnings.push("STT_PROVIDER=deepgram but DEEPGRAM_API_KEY is empty — falling back to browser recognition.");
  }
  if (config.tts.provider === "elevenlabs" && !config.tts.elevenLabsKey) {
    warnings.push("TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty — falling back to Windows SAPI.");
  }
  if (!config.picovoiceKey) {
    warnings.push("No PICOVOICE_ACCESS_KEY — wake word is off, hold SPACE to talk.");
  }
  return warnings;
}
