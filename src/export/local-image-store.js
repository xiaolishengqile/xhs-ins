import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { mediaExtension, safeFileName } from "./file-names.js";

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

function mediaKey(task, noteId, mediaIndex) {
  return `${task.platform}:${task.profileKey}:${noteId}:${mediaIndex}`;
}

function likeLabel(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "未知";
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class LocalImageStore {
  constructor({ rootDir, indexDir }) {
    this.rootDir = path.resolve(rootDir);
    this.indexDir = path.resolve(indexDir);
    this.saveQueues = new Map();
  }

  async save(task, notes, options) {
    const queueKey = `${task.platform}:${task.profileKey}`;
    const previous = this.saveQueues.get(queueKey) ?? Promise.resolve();
    const saving = previous.catch(() => {}).then(() => this.#save(task, notes, options));
    this.saveQueues.set(queueKey, saving);
    try {
      return await saving;
    } finally {
      if (this.saveQueues.get(queueKey) === saving) this.saveQueues.delete(queueKey);
    }
  }

  async #save(task, notes, {
    fetchBuffer,
    onProgress = async () => {},
    signal,
  }) {
    const account = safeFileName(task.profileKey, "未知博主");
    const authorDir = path.join(this.rootDir, account);
    const indexFile = path.join(this.indexDir, `${safeFileName(`${task.platform}-${task.profileKey}`)}.json`);
    await Promise.all([mkdir(authorDir, { recursive: true }), mkdir(this.indexDir, { recursive: true })]);
    const index = await this.#loadIndex(indexFile, authorDir, account);
    const result = structuredClone(notes);
    const total = result.reduce((count, note) => count + (note.media?.length ?? 0), 0);
    let current = 0;
    let imagesDownloaded = 0;

    for (const note of result) {
      for (let mediaIndex = 0; mediaIndex < (note.media?.length ?? 0); mediaIndex += 1) {
        throwIfAborted(signal);
        const media = note.media[mediaIndex];
        const key = mediaKey(task, note.id, mediaIndex);
        const existing = index.items[key];
        const existingPath = existing?.fileName ? path.join(authorDir, existing.fileName) : null;
        if (existingPath && await this.#exists(existingPath)) {
          Object.assign(media, { localPath: existingPath, error: null });
        } else {
          await this.#download({
            task,
            note,
            media,
            mediaIndex,
            key,
            account,
            authorDir,
            index,
            indexFile,
            fetchBuffer,
            signal,
          });
          if (media.localPath) imagesDownloaded += 1;
        }
        current += 1;
        await onProgress({ current, total, imagesDownloaded });
      }
    }

    return { directory: authorDir, notes: result, imagesDownloaded };
  }

  async #download({
    note,
    media,
    key,
    account,
    authorDir,
    index,
    indexFile,
    fetchBuffer,
    signal,
  }) {
    let temporary;
    try {
      const buffer = await fetchBuffer(media.url);
      throwIfAborted(signal);
      const sequence = String(index.nextSequence).padStart(6, "0");
      const fileName = `${account}_${sequence}_点赞${likeLabel(note.metrics?.likeCount)}${mediaExtension(media.url)}`;
      const destination = path.join(authorDir, fileName);
      temporary = path.join(authorDir, `.image-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporary, buffer);
      await rename(temporary, destination);
      temporary = null;
      index.nextSequence += 1;
      index.items[key] = { fileName };
      await this.#saveIndex(indexFile, index);
      Object.assign(media, { localPath: destination, error: null });
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (error?.name === "AbortError") throw error;
      Object.assign(media, {
        localPath: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #loadIndex(indexFile, authorDir, account) {
    try {
      const parsed = JSON.parse(await readFile(indexFile, "utf8"));
      return {
        nextSequence: Number.isInteger(parsed.nextSequence) && parsed.nextSequence > 0 ? parsed.nextSequence : 1,
        items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const names = await readdir(authorDir);
      const pattern = new RegExp(`^${escaped(account)}_(\\d{6})_点赞`);
      const highest = names.reduce((maximum, name) => {
        const sequence = Number(name.match(pattern)?.[1] ?? 0);
        return Math.max(maximum, sequence);
      }, 0);
      return { nextSequence: highest + 1, items: {} };
    }
  }

  async #saveIndex(indexFile, index) {
    const temporary = path.join(this.indexDir, `.index-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(temporary, indexFile);
  }

  async #exists(filePath) {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
