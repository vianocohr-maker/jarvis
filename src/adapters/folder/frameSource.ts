/**
 * THE GLASSES' CAMERA, WITHOUT AN APP
 *
 * Meta's camera API is a mobile SDK, so a native app is the only supported way
 * to pull a frame live. This is the way round it that needs no app, no Mac and
 * no Android phone at all:
 *
 *     say "Hey Meta, take a picture"
 *       -> glasses store it
 *       -> Meta AI app auto-imports when the glasses fold or go in the case
 *       -> iPhone Photos
 *       -> iCloud
 *       -> iCloud for Windows writes it to a folder here
 *       -> this reads the newest file
 *
 * Be clear-eyed about what this is: it is **capture now, ask later**, not a live
 * assistant. The import only fires when the glasses close, so latency is a
 * minute or two, and the capture is triggered by talking to Meta rather than to
 * Jarvis. What it buys is real pictures of what you were actually looking at,
 * for nothing, today.
 *
 * Staleness is the trap this guards against. If the sync has silently stopped,
 * the newest file might be from yesterday, and describing yesterday's photo as
 * though it were in front of you is worse than admitting nothing arrived. So
 * every frame carries its age, and anything older than the threshold is
 * refused with a message that says which part of the chain to go and check.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { Frame, FrameSource, ImageMime } from "../types.ts";

const MIME_BY_EXT: Record<string, ImageMime> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export interface FolderFrameOptions {
  folder: string;
  /** Refuse anything older than this. Default 15 minutes. */
  maxAgeMs?: number;
  /** Ignore files bigger than this — a 4K burst is not worth the upload. */
  maxBytes?: number;
}

export class FolderFrameSource implements FrameSource {
  private folder: string;
  private maxAgeMs: number;
  private maxBytes: number;
  /** Remembered so a repeated question does not re-read the same photo. */
  private lastServed: string | null = null;

  constructor(o: FolderFrameOptions) {
    this.folder = o.folder;
    this.maxAgeMs = o.maxAgeMs ?? 15 * 60_000;
    this.maxBytes = o.maxBytes ?? 12 * 1024 * 1024;
  }

  get available(): boolean {
    return existsSync(this.folder);
  }

  /** Human summary for the startup banner. */
  describe(): string {
    return `${this.folder} (newest image, max ${Math.round(this.maxAgeMs / 60000)} min old)`;
  }

  async capture(_reason: string): Promise<Frame> {
    if (!this.available) {
      throw new Error(
        `The photo folder does not exist: ${this.folder}. ` +
          `Install iCloud for Windows and turn on Photos, or point FRAME_FOLDER somewhere else.`,
      );
    }

    const newest = await this.newestImage();
    if (!newest) {
      throw new Error(
        `No photos in ${this.folder} yet. Say "Hey Meta, take a picture", then fold ` +
          `the glasses so the Meta AI app imports it.`,
      );
    }

    const age = Date.now() - newest.mtimeMs;
    if (age > this.maxAgeMs) {
      const mins = Math.round(age / 60000);
      throw new Error(
        `The newest photo is ${mins} minutes old, so I have not been sent anything recent. ` +
          `Check the glasses actually imported: they only sync when folded or in the case.`,
      );
    }

    const bytes = await readFile(newest.path);
    this.lastServed = newest.path;

    return {
      bytes,
      mime: newest.mime,
      // Dimensions are not needed downstream and reading them would mean
      // decoding every format including HEIC; the models do not care.
      width: 0,
      height: 0,
      capturedAt: Math.round(newest.mtimeMs),
    };
  }

  /** True when something has arrived that we have not already answered about. */
  async hasSomethingNew(): Promise<boolean> {
    const newest = await this.newestImage();
    if (!newest) return false;
    if (Date.now() - newest.mtimeMs > this.maxAgeMs) return false;
    return newest.path !== this.lastServed;
  }

  private async newestImage(): Promise<
    { path: string; mtimeMs: number; mime: ImageMime } | null
  > {
    let names: string[];
    try {
      names = await readdir(this.folder);
    } catch {
      return null;
    }

    let best: { path: string; mtimeMs: number; mime: ImageMime } | null = null;

    for (const name of names) {
      const mime = MIME_BY_EXT[extname(name).toLowerCase()];
      if (!mime) continue; // videos and stray files

      const path = join(this.folder, name);
      let s;
      try {
        s = await stat(path);
      } catch {
        continue; // vanished mid-scan, or iCloud is still materialising it
      }
      if (!s.isFile() || s.size === 0 || s.size > this.maxBytes) continue;

      if (!best || s.mtimeMs > best.mtimeMs) best = { path, mtimeMs: s.mtimeMs, mime };
    }

    return best;
  }
}
