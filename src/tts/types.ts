/**
 * Text to speech. Two shapes, because where the audio is rendered is an
 * architectural choice and not an implementation detail:
 *
 *   clientSide = true   the device speaks the text with its own synthesizer.
 *                       Nothing crosses the wire, so latency is near zero.
 *                       The browser does this today; iOS will use
 *                       AVSpeechSynthesizer in Phase 7.
 *
 *   clientSide = false  we render audio here and ship the bytes. Costs a
 *                       round trip, buys a voice worth listening to.
 */

export interface Speech {
  bytes: Buffer;
  mime: string;
}

export interface TtsProvider {
  readonly name: string;
  readonly clientSide: boolean;
  /** Render one utterance. Never called when clientSide is true. */
  synthesize(text: string): Promise<Speech>;
}
