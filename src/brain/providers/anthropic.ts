/**
 * CLAUDE — the paid brain.
 *
 * The best answers of the lot, and the only one here that costs money. Kept as
 * an option rather than the default so the project runs on a free tier out of
 * the box; switch to it when there is credit on the account and the difference
 * in reasoning is worth a fraction of a cent a turn.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Brain, ThinkOptions } from "../types.ts";
import { SentenceSplitter } from "../stream.ts";

export function anthropic(apiKey: string, model = "claude-opus-5"): Brain {
  const client = new Anthropic({ apiKey });

  return {
    name: "claude",
    model,
    vision: true,
    cost: "metered",

    async think(prompt: string, opts: ThinkOptions): Promise<string> {
      const content: Anthropic.ContentBlockParam[] = [];
      if (opts.image) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: opts.image.mime,
            data: opts.image.bytes.toString("base64"),
          },
        });
      }
      content.push({ type: "text", text: prompt });

      const stream = client.messages.stream(
        {
          model,
          max_tokens: 1024,
          system: opts.system,
          messages: [
            ...opts.history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content },
          ],
        },
        { signal: opts.signal },
      );

      let full = "";
      let first = true;
      const splitter = new SentenceSplitter(opts.onSentence);

      for await (const event of stream) {
        if (opts.signal?.aborted) break;
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;

        if (first) {
          first = false;
          opts.onFirstToken?.();
        }
        full += event.delta.text;
        splitter.push(event.delta.text);
      }

      if (!opts.signal?.aborted) splitter.flush();
      return full;
    },
  };
}
