/**
 * The brain. Streaming, sentence-chunked, and abortable.
 *
 * Sentence chunking is what buys the latency budget: the first sentence goes to
 * the synthesizer while the model is still writing the second. Waiting for a
 * complete response before speaking would put a two-second reply somewhere
 * north of 2500 ms, and the whole loop would feel dead.
 *
 * Abortable because of barge-in (item 03): when the user talks over us we stop
 * generating as well as stop speaking, so we are not billed for words nobody
 * will ever hear.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ThinkOptions {
  system: string;
  history: Message[];
  /** Optional image for a look-at-this turn. */
  image?: { bytes: Buffer; mime: "image/jpeg" | "image/png" };
  /** Fired once, on the very first token — this is the number that matters. */
  onFirstToken?: () => void;
  /** Fired per complete sentence, ready to speak. */
  onSentence: (sentence: string) => void;
  signal?: AbortSignal;
}

export class Brain {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /** Returns the complete text, having already emitted it sentence by sentence. */
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

    const messages: Anthropic.MessageParam[] = [
      ...opts.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content },
    ];

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 1024,
        system: opts.system,
        messages,
      },
      { signal: opts.signal },
    );

    let full = "";
    let pending = "";
    let first = true;

    for await (const event of stream) {
      if (opts.signal?.aborted) break;
      if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;

      if (first) {
        first = false;
        opts.onFirstToken?.();
      }

      const piece = event.delta.text;
      full += piece;
      pending += piece;

      for (;;) {
        const cut = firstSentenceBreak(pending);
        if (cut < 0) break;
        const sentence = pending.slice(0, cut + 1).trim();
        pending = pending.slice(cut + 1);
        if (sentence) opts.onSentence(sentence);
      }
    }

    const tail = pending.trim();
    if (tail && !opts.signal?.aborted) opts.onSentence(tail);
    return full;
  }
}

/**
 * Index of the first sentence-ending punctuation that is not an abbreviation or
 * a decimal point. Conservative on purpose — speaking half a sentence sounds
 * far worse than waiting one more token.
 */
function firstSentenceBreak(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const next = s[i + 1];
    // Need whitespace (or end of buffer) after the stop.
    if (next !== undefined && next !== " " && next !== "\n" && next !== '"' && next !== "'") continue;
    // A digit either side of a full stop is a decimal, not an ending.
    if (ch === "." && isDigit(s[i - 1]) && isDigit(s[i + 2])) continue;
    // Single capital before a full stop is probably an initial.
    if (ch === "." && i >= 1 && isUpper(s[i - 1]) && !isLetter(s[i - 2])) continue;
    // Don't emit until there is something after it, or we have enough to be sure.
    if (next === undefined && s.length < 12) continue;
    return i;
  }
  return -1;
}

const isDigit = (c?: string) => !!c && c >= "0" && c <= "9";
const isUpper = (c?: string) => !!c && c >= "A" && c <= "Z";
const isLetter = (c?: string) => !!c && /[a-zA-Z]/.test(c);
