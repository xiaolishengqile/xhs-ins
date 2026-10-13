import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const PAGE_SIZE = 30;
const PLATFORMS = ["instagram", "xiaohongshu"];
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const IMAGE_TYPES = new Map([
  ["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"],
  ["gif", "image/gif"], ["avif", "image/avif"],
]);

function failure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function segment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw failure("图片路径无效", 400);
  }
  return value;
}

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readIndex(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function publishedFromId(platform, noteId) {
  let time = null;
  if (platform === "instagram" && /^[A-Za-z0-9_-]{8,14}$/.test(noteId)) {
    let id = 0n;
    for (const character of noteId) id = id * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(character));
    time = Number((id >> 23n) + 1314220021721n);
  } else if (platform === "xiaohongshu" && /^[0-9a-f]{24}$/i.test(noteId)) {
    time = Number.parseInt(noteId.slice(0, 8), 16) * 1000;
  }
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

function noteUrlFor(platform, noteId) {
  return platform === "instagram"
    ? `https://www.instagram.com/p/${encodeURIComponent(noteId)}/`
    : `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
}

function dayBoundary(value, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure("日期格式无效", 400);
  const [year, month, day] = value.split("-").map(Number);
  return endOfDay ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime() : new Date(year, month - 1, day).getTime();
}

export class LocalImageLibrary {
  constructor(rootDir, indexDir = null) {
    this.rootDir = path.resolve(rootDir);
    this.indexDir = indexDir ? path.resolve(indexDir) : null;
    this.thumbnails = new Map();
  }

  async accounts() {
    return (await entries(this.rootDir))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async #accountDir(account) {
    segment(account);
    const root = await realpath(this.rootDir).catch((error) => {
      if (error.code === "ENOENT") throw failure("图片账号不存在", 404);
      throw error;
    });
    const directory = path.join(this.rootDir, account);
    const info = await lstat(directory).catch((error) => {
      if (error.code === "ENOENT") throw failure("图片账号不存在", 404);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(await realpath(directory)) !== root) {
      throw failure("图片账号不存在", 404);
    }
    return directory;
  }

  directory(account) {
    return this.#accountDir(account);
  }

  async #imageNames(directory) {
    return (await entries(directory))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
  }

  #indexFiles(account) {
    if (!this.indexDir) return [];
    return PLATFORMS.map((platform) => ({ platform, file: path.join(this.indexDir, `${platform}-${account}.json`) }));
  }

  async #sources(account) {
    const sources = new Map();
    for (const { platform, file } of this.#indexFiles(account)) {
      const index = await readIndex(file);
      for (const [key, item] of Object.entries(index?.items ?? {})) {
        if (!item?.fileName || item.deleted || sources.has(item.fileName)) continue;
        const noteId = item.noteId ?? key.split(":")[2];
        if (!noteId) continue;
        const publishedAt = item.publishedAt ?? publishedFromId(platform, noteId);
        sources.set(item.fileName, { noteId, noteUrl: item.noteUrl ?? noteUrlFor(platform, noteId), publishedAt });
      }
    }
    return sources;
  }

  async #entries(account, range) {
    const directory = await this.#accountDir(account);
    const sources = await this.#sources(account);
    const from = range?.from ? dayBoundary(range.from, false) : -Infinity;
    const to = range?.to ? dayBoundary(range.to, true) : Infinity;
    const filtering = Number.isFinite(from) || Number.isFinite(to);
    const items = (await this.#imageNames(directory)).map((name) => ({ name, ...sources.get(name) }))
      .filter((item) => {
        if (!filtering) return true;
        const time = Date.parse(item.publishedAt ?? "");
        return Number.isFinite(time) && time >= from && time <= to;
      });
    items.sort((left, right) => {
      const byDate = (Date.parse(right.publishedAt ?? "") || 0) - (Date.parse(left.publishedAt ?? "") || 0);
      if (byDate) return byDate;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    return { directory, items };
  }

  async remove(account, names, range) {
    if (names !== null && (!Array.isArray(names) || names.length === 0 || names.length > 5_000)) {
      throw failure("请选择要删除的图片", 400);
    }
    for (const name of names ?? []) segment(name);
    const { directory, items } = await this.#entries(account, names === null ? range : null);
    const available = new Set(items.map((item) => item.name));
    const total = (await this.#imageNames(directory)).length;
    const targets = names === null ? [...available] : [...new Set(names)].filter((name) => available.has(name));
    for (const name of targets) await rm(path.join(directory, name));
    await this.#markDeleted(account, new Set(targets));
    const remaining = total - targets.length;
    if (remaining === 0) await rmdir(directory).catch(() => {});
    return { deleted: targets.length, remaining };
  }

  async #markDeleted(account, names) {
    if (names.size === 0) return;
    const deletedAt = new Date().toISOString();
    for (const { file } of this.#indexFiles(account)) {
      const index = await readIndex(file);
      if (!index?.items) continue;
      let changed = false;
      for (const [key, item] of Object.entries(index.items)) {
        if (!names.has(item?.fileName) || item.deleted) continue;
        index.items[key] = { ...item, deleted: true, deletedAt };
        changed = true;
      }
      if (!changed) continue;
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await rename(temporary, file);
    }
  }

  async list(account, page = 1, range = null) {
    if (!Number.isSafeInteger(page) || page < 1) throw failure("页码无效", 400);
    const { items } = await this.#entries(account, range);
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    page = Math.min(page, pageCount);
    const selected = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return {
      account, page, pageCount, total: items.length,
      images: selected.map((item) => {
        const query = `account=${encodeURIComponent(account)}&name=${encodeURIComponent(item.name)}`;
        return {
          name: item.name,
          url: `/api/images/file?${query}`,
          thumbnailUrl: `/api/images/file?${query}&size=thumb`,
          noteId: item.noteId ?? null,
          noteUrl: item.noteUrl ?? null,
          publishedAt: item.publishedAt ?? null,
        };
      }),
    };
  }

  async read(account, name, size) {
    if (size !== "original" && size !== "thumb") throw failure("图片尺寸参数无效", 400);
    const directory = await this.#accountDir(account);
    segment(name);
    if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw failure("图片不存在", 404);
    const file = path.join(directory, name);
    const info = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") throw failure("图片不存在", 404);
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(file)) !== await realpath(directory)) {
      throw failure("图片不存在", 404);
    }
    if (info.size > MAX_FILE_BYTES) throw failure("图片超过 64 兆字节上限", 413);
    const input = await readFile(file);
    let metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: 32_000_000 }).metadata();
    } catch {
      throw failure("图片损坏或超过解码上限", 415);
    }
    const contentType = IMAGE_TYPES.get(metadata.format);
    if (!contentType || !metadata.width || !metadata.height || metadata.width * metadata.height > 32_000_000) {
      throw failure("图片格式不支持或超过解码上限", 415);
    }
    if (size === "original") return { body: input, contentType };
    const key = `${file}:${info.mtimeMs}:${info.size}`;
    if (this.thumbnails.has(key)) {
      const body = this.thumbnails.get(key);
      this.thumbnails.delete(key);
      this.thumbnails.set(key, body);
      return { body, contentType: "image/webp" };
    }
    let body;
    try {
      body = await sharp(input, { limitInputPixels: 32_000_000 })
        .resize(320, 320, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 }).toBuffer();
    } catch {
      throw failure("图片损坏或无法生成缩略图", 415);
    }
    this.thumbnails.set(key, body);
    while (this.thumbnails.size > 60) this.thumbnails.delete(this.thumbnails.keys().next().value);
    return { body, contentType: "image/webp" };
  }
}
