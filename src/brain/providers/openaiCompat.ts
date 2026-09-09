/**
 * ONE ADAPTER, MANY FREE BACKENDS
 *
 * Everything below speaks the OpenAI chat-completions shape, so they differ only
 * by base URL, key, and model name:
 *
 *   lmstudio    http://localhost:1234/v1      free, private, no key, no network
 *   ollama      http://localhost:11434/v1     same, if you install it
 *   groq        https://api.groq.com/openai/v1  free tier, very fast
 *   openrouter  https://openrouter.ai/api/v1   has models suffixed :free
 *   cerebras    https://api.cerebras.ai/v1     free tier, very fast
 *
 * `vision` is a constructor argument rather than something detected, because the
 * endpoint cannot tell you and guessing wrong means the model silently ignores
 * the image and describes something it never saw. Text-only models must declare
 * false so a visual turn can say "I can't see with this brain" instead.
 */

import type { Brain, ThinkOptions } from "../types.ts";
import { SentenceSplitter, sseLines, httpError } from "../stream.ts";

export interface CompatOptions {
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  vision: boolean;
  cost: "free" | "metered";
  /** Local servers can be very slow on modest hardware; do not cut them off. */
  timeoutMs?: number;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function openAiCompatible(o: CompatOptions): Brain {
  return {
    name: o.label,
    model: o.model,
    vision: o.vision,
    cost: o.cost,

    async think(prompt: string, opts: ThinkOptions): Promise<string> {
      const messages: Array<{ role: string; content: string | ContentPart[] }> = [
        { role: "system", content: opts.system },
        ...opts.history.map((m) => ({ role: m.role, content: m.content })),
      ];

      if (opts.image && o.vision) {
        const dataUrl = `data:${opts.image.mime};base64,${opts.image.bytes.toString("base64")}`;
        messages.push({
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ],
        });
      } else {
        messages.push({ role: "user", content: prompt });
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;

      // A local model on a laptop CPU can take a long time to produce anything.
      // Combine our own ceiling with the caller's abort signal.
      const timeout = AbortSignal.timeout(o.timeoutMs ?? 120_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: o.model, messages, stream: true, max_tokens: 1024 }),
          signal,
        });
      } catch (err) {
        const e = err as Error;
        if (e.name === "TimeoutError") {
          throw new Error(`${o.label} did not respond in time. Is the server running?`);
        }
        if (e.name === "AbortError") throw e;
        // A refused connection to localhost is the common case, and the message
        // should say what to do about it.
        throw new Error(
          `Could not reach ${o.label} at ${o.baseUrl} — ${e.message}. ` +
            `If this is LM Studio, open it and start the server under Developer.`,
        );
      }

      if (!res.ok) throw await httpError(o.label, res);

      let full = "";
      let first = true;
      const splitter = new SentenceSplitter(opts.onSentence);

      for await (const data of sseLines(res, opts.signal)) {
        if (opts.signal?.aborted) break;
        if (data === "[DONE]") break;

        let event: {
          choices?: Array<{ delta?: { content?: string | null } }>;
          error?: { message?: string };
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error?.message) throw new Error(`${o.label}: ${event.error.message}`);

        const chunk = event.choices?.[0]?.delta?.content;
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

/** Base URLs for the hosts above, so .env can name one instead of a URL. */
export const COMPAT_PRESETS: Record<string, { baseUrl: string; cost: "free" | "metered" }> = {
  lmstudio: { baseUrl: "http://localhost:1234/v1", cost: "free" },
  ollama: { baseUrl: "http://localhost:11434/v1", cost: "free" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", cost: "free" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", cost: "free" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", cost: "free" },
};
