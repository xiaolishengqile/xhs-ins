import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// 断点独立于任务摘要，避免任务列表反复传输所有图片地址。
export class CollectionCheckpoint {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "collection.json");
    this.value = { version: 1, entries: {}, pending: {}, retryMedia: null, result: null };
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.entries || Array.isArray(parsed.entries)
        || typeof parsed.entries !== "object" || (parsed.result && !Array.isArray(parsed.result.notes))) {
        throw new Error("采集断点格式无效");
      }
      this.value = { pending: {}, retryMedia: null, ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`读取采集断点失败：${error.message}`, { cause: error });
    }
    return structuredClone(this.value);
  }

  async record(entry) {
    if (!entry || typeof entry.key !== "string" || !entry.key) throw new Error("采集断点缺少帖子编号");
    Object.defineProperty(this.value.entries, entry.key, {
      value: structuredClone(entry), enumerable: true, configurable: true, writable: true,
    });
    delete this.value.pending[entry.key];
    await this.#save();
  }

  async reset() {
    this.value = { version: 1, entries: {}, pending: {}, retryMedia: null, result: null };
    await this.#save();
  }

  async complete(result) {
    this.value.result = structuredClone(result);
    await this.#save();
  }

  async extend(from, to) {
    const inRange = ([, entry]) => {
      const date = Date.parse(entry.publishedAt ?? entry.note?.publishedAt);
      return date >= Date.parse(from) && date <= Date.parse(to);
    };
    this.value.entries = Object.fromEntries(Object.entries(this.value.entries).filter(inRange));
    this.value.pending = Object.fromEntries(Object.entries(this.value.pending).filter(inRange));
    this.value.result = null;
    await this.#save();
  }

  async invalidate(notes) {
    const failed = notes.filter((note) => note.media?.some((media) => media.error || media.warning));
    this.value.retryMedia = failed.flatMap((note) => note.media.flatMap((media, index) =>
      media.error || media.warning ? [`${note.id}:${index}`] : []));
    const entries = { ...this.value.entries, ...this.value.pending };
    this.value.pending = {};
    for (const note of failed) {
      const key = Object.keys(entries).find((key) => entries[key].note?.id === note.id) ?? note.url ?? note.id;
      Object.defineProperty(this.value.pending, key, {
        value: { ...entries[key], key, note }, enumerable: true, configurable: true, writable: true,
      });
      delete this.value.entries[key];
    }
    // 失败帖下次重新解析，刷新可能已过期的图片链接；成功帖仍复用断点。
    if (failed.length) this.value.result = null;
    else this.value.retryMedia = null;
    await this.#save();
  }

  async #save() {
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.collection-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(this.value), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
