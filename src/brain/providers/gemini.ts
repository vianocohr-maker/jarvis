/**
 * GOOGLE GEMINI — the free brain.
 *
 * Free tier as of September 2026: 1,500 requests/day and 15/minute on
 * gemini-2.5-flash, the full 1M context, vision included, no credit card, and it
 * does not expire. For a personal assistant that is effectively unlimited —
 * 1,500 turns a day is more talking than anyone does.
 *
 * Two things worth knowing, both deliberate choices rather than oversights:
 *
 *  1. Google may train on free-tier prompts. The paid tier and Vertex do not.
 *     For something that sees your room, decide that consciously. Onboarding
 *     step B4 is where this gets surfaced to the user.
 *
 *  2. `thinkingBudget: 0` is set on purpose. Gemini 2.5 Flash reasons before
 *     answering by default, which is excellent for hard questions and fatal for
 *     a voice loop — it adds seconds before the first token. Voice needs the
 *     first syllable inside 800 ms, so the thinking is switched off.
 */

import type { Brain, ThinkOptions } from "../types.ts";
import { SentenceSplitter, sseLines, httpError } from "../stream.ts";

const HOST = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export function gemini(apiKey: string, model = "gemini-2.5-flash"): Brain {
  return {
    name: "gemini",
    model,
    vision: true,
    cost: "free",

    async think(prompt: string, opts: ThinkOptions): Promise<string> {
      const parts: GeminiPart[] = [];
      if (opts.image) {
        parts.push({
          inlineData: { mimeType: opts.image.mime, data: opts.image.bytes.toString("base64") },
        });
      }
      parts.push({ text: prompt });

      const body = {
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [
          // Gemini calls the assistant "model", not "assistant".
          ...opts.history.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          { role: "user", parts },
        ],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
          // See the note at the top of this file — this is the latency fix.
          thinkingConfig: { thinkingBudget: 0 },
        },
      };

      const res = await fetch(`${HOST}/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) throw await httpError("Gemini", res);

      let full = "";
      let first = true;
      const splitter = new SentenceSplitter(opts.onSentence);

      for await (const data of sseLines(res, opts.signal)) {
        if (opts.signal?.aborted) break;
        let event: {
          candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
          error?: { message?: string };
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error?.message) throw new Error(`Gemini: ${event.error.message}`);

        const chunk =
          event.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (!chunk) continue;

        if (first) {
          first = false;
          opts.onFirstToken?.();
        }
        full += chunk;
        splitter.push(chunk);
      }

      if (!opts.signal?.aborted) splitter.flush();
      return full;
    },
  };
}
