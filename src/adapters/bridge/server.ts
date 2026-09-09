/**
 * THE DEVICE BRIDGE
 *
 * Serves the stand-in client and turns each WebSocket connection into a
 * `Device` — the same interface the glasses will present in Phase 7. Nothing
 * above this file knows a browser is involved.
 *
 * The transport is deliberately the awkward part of the system rather than the
 * loop: a remote device that can vanish mid-sentence, whose camera may refuse,
 * and whose clock is not ours. Building against that from day one is what makes
 * swapping in a phone over Bluetooth a change of client and not a rewrite.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BINARY_TAG,
  decodeBinary,
  encodeBinary,
  type ClientMessage,
  type ServerMessage,
} from "../../bridge/protocol.ts";
import type {
  AudioSink,
  AudioSource,
  AudioChunk,
  Device,
  DeviceInfo,
  DeviceProvider,
  Frame,
  FrameSource,
} from "../types.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Control events that are not audio or frames — the things a transport knows
 * about but the three core interfaces have no place for. The app attaches these
 * after it receives the device, so a loop can be built first.
 */
export interface BridgeHooks {
  onWake: (at: number) => void;
  onEndOfSpeech: () => void;
  onBargeIn: () => void;
  onTranscript: (text: string, final: boolean) => void;
}

/** What the bridge actually hands back: a Device plus its control channel. */
export interface BridgeDeviceHandle extends Device {
  attach(hooks: BridgeHooks): void;
  send(msg: ServerMessage): void;
  /** Resolves once the client has sent hello and capabilities are known. */
  ready: Promise<void>;
}

export function bridgeProvider(
  port: number,
  clientConfig: object,
): DeviceProvider<BridgeDeviceHandle> {
  let http: ReturnType<typeof createServer> | null = null;
  let wss: WebSocketServer | null = null;

  return {
    name: "browser-bridge",

    async listen(onDevice) {
      http = createServer((req, res) => serveStatic(req, res, clientConfig));
      wss = new WebSocketServer({ server: http });

      wss.on("connection", (ws) => {
        // onDevice runs synchronously here, so hooks are attached and the audio
        // source is started before the client can send its first frame.
        onDevice(new BridgeDevice(ws));
      });

      await new Promise<void>((resolve, reject) => {
        http!.once("error", reject);
        http!.listen(port, () => resolve());
      });
    },

    async close() {
      wss?.clients.forEach((c) => c.close());
      wss?.close();
      await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
    },
  };
}

// ── the device ───────────────────────────────────────────────────────────────

class BridgeDevice implements BridgeDeviceHandle {
  info: DeviceInfo = {
    kind: "browser-bridge",
    label: "unidentified client",
    capabilities: { audioIn: false, audioOut: false, frames: false, display: false, battery: null },
  };

  audioIn: BridgeAudioSource;
  audioOut: BridgeAudioSink;
  camera: BridgeCamera;

  private ws: WebSocket;
  private disconnectHandlers: Array<() => void> = [];
  private hooks: BridgeHooks | null = null;
  /** Resolves once the client has said hello. */
  ready: Promise<void>;
  private markReady!: () => void;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.audioIn = new BridgeAudioSource();
    this.audioOut = new BridgeAudioSink((m) => this.send(m));
    this.audioOut.sendAudio = (b) => this.sendAudio(b);
    this.camera = new BridgeCamera((m) => this.send(m));
    this.ready = new Promise((r) => (this.markReady = r));

    ws.on("message", (raw, isBinary) => {
      if (isBinary) this.onBinary(toBuffer(raw));
      else this.onText(toBuffer(raw).toString("utf8"));
    });

    const gone = () => {
      this.camera.fail("device disconnected");
      this.audioOut.cancelAll();
      this.disconnectHandlers.forEach((h) => h());
    };
    ws.on("close", gone);
    ws.on("error", gone);
  }

  attach(hooks: BridgeHooks): void {
    this.hooks = hooks;
  }

  private onText(text: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case "hello":
        this.info = {
          kind: "browser-bridge",
          label: msg.label,
          capabilities: { ...msg.capabilities, battery: msg.battery },
        };
        this.camera.setAvailable(msg.capabilities.frames);
        this.markReady();
        break;
      case "wake":
        this.hooks?.onWake(msg.at);
        break;
      case "endOfSpeech":
        this.hooks?.onEndOfSpeech();
        break;
      case "bargeIn":
        this.hooks?.onBargeIn();
        break;
      case "transcript":
        this.hooks?.onTranscript(msg.text, msg.final);
        break;
      case "frameError":
        this.camera.fail(msg.reason);
        break;
      case "battery":
        this.info.capabilities.battery = msg.level;
        break;
      case "playbackDone":
        this.audioOut.resolvePlayback(msg.interrupted);
        break;
      default:
        break;
    }
  }

  private onBinary(buf: Buffer): void {
    const framed = decodeBinary(buf);
    if (!framed) return;
    if (framed.tag === BINARY_TAG.micPcm) {
      // Audio reaches the app through the AudioSource contract only — there is
      // deliberately no side channel for it.
      const chunk: AudioChunk = { pcm: framed.payload, capturedAt: Date.now() };
      this.audioIn.deliver(chunk);
    } else if (framed.tag === BINARY_TAG.frameJpeg) {
      this.camera.deliver(framed.payload);
    }
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(bytes: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encodeBinary(BINARY_TAG.ttsAudio, bytes));
    }
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

// ── the three interfaces ─────────────────────────────────────────────────────

class BridgeAudioSource implements AudioSource {
  private sink: ((c: AudioChunk) => void) | null = null;
  active = false;

  async start(onChunk: (chunk: AudioChunk) => void): Promise<void> {
    this.sink = onChunk;
    this.active = true;
  }

  async stop(): Promise<void> {
    this.active = false;
    this.sink = null;
  }

  deliver(chunk: AudioChunk): void {
    if (this.active) this.sink?.(chunk);
  }
}

class BridgeCamera implements FrameSource {
  available = false;
  private waiting: Array<{
    resolve: (f: Frame) => void;
    reject: (e: Error) => void;
  }> = [];

  private send: (m: ServerMessage) => void;

  constructor(send: (m: ServerMessage) => void) {
    this.send = send;
  }

  setAvailable(v: boolean): void {
    this.available = v;
  }

  capture(reason: string): Promise<Frame> {
    if (!this.available) return Promise.reject(new Error("no camera on this device"));
    return new Promise<Frame>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.send({ t: "captureFrame", reason });
    });
  }

  deliver(jpeg: Buffer): void {
    const w = this.waiting.shift();
    if (!w) return;
    const size = jpegSize(jpeg);
    w.resolve({
      bytes: jpeg,
      mime: "image/jpeg",
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      capturedAt: Date.now(),
    });
  }

  fail(reason: string): void {
    const all = this.waiting.splice(0);
    all.forEach((w) => w.reject(new Error(reason)));
  }
}

class BridgeAudioSink implements AudioSink {
  speaking = false;
  private current: {
    id: string;
    resolve: (r: { interrupted: boolean }) => void;
  } | null = null;
  private seq = 0;

  private send: (m: ServerMessage) => void;

  constructor(send: (m: ServerMessage) => void) {
    this.send = send;
  }

  /** Set by the device so we can push binary audio. */
  sendAudio: ((b: Buffer) => void) | null = null;

  play(audio: Buffer, mime: string): Promise<{ interrupted: boolean }> {
    const id = `u${++this.seq}`;
    this.speaking = true;
    this.send({ t: "speakBegin", mime, utteranceId: id });
    this.sendAudio?.(audio);
    this.send({ t: "speakEnd", utteranceId: id });

    return new Promise((resolve) => {
      this.current = { id, resolve };
    });
  }

  async stop(): Promise<void> {
    if (!this.current) {
      this.speaking = false;
      return;
    }
    this.send({ t: "speakCancel", utteranceId: this.current.id });
    this.resolvePlayback(true);
  }

  resolvePlayback(interrupted: boolean): void {
    this.speaking = false;
    const c = this.current;
    this.current = null;
    c?.resolve({ interrupted });
  }

  cancelAll(): void {
    this.resolvePlayback(true);
  }
}

// ── plumbing ─────────────────────────────────────────────────────────────────

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  clientConfig: object,
): Promise<void> {
  const url = (req.url ?? "/").split("?")[0]!;

  if (url === "/config.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(clientConfig));
    return;
  }

  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const root = resolve(PUBLIC_DIR);
  const path = resolve(join(root, normalize(rel)));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain" }).end("outside the public directory");
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]);
  return Buffer.from(raw as ArrayBuffer);
}

/** Enough JPEG parsing to fill in width and height for the frame record. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
