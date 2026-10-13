import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeFileName } from "./file-names.js";
import { readImageMetadata } from "./image-metadata.js";

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

function qualityFor(metadata, media) {
  const sourceWidth = Number(media?.sourceWidth);
  if (Number.isFinite(sourceWidth) && sourceWidth > 0 && metadata.width >= sourceWidth) return "full";
  return Math.max(metadata.width, metadata.height) >= 1080 ? "full" : "preview";
}

function hasStoredMetadata(stored) {
  return Number.isFinite(stored?.width)
    && Number.isFinite(stored?.height)
    && typeof stored?.contentType === "string"
    && typeof stored?.sha256 === "string";
}

function storedImageCoversCandidate(stored, media) {
  if (!hasStoredMetadata(stored)) return false;
  const sourceWidth = Number(media.sourceWidth);
  if (Number.isFinite(sourceWidth) && sourceWidth > 0) return stored.width >= sourceWidth;
  return stored.sourceUrl === media.url;
}

function imageArea(value) {
  return Number(value?.width ?? 0) * Number(value?.height ?? 0);
}

function fileReferenceCount(index, fileName) {
  return Object.values(index.items).filter((item) => item.fileName === fileName).length;
}

function applyStoredMedia(media, stored, localPath) {
  Object.assign(media, {
    localPath,
    error: null,
    warning: null,
    width: stored.width ?? null,
    height: stored.height ?? null,
    quality: stored.quality ?? "unknown",
    contentType: stored.contentType ?? null,
  });
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
    retryMedia = null,
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
    let previewImages = 0;
    let imagesAvailable = 0;
    let imagesFailed = 0;
    let imagesUpgradeFailed = 0;
    let imagesExcluded = 0;
    const retryKeys = retryMedia ? new Set(retryMedia) : null;

    for (const note of result) {
      const source = { noteId: note.id, noteUrl: note.url ?? null, publishedAt: note.publishedAt ?? null };
      for (let mediaIndex = 0; mediaIndex < (note.media?.length ?? 0); mediaIndex += 1) {
        throwIfAborted(signal);
        const media = note.media[mediaIndex];
        const key = mediaKey(task, note.id, mediaIndex);
        let existing = index.items[key];
        if (existing?.deleted) {
          Object.assign(media, { localPath: null, error: null, excluded: true });
          imagesExcluded += 1;
          current += 1;
          await onProgress({ current, total, imagesDownloaded, previewImages, imagesAvailable, imagesFailed, imagesUpgradeFailed, imagesExcluded });
          continue;
        }
        let existingPath = existing?.fileName ? path.join(authorDir, existing.fileName) : null;
        if (existingPath && await this.#exists(existingPath)) {
          ({ stored: existing, filePath: existingPath } = await this.#hydrateExisting({
            key,
            stored: existing,
            filePath: existingPath,
            authorDir,
            index,
            indexFile,
          }));
        } else {
          existing = null;
          existingPath = null;
        }
        const preserveSuccessful = retryKeys && !retryKeys.has(`${note.id}:${mediaIndex}`);
        // 补采中退出时，索引可能已落盘但整轮失败清单尚未更新；尺寸/来源仍能证明这张已完成。
        if (existingPath && (preserveSuccessful || storedImageCoversCandidate(existing, media))) {
          const stale = existing.sourceUrl !== media.url
            || Object.entries(source).some(([field, value]) => existing[field] !== value);
          if (stale) {
            existing = { ...existing, sourceUrl: media.url, ...source };
            index.items[key] = existing;
            await this.#saveIndex(indexFile, index);
          }
          applyStoredMedia(media, existing, existingPath);
        } else {
          const downloaded = await this.#download({
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
            existing,
            existingPath,
            source,
          });
          if (downloaded) imagesDownloaded += 1;
        }
        if (media.quality === "preview") previewImages += 1;
        if (media.localPath) imagesAvailable += 1;
        if (media.error) imagesFailed += 1;
        if (media.warning) imagesUpgradeFailed += 1;
        current += 1;
        await onProgress({ current, total, imagesDownloaded, previewImages, imagesAvailable, imagesFailed, imagesUpgradeFailed, imagesExcluded });
      }
    }

    return {
      directory: authorDir, notes: result, imagesDownloaded, previewImages,
      imagesAvailable, imagesFailed, imagesUpgradeFailed, imagesExcluded, imagesSkipped: imagesAvailable - imagesDownloaded,
    };
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
    existing,
    existingPath,
    source,
  }) {
    let temporary;
    try {
      const fetched = await fetchBuffer(media.url);
      const buffer = Buffer.isBuffer(fetched) ? fetched : fetched?.buffer;
      throwIfAborted(signal);
      const metadata = readImageMetadata(buffer);
      if (!metadata?.width || !metadata?.height) throw new Error("下载内容不是可识别的图片");
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (existingPath && imageArea(existing) >= imageArea(metadata)) {
        applyStoredMedia(media, existing, existingPath);
        return false;
      }
      const duplicate = Object.values(index.items).find((item) => item.sha256 === sha256);
      const duplicatePath = duplicate?.fileName ? path.join(authorDir, duplicate.fileName) : null;
      if (duplicatePath && await this.#exists(duplicatePath)) {
        const previousFileName = existing?.fileName;
        index.items[key] = { ...duplicate, sourceUrl: media.url, ...source };
        await this.#saveIndex(indexFile, index);
        if (
          previousFileName
          && previousFileName !== duplicate.fileName
          && fileReferenceCount(index, previousFileName) === 0
        ) {
          await rm(path.join(authorDir, previousFileName), { force: true }).catch(() => {});
        }
        applyStoredMedia(media, index.items[key], duplicatePath);
        return false;
      }
      const replacing = Boolean(
        existingPath
        && existing?.fileName
        && fileReferenceCount(index, existing.fileName) === 1,
      );
      const sequence = String(index.nextSequence).padStart(6, "0");
      const fileName = replacing
        ? `${path.basename(existing.fileName, path.extname(existing.fileName))}${metadata.extension}`
        : `${account}_${sequence}_点赞${likeLabel(note.metrics?.likeCount)}${metadata.extension}`;
      const destination = path.join(authorDir, fileName);
      temporary = path.join(authorDir, `.image-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporary, buffer);
      await rename(temporary, destination);
      temporary = null;
      if (replacing && existingPath !== destination) await rm(existingPath, { force: true });
      if (!replacing) index.nextSequence += 1;
      index.items[key] = {
        fileName,
        sourceUrl: media.url,
        width: metadata.width,
        height: metadata.height,
        quality: qualityFor(metadata, media),
        contentType: metadata.contentType,
        byteLength: buffer.length,
        sha256,
        ...source,
      };
      await this.#saveIndex(indexFile, index);
      applyStoredMedia(media, index.items[key], destination);
      return true;
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      if (error?.name === "AbortError") throw error;
      if (existingPath && await this.#exists(existingPath)) {
        applyStoredMedia(media, existing, existingPath);
        media.warning = `高清图片升级失败：${error instanceof Error ? error.message : String(error)}`;
        return false;
      }
      Object.assign(media, {
        localPath: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async #hydrateExisting({ key, stored, filePath, authorDir, index, indexFile }) {
    if (hasStoredMetadata(stored)) return { stored, filePath };
    try {
      const buffer = await readFile(filePath);
      const metadata = readImageMetadata(buffer);
      if (!metadata) return { stored, filePath };
      const expectedName = `${path.basename(stored.fileName, path.extname(stored.fileName))}${metadata.extension}`;
      const expectedPath = path.join(authorDir, expectedName);
      if (expectedPath !== filePath) {
        await rename(filePath, expectedPath);
        filePath = expectedPath;
      }
      stored = {
        ...stored,
        fileName: expectedName,
        width: metadata.width,
        height: metadata.height,
        quality: qualityFor(metadata),
        contentType: metadata.contentType,
        byteLength: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
      index.items[key] = stored;
      await this.#saveIndex(indexFile, index);
      return { stored, filePath };
    } catch {
      return { stored, filePath };
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
