/**
 * Speech to text, as a streaming session rather than a function call. Partial
 * transcripts matter: the loop uses them to show what it is hearing, and later
 * to start thinking before the sentence is finished.
 */

export interface SttEvents {
  /** Fired repeatedly as recognition firms up. */
  onPartial?: (text: string) => void;
  /** Fired once per utterance with the settled text. */
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
}

export interface SttSession {
  /** Feed s16le 16 kHz mono PCM. */
  push(pcm: Buffer): void;
  /** No more audio; flush and emit any pending final. */
  end(): Promise<void>;
  close(): void;
}

export interface SttProvider {
  readonly name: string;
  /**
   * True when transcription happens on the client instead of here — the
   * "browser" provider works this way, and the loop then takes text off the
   * wire rather than opening a session.
   */
  readonly clientSide: boolean;
  open(events: SttEvents): Promise<SttSession>;
}
