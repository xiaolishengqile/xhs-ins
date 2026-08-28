import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { eventually } from "../helpers/eventually.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";

function input(index) {
  return {
    url: `https://www.xiaohongshu.com/user/profile/user${index}`,
    range: { preset: "week" },
  };
}

async function managerFixture(t, collect, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-manager-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const manager = new TaskManager({
    store: new TaskStore(rootDir),
    collectorFactory: () => ({ collect }),
    exporter: async (task) => path.join(rootDir, task.id, "result.zip"),
    now: () => new Date(2026, 7, 28, 12),
    ...options,
  });
  await manager.init();
  t.after(() => manager.shutdown());
  return manager;
}

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

  await eventually(() => assert.equal(manager.get(first.id).status, "running"));
  await manager.cancel(first.id);

  await eventually(() => assert.equal(manager.get(first.id).status, "cancelled"));
  await eventually(() => assert.equal(manager.get(second.id).status, "completed"));
});

test("失败任务可以重试且其他任务照常完成", async (t) => {
  let shouldFail = true;
  const manager = await managerFixture(t, async (task) => {
    if (task.profileKey === "user0" && shouldFail) throw new Error("页面暂时不可用");
    return { author: task.profileKey, notes: [] };
  });
  const failed = await manager.create(input(0));
  const healthy = await manager.create(input(1));

  await eventually(() => assert.equal(manager.get(failed.id).status, "failed"));
  await eventually(() => assert.equal(manager.get(healthy.id).status, "completed"));
  shouldFail = false;
  await manager.retry(failed.id);

  await eventually(() => assert.equal(manager.get(failed.id).status, "completed"));
  assert.equal(manager.get(failed.id).error, null);
});

test("应用重启后会恢复未完成任务", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-restart-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
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
  t.after(() => manager.shutdown());

  await manager.init();

  await eventually(() => assert.equal(manager.list()[0].status, "completed"));
});
