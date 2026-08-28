import { randomUUID } from "node:crypto";

import { normalizeProfileUrl } from "../domain/platform.js";
import { resolveDateRange } from "../domain/date-range.js";
import { RESTARTABLE_STATUS, TASK_STATUS } from "./task-states.js";

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
    maxConcurrency = 5,
    now = () => new Date(),
    idFactory = randomUUID,
  }) {
    this.store = store;
    this.collectorFactory = collectorFactory;
    this.exporter = exporter;
    this.taskSessionFactory = taskSessionFactory;
    this.maxConcurrency = maxConcurrency;
    this.now = now;
    this.idFactory = idFactory;
    this.tasks = new Map();
    this.queue = [];
    this.running = new Map();
    this.runningPromises = new Set();
    this.taskRuns = new Map();
    this.closed = false;
  }

  async init() {
    for (const task of await this.store.loadAll()) {
      if (RESTARTABLE_STATUS.has(task.status)) {
        task.status = TASK_STATUS.QUEUED;
        task.error = null;
        task.progress = { ...task.progress, stage: "等待恢复" };
        await this.store.save(task);
        this.queue.push(task.id);
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
      status: TASK_STATUS.QUEUED,
      progress: { stage: "等待采集", current: 0, total: 0, imagesDownloaded: 0 },
      author: null,
      error: null,
      resultPath: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    await this.store.save(task);
    this.#requestSchedule();
    return clone(task);
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

  async cancel(id) {
    const task = this.#requireTask(id);
    if ([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(task.status)) return clone(task);
    task.status = TASK_STATUS.CANCELLED;
    task.error = null;
    task.progress.stage = "已取消";
    task.updatedAt = this.now().toISOString();
    this.running.get(id)?.abort();
    await this.store.save(task);
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
    if (this.closed) return;
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
        task.status = TASK_STATUS.CANCELLED;
        task.error = null;
        task.progress.stage = "已取消";
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
      task.updatedAt = this.now().toISOString();
      this.running.delete(task.id);
      await this.store.save(task);
      this.#requestSchedule();
    }
  }
}
