/**
 * THE VOICE LOOP  —  build sheet items 02, 03 and 05
 *
 *      idle ──wake──▶ listening ──end of speech──▶ thinking ──▶ speaking
 *        ▲                 ▲                                       │
 *        │                 └──────── follow-up window ◀────────────┘
 *        └──────────────── window expires ──────────────────────────┘
 *
 * Three things make this feel alive rather than like a command line:
 *
 *  02  Nothing waits for the stage before it to finish. Transcription runs
 *      while you speak, generation starts on the transcript, and the first
 *      sentence is spoken while the second is still being written.
 *
 *  03  Barge-in. While speaking we keep listening, and a human voice cancels
 *      generation and playback inside one frame. Everything downstream of the
 *      interruption is discarded, including tokens we have paid for.
 *
 *  05  After answering, the microphone stays open for a few seconds so a
 *      follow-up needs no wake word. Silence closes it.
 */

import { AUDIO } from "../adapters/types.ts";
import type { Device, Frame } from "../adapters/types.ts";
import { Vad } from "../audio/vad.ts";
import { PcmRing } from "../audio/ring.ts";
import { SpeakerId } from "../audio/speakerId.ts";
import { Turn } from "../telemetry.ts";
import { systemPrompt, type Persona } from "../persona.ts";
import type { Session } from "../session.ts";
import type { Brain, Message } from "./llm.ts";
import type { SttProvider, SttSession } from "../stt/types.ts";
import type { TtsProvider } from "../tts/types.ts";

/** Words that mean "look at this" — the only reason we spend a frame. */
const VISUAL_CUES = [
  "look at", "looking at", "see this", "what is this", "what's this",
  "read this", "read that", "what does this say", "in front of me",
  "am i holding", "this thing", "identify", "what colour", "what color",
];

type LoopState = "idle" | "listening" | "thinking" | "speaking";

/** How much audio to keep before the wake word fires, in bytes. */
const PREROLL_MS = 300;
const PREROLL_BYTES = (AUDIO.sampleRate * 2 * PREROLL_MS) / 1000;

export interface LoopDeps {
  session: Session;
  device: Device;
  brain: Brain;
  stt: SttProvider;
  tts: TtsProvider;
  persona: Persona;
  speakerId: SpeakerId;
  followUpWindowMs: number;
  /** Send text for the device to speak itself (client-side TTS). */
  speakOnClient: (text: string) => Promise<{ interrupted: boolean }>;
  onHeard: (text: string, final: boolean) => void;
  onSaid: (text: string) => void;
  log: (line: string) => void;
}

export class VoiceLoop {
  private d: LoopDeps;
  private history: Message[] = [];
  private ring = new PcmRing(PREROLL_BYTES);
  private vad: Vad;

  private state: LoopState = "idle";
  private stt: SttSession | null = null;
  private abort: AbortController | null = null;
  private followUpTimer: NodeJS.Timeout | null = null;
  private turn: Turn | null = null;

  /** Latest transcript for the utterance in progress. */
  private partial = "";
  /** The last text already announced as final, so we do not say it twice. */
  private emittedFinal = "";
  /** Audio of the current utterance, kept for the identity check. */
  private utterance: Buffer[] = [];
  private sawWakeAt = 0;

  constructor(deps: LoopDeps) {
    this.d = deps;
    this.vad = new Vad({
      onSpeechStart: () => this.onSpeechStart(),
      onSpeechEnd: () => this.onSpeechEnd(),
    });
  }

  // ── audio in ───────────────────────────────────────────────────────────────

  /** Every microphone frame from the device passes through here. */
  onAudio(pcm: Buffer): void {
    this.ring.push(pcm);
    this.vad.push(pcm);
    if (this.state === "listening") {
      this.utterance.push(pcm);
      this.stt?.push(pcm);
    }
  }

  /** Wake word fired on the client, or the talk key went down. */
  async onWake(at: number): Promise<void> {
    this.sawWakeAt = at;
    if (this.state === "speaking") await this.interrupt("wake during playback");
    if (this.state === "thinking") await this.interrupt("wake during generation");
    await this.beginListening(true);
  }

  private onSpeechStart(): void {
    // 03: a human started talking while we were holding the floor.
    if (this.state === "speaking" || this.state === "thinking") {
      void this.interrupt("barge-in");
      void this.beginListening(false);
    }
  }

  private onSpeechEnd(): void {
    if (this.state === "listening") void this.finishListening();
  }

  /** Client-side VAD or key release told us the utterance is over. */
  async onEndOfSpeech(): Promise<void> {
    if (this.state === "listening") await this.finishListening();
  }

  /** Transcript arriving from the client, when STT runs there. */
  onClientTranscript(text: string, final: boolean): void {
    if (this.state !== "listening") return;
    this.partial = text;
    if (final) this.emittedFinal = text;
    this.d.onHeard(text, final);
  }

  // ── state transitions ──────────────────────────────────────────────────────

  private async beginListening(fromWake: boolean): Promise<void> {
    this.clearFollowUp();
    this.state = "listening";
    this.d.session.setPhase("listening");
    this.partial = "";
    this.emittedFinal = "";
    this.utterance = [];
    this.turn = new Turn(fromWake && this.sawWakeAt ? this.sawWakeAt : Date.now());
    if (fromWake) this.turn.mark("wake");

    if (!this.d.stt.clientSide) {
      try {
        this.stt = await this.d.stt.open({
          onPartial: (t) => {
            this.partial = t;
            this.d.onHeard(t, false);
          },
          onFinal: (t) => {
            this.partial = t;
            this.d.onHeard(t, true);
          },
          onError: (e) => this.d.session.notice("error", `Transcription failed: ${e.message}`),
        });
        // Pre-roll, so we do not clip the first syllable.
        const pre = this.ring.drain();
        if (pre.length) this.stt.push(pre);
      } catch (err) {
        this.d.session.notice("error", `Could not start transcription: ${(err as Error).message}`);
        this.state = "idle";
        this.d.session.setPhase("idle");
      }
    }
  }

  private async finishListening(): Promise<void> {
    const said = this.partial.trim();
    const audio = Buffer.concat(this.utterance);
    this.utterance = [];

    if (this.stt) {
      await this.stt.end();
      this.stt.close();
      this.stt = null;
    }
    this.turn?.mark("stt");

    if (!said) {
      this.d.log("heard nothing; going idle");
      this.state = "idle";
      this.d.session.setPhase("idle");
      return;
    }

    // 04: is this even the right person?
    if (audio.length > 0) {
      const verdict = this.d.speakerId.accepts(audio);
      if (!verdict.ok) {
        this.d.log(`ignored: ${verdict.why}`);
        this.state = "idle";
        this.d.session.setPhase("idle");
        return;
      }
    }

    if (this.emittedFinal !== said) this.d.onHeard(said, true);
    await this.answer(said);
  }

  private async answer(said: string): Promise<void> {
    this.state = "thinking";
    this.d.session.setPhase("thinking");
    this.abort = new AbortController();
    const turn = this.turn ?? new Turn();

    // Spend a frame only when the words ask for one.
    let image: Frame | null = null;
    if (wantsEyes(said)) {
      this.d.session.setPhase("thinking", "looking");
      image = await this.d.session.tryCapture(said.slice(0, 60));
    }

    const queue = new SpeechQueue(
      async (sentence) => {
        if (this.state !== "speaking") {
          this.state = "speaking";
          this.d.session.setPhase("speaking");
        }
        this.d.onSaid(sentence);
        if (this.d.tts.clientSide) {
          await this.d.speakOnClient(sentence);
        } else {
          const speech = await this.d.tts.synthesize(sentence);
          await this.d.device.audioOut.play(speech.bytes, speech.mime);
        }
      },
      (err) => this.d.session.notice("error", `Speech failed: ${err.message}`),
    );

    let full = "";
    try {
      full = await this.d.brain.think(said, {
        system: systemPrompt(this.d.persona),
        history: this.history,
        image: image ? { bytes: image.bytes, mime: image.mime } : undefined,
        signal: this.abort.signal,
        onFirstToken: () => turn.mark("llmFirstToken"),
        onSentence: (s) => {
          if (!queue.started) turn.mark("tts");
          queue.push(s);
        },
      });
      await queue.drain();
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") {
        this.d.session.notice("error", `I could not answer that: ${e.message}`);
      }
    }

    if (full.trim()) {
      this.history.push({ role: "user", content: said });
      this.history.push({ role: "assistant", content: full.trim() });
      if (this.history.length > 24) this.history = this.history.slice(-24);
    }

    this.d.log(`turn ${this.d.session.countTurn()}  ${turn.format()}`);
    this.abort = null;

    // 05: hold the mic open for a follow-up. Read through is() because a
    // barge-in may have moved us to listening while this function was awaiting.
    if (!this.is("listening")) this.openFollowUpWindow();
  }

  private openFollowUpWindow(): void {
    this.state = "listening";
    this.d.session.setPhase("listening", "follow-up");
    this.partial = "";
    this.emittedFinal = "";
    this.utterance = [];
    this.vad.reset();

    if (!this.d.stt.clientSide) {
      void this.d.stt
        .open({
          onPartial: (t) => {
            this.partial = t;
            this.d.onHeard(t, false);
          },
          onFinal: (t) => {
            this.partial = t;
            this.d.onHeard(t, true);
          },
        })
        .then((s) => {
          if (this.state === "listening") this.stt = s;
          else s.close();
        })
        .catch(() => {});
    }

    this.clearFollowUp();
    this.followUpTimer = setTimeout(() => {
      if (this.state === "listening" && !this.vad.isSpeaking && !this.partial.trim()) {
        this.d.log("follow-up window closed");
        this.stt?.close();
        this.stt = null;
        this.state = "idle";
        this.d.session.setPhase("idle");
      }
    }, this.d.followUpWindowMs);
  }

  private clearFollowUp(): void {
    if (this.followUpTimer) {
      clearTimeout(this.followUpTimer);
      this.followUpTimer = null;
    }
  }

  /** Stop talking and stop thinking, now. */
  private async interrupt(why: string): Promise<void> {
    this.d.log(`interrupted: ${why}`);
    this.abort?.abort();
    this.abort = null;
    await this.d.device.audioOut.stop().catch(() => {});
  }

  /** Opaque to control-flow narrowing, unlike a direct comparison. */
  private is(...states: LoopState[]): boolean {
    return states.includes(this.state);
  }

  async close(): Promise<void> {
    this.clearFollowUp();
    this.abort?.abort();
    this.stt?.close();
  }
}

/**
 * Speaks sentences strictly in order while the model keeps producing them.
 * Without this, two sentences finishing synthesis out of order would play the
 * back half of an answer first.
 */
class SpeechQueue {
  private chain: Promise<void> = Promise.resolve();
  started = false;

  private speak: (s: string) => Promise<void>;
  private onError: (e: Error) => void;

  constructor(speak: (s: string) => Promise<void>, onError: (e: Error) => void) {
    this.speak = speak;
    this.onError = onError;
  }

  push(sentence: string): void {
    this.started = true;
    this.chain = this.chain.then(
      () => this.speak(sentence).catch((e) => this.onError(e as Error)),
    );
  }

  drain(): Promise<void> {
    return this.chain;
  }
}

function wantsEyes(said: string): boolean {
  const s = said.toLowerCase();
  return VISUAL_CUES.some((cue) => s.includes(cue));
}
