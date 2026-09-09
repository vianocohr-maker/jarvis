/**
 * Shared plumbing for every brain: sentence splitting and SSE reading.
 *
 * Both live here rather than in each provider because getting either subtly
 * wrong shows up as a voice that stutters or clips, and debugging that three
 * times over is a waste of an evening.
 */

/**
 * Emits complete sentences as text arrives. Conservative by design — speaking
 * half a clause sounds far worse than waiting one more token.
 */
export class SentenceSplitter {
  private pending = "";
  private onSentence: (s: string) => void;

  constructor(onSentence: (s: string) => void) {
    this.onSentence = onSentence;
  }

  push(piece: string): void {
    this.pending += piece;
    for (;;) {
      const cut = firstSentenceBreak(this.pending);
      if (cut < 0) break;
      const sentence = this.pending.slice(0, cut + 1).trim();
      this.pending = this.pending.slice(cut + 1);
      if (sentence) this.onSentence(sentence);
    }
  }

  /** Emit whatever is left. Call once the stream ends and was not aborted. */
  flush(): void {
    const tail = this.pending.trim();
    this.pending = "";
    if (tail) this.onSentence(tail);
  }
}

/**
 * Index of the first sentence-ending punctuation that is not an abbreviation, an
 * initial, or a decimal point.
 */
function firstSentenceBreak(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const next = s[i + 1];
    // Needs whitespace, a closing quote, or end of buffer after the stop.
    if (next !== undefined && next !== " " && next !== "\n" && next !== '"' && next !== "'") continue;
    // Digits either side of a full stop make it a decimal.
    if (ch === "." && isDigit(s[i - 1]) && isDigit(s[i + 2])) continue;
    // A lone capital before a full stop is probably an initial.
    if (ch === "." && i >= 1 && isUpper(s[i - 1]) && !isLetter(s[i - 2])) continue;
    // Hold a trailing stop until there is enough context to be sure.
    if (next === undefined && s.length < 12) continue;
    return i;
  }
  return -1;
}

const isDigit = (c?: string) => !!c && c >= "0" && c <= "9";
const isUpper = (c?: string) => !!c && c >= "A" && c <= "Z";
const isLetter = (c?: string) => !!c && /[a-zA-Z]/.test(c);

/**
 * Reads a `text/event-stream` body and yields each `data:` payload.
 *
 * Handles the two things that break naive implementations: a JSON object split
 * across chunk boundaries, and multi-line data fields.
 */
export async function* sseLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) throw new Error("response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Events are separated by a blank line.
      let split: number;
      while ((split = indexOfEventEnd(buf)) >= 0) {
        const raw = buf.slice(0, split);
        buf = buf.slice(split).replace(/^(\r?\n){1,2}/, "");
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data) yield data;
      }
    }
    const tail = buf
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function indexOfEventEnd(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** Turns a failed fetch into an error worth reading aloud. */
export async function httpError(provider: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const msg = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (msg) detail = msg;
  } catch {
    /* keep the raw text */
  }
  if (res.status === 429) {
    return new Error(`${provider} rate limit reached. ${detail}`);
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${provider} rejected the API key. ${detail}`);
  }
  return new Error(`${provider} returned ${res.status}. ${detail}`);
}
