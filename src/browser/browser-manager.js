import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { resolveSystemBrowserLaunchOptions } from "./system-browser.js";
import { TaskBrowserSession } from "./task-browser-session.js";

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
    browserLaunchOptions = resolveSystemBrowserLaunchOptions,
    launchPersistentContext = (directory, options) => chromium.launchPersistentContext(directory, options),
  }) {
    this.profilesDir = path.resolve(profilesDir);
    this.headless = headless;
    this.browserLaunchOptions = browserLaunchOptions;
    this.launchPersistentContext = launchPersistentContext;
    this.contexts = new Map();
    this.keepalivePages = new Map();
    this.taskSessions = new Map();
    this.humanActionPages = new Map();
  }

  async newPage(platform) {
    return this.createTaskPage(platform);
  }

  async createTaskPage(platform) {
    return (await this.#context(platform)).newPage();
  }

  async createTaskSession(platform, taskId) {
    if (!taskId) throw new Error("任务编号不能为空");
    await this.#context(platform);
    const key = `${platform}:${taskId}`;
    const existing = this.taskSessions.get(key);
    if (existing && !existing.closed) return existing;
    const session = new TaskBrowserSession({ manager: this, platform, taskId });
    this.taskSessions.set(key, session);
    return session;
  }

  releaseTaskSession(session, { preserveHumanAction = false } = {}) {
    if (preserveHumanAction) return;
    const key = `${session.platform}:${session.taskId}`;
    if (this.taskSessions.get(key) === session) this.taskSessions.delete(key);
  }

  async fetchBuffer(platform, url) {
    const safeUrl = validateMediaUrl(platform, url);
    const response = await (await this.#context(platform)).request.get(safeUrl);
    if (!response.ok()) throw new Error(`图片下载失败：${response.status?.() ?? "未知状态"}`);
    return response.body();
  }

  async retainPageForHumanAction(platform, page) {
    if (!MEDIA_HOSTS[platform]) throw new Error(`不支持的平台：${platform}`);
    if (!this.humanActionPages.has(platform)) this.humanActionPages.set(platform, new Set());
    this.humanActionPages.get(platform).add(page);
  }

  async closeHumanActionPages(platform) {
    const pages = [...(this.humanActionPages.get(platform) ?? [])];
    this.humanActionPages.delete(platform);
    await Promise.allSettled(pages.map((page) => page.close()));
  }

  async close() {
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    this.contexts.clear();
    this.keepalivePages.clear();
    this.taskSessions.clear();
    this.humanActionPages.clear();
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
    const options = {
      headless: this.headless,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      acceptDownloads: false,
    };
    const browserLaunchOptions = await this.browserLaunchOptions();
    let context;
    let launchError;
    for (const browserOptions of browserLaunchOptions) {
      try {
        context = await this.launchPersistentContext(profileDir, { ...options, ...browserOptions });
        break;
      } catch (error) {
        launchError = error;
      }
    }
    if (!context) {
      throw new Error("无法启动系统默认浏览器，也无法启动备用的谷歌浏览器或微软浏览器", { cause: launchError });
    }
    let keepalivePage = (context.pages?.() ?? []).find((page) => page.url?.() === "about:blank");
    keepalivePage ??= await context.newPage();
    this.keepalivePages.set(platform, keepalivePage);
    context.on?.("close", () => {
      this.contexts.delete(platform);
      this.keepalivePages.delete(platform);
      for (const [key, session] of this.taskSessions) {
        if (session.platform === platform) this.taskSessions.delete(key);
      }
    });
    return context;
  }
}
