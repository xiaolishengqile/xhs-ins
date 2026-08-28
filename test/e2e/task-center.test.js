import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { ApplicationController } from "../../src/application/controller.js";
import { LoginRequiredError } from "../../src/collectors/errors.js";
import { createApp } from "../../src/http/app.js";
import { startServer } from "../../src/http/server.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { createLinkDocxBuffer } from "../helpers/docx.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(t, collect = async (task) => ({ author: task.profileKey, notes: [] })) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-e2e-"));
  const events = [];
  const manager = new TaskManager({
    store: new TaskStore(rootDir),
    collectorFactory: () => ({ collect }),
    exporter: async (task) => path.join(rootDir, "output", task.profileKey),
    now: () => new Date(2026, 7, 28, 12),
  });
  await manager.init();
  const browserManager = {
    close: async () => events.push("close-browser"),
    openLogin: async (platform) => events.push(`open-login:${platform}`),
    closeLogin: async (platform) => events.push(`close-login:${platform}`),
  };
  const controller = new ApplicationController({
    manager,
    browserManager,
    outputDir: path.join(rootDir, "output"),
    ensureDir: async () => {},
    openPath: async (directory) => events.push(`open-output:${directory}`),
  });
  const instance = await startServer({ handler: createApp({ manager, controller }), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(4_000);
  t.after(async () => {
    await browser.close();
    await instance.close();
    await manager.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return { manager, page, events, outputDir: path.join(rootDir, "output"), url: instance.url };
}

test("手动提交只创建待开始任务，点击开始后才运行", async (t) => {
  const { manager, page, url } = await fixture(
    t,
    (_task, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    }),
  );
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill("https://www.instagram.com/manual_creator/");

  await page.getByRole("button", { name: "加入待采集" }).click();

  await page.locator('[data-status="pending"]').waitFor();
  assert.equal(manager.list()[0].status, "pending");
  await page.locator('[data-status="pending"]').getByRole("button", { name: "开始" }).click();
  await page.locator('[data-status="running"]').waitFor();
  assert.equal(manager.list()[0].status, "running");
});

test("采集周期可以选择最近一年", async (t) => {
  const { manager, page, url } = await fixture(t);
  await page.goto(url);
  await page.getByLabel("博主主页链接").fill("https://www.instagram.com/year_creator/");
  await page.locator("#range-preset").selectOption("year");

  await page.getByRole("button", { name: "加入待采集" }).click();

  await page.locator('[data-status="pending"]').waitFor();
  const task = manager.list()[0];
  const from = new Date(task.from);
  const to = new Date(task.to);
  assert.deepEqual([from.getFullYear(), from.getMonth(), from.getDate()], [2025, 7, 28]);
  assert.deepEqual([to.getFullYear(), to.getMonth(), to.getDate()], [2026, 7, 28]);
});

test("导入文档只填充链接预览，不会自动创建任务", async (t) => {
  const { manager, page, url } = await fixture(t);
  await page.goto(url);
  await page.getByLabel("链接文件").setInputFiles({
    name: "主页链接.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await createLinkDocxBuffer(),
  });

  await page.getByRole("button", { name: "导入文件" }).click();

  await page.getByText("已导入 3 条链接，请确认后加入待采集").waitFor();
  assert.equal(manager.list().length, 0);
  assert.equal((await page.getByLabel("博主主页链接").inputValue()).split("\n").length, 3);
});

test("加载内置博主只预览，确认后分批创建 719 个待开始任务", async (t) => {
  const { manager, page, url } = await fixture(t);
  await page.goto(url);

  await page.getByRole("button", { name: "加载内置博主（719）" }).click();

  await page.getByText("已加载 719 位内置博主，请确认后加入待采集").waitFor();
  assert.equal(manager.list().length, 0);
  await page.getByRole("button", { name: "加入待采集" }).click();
  await page.getByText("已创建 719 个待开始任务").waitFor({ timeout: 12_000 });
  assert.equal(manager.list().length, 719);
  assert.ok(manager.list().every((task) => task.status === "pending"));
});

test("选中待开始任务后可以批量开始", async (t) => {
  const { manager, page, url } = await fixture(t);
  for (let index = 0; index < 3; index += 1) {
    await manager.create({
      url: `https://www.instagram.com/bulk_start_${index}/`,
      range: { preset: "week" },
    });
  }
  await page.goto(url);
  const cards = page.locator("[data-task-id]");
  await cards.nth(0).getByRole("checkbox").check();
  await cards.nth(1).getByRole("checkbox").check();

  await page.getByRole("button", { name: "开始选中（2）" }).click();

  await eventually(() => assert.equal(manager.list().filter((task) => task.status === "completed").length, 2));
  assert.equal(manager.list().filter((task) => task.status === "pending").length, 1);
});

test("任务可以批量删除且提示不会删除已保存图片", async (t) => {
  const { manager, page, url } = await fixture(t);
  for (let index = 0; index < 2; index += 1) {
    await manager.create({
      url: `https://www.instagram.com/bulk_delete_${index}/`,
      range: { preset: "week" },
    });
  }
  await page.goto(url);
  await page.getByRole("checkbox", { name: "全选任务" }).check();
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /不会删除已经保存到图片文件夹的图片/);
    await dialog.accept();
  });

  await page.getByRole("button", { name: "删除选中（2）" }).click();

  await page.getByText("还没有任务").waitFor();
  assert.equal(manager.list().length, 0);
});

test("等待登录时由用户显式打开窗口并确认继续", async (t) => {
  let requiresLogin = true;
  const { manager, page, events, url } = await fixture(t, async (task) => {
    if (requiresLogin) throw new LoginRequiredError();
    return { author: task.profileKey, notes: [] };
  });
  const created = await manager.create({
    url: "https://www.instagram.com/login_creator/",
    range: { preset: "week" },
  });
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "waiting_user"));
  await page.goto(url);

  await page.getByRole("button", { name: "打开登录窗口" }).click();
  assert.deepEqual(events, ["open-login:instagram"]);

  requiresLogin = false;
  await page.getByRole("button", { name: "我已处理，继续" }).click();
  await page.locator('[data-status="completed"]').waitFor();
  assert.deepEqual(events, ["open-login:instagram", "close-login:instagram"]);
});

test("页面只提供打开图片文件夹，不提供结果下载", async (t) => {
  const { page, events, outputDir, url } = await fixture(t);
  await page.goto(url);

  assert.equal(await page.getByText("下载结果").count(), 0);
  assert.equal(await page.getByText(/下载已完成任务/).count(), 0);
  await page.getByRole("button", { name: "打开图片文件夹" }).click();

  assert.deepEqual(events, [`open-output:${outputDir}`]);
});

test("没有运行任务时不会持续轮询任务列表", async (t) => {
  const { page, url } = await fixture(t);
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
