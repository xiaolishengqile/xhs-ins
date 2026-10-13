import { randomUUID } from "node:crypto";

import { normalizeProfileUrl } from "../domain/platform.js";
import { resolveDateRange } from "../domain/date-range.js";
import { RESTARTABLE_STATUS, TASK_STATUS } from "./task-states.js";
import { normalizeBatchEntries } from "./batch-input.js";
import { PlatformCooldowns } from "./platform-cooldowns.js";
import { CollectionCheckpoint } from "./collection-checkpoint.js";

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
    maxConcurrency = 1,
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
    this.pendingStorageWrites = new Set();
    this.paused = false;
    this.storageError = null;
    this.closed = false;
    this.throttle = { imageDelayMs: 0, bloggerGapMs: 0, dailyLimit: 0 };
    this.lastRunFinishedAt = 0;
    this.throttleWait = null;
    this.throttleTimer = null;
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
      if (task.status !== previousStatus) await this.#saveTask(task);
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
    await this.#saveTask(task);
    return clone(task);
  }

  async start(id, range) {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const task = this.#requireTask(id);
    if (task.status !== TASK_STATUS.PENDING) throw new Error("只有待开始任务可以启动");
    if (range) {
      const resolved = resolveDateRange(range, this.now());
      task.from = resolved.from;
      task.to = resolved.to;
      task.updatedAt = this.now().toISOString();
      await this.#saveTask(task);
    }
    return this.#requeue(task, "等待采集");
  }

  async startBatch(ids, range) {
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
      await this.start(id, range);
      started.push(id);
    }
    return { started, skipped };
  }

  async createBatch({ entries, range }) {
    if (this.closed) throw new Error("任务管理器已关闭");
    resolveDateRange(range, this.now());
    const normalized = normalizeBatchEntries(entries);
    const existing = new Set();
    for (const task of this.tasks.values()) {
      try {
        existing.add(normalizeProfileUrl(task.profileUrl).url);
      } catch {
        if (task.profileUrl) existing.add(task.profileUrl);
      }
    }
    const tasks = [];
    let duplicates = normalized.duplicates;
    for (const entry of normalized.valid) {
      if (existing.has(entry.url)) {
        duplicates += 1;
        continue;
      }
      existing.add(entry.url);
      try {
        tasks.push(await this.create({ url: entry.url, range }));
      } catch (error) {
        existing.delete(entry.url);
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
      duplicates,
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
      storageError: this.storageError,
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
      throttleWait: this.throttleWait,
    };
  }

  setThrottle(values) {
    Object.assign(this.throttle, values);
    this.#requestSchedule();
  }

  async pauseAll() {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (!this.paused) {
      this.paused = true;
      await this.#persistStorage(() => this.platformCooldowns.save(true));
    }
    const queued = this.queue;
    this.queue = [];
    for (const id of queued) {
      const task = this.tasks.get(id);
      if (!task || task.status !== TASK_STATUS.QUEUED) continue;
      task.status = TASK_STATUS.PAUSED;
      task.progress.stage = "已暂停";
      task.updatedAt = this.now().toISOString();
      await this.#saveTask(task);
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
    const recoveringStorage = this.storageError !== null;
    if (!this.paused && !recoveringStorage) return this.controlStatus();
    if (recoveringStorage) {
      await Promise.allSettled([...this.runningPromises]);
      await this.#retryStorageWrites();
      try {
        for (const task of this.tasks.values()) await this.store.save(task);
      } catch (error) {
        this.#haltForStorage(error);
        throw error;
      }
    }
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
      try {
        await this.store.save(task);
      } catch (error) {
        this.#haltForStorage(error);
        throw error;
      }
    }
    if (this.paused) await this.#persistStorage(() => this.platformCooldowns.save(false));
    for (const task of this.tasks.values()) {
      if (task.status === TASK_STATUS.QUEUED && !this.queue.includes(task.id)) this.queue.push(task.id);
    }
    this.paused = false;
    this.storageError = null;
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
    await this.#saveTask(task);
    if (runningPromise) await Promise.allSettled([runningPromise]);
    this.#requestSchedule();
    return clone(task);
  }

  async retry(id) {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const task = this.#requireTask(id);
    if (![TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.PARTIAL].includes(task.status)) {
      throw new Error("只有失败、部分完成或已取消任务可以重试");
    }
    task.recoveryAttempts = 0;
    return this.#requeue(task, "等待重试");
  }

  async update(id, range) {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const task = this.#requireTask(id);
    if (![TASK_STATUS.COMPLETED, TASK_STATUS.PARTIAL].includes(task.status)) throw new Error("只有已完成或部分完成任务可以采集新增");
    const resolved = resolveDateRange(range ?? { preset: "year" }, this.now());
    Object.assign(task, {
      from: range ? resolved.from : task.from,
      to: resolved.to,
      completedAt: null,
      recoveryAttempts: 0,
      refreshRequested: true,
    });
    return this.#requeue(task, "等待采集新增");
  }

  async runBatch(action, ids, range) {
    if (!["recollect", "update"].includes(action)) throw new Error("不支持的批量操作");
    if (!Array.isArray(ids)) throw new Error("任务编号必须是数组");
    const started = [];
    const skipped = [];
    for (const id of new Set(ids)) {
      try {
        await this[action](id, range);
        started.push(id);
      } catch (error) {
        if (this.paused || this.storageError) throw error;
        skipped.push({ id, reason: errorMessage(error) });
      }
    }
    return { started, skipped };
  }

  async recollect(id, range) {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
    const task = this.#requireTask(id);
    const resolved = range ? resolveDateRange(range, this.now()) : null;
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    this.running.get(id)?.abort();
    const runningPromise = this.taskRuns.get(id);
    if (runningPromise) await Promise.allSettled([runningPromise]);
    if (resolved) Object.assign(task, { from: resolved.from, to: resolved.to });
    await this.#persistStorage(() => new CollectionCheckpoint(this.store.taskDir(id)).reset());
    Object.assign(task, { completedAt: null, recoveryAttempts: 0, refreshRequested: false });
    return this.#requeue(task, "等待重新采集");
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
    this.#assertSchedulingAvailable();
    this.platformBlocks.delete(platform);
    const tasks = [...this.tasks.values()].filter(
      (task) => task.platform === platform && task.status === TASK_STATUS.WAITING_USER,
    );
    for (const task of tasks) await this.#requeue(task, "等待恢复");
    return tasks.map((task) => clone(task));
  }

  async recoverPlatform(platform) {
    this.#assertSchedulingAvailable();
    if (this.platformBlocks.get(platform)?.reason !== "browser") {
      throw new Error("该平台没有浏览器运行环境故障");
    }
    this.platformBlocks.delete(platform);
    const taskIds = [...this.tasks.values()].filter(
      (task) => task.platform === platform
        && task.status === TASK_STATUS.BLOCKED
        && task.blockReason === "browser",
    ).map((task) => task.id);
    const recovered = [];
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (task?.status !== TASK_STATUS.BLOCKED || task.blockReason !== "browser") continue;
      recovered.push(await this.#requeue(task, "等待重新检测", false));
    }
    this.#requestSchedule();
    return recovered;
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
    clearTimeout(this.throttleTimer);
    this.platformCooldowns.close();
    for (const [id, controller] of this.running) {
      if (this.tasks.get(id)?.status !== TASK_STATUS.CANCELLED) this.pauseRequested.add(id);
      controller.abort();
    }
    await Promise.allSettled([...this.runningPromises]);
  }

  #requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  async #requeue(task, stage, schedule = true) {
    this.#assertSchedulingAvailable();
    const block = this.platformBlocks.get(task.platform);
    if (block) {
      this.#applyBlock(task, block);
      task.updatedAt = this.now().toISOString();
      await this.#saveTask(task);
      return clone(task);
    }
    task.status = TASK_STATUS.QUEUED;
    task.error = null;
    task.blockReason = null;
    task.resultPath = null;
    task.progress = { stage, current: 0, total: 0, imagesDownloaded: 0, previewImages: 0 };
    task.warningCount = 0;
    task.updatedAt = this.now().toISOString();
    this.queue.push(task.id);
    await this.#saveTask(task);
    if (schedule) this.#requestSchedule();
    return clone(task);
  }

  #requestSchedule() {
    queueMicrotask(() => this.#schedule());
  }

  #throttleDelay(candidate) {
    const now = this.now().getTime();
    const { bloggerGapMs, dailyLimit } = this.throttle;
    const today = this.now().toDateString();
    const candidateRanToday = candidate?.lastRunAt && new Date(candidate.lastRunAt).toDateString() === today;
    if (dailyLimit > 0 && !candidateRanToday) {
      const startedToday = [...this.tasks.values()]
        .filter((task) => task.lastRunAt && new Date(task.lastRunAt).toDateString() === today).length;
      if (startedToday >= dailyLimit) {
        const midnight = new Date(this.now());
        midnight.setHours(24, 0, 0, 0);
        return { reason: "daily", until: midnight.getTime() };
      }
    }
    if (bloggerGapMs > 0 && this.running.size === 0 && this.lastRunFinishedAt) {
      const until = this.lastRunFinishedAt + bloggerGapMs;
      if (until > now) return { reason: "gap", until };
    }
    return null;
  }

  #schedule() {
    clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
    this.throttleWait = null;
    if (this.closed || this.paused || this.storageError) return;
    this.platformCooldowns.refresh();
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      let runnableIndex = -1;
      let delay = null;
      for (const [index, id] of this.queue.entries()) {
        const candidate = this.tasks.get(id);
        const runnable = candidate?.status === TASK_STATUS.QUEUED
          && !this.platformBlocks.has(candidate.platform)
          && !this.platformCooldowns.has(candidate.platform)
          && this.#runningCount(candidate.platform) < (this.platformConcurrency[candidate.platform] ?? this.maxConcurrency);
        if (!runnable) continue;
        const candidateDelay = this.#throttleDelay(candidate);
        if (!candidateDelay) {
          runnableIndex = index;
          break;
        }
        delay ??= candidateDelay;
      }
      if (runnableIndex < 0) {
        if (delay) {
          this.throttleWait = { reason: delay.reason, until: new Date(delay.until).toISOString() };
          const wait = Math.min(Math.max(delay.until - this.now().getTime(), 1_000), 2_147_000_000);
          this.throttleTimer = setTimeout(() => this.#requestSchedule(), wait);
          this.throttleTimer.unref?.();
        }
        return;
      }
      const [id] = this.queue.splice(runnableIndex, 1);
      const task = this.tasks.get(id);
      if (!task || task.status !== TASK_STATUS.QUEUED) continue;
      const promise = this.#run(task);
      this.runningPromises.add(promise);
      this.taskRuns.set(id, promise);
      const cleanup = () => {
        this.runningPromises.delete(promise);
        if (this.taskRuns.get(id) === promise) this.taskRuns.delete(id);
      };
      promise.then(cleanup, cleanup);
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
    const checkpoint = new CollectionCheckpoint(this.store.taskDir(task.id));
    let browserSession = null;
    this.running.set(task.id, controller);
    task.status = TASK_STATUS.RUNNING;
    task.error = null;
    task.startedAt = task.startedAt ?? this.now().toISOString();
    task.lastRunAt = this.now().toISOString();
    task.updatedAt = this.now().toISOString();
    task.progress.stage = "正在采集";
    const onProgress = async (progress) => {
      if (controller.signal.aborted) return;
      task.progress = { ...task.progress, ...progress };
      task.updatedAt = this.now().toISOString();
      await this.#saveTask(task);
    };

    try {
      await this.#saveTask(task);
      throwIfAborted(controller.signal);
      browserSession = await this.taskSessionFactory(clone(task));
      throwIfAborted(controller.signal);
      const collector = this.collectorFactory(task.platform, browserSession ?? undefined);
      let saved = await checkpoint.load();
      if (task.refreshRequested) {
        await this.#persistStorage(() => checkpoint.extend(task.from, task.to));
        saved = await checkpoint.load();
        task.refreshRequested = false;
        await this.#saveTask(task);
      }
      throwIfAborted(controller.signal);
      const result = saved.result ?? await collector.collect(clone(task), {
        signal: controller.signal, onProgress, checkpoint: saved,
        onCheckpoint: async (entry) => {
          throwIfAborted(controller.signal);
          await this.#persistStorage(() => checkpoint.record(entry));
        },
      });
      throwIfAborted(controller.signal);
      await this.#persistStorage(() => checkpoint.complete(result));
      throwIfAborted(controller.signal);
      task.author = result.author ?? task.profileKey;
      task.warningCount = result.warnings?.length ?? 0;
      await this.#export(task, result.notes ?? [], checkpoint, {
        signal: controller.signal,
        onProgress,
        browserSession,
      });
      throwIfAborted(controller.signal);
      const incomplete = (task.progress.imagesFailed ?? 0) + (task.progress.imagesUpgradeFailed ?? 0);
      task.status = incomplete > 0 ? TASK_STATUS.PARTIAL : TASK_STATUS.COMPLETED;
      task.progress.stage = incomplete > 0 ? `部分完成，${incomplete} 张图片需重试` : task.warningCount > 0
        ? `采集完成，跳过 ${task.warningCount} 篇不可访问帖子`
        : (result.notes?.length ?? 0) === 0
          ? "采集完成，区间内没有图文帖子"
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
            await this.#export(task, partial.notes, checkpoint, {
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
            await this.#persistStorage(() => this.platformCooldowns.set(task.platform, retryAfterMs));
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
      this.lastRunFinishedAt = this.now().getTime();
      try {
        await this.#saveTask(task);
      } catch { /* 故障已进入 controlStatus，等待用户明确继续。 */ }
      if (!this.storageError) this.#requestSchedule();
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

  async #export(task, notes, checkpoint, options) {
    const saved = await this.exporter(task, notes, this.store.taskDir(task.id), {
      ...options, retryMedia: checkpoint.value.retryMedia,
    });
    throwIfAborted(options.signal);
    if (typeof saved === "string") {
      task.resultPath = saved;
      return;
    }
    task.resultPath = saved.directory;
    for (const key of ["imagesDownloaded", "imagesAvailable", "imagesFailed", "imagesSkipped", "imagesUpgradeFailed", "imagesExcluded", "previewImages"]) {
      task.progress[key] = saved[key] ?? 0;
    }
    await this.#persistStorage(() => checkpoint.invalidate(saved.notes ?? []));
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
        await this.#saveTask(task);
      } else if (task.status === TASK_STATUS.RUNNING) {
        this.taskInterruptions.set(task.id, block);
        this.running.get(task.id)?.abort();
        const runningPromise = this.taskRuns.get(task.id);
        if (runningPromise) runningPromises.push(runningPromise);
      }
    }
    await Promise.allSettled(runningPromises);
  }

  #assertSchedulingAvailable() {
    if (this.storageError) throw new Error(`存储故障，请确认磁盘可写后继续：${this.storageError}`);
    if (this.paused) throw new Error("调度器已暂停，请先继续调度");
  }

  async #saveTask(task) {
    try {
      await this.store.save(task);
    } catch (error) {
      this.#haltForStorage(error);
      throw error;
    }
  }

  async #persistStorage(operation) {
    try {
      await operation();
    } catch (error) {
      this.pendingStorageWrites.add(operation);
      this.#haltForStorage(error);
      throw error;
    }
  }

  async #retryStorageWrites() {
    for (const operation of [...this.pendingStorageWrites]) {
      try {
        await operation();
        this.pendingStorageWrites.delete(operation);
      } catch (error) {
        this.#haltForStorage(error);
        throw error;
      }
    }
  }

  #haltForStorage(error) {
    this.storageError = errorMessage(error);
    const interruption = {
      reason: "storage",
      message: this.storageError,
      status: TASK_STATUS.PAUSED,
      stage: "存储故障，已暂停",
    };
    for (const [id, controller] of this.running) {
      this.taskInterruptions.set(id, interruption);
      controller.abort();
    }
  }
}
