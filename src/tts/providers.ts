/**
 * The three voices.
 *
 * `client`     — the device's own synthesizer. Default, because it needs no
 *                key, no binary, and no round trip.
 * `sapi`       — Windows System.Speech rendered to a WAV here and shipped.
 *                Better than it has any right to be, and entirely offline.
 * `elevenlabs` — the one you will actually want once the loop works.
 */

import { spawn } from "node:child_process";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Speech, TtsProvider } from "./types.ts";

/** The device speaks for itself; nothing to render. */
export function clientTts(): TtsProvider {
  return {
    name: "client",
    clientSide: true,
    async synthesize(): Promise<Speech> {
      throw new Error("clientTts renders nothing — the device speaks the text itself.");
    },
  };
}

export function sapiTts(rate = 0): TtsProvider {
  return {
    name: "sapi",
    clientSide: false,
    async synthesize(text: string): Promise<Speech> {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-tts-"));
      const wav = join(dir, "out.wav");

      // Base64 the text so quotes, newlines and apostrophes cannot break the
      // PowerShell command line. Rate is System.Speech's -10..10 scale.
      const b64 = Buffer.from(text, "utf8").toString("base64");
      const clamped = Math.max(-10, Math.min(10, Math.round(rate)));
      const script = [
        "Add-Type -AssemblyName System.Speech;",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
        `$s.Rate = ${clamped};`,
        `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}');`,
        `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));`,
        "$s.Speak($t);",
        "$s.Dispose();",
      ].join(" ");

      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

      try {
        const bytes = await readFile(wav);
        return { bytes, mime: "audio/wav" };
      } finally {
        await unlink(wav).catch(() => {});
      }
    },
  };
}

export function elevenLabsTts(apiKey: string, voiceId: string): TtsProvider {
  return {
    name: "elevenlabs",
    clientSide: false,
    async synthesize(text: string): Promise<Speech> {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model; anything slower blows the budget.
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.4, similarity_boost: 0.75 },
          }),
        },
      );

      if (!res.ok) {
        throw new Error(`ElevenLabs returned ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
    },
  };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
  });
}
