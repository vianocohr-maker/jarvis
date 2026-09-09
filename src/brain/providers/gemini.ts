/**
 * GOOGLE GEMINI — the free brain, with tool calling.
 *
 * Free tier as of September 2026: 1,500 requests/day and 15/minute on
 * gemini-2.5-flash, the full 1M context, vision included, no credit card, and it
 * does not expire. Note that a turn using tools costs several requests against
 * that quota, not one — a browsing task can easily be five or six.
 *
 * Two things worth knowing, both deliberate:
 *
 *  1. Google may train on free-tier prompts. The paid tier and Vertex do not.
 *     Onboarding step B4 is where that gets put to the user.
 *
 *  2. `thinkingBudget` is 0 for plain conversation and raised when tools are in
 *     play. Flash reasons before answering by default, which is fatal for a
 *     voice loop's first token but genuinely useful when deciding which button
 *     to click. Latency matters less once we have already said "checking".
 */

import type { Brain, ThinkOptions, ToolSpec } from "../types.ts";
import { SentenceSplitter, sseLines, httpError } from "../stream.ts";

const HOST = "https://generativelanguage.googleapis.com/v1beta";

/** Stop a confused model looping forever on a site that will not cooperate. */
const MAX_TOOL_ROUNDS = 8;

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

export function gemini(apiKey: string, model = "gemini-2.5-flash"): Brain {
  return {
    name: "gemini",
    model,
    vision: true,
    cost: "free",

    async think(prompt: string, opts: ThinkOptions): Promise<string> {
      const first: Part[] = [];
      if (opts.image) {
        first.push({
          inlineData: { mimeType: opts.image.mime, data: opts.image.bytes.toString("base64") },
        });
      }
      first.push({ text: prompt });

      const contents: Content[] = [
        // Gemini calls the assistant "model", not "assistant".
        ...opts.history.map(
          (m): Content => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }),
        ),
        { role: "user", parts: first },
      ];

      const usingTools = !!opts.tools?.length && !!opts.runTool;
      const splitter = new SentenceSplitter(opts.onSentence);
      let full = "";
      let announcedFirstToken = false;

      for (let round = 0; round < (usingTools ? MAX_TOOL_ROUNDS : 1); round++) {
        if (opts.signal?.aborted) break;

        const body: Record<string, unknown> = {
          systemInstruction: { parts: [{ text: opts.system }] },
          contents,
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7,
            // See the note at the top of this file.
            thinkingConfig: { thinkingBudget: usingTools ? 512 : 0 },
          },
        };
        if (usingTools) {
          body.tools = [{ functionDeclarations: opts.tools!.map(toDeclaration) }];
        }

        const res = await fetch(`${HOST}/models/${model}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!res.ok) throw await httpError("Gemini", res);

        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        let roundText = "";

        for await (const data of sseLines(res, opts.signal)) {
          if (opts.signal?.aborted) break;
          let event: {
            candidates?: Array<{ content?: { parts?: Part[] } }>;
            error?: { message?: string };
          };
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          if (event.error?.message) throw new Error(`Gemini: ${event.error.message}`);

          for (const part of event.candidates?.[0]?.content?.parts ?? []) {
            if (part.functionCall?.name) {
              calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
            }
            if (part.text) {
              if (!announcedFirstToken) {
                announcedFirstToken = true;
                opts.onFirstToken?.();
              }
              roundText += part.text;
              full += part.text;
              splitter.push(part.text);
            }
          }
        }

        if (!calls.length || opts.signal?.aborted) break;

        // Record what the model asked for, then answer each call.
        contents.push({
          role: "model",
          parts: [
            ...(roundText ? [{ text: roundText }] : []),
            ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          ],
        });

        const responses: Part[] = [];
        let halted: string | null = null;

        for (const call of calls) {
          opts.onToolStart?.(call.name);
          const outcome = await opts.runTool!(call.name, call.args);
          if ("halt" in outcome) {
            halted = outcome.halt;
            break;
          }
          responses.push({
            functionResponse: { name: call.name, response: { result: outcome.summary } },
          });
        }

        if (halted) {
          // Something needs a human. Say that and stop — carrying on would have
          // the model narrating an action that has not happened.
          splitter.push(halted);
          full += (full ? " " : "") + halted;
          break;
        }

        contents.push({ role: "user", parts: responses });
      }

      if (!opts.signal?.aborted) splitter.flush();
      return full;
    },
  };
}

function toDeclaration(t: ToolSpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(t.params)) {
    properties[name] = {
      type: spec.type.toUpperCase(),
      description: spec.description,
      ...(spec.enum ? { enum: spec.enum } : {}),
    };
    if (spec.required) required.push(name);
  }
  return {
    name: t.name,
    description: t.description,
    parameters: { type: "OBJECT", properties, ...(required.length ? { required } : {}) },
  };
}
