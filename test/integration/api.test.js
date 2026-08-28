import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "../../src/http/app.js";
import { startServer } from "../../src/http/server.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { eventually } from "../helpers/eventually.js";
import { readZipEntries } from "../helpers/zip.js";

async function fixture(t, collect = async (task) => ({ author: task.profileKey, notes: [] })) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-api-"));
  const manager = new TaskManager({
    store: new TaskStore(rootDir),
    collectorFactory: () => ({ collect }),
    exporter: async (task, _notes, taskDir) => {
      const resultPath = path.join(taskDir, "result.zip");
      await writeFile(resultPath, `archive:${task.id}`);
      return resultPath;
    },
    now: () => new Date(2026, 7, 28, 12),
  });
  await manager.init();
  const instance = await startServer({ handler: createApp({ manager }), port: 0 });
  t.after(async () => {
    await instance.close();
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { manager, ...instance };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

test("健康检查与任务创建、列表和详情接口可用", async (t) => {
  const { url } = await fixture(t);
  const health = await json(await fetch(`${url}/api/health`));
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok", maxConcurrency: 5 });

  const created = await json(
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/api-user",
        range: { preset: "week" },
      }),
    }),
  );
  assert.equal(created.response.status, 202);
  assert.equal(created.body.task.profileKey, "api-user");

  const listed = await json(await fetch(`${url}/api/tasks`));
  assert.equal(listed.body.tasks.length, 1);
  const detail = await json(await fetch(`${url}/api/tasks/${created.body.task.id}`));
  assert.equal(detail.body.task.id, created.body.task.id);
});

test("接口拒绝无效链接、无效数据和不存在任务", async (t) => {
  const { url } = await fixture(t);
  const invalidLink = await json(
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/private", range: { preset: "week" } }),
    }),
  );
  assert.equal(invalidLink.response.status, 400);
  assert.match(invalidLink.body.error, /仅支持/);

  const invalidJson = await json(
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    }),
  );
  assert.equal(invalidJson.response.status, 400);
  assert.match(invalidJson.body.error, /JSON/);

  assert.equal((await fetch(`${url}/api/tasks/123e4567-e89b-12d3-a456-426614174000`)).status, 404);
  assert.equal((await fetch(`${url}/api/unknown`)).status, 404);
});

test("任务完成后可以下载结果", async (t) => {
  const { url, manager } = await fixture(t);
  const created = await (
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.instagram.com/download.user/",
        range: { preset: "month" },
      }),
    })
  ).json();
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));

  const response = await fetch(`${url}/api/tasks/${created.task.id}/download`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(await response.text(), `archive:${created.task.id}`);
});

test("取消和重试只影响指定任务", async (t) => {
  let release;
  const { url, manager } = await fixture(
    t,
    (_task, { signal }) => new Promise((resolve, reject) => {
      release = () => resolve({ author: "测试", notes: [] });
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    }),
  );
  const created = await (
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/cancel-user",
        range: { preset: "week" },
      }),
    })
  ).json();
  await eventually(() => assert.equal(manager.get(created.task.id).status, "running"));

  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}/cancel`, { method: "POST" })).status, 200);
  await eventually(() => assert.equal(manager.get(created.task.id).status, "cancelled"));
  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}/retry`, { method: "POST" })).status, 200);
  await eventually(() => assert.equal(manager.get(created.task.id).status, "running"));
  await eventually(() => assert.equal(typeof release, "function"));
  release();
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));
});

test("删除任务接口会移除任务及其结果文件", async (t) => {
  const { url, manager } = await fixture(t);
  const created = await (
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.xiaohongshu.com/user/profile/delete-user",
        range: { preset: "week" },
      }),
    })
  ).json();
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));

  const removed = await json(await fetch(`${url}/api/tasks/${created.task.id}`, { method: "DELETE" }));

  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body, { deleted: true });
  assert.equal(manager.get(created.task.id), null);
  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}`)).status, 404);
});

test("批量创建会跳过无效和重复链接并返回任务摘要", async (t) => {
  const { url, manager } = await fixture(t);

  const result = await json(await fetch(`${url}/api/tasks/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entries: [
        { line: 1, url: "https://www.instagram.com/batch_one/" },
        { line: 2, url: "https://www.instagram.com/batch_one/?source=file" },
        { line: 3, url: "broken" },
        { line: 4, url: "https://www.xiaohongshu.com/user/profile/batch-two" },
      ],
      range: { preset: "week" },
    }),
  }));

  assert.equal(result.response.status, 202);
  assert.equal(result.body.tasks.length, 2);
  assert.equal(result.body.duplicates, 1);
  assert.deepEqual(result.body.rejected, [
    { line: 3, url: "broken", reason: "请输入完整、安全的主页链接" },
  ]);
  assert.equal(result.body.control.maxConcurrency, 5);
  assert.equal(manager.list().length, 2);
});

test("控制接口可以幂等暂停和继续调度器", async (t) => {
  const { url } = await fixture(t);

  const initial = await json(await fetch(`${url}/api/control`));
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, {
    paused: false,
    maxConcurrency: 5,
    running: 0,
    queued: 0,
    pausedTasks: 0,
  });

  const paused = await json(await fetch(`${url}/api/control/pause`, { method: "POST" }));
  const pausedAgain = await json(await fetch(`${url}/api/control/pause`, { method: "POST" }));
  assert.equal(paused.body.paused, true);
  assert.equal(pausedAgain.body.paused, true);

  const resumed = await json(await fetch(`${url}/api/control/resume`, { method: "POST" }));
  const resumedAgain = await json(await fetch(`${url}/api/control/resume`, { method: "POST" }));
  assert.equal(resumed.body.paused, false);
  assert.equal(resumedAgain.body.paused, false);
});

test("汇总下载包含点击时所有可用的完成任务", async (t) => {
  const { url, manager } = await fixture(t);
  const empty = await json(await fetch(`${url}/api/tasks/download-completed`));
  assert.equal(empty.response.status, 409);
  assert.match(empty.body.error, /没有可下载/);

  const first = await manager.create({
    url: "https://www.instagram.com/all_one/",
    range: { preset: "week" },
  });
  const second = await manager.create({
    url: "https://www.xiaohongshu.com/user/profile/all-two",
    range: { preset: "week" },
  });
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));

  const response = await fetch(`${url}/api/tasks/download-completed`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /attachment/);
  const archivePath = path.join(manager.store.rootDir, "completed.zip");
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  const entries = await readZipEntries(archivePath);
  assert.equal([...entries.keys()].filter((name) => name.endsWith(".zip")).length, 2);
  const manifest = entries.get("manifest.json").toString("utf8");
  assert.match(manifest, new RegExp(first.id));
  assert.match(manifest, new RegExp(second.id));
});
