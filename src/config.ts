import { fileURLToPath } from "node:url";

/** Settings, read once at boot. Missing required values fail loudly here
 *  rather than three layers down mid-conversation. */

function opt(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export type SttProvider = "deepgram" | "browser";
export type TtsProvider = "client" | "sapi" | "elevenlabs";

const brainProvider = opt("BRAIN", "gemini").toLowerCase();

/** The key each backend wants, so .env can keep them side by side. */
function brainKey(provider: string): string {
  if (provider === "gemini") return opt("GEMINI_API_KEY");
  if (provider === "claude" || provider === "anthropic") return opt("ANTHROPIC_API_KEY");
  return opt("BRAIN_API_KEY");
}

export const config = {
  port: Number(opt("PORT", "8787")),

  brain: {
    provider: brainProvider,
    model: opt("BRAIN_MODEL"),
    apiKey: brainKey(brainProvider),
    baseUrl: opt("BRAIN_BASE_URL") || undefined,
    /** Override when you know the loaded model can see. */
    vision: opt("BRAIN_VISION") ? opt("BRAIN_VISION") === "true" : undefined,
  },

  stt: {
    provider: opt("STT_PROVIDER", "browser") as SttProvider,
    deepgramKey: opt("DEEPGRAM_API_KEY"),
  },

  tts: {
    provider: opt("TTS_PROVIDER", "client") as TtsProvider,
    elevenLabsKey: opt("ELEVENLABS_API_KEY"),
    elevenLabsVoice: opt("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
  },

  /** Where "look at this" gets its picture from.
   *  "device"  the connected client's camera (webcam today)
   *  "folder"  newest photo in a watched folder — glasses photos arriving via
   *            Meta AI auto-import and iCloud, needing no app at all */
  frames: {
    source: opt("FRAME_SOURCE", "device") as "device" | "folder",
    folder: opt("FRAME_FOLDER"),
    maxAgeMinutes: Number(opt("FRAME_MAX_AGE_MIN", "15")),
  },

  /** Item 30/36. "browser" gives it a real Chrome; "off" leaves it able only
   *  to talk. Anything that changes something still needs a spoken yes. */
  tools: {
    enabled: opt("TOOLS", "off") !== "off",
    headed: opt("BROWSER_HEADED", "true") !== "false",
    profileDir: opt("BROWSER_PROFILE_DIR"),
    /** Empty means anywhere. Naming hosts is the safer way to start. */
    allowedHosts: opt("BROWSER_ALLOWED_HOSTS")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
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
    warnings.push(
      "STT_PROVIDER=deepgram but DEEPGRAM_API_KEY is empty — falling back to browser recognition.",
    );
  }
  if (config.tts.provider === "elevenlabs" && !config.tts.elevenLabsKey) {
    warnings.push(
      "TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty — falling back to Windows SAPI.",
    );
  }
  if (!config.picovoiceKey) {
    warnings.push("No PICOVOICE_ACCESS_KEY — wake word is off, hold SPACE to talk.");
  }
  return warnings;
}
