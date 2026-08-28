import { randomUUID } from "node:crypto";

import { normalizeProfileUrl } from "../domain/platform.js";
import { resolveDateRange } from "../domain/date-range.js";
import { RESTARTABLE_STATUS, TASK_STATUS } from "./task-states.js";
import { normalizeBatchEntries } from "./batch-input.js";

function clone(value) {
  return structuredClone(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    now = () => new Date(),
    idFactory = randomUUID,
  }) {
    this.store = store;
    this.collectorFactory = collectorFactory;
    this.exporter = exporter;
    this.taskSessionFactory = taskSessionFactory;
    this.controlStore = controlStore;
    this.maxConcurrency = maxConcurrency;
    this.now = now;
    this.idFactory = idFactory;
    this.tasks = new Map();
    this.queue = [];
    this.running = new Map();
    this.runningPromises = new Set();
    this.taskRuns = new Map();
    this.pauseRequested = new Set();
    this.paused = false;
    this.closed = false;
  }

  async init() {
    this.paused = (await this.controlStore.load()).paused === true;
    for (const task of await this.store.loadAll()) {
      const previousStatus = task.status;
      if (task.status === TASK_STATUS.RUNNING) {
        task.status = this.paused ? TASK_STATUS.PAUSED : TASK_STATUS.QUEUED;
      } else if (task.status === TASK_STATUS.PAUSED && !this.paused) {
        task.status = TASK_STATUS.QUEUED;
      }
      if (task.status === TASK_STATUS.QUEUED && RESTARTABLE_STATUS.has(previousStatus)) {
        task.error = null;
        task.progress = { ...task.progress, stage: "等待恢复" };
      }
      if (task.status !== previousStatus) await this.store.save(task);
      if (task.status === TASK_STATUS.QUEUED) this.queue.push(task.id);
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
      progress: { stage: "待开始", current: 0, total: 0, imagesDownloaded: 0 },
      author: null,
      error: null,
      resultPath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
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
      await this.#requeue(task, "等待采集");
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
    };
  }

  async pauseAll() {
    if (this.closed) throw new Error("任务管理器已关闭");
    if (!this.paused) {
      this.paused = true;
      try {
        await this.controlStore.save({ paused: true, updatedAt: this.now().toISOString() });
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
      task.author = null;
      task.resultPath = null;
      task.progress = { stage: "等待继续", current: 0, total: 0, imagesDownloaded: 0 };
      task.updatedAt = this.now().toISOString();
      task.startedAt = null;
      task.completedAt = null;
      if (!this.queue.includes(task.id)) this.queue.push(task.id);
      await this.store.save(task);
    }
    await this.controlStore.save({ paused: false, updatedAt: this.now().toISOString() });
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
    return this.#requeue(task, "等待重试");
  }

  async resume(id) {
    const task = this.#requireTask(id);
    if (task.status !== TASK_STATUS.WAITING_USER) throw new Error("该任务不需要人工恢复");
    return this.#requeue(task, "等待恢复");
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
    for (const controller of this.running.values()) controller.abort();
    await Promise.allSettled([...this.runningPromises]);
  }

  #requireTask(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  async #requeue(task, stage) {
    task.status = TASK_STATUS.QUEUED;
    task.error = null;
    task.resultPath = null;
    task.progress = { stage, current: 0, total: 0, imagesDownloaded: 0 };
    task.updatedAt = this.now().toISOString();
    this.queue.push(task.id);
    await this.store.save(task);
    this.#requestSchedule();
    return clone(task);
  }

  #requestSchedule() {
    queueMicrotask(() => this.#schedule());
  }

  #schedule() {
    if (this.closed || this.paused) return;
    while (this.running.size < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
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

  async #run(task) {
    const controller = new AbortController();
    let browserSession = null;
    let preserveHumanAction = false;
    this.running.set(task.id, controller);
    task.status = TASK_STATUS.RUNNING;
    task.error = null;
    task.startedAt = task.startedAt ?? this.now().toISOString();
    task.updatedAt = this.now().toISOString();
    task.progress.stage = "正在采集";
    await this.store.save(task);

    try {
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      browserSession = await this.taskSessionFactory(clone(task));
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      const onProgress = async (progress) => {
        if (controller.signal.aborted) return;
        task.progress = { ...task.progress, ...progress };
        task.updatedAt = this.now().toISOString();
        await this.store.save(task);
      };
      const collector = this.collectorFactory(task.platform, browserSession ?? undefined);
      const result = await collector.collect(clone(task), {
        signal: controller.signal,
        onProgress,
      });
      if (controller.signal.aborted) return;
      task.author = result.author ?? task.profileKey;
      task.resultPath = await this.exporter(task, result.notes ?? [], this.store.taskDir(task.id), {
        signal: controller.signal,
        onProgress,
        browserSession,
      });
      task.status = TASK_STATUS.COMPLETED;
      task.progress.stage = "采集完成";
      task.completedAt = this.now().toISOString();
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        const paused = this.pauseRequested.has(task.id);
        task.status = paused ? TASK_STATUS.PAUSED : TASK_STATUS.CANCELLED;
        task.error = null;
        task.progress.stage = paused ? "已暂停" : "已取消";
      } else if (error?.code === "HUMAN_ACTION_REQUIRED") {
        preserveHumanAction = true;
        task.status = TASK_STATUS.WAITING_USER;
        task.error = errorMessage(error);
        task.progress.stage = "等待人工登录或验证";
      } else {
        task.status = TASK_STATUS.FAILED;
        task.error = errorMessage(error);
        task.progress.stage = "采集失败";
      }
    } finally {
      await browserSession?.close({ preserveHumanAction }).catch(() => {});
      this.pauseRequested.delete(task.id);
      task.updatedAt = this.now().toISOString();
      this.running.delete(task.id);
      await this.store.save(task);
      this.#requestSchedule();
    }
  }
}
