/**
 * Jarvis — Phase 1.
 *
 * Boots the bridge, waits for a device, and gives each one a voice loop.
 * Everything device-specific lives behind the three interfaces in
 * src/adapters/types.ts; the loop below never learns what it is talking to.
 */

import { config, validate } from "./config.ts";
import * as personaStore from "./persona.ts";
import { Session } from "./session.ts";
import { SpeakerId } from "./audio/speakerId.ts";
import { makeBrain } from "./brain/index.ts";
import { VoiceLoop } from "./brain/loop.ts";
import { bridgeProvider, type BridgeDeviceHandle } from "./adapters/bridge/server.ts";
import { deepgram } from "./stt/deepgram.ts";
import { browserStt } from "./stt/browser.ts";
import { clientTts, sapiTts, elevenLabsTts } from "./tts/providers.ts";
import type { SttProvider } from "./stt/types.ts";
import type { TtsProvider } from "./tts/types.ts";

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (line: string) => console.log(`${stamp()}  ${line}`);

function pickStt(): SttProvider {
  if (config.stt.provider === "deepgram" && config.stt.deepgramKey) {
    return deepgram(config.stt.deepgramKey);
  }
  return browserStt();
}

function pickTts(): TtsProvider {
  if (config.tts.provider === "elevenlabs" && config.tts.elevenLabsKey) {
    return elevenLabsTts(config.tts.elevenLabsKey, config.tts.elevenLabsVoice);
  }
  if (config.tts.provider === "sapi") return sapiTts();
  return clientTts();
}

async function main(): Promise<void> {
  for (const w of validate()) say(`note: ${w}`);

  const persona = personaStore.load(config.dataDir);
  const brain = makeBrain(config.brain);
  const stt = pickStt();
  const tts = pickTts();
  const speakerId = new SpeakerId(config.dataDir, "heuristic");

  say(`persona ${persona.name} · ${persona.verbosity}`);
  say(
    `brain ${brain.name} ${brain.model} · ${brain.cost}` +
      `${brain.vision ? " · can see" : " · TEXT ONLY, no vision"}`,
  );
  say(
    `stt ${stt.name}${stt.clientSide ? " (on device)" : ""} · ` +
      `tts ${tts.name}${tts.clientSide ? " (on device)" : ""}`,
  );
  if (!brain.vision) {
    say(`note: ${brain.name} cannot see — "look at this" will say so rather than guess`);
  }
  if (!speakerId.enrolled) {
    say("note: no voiceprint yet — it will answer any voice (onboarding B1)");
  }

  const clientConfig = {
    stt: stt.clientSide ? "browser" : stt.name,
    tts: tts.clientSide ? "client" : tts.name,
    wake: config.picovoiceKey ? "porcupine" : "push-to-talk",
    picovoiceKey: config.picovoiceKey || null,
  };

  const provider = bridgeProvider(config.port, clientConfig);
  const live = new Set<VoiceLoop>();

  await provider.listen((device: BridgeDeviceHandle) => {
    const session = new Session(device, {
      onPhase: (phase, detail) => device.send({ t: "state", phase, detail }),
      onNotice: (level, text) => {
        say(`  ${level}: ${text}`);
        device.send({ t: "notice", level, text });
      },
      onGone: () => {
        void loop.close();
        live.delete(loop);
        say(`device gone — ${live.size} still connected`);
      },
    });

    const loop = new VoiceLoop({
      session,
      device,
      brain,
      stt,
      tts,
      persona,
      speakerId,
      followUpWindowMs: config.followUpWindowMs,
      // With client-side TTS the `said` message is what makes the device speak,
      // so there is nothing to await here. A server-rendered voice goes through
      // device.audioOut instead and does report real playback completion.
      speakOnClient: async () => ({ interrupted: false }),
      onHeard: (text, final) => {
        if (final) say(`you: ${text}`);
        device.send({ t: "heard", text, final });
      },
      onSaid: (text) => {
        say(`${persona.name}: ${text}`);
        device.send({ t: "said", text });
      },
      log: (line) => say(`  ${line}`),
    });

    live.add(loop);

    // Control events the three core interfaces have no place for.
    device.attach({
      onWake: (at) => void loop.onWake(at),
      onEndOfSpeech: () => void loop.onEndOfSpeech(),
      onBargeIn: () => {
        /* the wake message that follows is what interrupts */
      },
      onTranscript: (text, final) => loop.onClientTranscript(text, final),
    });

    // Audio arrives through the contract, not a side channel.
    void device.audioIn.start((chunk) => loop.onAudio(chunk.pcm));

    void device.ready.then(() => {
      say(`device connected — ${session.banner()}`);
      device.send({ t: "ready", persona: { name: persona.name, greeting: persona.greeting } });
      if (!device.info.capabilities.frames) {
        session.notice("info", "No camera on this device — look-at-this questions will not work.");
      }
    });
  });

  say(`listening on http://localhost:${config.port}  — open it and hold Space to talk`);

  const shutdown = async () => {
    say("shutting down");
    for (const l of live) await l.close();
    await provider.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`\nfailed to start: ${(err as Error).message}\n`);
  process.exit(1);
});
