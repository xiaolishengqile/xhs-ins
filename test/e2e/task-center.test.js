import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { createApp } from "../../src/app.js";
import { startServer } from "../../src/http/server.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(t, collect) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-e2e-"));
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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2_000);
  t.after(async () => {
    await browser.close();
    await instance.close();
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { manager, page, url: instance.url };
}

test("六次提交会显示五个运行任务和一个等待任务且表单保持可用", async (t) => {
  const { page, url } = await fixture(
    t,
    (_task, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    }),
  );
  await page.goto(url);

  for (let index = 0; index < 6; index += 1) {
    await page.getByLabel("博主主页链接").fill(`https://www.xiaohongshu.com/user/profile/ui-user-${index}`);
    await page.getByRole("button", { name: "开始采集" }).click();
  }

  await page.locator("[data-task-id]").first().waitFor();
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-status="running"]').length === 5 &&
    document.querySelectorAll('[data-status="queued"]').length === 1,
  );
  assert.equal(await page.locator('[data-status="running"]').count(), 5);
  assert.equal(await page.locator('[data-status="queued"]').count(), 1);
  assert.equal(await page.getByTestId("running-summary").textContent(), "5 / 5");
  assert.equal(await page.getByLabel("博主主页链接").isEnabled(), true);

  await page.locator('[data-status="running"]').first().getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-status="cancelled"]').length === 1);
  await page.waitForFunction(() => document.querySelectorAll('[data-status="running"]').length === 5);
  assert.equal(await page.locator('[data-status="queued"]').count(), 0);
});

test("完成任务显示独立下载入口", async (t) => {
  const { page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill("https://www.instagram.com/download.creator/");
  await page.getByRole("button", { name: "开始采集" }).click();

  const completed = page.locator('[data-status="completed"]');
  await completed.waitFor();
  const download = completed.getByRole("link", { name: "下载结果" });
  assert.match(await download.getAttribute("href"), /\/api\/tasks\/[0-9a-f-]+\/download$/);
});

test("没有活动任务时不会持续请求任务列表", async (t) => {
  const { page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  let listRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/api/tasks")) listRequests += 1;
  });
  const initialList = page.waitForResponse((response) =>
    response.request().method() === "GET" && response.url().endsWith("/api/tasks"),
  );

  await page.goto(url);
  await initialList;
  await page.waitForTimeout(1_200);

  assert.equal(listRequests, 1);
});

test("一次粘贴五条链接会创建五个并行任务并自动去重", async (t) => {
  const { manager, page, url } = await fixture(
    t,
    (_task, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    }),
  );
  const links = Array.from(
    { length: 5 },
    (_value, index) => `https://www.xiaohongshu.com/user/profile/batch-user-${index}`,
  );
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill([...links, links[0]].join("\n"));

  await page.getByRole("button", { name: "开始采集" }).click();

  await page.waitForFunction(() => document.querySelectorAll('[data-status="running"]').length === 5);
  assert.equal(manager.list().length, 5);
  assert.deepEqual(new Set(manager.list().map((task) => task.profileUrl)), new Set(links));
});

test("一次输入超过五位不同博主时不会创建部分任务", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  const links = Array.from(
    { length: 6 },
    (_value, index) => `https://www.xiaohongshu.com/user/profile/too-many-${index}`,
  );
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill(links.join("\n"));

  await page.getByRole("button", { name: "开始采集" }).click();

  await page.getByText("一次最多提交 5 条链接").waitFor();
  assert.equal(manager.list().length, 0);
});

test("任务卡片可以确认后永久删除", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill("https://www.instagram.com/remove.creator/");
  await page.getByRole("button", { name: "开始采集" }).click();
  const completed = page.locator('[data-status="completed"]');
  await completed.waitFor();
  page.once("dialog", (dialog) => dialog.accept());

  await completed.getByRole("button", { name: "删除" }).click();

  await page.getByText("还没有任务").waitFor();
  assert.equal(manager.list().length, 0);
});

test("全选后可以一次删除所有任务", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  for (let index = 0; index < 3; index += 1) {
    await manager.create({
      url: `https://www.instagram.com/bulk_remove_${index}/`,
      range: { preset: "week" },
    });
  }
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
  await page.goto(url);

  await page.getByRole("checkbox", { name: "全选任务" }).check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除选中（3）" }).click();

  await page.getByText("还没有任务").waitFor();
  assert.equal(manager.list().length, 0);
});

test("批量删除只移除勾选的任务", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  for (let index = 0; index < 3; index += 1) {
    await manager.create({
      url: `https://www.instagram.com/partial_remove_${index}/`,
      range: { preset: "week" },
    });
  }
  await eventually(() => assert.ok(manager.list().every((task) => task.status === "completed")));
  await page.goto(url);
  const cards = page.locator("[data-task-id]");

  await cards.nth(0).getByRole("checkbox").check();
  await cards.nth(1).getByRole("checkbox").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除选中（2）" }).click();

  await eventually(() => assert.equal(manager.list().length, 1));
  await page.waitForFunction(() => document.querySelectorAll("[data-task-id]").length === 1);
  assert.equal(await page.locator("[data-task-id]").count(), 1);
});
