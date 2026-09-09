/**
 * Deepgram streaming transcription over a raw WebSocket — no SDK, because the
 * protocol is three query parameters and a JSON message.
 *
 * Budgeted at 180 ms in the latency plan. Deepgram's interim results usually
 * beat that; the final lands after the endpointing delay, which is why the
 * loop starts thinking on the last good partial rather than waiting.
 */

import WebSocket from "ws";
import { AUDIO } from "../adapters/types.ts";
import type { SttEvents, SttProvider, SttSession } from "./types.ts";

const ENDPOINT = "wss://api.deepgram.com/v1/listen";

export function deepgram(apiKey: string): SttProvider {
  return {
    name: "deepgram",
    clientSide: false,
    async open(events: SttEvents): Promise<SttSession> {
      const params = new URLSearchParams({
        encoding: "linear16",
        sample_rate: String(AUDIO.sampleRate),
        channels: String(AUDIO.channels),
        model: "nova-3",
        interim_results: "true",
        smart_format: "true",
        // Close the turn quickly; the loop's own VAD is the real arbiter.
        endpointing: "300",
      });

      const ws = new WebSocket(`${ENDPOINT}?${params}`, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      await new Promise<void>((resolve, reject) => {
        const fail = (e: unknown) =>
          reject(new Error(`Deepgram would not connect: ${(e as Error)?.message ?? e}`));
        ws.once("open", () => resolve());
        ws.once("error", fail);
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            channel?: { alternatives?: Array<{ transcript?: string }> };
            is_final?: boolean;
          };
          const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
          if (!text) return;
          if (msg.is_final) events.onFinal?.(text);
          else events.onPartial?.(text);
        } catch {
          // Deepgram also sends metadata frames we do not care about.
        }
      });

      ws.on("error", (err) => events.onError?.(err as Error));

      let closed = false;
      return {
        push(pcm: Buffer) {
          if (!closed && ws.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        async end() {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "CloseStream" }));
          // Give Deepgram a moment to emit the trailing final.
          await new Promise((r) => setTimeout(r, 250));
        },
        close() {
          closed = true;
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        },
      };
    },
  };
}
