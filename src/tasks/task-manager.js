import { randomUUID } from "node:crypto";

import { normalizeProfileUrl } from "../domain/platform.js";
import { resolveDateRange } from "../domain/date-range.js";
import { RESTARTABLE_STATUS, TASK_STATUS } from "./task-states.js";
import { normalizeBatchEntries } from "./batch-input.js";
import { PlatformCooldowns } from "./platform-cooldowns.js";

const PLATFORM_BLOCKS = Object.freeze({
  login: Object.freeze({
    reason: "login",
    message: "该平台需要先完成登录或验证",
    status: TASK_STATUS.WAITING_USER,
    stage: "等待平台登录或验证",
  }),
  browser: Object.freeze({
    reason: "browser",
    message: "浏览器运行环境不可用",
    status: TASK_STATUS.BLOCKED,
    stage: "浏览器运行环境受阻",
  }),
});

function clone(value) {
  return structuredClone(value);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/page\.goto|net::ERR_/i.test(message)) return "页面访问失败，请稍后重试";
  return message.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0];
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
}

export class TaskManager {
  constructor({
    store,
    collectorFactory,
    exporter,
    taskSessionFactory = async () => null,
    controlStore = {
      load: async () => ({ paused: false, updatedAt: null }),
      save: async () => {},
    },
    maxConcurrency = 5,
    platformConcurrency = { instagram: 1 },
    maxPlatformRecoveryAttempts = 2,
    now = () => new Date(),
    idFactory = randomUUID,
  }) {
    this.store = store;
    this.collectorFactory = collectorFactory;
    this.exporter = exporter;
    this.taskSessionFactory = taskSessionFactory;
    this.controlStore = controlStore;
    this.maxConcurrency = maxConcurrency;
    this.platformConcurrency = { ...platformConcurrency };
    this.maxPlatformRecoveryAttempts = maxPlatformRecoveryAttempts;
    this.now = now;
    this.idFactory = idFactory;
    this.tasks = new Map();
    this.queue = [];
    this.running = new Map();
    this.runningPromises = new Set();
    this.taskRuns = new Map();
    this.pauseRequested = new Set();
    this.taskInterruptions = new Map();
    this.platformBlocks = new Map();
    this.paused = false;
    this.closed = false;
    this.platformCooldowns = new PlatformCooldowns({
      store: this.controlStore,
      now: this.now,
      isPaused: () => this.paused,
      onReady: () => this.#requestSchedule(),
    });
  }

  async init() {
    this.paused = await this.platformCooldowns.init();
    for (const task of await this.store.loadAll()) {
      const previousStatus = task.status;
      if (task.status === TASK_STATUS.RUNNING) {
        task.status = this.paused ? TASK_STATUS.PAUSED : TASK_STATUS.QUEUED;
      } else if (task.status === TASK_STATUS.PAUSED && !this.paused) {
        task.status = TASK_STATUS.QUEUED;
      } else if (task.status === TASK_STATUS.BLOCKED && task.blockReason === "browser") {
        task.status = this.paused ? TASK_STATUS.PAUSED : TASK_STATUS.QUEUED;
      }
      if (task.status === TASK_STATUS.QUEUED && RESTARTABLE_STATUS.has(previousStatus)) {
        task.error = null;
        task.blockReason = null;
        task.progress = { ...task.progress, stage: "等待恢复" };
      }
      if (task.status !== previousStatus) await this.store.save(task);
      if (task.status === TASK_STATUS.QUEUED) this.queue.push(task.id);
      if (task.status === TASK_STATUS.WAITING_USER) {
        task.blockReason = "login";
        this.platformBlocks.set(task.platform, PLATFORM_BLOCKS.login);
      }
      this.tasks.set(task.id, task);
    }
    this.#requestSchedule();
  }

  async create(input) {
    if (this.closed) throw new Error("任务管理器已关闭");
    const profile = normalizeProfileUrl(input.url);
    const range = resolveDateRange(input.range, this.now());
    const timestamp = this.now().toISOString();
    const task = {
      id: this.idFactory(),
      platform: profile.platform,
      profileUrl: profile.url,
      profileKey: profile.profileKey,
      from: range.from,
      to: range.to,
      status: TASK_STATUS.PENDING,
      progress: { stage: "待开始", current: 0, total: 0, imagesDownloaded: 0, previewImages: 0 },
      author: null,
      error: null,
      resultPath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
      recoveryAttempts: 0,
      warningCount: 0,
      blockReason: null,
    };
    this.tasks.set(task.id, task);
    await this.store.save(task);
    return clone(task);
  }

  async start(id) {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const task = this.#requireTask(id);
    if (task.status !== TASK_STATUS.PENDING) throw new Error("只有待开始任务可以启动");
    const block = this.platformBlocks.get(task.platform);
    if (block) {
      this.#applyBlock(task, block);
      task.updatedAt = this.now().toISOString();
      await this.store.save(task);
      return clone(task);
    }
    return this.#requeue(task, "等待采集");
  }

  async startBatch(ids) {
    if (!Array.isArray(ids)) throw new Error("任务编号必须是数组");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const started = [];
    const skipped = [];
    for (const id of new Set(ids)) {
      const task = this.tasks.get(id);
      if (!task || task.status !== TASK_STATUS.PENDING) {
        skipped.push(id);
        continue;
      }
      await this.start(id);
      started.push(id);
    }
    return { started, skipped };
  }

  async createBatch({ entries, range }) {
    if (this.closed) throw new Error("任务管理器已关闭");
    resolveDateRange(range, this.now());
    const normalized = normalizeBatchEntries(entries);
    const tasks = [];
    for (const entry of normalized.valid) {
      try {
        tasks.push(await this.create({ url: entry.url, range }));
      } catch (error) {
        normalized.rejected.push({
          line: entry.line,
          url: entry.url,
          reason: errorMessage(error),
        });
      }
    }
    return {
      tasks,
      rejected: normalized.rejected,
      duplicates: normalized.duplicates,
    };
  }

  list() {
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  get(id) {
    const task = this.tasks.get(id);
    return task ? clone(task) : null;
  }

  controlStatus() {
    const tasks = [...this.tasks.values()];
    return {
      paused: this.paused,
      maxConcurrency: this.maxConcurrency,
      running: tasks.filter((task) => task.status === TASK_STATUS.RUNNING).length,
      queued: tasks.filter((task) => task.status === TASK_STATUS.QUEUED).length,
      pausedTasks: tasks.filter((task) => task.status === TASK_STATUS.PAUSED).length,
      pending: tasks.filter((task) => task.status === TASK_STATUS.PENDING).length,
      blockedPlatforms: [...this.platformBlocks.keys()],
      platformBlocks: [...this.platformBlocks].map(([platform, block]) => ({
        platform,
        reason: block.reason,
        message: block.message,
      })),
      cooldowns: this.platformCooldowns.values(),
    };
  }

  async pauseAll() {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (!this.paused) {
      this.paused = true;
      try {
        await this.platformCooldowns.save(true);
      } catch (error) {
        this.paused = false;
        this.#requestSchedule();
        throw error;
      }
    }
    const queued = this.queue;
    this.queue = [];
    for (const id of queued) {
      const task = this.tasks.get(id);
      if (!task || task.status !== TASK_STATUS.QUEUED) continue;
      task.status = TASK_STATUS.PAUSED;
      task.progress.stage = "已暂停";
      task.updatedAt = this.now().toISOString();
      await this.store.save(task);
    }
    const runningPromises = [];
    for (const [id, controller] of this.running) {
      this.pauseRequested.add(id);
      controller.abort();
      const runningPromise = this.taskRuns.get(id);
      if (runningPromise) runningPromises.push(runningPromise);
    }
    await Promise.allSettled(runningPromises);
    return this.controlStatus();
  }

  async resumeAll() {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (!this.paused) return this.controlStatus();
    for (const task of this.tasks.values()) {
      if (task.status !== TASK_STATUS.PAUSED) continue;
      task.status = TASK_STATUS.QUEUED;
      task.error = null;
      task.blockReason = null;
      task.author = null;
      task.resultPath = null;
      task.progress = { stage: "等待继续", current: 0, total: 0, imagesDownloaded: 0, previewImages: 0 };
      task.updatedAt = this.now().toISOString();
      task.startedAt = null;
      task.completedAt = null;
      if (!this.queue.includes(task.id)) this.queue.push(task.id);
      await this.store.save(task);
    }
    await this.platformCooldowns.save(false);
    this.paused = false;
    this.#requestSchedule();
    return this.controlStatus();
  }

  async cancel(id) {
    const task = this.#requireTask(id);
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(task.status)) return clone(task);
    task.status = TASK_STATUS.CANCELLED;
    task.error = null;
    task.progress.stage = "已取消";
    task.updatedAt = this.now().toISOString();
    const runningPromise = this.taskRuns.get(id);
    this.running.get(id)?.abort();
    await this.store.save(task);
    if (runningPromise) await Promise.allSettled([runningPromise]);
    this.#requestSchedule();
    return clone(task);
  }

  async retry(id) {
    const task = this.#requireTask(id);
    if (![TASK_STATUS.FAILED, TASK_STATUS.CANCELLED].includes(task.status)) {
      throw new Error("只有失败或已取消任务可以重试");
    }
    task.recoveryAttempts = 0;
    return this.#requeue(task, "等待重试");
  }

  async resume(id) {
    const task = this.#requireTask(id);
    if (task.status !== TASK_STATUS.WAITING_USER) throw new Error("该任务不需要人工恢复");
    await this.resumePlatform(task.platform);
    return this.get(id);
  }

  async prepareHumanAction(platform) {
    await this.#blockPlatform(platform, undefined, PLATFORM_BLOCKS.login);
    return this.controlStatus();
  }

  async resumePlatform(platform) {
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    this.platformBlocks.delete(platform);
    const tasks = [...this.tasks.values()].filter(
      (task) => task.platform === platform && task.status === TASK_STATUS.WAITING_USER,
    );
    for (const task of tasks) await this.#requeue(task, "等待恢复");
    return tasks.map((task) => clone(task));
  }

  async recoverPlatform(platform) {
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    if (this.platformBlocks.get(platform)?.reason !== "browser") {
      throw new Error("该平台没有浏览器运行环境故障");
    }
    this.platformBlocks.delete(platform);
    const tasks = [...this.tasks.values()].filter(
      (task) => task.platform === platform
        && task.status === TASK_STATUS.BLOCKED
        && task.blockReason === "browser",
    );
    for (const task of tasks) await this.#requeue(task, "等待重新检测", false);
    this.#requestSchedule();
    return tasks.map((task) => clone(task));
  }

  async delete(id) {
    this.#requireTask(id);
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    this.running.get(id)?.abort();
    const runningPromise = this.taskRuns.get(id);
    if (runningPromise) await Promise.allSettled([runningPromise]);
    this.tasks.delete(id);
    await this.store.remove(id);
    this.#requestSchedule();
  }

  async shutdown() {
    this.closed = true;
    this.platformCooldowns.close();
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled([...this.runningPromises]);
  }

  #requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  async #requeue(task, stage, schedule = true) {
    task.status = TASK_STATUS.QUEUED;
    task.error = null;
    task.blockReason = null;
    task.resultPath = null;
    task.progress = { stage, current: 0, total: 0, imagesDownloaded: 0, previewImages: 0 };
    task.warningCount = 0;
    task.updatedAt = this.now().toISOString();
    this.queue.push(task.id);
    await this.store.save(task);
    if (schedule) this.#requestSchedule();
    return clone(task);
  }

  #requestSchedule() {
    queueMicrotask(() => this.#schedule());
  }

  #schedule() {
    if (this.closed || this.paused) return;
    this.platformCooldowns.refresh();
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const runnableIndex = this.queue.findIndex((id) => {
        const task = this.tasks.get(id);
        return task?.status === TASK_STATUS.QUEUED
          && !this.platformBlocks.has(task.platform)
          && !this.platformCooldowns.has(task.platform)
          && this.#runningCount(task.platform) < (this.platformConcurrency[task.platform] ?? this.maxConcurrency);
      });
      if (runnableIndex < 0) {
        return;
      }
      const [id] = this.queue.splice(runnableIndex, 1);
      const task = this.tasks.get(id);
      if (!task || task.status !== TASK_STATUS.QUEUED) continue;
      const promise = this.#run(task);
      this.runningPromises.add(promise);
      this.taskRuns.set(id, promise);
      promise.finally(() => {
        this.runningPromises.delete(promise);
        if (this.taskRuns.get(id) === promise) this.taskRuns.delete(id);
      });
    }
  }

  #runningCount(platform) {
    let count = 0;
    for (const id of this.running.keys()) {
      if (this.tasks.get(id)?.platform === platform) count += 1;
    }
    return count;
  }

  async #run(task) {
    const controller = new AbortController();
    let browserSession = null;
    this.running.set(task.id, controller);
    task.status = TASK_STATUS.RUNNING;
    task.error = null;
    task.startedAt = task.startedAt ?? this.now().toISOString();
    task.updatedAt = this.now().toISOString();
    task.progress.stage = "正在采集";
    await this.store.save(task);
    const onProgress = async (progress) => {
      if (controller.signal.aborted) return;
      task.progress = { ...task.progress, ...progress };
      task.updatedAt = this.now().toISOString();
      await this.store.save(task);
    };

    try {
      throwIfAborted(controller.signal);
      browserSession = await this.taskSessionFactory(clone(task));
      throwIfAborted(controller.signal);
      const collector = this.collectorFactory(task.platform, browserSession ?? undefined);
      const result = await collector.collect(clone(task), {
        signal: controller.signal,
        onProgress,
      });
      if (controller.signal.aborted) return;
      task.author = result.author ?? task.profileKey;
      task.warningCount = result.warnings?.length ?? 0;
      task.resultPath = await this.exporter(task, result.notes ?? [], this.store.taskDir(task.id), {
        signal: controller.signal,
        onProgress,
        browserSession,
      });
      task.status = TASK_STATUS.COMPLETED;
      task.progress.stage = task.warningCount > 0
        ? `采集完成，跳过 ${task.warningCount} 篇不可访问帖子`
        : "采集完成";
      task.completedAt = this.now().toISOString();
      task.recoveryAttempts = 0;
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        this.#markInterrupted(task);
      } else if (error?.code === "HUMAN_ACTION_REQUIRED") {
        this.#applyBlock(task, PLATFORM_BLOCKS.login, errorMessage(error));
        await this.#blockPlatform(task.platform, task.id, PLATFORM_BLOCKS.login);
      } else if (error?.code === "BROWSER_LAUNCH_FAILED") {
        this.#applyBlock(task, PLATFORM_BLOCKS.browser, errorMessage(error));
        await this.#blockPlatform(task.platform, task.id, PLATFORM_BLOCKS.browser);
      } else if (error?.code === "PLATFORM_TEMPORARILY_UNAVAILABLE") {
        try {
          throwIfAborted(controller.signal);
          const partial = error.partialResult;
          task.warningCount = Math.max(task.warningCount ?? 0, partial?.warnings?.length ?? 0);
          if ((partial?.notes?.length ?? 0) > 0) {
            task.author = partial.author ?? task.profileKey;
            task.resultPath = await this.exporter(task, partial.notes, this.store.taskDir(task.id), {
              signal: controller.signal,
              onProgress,
              browserSession,
            });
            throwIfAborted(controller.signal);
          }
          task.recoveryAttempts = (task.recoveryAttempts ?? 0) + 1;
          if (task.recoveryAttempts > this.maxPlatformRecoveryAttempts) {
            task.status = TASK_STATUS.FAILED;
            task.error = "平台持续拒绝访问，请稍后手动重试";
            task.progress.stage = "平台持续拒绝访问";
          } else {
            const retryAfterMs = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 5 * 60_000;
            await this.platformCooldowns.set(task.platform, retryAfterMs);
            throwIfAborted(controller.signal);
            task.status = TASK_STATUS.QUEUED;
            task.error = "平台访问过于频繁，已自动降低速度";
            task.progress.stage = "平台冷却中，稍后自动继续";
            task.updatedAt = this.now().toISOString();
            if (!this.queue.includes(task.id)) this.queue.push(task.id);
          }
        } catch (recoveryError) {
          if (controller.signal.aborted || recoveryError?.name === "AbortError") {
            this.#markInterrupted(task);
          } else {
            task.status = TASK_STATUS.FAILED;
            task.error = errorMessage(recoveryError);
            task.progress.stage = "保存部分结果失败";
          }
        }
      } else {
        task.status = TASK_STATUS.FAILED;
        task.error = errorMessage(error);
        task.progress.stage = "采集失败";
      }
    } finally {
      await browserSession?.close().catch(() => {});
      this.pauseRequested.delete(task.id);
      this.taskInterruptions.delete(task.id);
      task.updatedAt = this.now().toISOString();
      this.running.delete(task.id);
      await this.store.save(task);
      this.#requestSchedule();
    }
  }

  #markInterrupted(task) {
    const paused = this.pauseRequested.has(task.id);
    const interruption = this.taskInterruptions.get(task.id);
    task.status = interruption
      ? interruption.status
      : paused
        ? TASK_STATUS.PAUSED
        : TASK_STATUS.CANCELLED;
    task.error = interruption?.message ?? null;
    task.blockReason = interruption?.reason ?? null;
    task.progress.stage = interruption
      ? interruption.stage
      : paused
        ? "已暂停"
        : "已取消";
  }

  #applyBlock(task, block, message = block.message) {
    task.status = block.status;
    task.error = message;
    task.blockReason = block.reason;
    task.progress.stage = block.stage;
  }

  async #blockPlatform(platform, sourceId, block) {
    this.platformBlocks.set(platform, block);
    const runningPromises = [];
    for (const task of this.tasks.values()) {
      if (task.id === sourceId || task.platform !== platform) continue;
      if (task.status === TASK_STATUS.QUEUED) {
        this.queue = this.queue.filter((id) => id !== task.id);
        this.#applyBlock(task, block);
        task.updatedAt = this.now().toISOString();
        await this.store.save(task);
      } else if (task.status === TASK_STATUS.RUNNING) {
        this.taskInterruptions.set(task.id, block);
        this.running.get(task.id)?.abort();
        const runningPromise = this.taskRuns.get(task.id);
        if (runningPromise) runningPromises.push(runningPromise);
      }
    }
    await Promise.allSettled(runningPromises);
  }
}
