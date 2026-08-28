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
import { createLinkDocxBuffer } from "../helpers/docx.js";
import { ApplicationController } from "../../src/application/controller.js";
import { LoginRequiredError } from "../../src/collectors/errors.js";

async function fixture(t, collect = async (task) => ({ author: task.profileKey, notes: [] }), options = {}) {
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
  const browserManager = options.browserManager ?? {
    close: async () => {},
    openLogin: async () => {},
    closeLogin: async () => {},
  };
  const controller = new ApplicationController({ manager, browserManager, ...options.controllerOptions });
  const instance = await startServer({ handler: createApp({ manager, controller }), port: 0 });
  t.after(async () => {
    await instance.close();
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { manager, browserManager, ...instance };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

test("健康检查与任务创建、列表和详情接口可用", async (t) => {
  const { url, manager } = await fixture(t);
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
  assert.equal(created.body.task.status, "pending");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(created.body.task.id).status, "pending");

  const started = await json(await fetch(`${url}/api/tasks/${created.body.task.id}/start`, { method: "POST" }));
  assert.equal(started.response.status, 200);
  await eventually(() => assert.equal(manager.get(created.body.task.id).status, "completed"));

  const listed = await json(await fetch(`${url}/api/tasks`));
  assert.equal(listed.body.tasks.length, 1);
  const detail = await json(await fetch(`${url}/api/tasks/${created.body.task.id}`));
  assert.equal(detail.body.task.id, created.body.task.id);
});

test("批量启动接口只启动选中的待开始任务", async (t) => {
  const { url, manager } = await fixture(t);
  const created = await json(await fetch(`${url}/api/tasks/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entries: [
        { line: 1, url: "https://www.instagram.com/start_one/" },
        { line: 2, url: "https://www.instagram.com/start_two/" },
      ],
      range: { preset: "week" },
    }),
  }));
  const ids = created.body.tasks.map((task) => task.id);

  const started = await json(await fetch(`${url}/api/tasks/start-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [ids[0], ids[0], ids[1]] }),
  }));

  assert.equal(started.response.status, 200);
  assert.deepEqual(started.body.started.sort(), ids.sort());
  assert.deepEqual(started.body.skipped, []);
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
});

test("内置博主接口返回文档中的 719 个唯一主页", async (t) => {
  const { url } = await fixture(t);

  const result = await json(await fetch(`${url}/api/profiles/builtin`));

  assert.equal(result.response.status, 200);
  assert.equal(result.body.profiles.length, 719);
  assert.equal(new Set(result.body.profiles).size, 719);
  assert.equal(result.body.profiles[0], "https://www.instagram.com/lucencyofficial/");
  assert.equal(result.body.profiles.at(-1), "https://www.instagram.com/wwwluchen/");
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

test("任务完成后不再提供压缩包下载接口", async (t) => {
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
  await fetch(`${url}/api/tasks/${created.task.id}/start`, { method: "POST" });
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));

  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}/download`)).status, 404);
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
  await fetch(`${url}/api/tasks/${created.task.id}/start`, { method: "POST" });
  await eventually(() => assert.equal(manager.get(created.task.id).status, "running"));

  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}/cancel`, { method: "POST" })).status, 200);
  await eventually(() => assert.equal(manager.get(created.task.id).status, "cancelled"));
  assert.equal((await fetch(`${url}/api/tasks/${created.task.id}/retry`, { method: "POST" })).status, 200);
  await eventually(() => assert.equal(manager.get(created.task.id).status, "running"));
  await eventually(() => assert.equal(typeof release, "function"));
  release();
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));
});

test("删除任务接口会移除任务记录", async (t) => {
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
  await fetch(`${url}/api/tasks/${created.task.id}/start`, { method: "POST" });
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

test("文档上传接口会提取正文、表格和可点击链接", async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/api/link-files/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x-file-name": encodeURIComponent("主页链接.docx"),
    },
    body: await createLinkDocxBuffer(),
  });
  const result = await json(response);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.entries.map((entry) => entry.url), [
    "https://www.instagram.com/body_user/",
    "https://www.xiaohongshu.com/user/profile/table-user",
    "https://www.instagram.com/clickable_user/",
  ]);
});

test("控制接口可以幂等暂停和继续调度器", async (t) => {
  let browserCloses = 0;
  const { url } = await fixture(t, undefined, {
    browserManager: {
      close: async () => { browserCloses += 1; },
      openLogin: async () => {},
      closeLogin: async () => {},
    },
  });

  const initial = await json(await fetch(`${url}/api/control`));
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, {
    paused: false,
    maxConcurrency: 5,
    running: 0,
    queued: 0,
    pausedTasks: 0,
    pending: 0,
    blockedPlatforms: [],
    cooldowns: {},
  });

  const paused = await json(await fetch(`${url}/api/control/pause`, { method: "POST" }));
  const pausedAgain = await json(await fetch(`${url}/api/control/pause`, { method: "POST" }));
  assert.equal(paused.body.paused, true);
  assert.equal(pausedAgain.body.paused, true);
  assert.equal(browserCloses, 2);

  const resumed = await json(await fetch(`${url}/api/control/resume`, { method: "POST" }));
  const resumedAgain = await json(await fetch(`${url}/api/control/resume`, { method: "POST" }));
  assert.equal(resumed.body.paused, false);
  assert.equal(resumedAgain.body.paused, false);
});

test("登录接口只在用户点击后打开窗口并在完成后恢复平台任务", async (t) => {
  let requiresLogin = true;
  const events = [];
  const { url, manager } = await fixture(
    t,
    async (task) => {
      if (requiresLogin) throw new LoginRequiredError();
      return { author: task.profileKey, notes: [] };
    },
    {
      browserManager: {
        close: async () => {},
        openLogin: async (platform) => events.push(`open:${platform}`),
        closeLogin: async (platform) => events.push(`close:${platform}`),
      },
    },
  );
  const created = await (
    await fetch(`${url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.instagram.com/login_user/",
        range: { preset: "week" },
      }),
    })
  ).json();
  await fetch(`${url}/api/tasks/${created.task.id}/start`, { method: "POST" });
  await eventually(() => assert.equal(manager.get(created.task.id).status, "waiting_user"));

  const opened = await fetch(`${url}/api/tasks/${created.task.id}/login`, { method: "POST" });
  assert.equal(opened.status, 200);
  assert.deepEqual(events, ["open:instagram"]);

  requiresLogin = false;
  const resumed = await fetch(`${url}/api/tasks/${created.task.id}/resume`, { method: "POST" });
  assert.equal(resumed.status, 200);
  assert.deepEqual(events, ["open:instagram", "close:instagram"]);
  await eventually(() => assert.equal(manager.get(created.task.id).status, "completed"));
});

test("打开图片文件夹接口只打开固定输出目录", async (t) => {
  const events = [];
  const outputDir = path.join(tmpdir(), "固定图片目录");
  const { url } = await fixture(t, undefined, {
    controllerOptions: {
      outputDir,
      ensureDir: async (directory) => events.push(`mkdir:${directory}`),
      openPath: async (directory) => events.push(`open:${directory}`),
    },
  });

  const result = await json(await fetch(`${url}/api/output/open`, { method: "POST" }));

  assert.equal(result.response.status, 200);
  assert.equal(result.body.directory, outputDir);
  assert.deepEqual(events, [`mkdir:${outputDir}`, `open:${outputDir}`]);
  assert.equal((await fetch(`${url}/api/tasks/download-completed`)).status, 404);
});
