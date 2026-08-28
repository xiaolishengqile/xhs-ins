import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserLaunchError } from "../../src/browser/errors.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { eventually } from "../helpers/eventually.js";

function input(platform, key) {
  return {
    url: platform === "instagram"
      ? `https://www.instagram.com/${key}/`
      : `https://www.xiaohongshu.com/user/profile/${key}`,
    range: { preset: "week" },
  };
}

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-browser-breaker-"));
  const manager = new TaskManager({
    store: new TaskStore(path.join(rootDir, "tasks")),
    collectorFactory: () => ({ collect: async (task) => ({ author: task.profileKey, notes: [] }) }),
    exporter: async (task) => path.join(rootDir, "output", task.profileKey),
    now: () => new Date(2026, 7, 29, 12),
    ...options,
  });
  await manager.init();
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { manager, rootDir };
}

function blockNextRecoverySave(manager) {
  const save = manager.store.save.bind(manager.store);
  let release;
  let markStarted;
  let blocked = false;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  manager.store.save = async (task) => {
    if (!blocked && task.status === "queued" && task.progress.stage === "等待重新检测") {
      blocked = true;
      markStarted();
      await gate;
    }
    return save(task);
  };
  return { started, release };
}

test("浏览器启动失败只熔断同平台一次且其他平台继续", async (t) => {
  let instagramAttempts = 0;
  const { manager } = await fixture(t, {
    taskSessionFactory: async (task) => {
      if (task.platform === "instagram") {
        instagramAttempts += 1;
        throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
      }
      return { close: async () => {} };
    },
  });
  const first = await manager.create(input("instagram", "first"));
  const second = await manager.create(input("instagram", "second"));
  const otherPlatform = await manager.create(input("xiaohongshu", "other"));

  await manager.startBatch([first.id, second.id, otherPlatform.id]);

  await eventually(() => assert.equal(manager.get(otherPlatform.id).status, "completed"));
  await eventually(() => assert.equal(manager.controlStatus().running, 0));
  assert.equal(manager.get(first.id).status, "blocked");
  assert.equal(manager.get(second.id).status, "blocked");
  assert.equal(manager.get(first.id).blockReason, "browser");
  assert.equal(instagramAttempts, 1);
  assert.deepEqual(manager.controlStatus().platformBlocks, [{
    platform: "instagram",
    reason: "browser",
    message: "浏览器运行环境不可用",
  }]);
});

test("重新检测会一次恢复同平台全部受阻任务", async (t) => {
  let browserUnavailable = true;
  const { manager } = await fixture(t, {
    taskSessionFactory: async () => {
      if (browserUnavailable) {
        throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
      }
      return { close: async () => {} };
    },
  });
  const first = await manager.create(input("instagram", "recover_first"));
  const second = await manager.create(input("instagram", "recover_second"));
  await manager.startBatch([first.id, second.id]);
  await eventually(() => assert.equal(manager.get(second.id).status, "blocked"));
  browserUnavailable = false;

  const recovered = await manager.recoverPlatform("instagram");

  assert.deepEqual(recovered.map((task) => task.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(manager.controlStatus().platformBlocks, []);
  await eventually(() => assert.ok([first.id, second.id].every((id) => manager.get(id).status === "completed")));
});

test("平台熔断期间启动新任务不会再次尝试浏览器", async (t) => {
  let browserAttempts = 0;
  const { manager } = await fixture(t, {
    taskSessionFactory: async () => {
      browserAttempts += 1;
      throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
    },
  });
  const first = await manager.create(input("instagram", "blocked_first"));
  await manager.start(first.id);
  await eventually(() => assert.equal(manager.get(first.id).status, "blocked"));
  const later = await manager.create(input("instagram", "blocked_later"));

  await manager.start(later.id);

  assert.equal(manager.get(later.id).status, "blocked");
  assert.equal(manager.get(later.id).blockReason, "browser");
  assert.equal(browserAttempts, 1);
});

test("最后一个受阻任务取消后重试仍保留恢复入口", async (t) => {
  let browserAttempts = 0;
  const { manager } = await fixture(t, {
    taskSessionFactory: async () => {
      browserAttempts += 1;
      throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
    },
  });
  const task = await manager.create(input("instagram", "retry_blocked"));
  await manager.start(task.id);
  await eventually(() => assert.equal(manager.get(task.id).status, "blocked"));
  await manager.cancel(task.id);

  await manager.retry(task.id);

  assert.equal(manager.get(task.id).status, "blocked");
  assert.equal(manager.get(task.id).blockReason, "browser");
  assert.equal(manager.controlStatus().queued, 0);
  assert.equal(browserAttempts, 1);
});

test("服务重启后自动重新检测浏览器受阻任务", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-browser-restart-"));
  const store = new TaskStore(path.join(rootDir, "tasks"));
  const timestamp = new Date(2026, 7, 29, 12).toISOString();
  await store.save({
    id: "123e4567-e89b-12d3-a456-426614174001",
    platform: "instagram",
    profileUrl: "https://www.instagram.com/restart_blocked/",
    profileKey: "restart_blocked",
    from: timestamp,
    to: timestamp,
    status: "blocked",
    blockReason: "browser",
    progress: { stage: "浏览器运行环境受阻", current: 0, total: 0, imagesDownloaded: 0, previewImages: 0 },
    author: null,
    error: "浏览器运行环境不可用",
    resultPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    recoveryAttempts: 0,
    warningCount: 0,
  });
  const manager = new TaskManager({
    store,
    collectorFactory: () => ({ collect: async (task) => ({ author: task.profileKey, notes: [] }) }),
    exporter: async () => path.join(rootDir, "output"),
    taskSessionFactory: async () => ({ close: async () => {} }),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });

  await manager.init();

  await eventually(() => assert.equal(manager.list()[0].status, "completed"));
  assert.equal(manager.list()[0].blockReason, null);
});

test("恢复平台期间取消后续任务不会被重新排队", async (t) => {
  const { manager } = await fixture(t, {
    taskSessionFactory: async () => {
      throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
    },
  });
  const first = await manager.create(input("instagram", "cancel_race_first"));
  const second = await manager.create(input("instagram", "cancel_race_second"));
  await manager.startBatch([first.id, second.id]);
  await eventually(() => assert.equal(manager.get(second.id).status, "blocked"));
  manager.maxConcurrency = 0;
  const gate = blockNextRecoverySave(manager);

  const recovering = manager.recoverPlatform("instagram");
  await gate.started;
  await manager.cancel(second.id);
  gate.release();
  await recovering;

  assert.equal(manager.get(second.id).status, "cancelled");
  assert.equal(manager.controlStatus().queued, 1);
});

test("恢复平台期间删除后续任务不会在磁盘复活", async (t) => {
  const { manager } = await fixture(t, {
    taskSessionFactory: async () => {
      throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
    },
  });
  const first = await manager.create(input("instagram", "delete_race_first"));
  const second = await manager.create(input("instagram", "delete_race_second"));
  await manager.startBatch([first.id, second.id]);
  await eventually(() => assert.equal(manager.get(second.id).status, "blocked"));
  manager.maxConcurrency = 0;
  const gate = blockNextRecoverySave(manager);

  const recovering = manager.recoverPlatform("instagram");
  await gate.started;
  await manager.delete(second.id);
  gate.release();
  await recovering;

  assert.equal(manager.get(second.id), null);
  assert.equal((await manager.store.loadAll()).some((task) => task.id === second.id), false);
});
