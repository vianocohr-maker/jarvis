/**
 * The zero-key fallback: recognition runs in the client using the browser's
 * own speech engine, and arrives here as `transcript` control messages.
 *
 * This provider therefore transcribes nothing. It exists so the loop has one
 * code path regardless of where the words come from, and so the first run of
 * this project needs exactly one API key instead of three.
 *
 * Worth knowing what you are trading: browser recognition is markedly worse in
 * noise, gives you no control over endpointing, and on the iPhone it will not
 * exist at all. Switch to Deepgram before Phase 2.
 */

import type { SttProvider, SttSession } from "./types.ts";

export function browserStt(): SttProvider {
  return {
    name: "browser",
    clientSide: true,
    async open(): Promise<SttSession> {
      return {
        push() {
          /* transcription happens on the client */
        },
        async end() {},
        close() {},
      };
    },
  };
}
