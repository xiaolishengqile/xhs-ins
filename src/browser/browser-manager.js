import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const MEDIA_HOSTS = {
  xiaohongshu: ["xiaohongshu.com", ".xhscdn.com", ".xhscdn.net"],
  instagram: ["instagram.com", ".cdninstagram.com", ".fbcdn.net"],
};

function allowedHost(hostname, patterns) {
  return patterns.some((pattern) =>
    pattern.startsWith(".") ? hostname.endsWith(pattern) : hostname === pattern || hostname.endsWith(`.${pattern}`),
  );
}

function validateMediaUrl(platform, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("图片地址无效");
  }
  const patterns = MEDIA_HOSTS[platform];
  if (
    !patterns ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !allowedHost(url.hostname.toLowerCase(), patterns)
  ) {
    throw new Error("图片地址不属于目标平台的公开图片域名");
  }
  return url.href;
}

export class BrowserManager {
  constructor({
    profilesDir,
    headless = process.env.COLLECTOR_HEADLESS === "1",
    launchPersistentContext = (directory, options) => chromium.launchPersistentContext(directory, options),
  }) {
    this.profilesDir = path.resolve(profilesDir);
    this.headless = headless;
    this.launchPersistentContext = launchPersistentContext;
    this.contexts = new Map();
  }

  async newPage(platform) {
    return (await this.#context(platform)).newPage();
  }

  async fetchBuffer(platform, url) {
    const safeUrl = validateMediaUrl(platform, url);
    const response = await (await this.#context(platform)).request.get(safeUrl);
    if (!response.ok()) throw new Error(`图片下载失败：${response.status?.() ?? "未知状态"}`);
    return response.body();
  }

  async close() {
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    this.contexts.clear();
    await Promise.allSettled(
      contexts.filter((item) => item.status === "fulfilled").map((item) => item.value.close()),
    );
  }

  async #context(platform) {
    if (!MEDIA_HOSTS[platform]) throw new Error(`不支持的平台：${platform}`);
    if (!this.contexts.has(platform)) {
      const promise = this.#launch(platform);
      this.contexts.set(platform, promise);
      promise.catch(() => this.contexts.delete(platform));
    }
    return this.contexts.get(platform);
  }

  async #launch(platform) {
    const profileDir = path.join(this.profilesDir, platform);
    await mkdir(profileDir, { recursive: true });
    return this.launchPersistentContext(profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      acceptDownloads: false,
    });
  }
}
