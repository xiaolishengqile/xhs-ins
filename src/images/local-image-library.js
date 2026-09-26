import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const PAGE_SIZE = 30;
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

export class LocalImageLibrary {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
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

  async list(account, page = 1) {
    const directory = await this.#accountDir(account);
    if (!Number.isSafeInteger(page) || page < 1) throw failure("页码无效", 400);
    const names = (await entries(directory))
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
    const pageCount = Math.max(1, Math.ceil(names.length / PAGE_SIZE));
    page = Math.min(page, pageCount);
    const selected = names.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return {
      account, page, pageCount, total: names.length,
      images: selected.map((name) => {
        const query = `account=${encodeURIComponent(account)}&name=${encodeURIComponent(name)}`;
        return { name, url: `/api/images/file?${query}`, thumbnailUrl: `/api/images/file?${query}&size=thumb` };
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
