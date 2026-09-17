import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const managerUrl = pathToFileURL(path.resolve("src/tasks/task-manager.js")).href;
const storeUrl = pathToFileURL(path.resolve("src/tasks/task-store.js")).href;

async function probeStorageFault(t, failurePoint) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "collector-storage-fault-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const source = `
    import { TaskManager } from ${JSON.stringify(managerUrl)};
    import { TaskStore } from ${JSON.stringify(storeUrl)};

    const store = new TaskStore(${JSON.stringify(dataDir)});
    let runs = 0;
    const manager = new TaskManager({
      store,
      maxConcurrency: 1,
      collectorFactory: () => ({
        collect: async (_task, { onProgress }) => {
          runs += 1;
          await onProgress({ current: 1, total: 1 });
          return { author: "测试账号", notes: [] };
        },
      }),
      exporter: async () => ${JSON.stringify(path.join(dataDir, "output"))},
    });
    await manager.init();
    const first = await manager.create({
      url: "https://www.instagram.com/storage_first/",
      range: { preset: "week" },
    });
    const second = await manager.create({
      url: "https://www.instagram.com/storage_second/",
      range: { preset: "week" },
    });
    const save = store.save.bind(store);
    let runningSaves = 0;
    store.save = async (task) => {
      if (task.status === "running") runningSaves += 1;
      const shouldFail = ${JSON.stringify(failurePoint)} === "running"
        ? task.status === "running" && runningSaves === 1
        : ${JSON.stringify(failurePoint)} === "progress"
          ? task.status === "running" && runningSaves === 2
          : task.status === "completed";
      if (shouldFail) {
        const error = new Error("模拟磁盘空间不足");
        error.code = "ENOSPC";
        throw error;
      }
      return save(task);
    };
    await manager.start(first.id);
    await manager.start(second.id).catch(() => {});
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const control = manager.controlStatus();
      if (control.storageError && control.running === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log(JSON.stringify({
      control: manager.controlStatus(),
      first: manager.get(first.id),
      second: manager.get(second.id),
      runs,
    }));
    await manager.shutdown();
  `;
  try {
    const result = await execFileAsync(process.execPath, [
      "--unhandled-rejections=strict",
      "--input-type=module",
      "--eval",
      source,
    ], { timeout: 5_000 });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout?.trim() ?? "",
      stderr: error.stderr?.trim() ?? "",
    };
  }
}

for (const [failurePoint, label] of [
  ["running", "首次运行状态保存"],
  ["progress", "运行进度保存"],
  ["completed", "任务结束状态保存"],
]) {
  test(`${label}失败会释放占位、冻结队列且没有未处理拒绝`, async (t) => {
    const result = await probeStorageFault(t, failurePoint);

    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.control.running, 0);
    assert.equal(state.control.storageError, "模拟磁盘空间不足");
    assert.ok(!["running", "completed", "partial"].includes(state.second.status));
    assert.ok(state.runs <= 1);
  });
}

test("存储故障只在用户明确继续且状态成功写回后解除", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-storage-recovery-"));
  const { TaskManager } = await import(managerUrl);
  const { TaskStore } = await import(storeUrl);
  const store = new TaskStore(rootDir);
  let fail = true;
  let runs = 0;
  const manager = new TaskManager({
    store,
    collectorFactory: () => ({ collect: async () => {
      runs += 1;
      return { author: "恢复账号", notes: [] };
    } }),
    exporter: async () => path.join(rootDir, "output"),
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  await manager.init();
  const created = await manager.create({
    url: "https://www.instagram.com/storage_recovery/",
    range: { preset: "week" },
  });
  const save = store.save.bind(store);
  let faulted = false;
  const recoveryWrites = [];
  store.save = async (task) => {
    if (faulted) recoveryWrites.push(task.status);
    if (fail && (faulted || task.status === "running")) {
      faulted = true;
      throw new Error("磁盘仍不可写");
    }
    return save(task);
  };

  await manager.start(created.id);
  const faultDeadline = Date.now() + 2_000;
  while ((!manager.controlStatus().storageError || manager.controlStatus().running) && Date.now() < faultDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.controlStatus().storageError, "磁盘仍不可写");
  assert.equal(runs, 0);
  await assert.rejects(() => manager.resumeAll(), /磁盘仍不可写/);
  assert.equal(manager.controlStatus().storageError, "磁盘仍不可写");
  assert.equal(runs, 0);

  fail = false;
  recoveryWrites.length = 0;
  await manager.resumeAll();
  const deadline = Date.now() + 2_000;
  while (manager.get(created.id).status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.controlStatus().storageError, null);
  assert.equal(manager.get(created.id).status, "completed");
  assert.equal(runs, 1);
  assert.deepEqual(recoveryWrites.slice(0, 2), ["paused", "queued"]);
});

test("用户立即继续时先等待故障任务释放运行资源", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-storage-drain-"));
  const { TaskManager } = await import(managerUrl);
  const { TaskStore } = await import(storeUrl);
  const store = new TaskStore(rootDir);
  let releaseFinalSave;
  const finalSaveBlocked = new Promise((resolve) => { releaseFinalSave = resolve; });
  let failRunningSave = true;
  let blockPausedSave = true;
  let runs = 0;
  const manager = new TaskManager({
    store,
    collectorFactory: () => ({ collect: async () => {
      runs += 1;
      return { author: "竞态恢复账号", notes: [] };
    } }),
    exporter: async () => path.join(rootDir, "output"),
  });
  t.after(async () => {
    releaseFinalSave();
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  await manager.init();
  const created = await manager.create({
    url: "https://www.instagram.com/storage_drain/",
    range: { preset: "week" },
  });
  const save = store.save.bind(store);
  store.save = async (task) => {
    if (task.status === "running" && failRunningSave) {
      failRunningSave = false;
      throw new Error("首次写盘失败");
    }
    if (task.status === "paused" && blockPausedSave) {
      blockPausedSave = false;
      await finalSaveBlocked;
    }
    return save(task);
  };

  await manager.start(created.id);
  const deadline = Date.now() + 2_000;
  while (!manager.controlStatus().storageError && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const recovery = manager.resumeAll();
  const recoveredBeforeCleanup = await Promise.race([
    recovery.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  releaseFinalSave();
  await recovery;
  const completedDeadline = Date.now() + 2_000;
  while (manager.get(created.id).status !== "completed" && Date.now() < completedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(recoveredBeforeCleanup, false);
  assert.equal(manager.get(created.id).status, "completed");
  assert.equal(runs, 1);
});
