import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { resolveSystemBrowserLaunchOptions } from "./system-browser.js";
import { TaskBrowserSession } from "./task-browser-session.js";

const MEDIA_HOSTS = {
  xiaohongshu: ["xiaohongshu.com", ".xhscdn.com", ".xhscdn.net"],
  instagram: ["instagram.com", ".cdninstagram.com", ".fbcdn.net"],
};
const LOGIN_URLS = {
  xiaohongshu: "https://www.xiaohongshu.com/",
  instagram: "https://www.instagram.com/accounts/login/",
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
    headless = process.env.COLLECTOR_HEADLESS !== "0",
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
    this.loginContexts = new Map();
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

  releaseTaskSession(session) {
    const key = `${session.platform}:${session.taskId}`;
    if (this.taskSessions.get(key) === session) this.taskSessions.delete(key);
  }

  async fetchBuffer(platform, url) {
    const safeUrl = validateMediaUrl(platform, url);
    const response = await (await this.#context(platform)).request.get(safeUrl);
    if (!response.ok()) throw new Error(`图片下载失败：${response.status?.() ?? "未知状态"}`);
    return response.body();
  }

  async openLogin(platform) {
    if (!LOGIN_URLS[platform]) throw new Error(`不支持的平台：${platform}`);
    if (!this.loginContexts.has(platform)) {
      const promise = this.#launchLogin(platform);
      this.loginContexts.set(platform, promise);
      promise.catch(() => this.loginContexts.delete(platform));
    }
    const login = await this.loginContexts.get(platform);
    await login.page.bringToFront?.();
    return login.page;
  }

  async closeLogin(platform) {
    const promise = this.loginContexts.get(platform);
    if (!promise) return;
    this.loginContexts.delete(platform);
    const login = await promise.catch(() => null);
    await login?.context.close().catch(() => {});
  }

  async close() {
    const contexts = await Promise.allSettled([...this.contexts.values()]);
    const loginContexts = await Promise.allSettled([...this.loginContexts.values()]);
    this.contexts.clear();
    this.loginContexts.clear();
    this.keepalivePages.clear();
    this.taskSessions.clear();
    await Promise.allSettled(
      [
        ...contexts.filter((item) => item.status === "fulfilled").map((item) => item.value),
        ...loginContexts.filter((item) => item.status === "fulfilled").map((item) => item.value.context),
      ].map((context) => context.close()),
    );
  }

  async #context(platform) {
    if (!MEDIA_HOSTS[platform]) throw new Error(`不支持的平台：${platform}`);
    if (this.loginContexts.has(platform)) throw new Error("该平台正在登录，请先完成登录");
    if (!this.contexts.has(platform)) {
      const promise = this.#launch(platform);
      this.contexts.set(platform, promise);
      promise.catch(() => this.contexts.delete(platform));
    }
    return this.contexts.get(platform);
  }

  async #launch(platform) {
    const context = await this.#launchPersistent(platform, this.headless);
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

  async #launchLogin(platform) {
    await this.#closeCollectionContext(platform);
    const context = await this.#launchPersistent(platform, false);
    const page = (context.pages?.() ?? [])[0] ?? await context.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: "domcontentloaded", timeout: 60_000 });
    return { context, page };
  }

  async #closeCollectionContext(platform) {
    const promise = this.contexts.get(platform);
    if (!promise) return;
    this.contexts.delete(platform);
    this.keepalivePages.delete(platform);
    for (const [key, session] of this.taskSessions) {
      if (session.platform === platform) this.taskSessions.delete(key);
    }
    const context = await promise.catch(() => null);
    await context?.close().catch(() => {});
  }

  async #launchPersistent(platform, headless) {
    const profileDir = path.join(this.profilesDir, platform);
    await mkdir(profileDir, { recursive: true });
    const options = {
      headless,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      acceptDownloads: false,
    };
    const browserLaunchOptions = await this.browserLaunchOptions();
    let launchError;
    for (const browserOptions of browserLaunchOptions) {
      try {
        return await this.launchPersistentContext(profileDir, { ...options, ...browserOptions });
      } catch (error) {
        launchError = error;
      }
    }
    throw new Error("无法启动系统默认浏览器，也无法启动备用的谷歌浏览器或微软浏览器", { cause: launchError });
  }
}
