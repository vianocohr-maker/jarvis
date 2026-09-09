/**
 * A device that is not there.
 *
 * Speaks the wire protocol with no microphone, no camera and no browser, so the
 * loop can be exercised from a terminal: wake, transcript, and a synthetic
 * frame when one is asked for. Useful for checking the state machine without
 * putting on a pair of glasses, and the reason item 71 exists on the build sheet.
 *
 *   node scripts/mock-device.ts "what is the capital of france"
 *   node scripts/mock-device.ts "look at this and tell me what you see"
 */

import WebSocket from "ws";
import { BINARY_TAG, encodeBinary, type ServerMessage } from "../src/bridge/protocol.ts";

const said = process.argv.slice(2).join(" ") || "say hello in five words";
const port = process.env.PORT ?? "8787";
const ws = new WebSocket(`ws://localhost:${port}`);

/** A 1x1 white JPEG, so a look-at-this turn has something to look at. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwcJC4nICIsIxwcKDcpLDA1NTU1KTs/RDo/RS8vNf/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAAB" +
    "BQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFB" +
    "BhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RV" +
    "VldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrC" +
    "w8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A/v4oooo" +
    "A//Z",
  "base64",
);

const log = (s: string) => console.log(`  ${s}`);

ws.on("open", () => {
  console.log(`mock device connected to :${port}`);
  ws.send(
    JSON.stringify({
      t: "hello",
      label: "mock device (no hardware)",
      capabilities: { audioIn: true, audioOut: true, frames: true, display: false },
      battery: 0.62,
      wake: "push-to-talk",
    }),
  );

  // Wake, then hand over the transcript, then close the turn — the same order a
  // real client sends them in.
  setTimeout(() => {
    log(`wake`);
    ws.send(JSON.stringify({ t: "wake", at: Date.now(), source: "push-to-talk" }));
  }, 150);

  setTimeout(() => {
    log(`saying: "${said}"`);
    ws.send(JSON.stringify({ t: "transcript", text: said, final: true, at: Date.now() }));
  }, 300);

  setTimeout(() => {
    ws.send(JSON.stringify({ t: "endOfSpeech", at: Date.now() }));
  }, 450);
});

ws.on("message", (raw, isBinary) => {
  if (isBinary) {
    log(`audio in: ${(raw as Buffer).length} bytes`);
    ws.send(JSON.stringify({ t: "playbackDone", interrupted: false }));
    return;
  }

  const msg = JSON.parse(raw.toString()) as ServerMessage;
  switch (msg.t) {
    case "ready":
      log(`ready — ${msg.persona.name}`);
      break;
    case "state":
      log(`state: ${msg.phase}${msg.detail ? ` (${msg.detail})` : ""}`);
      break;
    case "heard":
      if (msg.final) log(`it heard: ${msg.text}`);
      break;
    case "said":
      console.log(`\n  JARVIS: ${msg.text}\n`);
      // Client-side TTS: pretend we spoke it instantly.
      ws.send(JSON.stringify({ t: "playbackDone", interrupted: false }));
      break;
    case "captureFrame":
      log(`frame requested (${msg.reason}) — sending a 1x1 stand-in`);
      ws.send(encodeBinary(BINARY_TAG.frameJpeg, TINY_JPEG));
      break;
    case "notice":
      log(`${msg.level}: ${msg.text}`);
      break;
    case "speakBegin":
      log(`speakBegin ${msg.mime}`);
      break;
    default:
      break;
  }
});

ws.on("error", (err) => {
  console.error(`\ncould not reach the server on :${port} — is it running?\n${err.message}\n`);
  process.exit(1);
});

// Long enough for a full turn plus the follow-up window.
setTimeout(() => {
  console.log("done");
  ws.close();
  process.exit(0);
}, 20_000);
