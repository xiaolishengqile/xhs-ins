import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { openPath as openSystemPath } from "../system/open-path.js";

export function throttleFrom(preferences) {
  return {
    imageDelayMs: Math.round(preferences.imageDelaySeconds * 1000),
    bloggerGapMs: Math.round(preferences.bloggerGapSeconds * 1000),
    dailyLimit: preferences.dailyBloggerLimit,
  };
}

export class ApplicationController {
  constructor({
    manager,
    browserManager,
    dataDir,
    preferencesStore,
    outputDir = path.join(homedir(), "Pictures", "博主图片采集"),
    ensureDir = (directory) => mkdir(directory, { recursive: true }),
    openPath = openSystemPath,
    isCloud = process.env.VERCEL === "1",
  }) {
    this.manager = manager;
    this.browserManager = browserManager;
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.preferencesStore = preferencesStore;
    this.outputDir = path.resolve(outputDir);
    this.ensureDir = ensureDir;
    this.openPath = openPath;
    this.isCloud = isCloud;
  }

  async start(taskId, range) {
    this.#assertLocal();
    return this.manager.start(taskId, range);
  }

  async startBatch(ids, range) {
    this.#assertLocal();
    return this.manager.startBatch(ids, range);
  }

  async pauseAll() {
    await this.manager.pauseAll();
    await this.browserManager.close();
    return this.manager.controlStatus();
  }

  resumeAll() {
    return this.manager.resumeAll();
  }

  async openLogin(taskId) {
    this.#assertLocal();
    const task = this.#waitingTask(taskId);
    await this.manager.prepareHumanAction(task.platform);
    await this.browserManager.openLogin(task.platform);
    return task;
  }

  async completeLogin(taskId) {
    this.#assertLocal();
    const task = this.#waitingTask(taskId);
    await this.browserManager.closeLogin(task.platform);
    await this.manager.resumePlatform(task.platform);
    return this.manager.get(taskId);
  }

  async recoverBrowser(taskId) {
    this.#assertLocal();
    const task = this.#browserBlockedTask(taskId);
    await this.browserManager.closePlatform(task.platform);
    await this.manager.recoverPlatform(task.platform);
    return this.manager.get(taskId);
  }

  async openOutputDirectory() {
    this.#assertLocal();
    await this.ensureDir(this.outputDir);
    await this.openPath(this.outputDir);
    return { directory: this.outputDir };
  }

  async openImageDirectory(directory) {
    this.#assertLocal();
    await this.openPath(directory);
    return { directory };
  }

  async settings() {
    const preferences = await this.preferencesStore.load();
    return { ...preferences, actualOutputDir: this.outputDir, dataDir: this.dataDir, nodeVersion: process.version };
  }

  async saveSettings(input) {
    const saved = await this.preferencesStore.save(input);
    this.manager.setThrottle?.(throttleFrom(saved));
    return this.settings();
  }

  #assertLocal() {
    if (this.isCloud) throw new Error("采集和图片目录仅支持本地环境，请在本机运行本项目");
  }

  #waitingTask(taskId) {
    const task = this.manager.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "waiting_user") throw new Error("该任务不需要人工登录");
    return task;
  }

  #browserBlockedTask(taskId) {
    const task = this.manager.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "blocked" || task.blockReason !== "browser") {
      throw new Error("该任务没有浏览器运行环境故障");
    }
    return task;
  }
}
