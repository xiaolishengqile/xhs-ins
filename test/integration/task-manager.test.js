import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eventually } from "../helpers/eventually.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { SchedulerStateStore } from "../../src/tasks/scheduler-state-store.js";
import { LoginRequiredError, PlatformTemporarilyUnavailableError } from "../../src/collectors/errors.js";

function input(index) {
  return {
    url: `https://www.xiaohongshu.com/user/profile/user${index}`,
    range: { preset: "week" },
  };
}

function instagramInput(index) {
  return {
    url: `https://www.instagram.com/creator${index}/`,
    range: { preset: "week" },
  };
}

async function managerFixture(t, collect, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-manager-"));
  const manager = new TaskManager({
    store: new TaskStore(rootDir),
    collectorFactory: () => ({ collect }),
    exporter: async (task) => path.join(rootDir, task.id, "result.zip"),
    maxConcurrency: 5,
    now: () => new Date(2026, 7, 28, 12),
    ...options,
  });
  await manager.init();
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return manager;
}

async function createAndStart(manager, taskInput) {
  const task = await manager.create(taskInput);
  await manager.start(task.id);
  return task;
}

test("新任务保持待开始，用户明确启动后才采集", async (t) => {
  let runs = 0;
  const manager = await managerFixture(t, async (task) => {
    runs += 1;
    return { author: task.profileKey, notes: [] };
  });

  const created = await manager.create(input(0));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.status, "pending");
  assert.equal(manager.get(created.id).status, "pending");
  assert.equal(runs, 0);

  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
  assert.equal(runs, 1);
});

test("批量启动只启动待开始任务并跳过重复编号", async (t) => {
  const manager = await managerFixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  const first = await manager.create(input(0));
  const second = await manager.create(input(1));

  const result = await manager.startBatch([first.id, first.id, second.id]);

  assert.deepEqual(result.started.sort(), [first.id, second.id].sort());
  assert.deepEqual(result.skipped, []);
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
});

test("调度器暂停时拒绝启动待开始任务", async (t) => {
  const manager = await managerFixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  const created = await manager.create(input(0));

  await manager.pauseAll();

  await assert.rejects(() => manager.start(created.id), /调度器已暂停/);
  assert.equal(manager.get(created.id).status, "pending");
});

test("六个任务中最多五个并行且空位出现后第六个自动开始", async (t) => {
  const releases = [];
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const manager = await managerFixture(t, async (_task, { signal }) => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve, reject) => {
        releases.push(resolve);
        signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
      });
      return { author: "测试博主", notes: [] };
    } finally {
      active -= 1;
    }
  });

  const created = [];
  for (let index = 0; index < 6; index += 1) created.push(await manager.create(input(index)));
  await manager.startBatch(created.map((task) => task.id));

  await eventually(() => assert.equal(active, 5));
  assert.equal(maxActive, 5);
  assert.equal(started, 5);
  assert.equal(manager.get(created[5].id).status, "queued");

  releases.shift()();
  await eventually(() => assert.equal(started, 6));
  assert.equal(maxActive, 5);
  assert.equal(manager.get(created[5].id).status, "running");

  for (const release of releases) release();
  await eventually(() => assert.equal(manager.list().filter((task) => task.status === "completed").length, 6));
});

test("照片墙平台一次只运行一个任务且不阻塞其他平台", async (t) => {
  const releases = new Map();
  const started = [];
  const manager = await managerFixture(t, async (task, { signal }) => {
    started.push(task.profileKey);
    await new Promise((resolve, reject) => {
      releases.set(task.id, resolve);
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    });
    return { author: task.profileKey, notes: [] };
  });
  const firstInstagram = await manager.create(instagramInput(1));
  const secondInstagram = await manager.create(instagramInput(2));
  const xiaohongshu = await manager.create(input(3));

  await manager.startBatch([firstInstagram.id, secondInstagram.id, xiaohongshu.id]);

  await eventually(() => assert.deepEqual(started.sort(), ["creator1", "user3"].sort()));
  assert.equal(manager.get(secondInstagram.id).status, "queued");

  releases.get(firstInstagram.id)();
  await eventually(() => assert.ok(started.includes("creator2")));

  releases.get(secondInstagram.id)();
  releases.get(xiaohongshu.id)();
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
});

test("运行任务可取消且不会影响其他任务", async (t) => {
  const manager = await managerFixture(t, async (task, { signal }) => {
    if (task.profileKey === "user0") {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
      });
    }
    return { author: task.profileKey, notes: [] };
  });
  const first = await manager.create(input(0));
  const second = await manager.create(input(1));
  await manager.startBatch([first.id, second.id]);

  await eventually(() => assert.equal(manager.get(first.id).status, "running"));
  await manager.cancel(first.id);

  await eventually(() => assert.equal(manager.get(first.id).status, "cancelled"));
  await eventually(() => assert.equal(manager.get(second.id).status, "completed"));
});

test("删除运行任务会先停止采集并彻底移除记录", async (t) => {
  let started = false;
  let aborted = false;
  const manager = await managerFixture(
    t,
    (_task, { signal }) => {
      started = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("已取消", "AbortError"));
        }, { once: true });
      });
    },
  );
  const created = await createAndStart(manager, input(0));
  const taskDir = manager.store.taskDir(created.id);
  await eventually(() => assert.equal(started, true));

  await manager.delete(created.id);

  assert.equal(aborted, true);
  assert.equal(manager.get(created.id), null);
  assert.deepEqual(await manager.store.loadAll(), []);
  await assert.rejects(() => access(taskDir), { code: "ENOENT" });
});

test("失败任务可以重试且其他任务照常完成", async (t) => {
  let shouldFail = true;
  const manager = await managerFixture(t, async (task) => {
    if (task.profileKey === "user0" && shouldFail) throw new Error("页面暂时不可用");
    return { author: task.profileKey, notes: [] };
  });
  const failed = await manager.create(input(0));
  const healthy = await manager.create(input(1));
  await manager.startBatch([failed.id, healthy.id]);

  await eventually(() => assert.equal(manager.get(failed.id).status, "failed"));
  await eventually(() => assert.equal(manager.get(healthy.id).status, "completed"));
  shouldFail = false;
  await manager.retry(failed.id);

  await eventually(() => assert.equal(manager.get(failed.id).status, "completed"));
  assert.equal(manager.get(failed.id).error, null);
});

test("底层页面跳转错误会转换成简洁中文提示", async (t) => {
  const manager = await managerFixture(t, async () => {
    throw new Error("page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE\n\u001b[2mCall log\u001b[22m");
  });
  const created = await createAndStart(manager, input(0));

  await eventually(() => assert.equal(manager.get(created.id).status, "failed"));

  assert.equal(manager.get(created.id).error, "页面访问失败，请稍后重试");
});

test("平台临时拒绝访问时保存部分结果并冷却同平台队列", async (t) => {
  const runs = [];
  const exportedNoteIds = [];
  const attempts = new Map();
  const manager = await managerFixture(
    t,
    async (task) => {
      runs.push(task.profileKey);
      const attempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, attempt);
      if (task.profileKey === "creator1" && attempt === 1) {
        throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
          retryAfterMs: 80,
          partialResult: {
            author: task.profileKey,
            notes: [{ id: "saved-before-cooldown" }],
            warnings: ["帖子已失效"],
          },
        });
      }
      return {
        author: task.profileKey,
        notes: [],
        warnings: task.profileKey === "creator1" ? ["帖子已失效"] : [],
      };
    },
    {
      now: () => new Date(),
      exporter: async (_task, notes, taskDir) => {
        exportedNoteIds.push(...notes.map((note) => note.id));
        return path.join(taskDir, "result");
      },
    },
  );
  const first = await manager.create(instagramInput(1));
  const second = await manager.create(instagramInput(2));
  await manager.startBatch([first.id, second.id]);

  await eventually(() => assert.equal(manager.get(first.id).progress.stage, "平台冷却中，稍后自动继续"));
  assert.deepEqual(runs, ["creator1"]);
  assert.deepEqual(exportedNoteIds, ["saved-before-cooldown"]);
  assert.ok(manager.controlStatus().cooldowns.instagram);

  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
  assert.equal(attempts.get(first.id), 2);
  assert.equal(attempts.get(second.id), 1);
  assert.equal(manager.get(first.id).warningCount, 1);
});

test("平台冷却前保存部分结果失败时任务会正常失败", async (t) => {
  const manager = await managerFixture(
    t,
    async () => {
      throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
        retryAfterMs: 80,
        partialResult: { author: "creator1", notes: [{ id: "partial" }], warnings: [] },
      });
    },
    {
      now: () => new Date(),
      exporter: async () => { throw new Error("部分结果保存失败"); },
    },
  );
  const created = await createAndStart(manager, instagramInput(1));

  await eventually(() => assert.equal(manager.get(created.id).status, "failed"));

  assert.equal(manager.get(created.id).error, "部分结果保存失败");
  assert.equal(manager.controlStatus().running, 0);
  assert.deepEqual(manager.controlStatus().cooldowns, {});
});

test("平台冷却状态保存失败时不会留下无效冷却", async (t) => {
  const manager = await managerFixture(
    t,
    async () => {
      throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
        retryAfterMs: 80,
        partialResult: { author: "creator1", notes: [], warnings: [] },
      });
    },
    {
      now: () => new Date(),
      controlStore: {
        load: async () => ({ paused: false, updatedAt: null }),
        save: async () => { throw new Error("冷却状态保存失败"); },
      },
    },
  );
  const created = await createAndStart(manager, instagramInput(1));

  await eventually(() => assert.equal(manager.get(created.id).status, "failed"));

  assert.equal(manager.get(created.id).error, "冷却状态保存失败");
  assert.deepEqual(manager.controlStatus().cooldowns, {});
});

test("保存冷却前部分结果时取消任务不会被覆盖成失败", async (t) => {
  let exportStarted = false;
  const manager = await managerFixture(
    t,
    async () => {
      throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
        retryAfterMs: 80,
        partialResult: { author: "creator1", notes: [{ id: "partial" }], warnings: [] },
      });
    },
    {
      now: () => new Date(),
      exporter: async (_task, _notes, _taskDir, { signal }) => {
        exportStarted = true;
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
        });
      },
    },
  );
  const created = await createAndStart(manager, instagramInput(1));
  await eventually(() => assert.equal(exportStarted, true));

  await manager.cancel(created.id);

  assert.equal(manager.get(created.id).status, "cancelled");
  assert.equal(manager.get(created.id).error, null);
});

test("保存冷却前部分结果时暂停任务不会被覆盖成失败", async (t) => {
  let exportStarted = false;
  const manager = await managerFixture(
    t,
    async () => {
      throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
        retryAfterMs: 80,
        partialResult: { author: "creator1", notes: [{ id: "partial" }], warnings: [] },
      });
    },
    {
      now: () => new Date(),
      exporter: async (_task, _notes, _taskDir, { signal }) => {
        exportStarted = true;
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
        });
      },
    },
  );
  const created = await createAndStart(manager, instagramInput(1));
  await eventually(() => assert.equal(exportStarted, true));

  await manager.pauseAll();

  assert.equal(manager.get(created.id).status, "paused");
  assert.equal(manager.get(created.id).error, null);
});

test("写入平台冷却状态期间取消任务不会重新入队", async (t) => {
  let releaseSave;
  let saveStarted = false;
  const manager = await managerFixture(
    t,
    async () => {
      throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
        retryAfterMs: 80,
        partialResult: { author: "creator1", notes: [], warnings: [] },
      });
    },
    {
      now: () => new Date(),
      controlStore: {
        load: async () => ({ paused: false, updatedAt: null }),
        save: async () => {
          saveStarted = true;
          await new Promise((resolve) => { releaseSave = resolve; });
        },
      },
    },
  );
  const created = await createAndStart(manager, instagramInput(1));
  await eventually(() => assert.equal(saveStarted, true));

  const cancelling = manager.cancel(created.id);
  await new Promise((resolve) => setImmediate(resolve));
  releaseSave();
  await cancelling;

  assert.equal(manager.get(created.id).status, "cancelled");
  assert.equal(manager.controlStatus().queued, 0);
});

test("平台多次冷却后仍被拒绝会停止自动重试", async (t) => {
  let runs = 0;
  const manager = await managerFixture(
    t,
    async () => {
      runs += 1;
      throw new PlatformTemporarilyUnavailableError("平台持续拒绝访问", {
        retryAfterMs: 20,
        partialResult: { author: "creator1", notes: [], warnings: [] },
      });
    },
    { now: () => new Date(), maxPlatformRecoveryAttempts: 1 },
  );
  const created = await createAndStart(manager, instagramInput(1));

  await eventually(() => assert.equal(manager.get(created.id).status, "failed"));

  assert.equal(runs, 2);
  assert.equal(manager.get(created.id).progress.stage, "平台持续拒绝访问");
  assert.match(manager.get(created.id).error, /稍后手动重试/);
});

test("应用重启后会恢复未完成任务", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-restart-"));
  const store = new TaskStore(rootDir);
  await store.save({
    id: "123e4567-e89b-12d3-a456-426614174000",
    platform: "xiaohongshu",
    profileUrl: "https://www.xiaohongshu.com/user/profile/restart",
    profileKey: "restart",
    from: new Date(2026, 7, 22).toISOString(),
    to: new Date(2026, 7, 28, 23, 59, 59, 999).toISOString(),
    status: "running",
    progress: { stage: "采集中", current: 2, total: 5, imagesDownloaded: 0 },
    error: null,
    resultPath: null,
    createdAt: new Date(2026, 7, 28).toISOString(),
    updatedAt: new Date(2026, 7, 28).toISOString(),
  });
  const manager = new TaskManager({
    store,
    collectorFactory: () => ({ collect: async () => ({ author: "恢复任务", notes: [] }) }),
    exporter: async () => path.join(rootDir, "result.zip"),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });

  await manager.init();

  await eventually(() => assert.equal(manager.list()[0].status, "completed"));
});

test("需要登录时同平台任务统一等待且另一平台继续运行", async (t) => {
  let requiresLogin = true;
  const manager = await managerFixture(t, async (task) => {
    if (task.profileKey === "user0" && requiresLogin) throw new LoginRequiredError();
    return { author: task.profileKey, notes: [] };
  }, { maxConcurrency: 1 });
  const waiting = await manager.create(input(0));
  const samePlatform = await manager.create(input(1));
  const otherPlatform = await manager.create({
    url: "https://www.instagram.com/other_platform/",
    range: { preset: "week" },
  });
  await manager.startBatch([waiting.id, samePlatform.id, otherPlatform.id]);

  await eventually(() => assert.equal(manager.get(waiting.id).status, "waiting_user"));
  await eventually(() => assert.equal(manager.get(samePlatform.id).status, "waiting_user"));
  await eventually(() => assert.equal(manager.get(otherPlatform.id).status, "completed"));

  requiresLogin = false;
  await manager.resumePlatform("xiaohongshu");

  await eventually(() => assert.equal(manager.get(waiting.id).status, "completed"));
  await eventually(() => assert.equal(manager.get(samePlatform.id).status, "completed"));
});

test("导出阶段可以更新图片下载进度", async (t) => {
  const manager = await managerFixture(
    t,
    async () => ({ author: "测试博主", notes: [{ id: "n1" }] }),
    {
      exporter: async (_task, _notes, taskDir, { onProgress, signal }) => {
        assert.equal(signal.aborted, false);
        await onProgress({ stage: "下载图片", imagesDownloaded: 2 });
        return path.join(taskDir, "result.zip");
      },
    },
  );
  const created = await createAndStart(manager, input(0));

  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
  assert.equal(manager.get(created.id).progress.imagesDownloaded, 2);
});

test("完成任务会展示跳过帖子与预览图数量", async (t) => {
  const manager = await managerFixture(
    t,
    async () => ({ author: "测试博主", notes: [{ id: "n1" }], warnings: ["帖子一不可访问"] }),
    {
      exporter: async (_task, _notes, taskDir, { onProgress }) => {
        await onProgress({ stage: "下载图片", imagesDownloaded: 1, previewImages: 2 });
        return path.join(taskDir, "result");
      },
    },
  );
  const created = await createAndStart(manager, input(0));

  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));

  const completed = manager.get(created.id);
  assert.equal(completed.warningCount, 1);
  assert.equal(completed.progress.previewImages, 2);
  assert.equal(completed.progress.stage, "采集完成，跳过 1 篇不可访问帖子");
});

test("任务页面在媒体导出和归档完成后才关闭", async (t) => {
  const events = [];
  const browserSession = {
    close: async () => events.push("close"),
    fetchBuffer: async () => {
      events.push("fetch");
      return Buffer.from("image");
    },
  };
  const manager = await managerFixture(
    t,
    async () => {
      events.push("collect");
      return { author: "测试博主", notes: [] };
    },
    {
      taskSessionFactory: async () => browserSession,
      exporter: async (_task, _notes, taskDir, { browserSession: activeSession }) => {
        await activeSession.fetchBuffer("https://example.com/image.jpg");
        events.push("archive");
        return path.join(taskDir, "result.zip");
      },
    },
  );
  const created = await createAndStart(manager, input(0));

  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));

  assert.deepEqual(events, ["collect", "fetch", "archive", "close"]);
});

test("失败和取消任务会完整关闭浏览器会话", async (t) => {
  const closeOptions = [];
  let sessionCreations = 0;
  const browserSession = { close: async (options) => closeOptions.push(options) };
  const manager = await managerFixture(
    t,
    async (task, { signal }) => {
      if (task.profileKey === "user0") throw new Error("页面失败");
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
      });
    },
    {
      taskSessionFactory: async () => {
        sessionCreations += 1;
        return browserSession;
      },
    },
  );
  const failed = await createAndStart(manager, input(0));
  await eventually(() => assert.equal(manager.get(failed.id).status, "failed"));
  const cancelled = await createAndStart(manager, input(1));
  await eventually(() => assert.equal(manager.get(cancelled.id).status, "running"));
  await eventually(() => assert.equal(sessionCreations, 2));
  await manager.cancel(cancelled.id);
  await eventually(() => assert.equal(manager.get(cancelled.id).status, "cancelled"));
  await eventually(() => assert.equal(closeOptions.length, 2));

  assert.deepEqual(closeOptions, [undefined, undefined]);
});

test("等待人工处理任务也会关闭后台浏览器会话", async (t) => {
  const closeOptions = [];
  const manager = await managerFixture(
    t,
    async () => { throw new LoginRequiredError(); },
    {
      taskSessionFactory: async () => ({
        close: async (options) => closeOptions.push(options),
      }),
    },
  );
  const created = await createAndStart(manager, input(0));

  await eventually(() => assert.equal(manager.get(created.id).status, "waiting_user"));

  assert.deepEqual(closeOptions, [undefined]);
});

test("暂停全部会停止运行任务并冻结队列直到继续", async (t) => {
  const runs = new Map();
  const controlStates = [];
  const controlStore = {
    load: async () => ({ paused: false, updatedAt: null }),
    save: async (state) => controlStates.push(structuredClone(state)),
  };
  const manager = await managerFixture(
    t,
    async (task, { signal }) => {
      const count = (runs.get(task.id) ?? 0) + 1;
      runs.set(task.id, count);
      if (task.profileKey === "user0" && count === 1) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
        });
      }
      return { author: task.profileKey, notes: [] };
    },
    { maxConcurrency: 1, controlStore },
  );
  const first = await manager.create(input(0));
  const second = await manager.create(input(1));
  await manager.startBatch([first.id, second.id]);
  await eventually(() => assert.equal(manager.get(first.id).status, "running"));
  await eventually(() => assert.equal(runs.get(first.id), 1));

  const paused = await manager.pauseAll();

  assert.equal(paused.paused, true);
  assert.equal(manager.get(first.id).status, "paused");
  assert.equal(manager.get(second.id).status, "paused");
  assert.equal(runs.has(second.id), false);
  assert.equal(manager.controlStatus().queued, 0);
  assert.equal(manager.controlStatus().pausedTasks, 2);

  const resumed = await manager.resumeAll();

  assert.equal(resumed.paused, false);
  await eventually(() => assert.deepEqual(manager.list().map((task) => task.status), ["completed", "completed"]));
  assert.equal(runs.get(first.id), 2);
  assert.equal(runs.get(second.id), 1);
  assert.deepEqual(controlStates.map((state) => state.paused), [true, false]);
});

test("服务重启后保持暂停且运行中任务转为已暂停", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-paused-restart-"));
  const taskStore = new TaskStore(path.join(rootDir, "tasks"));
  const controlStore = new SchedulerStateStore(path.join(rootDir, "scheduler.json"));
  const savedTask = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    platform: "xiaohongshu",
    profileUrl: "https://www.xiaohongshu.com/user/profile/restart-paused",
    profileKey: "restart-paused",
    from: "2026-08-22T00:00:00.000Z",
    to: "2026-08-28T23:59:59.999Z",
    status: "running",
    progress: { stage: "正在采集", current: 1, total: 2, imagesDownloaded: 0 },
    author: null,
    error: null,
    resultPath: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T01:00:00.000Z",
    startedAt: "2026-08-28T01:00:00.000Z",
    completedAt: null,
  };
  await taskStore.save(savedTask);
  await controlStore.save({ paused: true, updatedAt: "2026-08-28T12:00:00.000Z" });
  let runs = 0;
  const manager = new TaskManager({
    store: taskStore,
    controlStore,
    collectorFactory: () => ({
      collect: async () => {
        runs += 1;
        return { author: "恢复任务", notes: [] };
      },
    }),
    exporter: async () => path.join(rootDir, "result.zip"),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });

  await manager.init();

  assert.equal(manager.get(savedTask.id).status, "paused");
  assert.equal(manager.controlStatus().paused, true);
  assert.equal(runs, 0);
  await manager.resumeAll();
  await eventually(() => assert.equal(manager.get(savedTask.id).status, "completed"));
  assert.equal(runs, 1);
});

test("服务重启后继续遵守尚未结束的平台冷却时间", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-cooldown-restart-"));
  const taskStore = new TaskStore(path.join(rootDir, "tasks"));
  const controlStore = new SchedulerStateStore(path.join(rootDir, "scheduler.json"));
  const savedTask = {
    id: "123e4567-e89b-12d3-a456-426614174001",
    platform: "instagram",
    profileUrl: "https://www.instagram.com/restart.cooldown/",
    profileKey: "restart.cooldown",
    from: "2026-08-22T00:00:00.000Z",
    to: "2026-08-28T23:59:59.999Z",
    status: "queued",
    progress: { stage: "平台冷却中，稍后自动继续", current: 0, total: 0, imagesDownloaded: 0 },
    author: null,
    error: "平台访问过于频繁，已自动降低速度",
    resultPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  await taskStore.save(savedTask);
  await controlStore.save({
    paused: false,
    updatedAt: new Date().toISOString(),
    cooldowns: { instagram: new Date(Date.now() + 120).toISOString() },
  });
  let runs = 0;
  const manager = new TaskManager({
    store: taskStore,
    controlStore,
    collectorFactory: () => ({ collect: async () => {
      runs += 1;
      return { author: "恢复任务", notes: [] };
    } }),
    exporter: async () => path.join(rootDir, "result"),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });

  await manager.init();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(runs, 0);
  assert.ok(manager.controlStatus().cooldowns.instagram);
  await eventually(() => assert.equal(manager.get(savedTask.id).status, "completed"));
  assert.equal(runs, 1);
});
