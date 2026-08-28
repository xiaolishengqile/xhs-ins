import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TaskStore } from "../../src/tasks/task-store.js";
import { SchedulerStateStore } from "../../src/tasks/scheduler-state-store.js";

test("任务状态按任务目录原子保存并可重新加载", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-store-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore(rootDir);
  const task = { id: "123e4567-e89b-12d3-a456-426614174000", status: "queued", progress: { current: 0 } };

  await store.save(task);

  assert.deepEqual(await store.loadAll(), [task]);
  assert.deepEqual(await readdir(store.taskDir(task.id)), ["task.json"]);
});

test("任务目录拒绝路径穿越", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-store-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore(rootDir);

  assert.throws(() => store.taskDir("../../outside"), /任务编号/);
});

test("同一任务的并发状态保存会按调用顺序串行完成", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-store-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TaskStore(rootDir);
  const id = "123e4567-e89b-12d3-a456-426614174000";

  await Promise.all(Array.from({ length: 40 }, (_value, revision) => store.save({
    id,
    status: "running",
    revision,
  })));

  assert.equal((await store.loadAll())[0].revision, 39);
});

test("调度暂停和平台冷却状态可原子保存并重新读取", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-control-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new SchedulerStateStore(path.join(rootDir, "scheduler.json"));

  assert.deepEqual(await store.load(), { paused: false, updatedAt: null, cooldowns: {} });
  await store.save({
    paused: true,
    updatedAt: "2026-08-28T12:00:00.000Z",
    cooldowns: { instagram: "2026-08-28T12:05:00.000Z" },
  });

  assert.deepEqual(await store.load(), {
    paused: true,
    updatedAt: "2026-08-28T12:00:00.000Z",
    cooldowns: { instagram: "2026-08-28T12:05:00.000Z" },
  });
  assert.deepEqual((await readdir(rootDir)).filter((name) => name.endsWith(".tmp")), []);
});
