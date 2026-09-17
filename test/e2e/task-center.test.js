import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { ApplicationController } from "../../src/application/controller.js";
import { LoginRequiredError, PlatformTemporarilyUnavailableError } from "../../src/collectors/errors.js";
import { BrowserLaunchError } from "../../src/browser/errors.js";
import { createApp } from "../../src/http/app.js";
import { startServer } from "../../src/http/server.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { createLinkDocxBuffer } from "../helpers/docx.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(
  t,
  collect = async (task) => ({ author: task.profileKey, notes: [] }),
  options = {},
) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-e2e-"));
  const events = [];
  const manager = new TaskManager({
    store: new TaskStore(rootDir),
    collectorFactory: () => ({ collect }),
    exporter: options.exporter ?? (async (task) => path.join(rootDir, "output", task.profileKey)),
    now: () => new Date(2026, 7, 28, 12),
  });
  await manager.init();
  const browserManager = {
    close: async () => events.push("close-browser"),
    closePlatform: async (platform) => events.push(`close-platform:${platform}`),
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

function controlSnapshot(storageError) {
  return {
    paused: false,
    storageError,
    maxConcurrency: 1,
    running: 0,
    queued: 0,
    pausedTasks: 0,
    pending: 1,
    blockedPlatforms: [],
    platformBlocks: [],
    cooldowns: {},
  };
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

test("采集周期默认使用最近一年", async (t) => {
  const { manager, page, url } = await fixture(t);
  await page.goto(url);
  assert.equal(await page.locator("#range-preset").inputValue(), "year");
  await page.getByLabel("博主主页链接").fill("https://www.instagram.com/year_creator/");

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
  assert.equal(await page.locator("[data-task-id]").count(), 30);
  await page.getByRole("checkbox", { name: "全选任务" }).check();
  await page.getByText("已选 719 项", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页" }).click();
  await page.getByText("第 2 / 24 页，共 719 项", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-task-id] input:checked").count(), 30);
});

test("部分完成显示图片统计并允许补采", async (t) => {
  const { manager, page, url } = await fixture(t, async () => ({ notes: [] }), {
    exporter: async () => ({ directory: "images", imagesAvailable: 2, imagesFailed: 1, imagesSkipped: 1, notes: [] }),
  });
  const task = await manager.create({ url: "https://www.instagram.com/partial_creator/", range: { preset: "year" } });
  await manager.start(task.id);
  await eventually(() => assert.equal(manager.get(task.id).status, "partial"));
  await page.goto(url);
  await page.locator('[data-status="partial"]').waitFor();
  await page.getByText("已保存 2 张 · 失败 1 张 · 复用 1 张", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "补采失败图片" }).count(), 1);
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

test("空闲可见页面每十五秒检查外部状态", async (t) => {
  const { manager, page, url } = await fixture(t);
  await page.clock.install();
  let controlRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/api/control")) controlRequests += 1;
  });
  await page.goto(url);
  assert.equal(controlRequests, 1);

  await manager.pauseAll();
  await page.clock.fastForward(12_000);
  assert.equal(controlRequests, 1);
  await page.clock.fastForward(3_000);

  await page.getByText("队列已暂停", { exact: true }).waitFor();
  assert.equal(controlRequests, 2);
});

test("活动页面每三秒刷新，隐藏后停止轮询", async (t) => {
  const { manager, page, url } = await fixture(
    t,
    (_task, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    }),
  );
  const created = await manager.create({
    url: "https://www.instagram.com/polling_creator/",
    range: { preset: "week" },
  });
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "running"));
  await page.clock.install();
  let controlRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().endsWith("/api/control")) controlRequests += 1;
  });
  await page.goto(url);

  await page.clock.fastForward(3_000);
  assert.equal(controlRequests, 2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30_000);

  assert.equal(controlRequests, 2);
});

test("页面明确显示存储故障并提供手动恢复入口", async (t) => {
  const { page, url } = await fixture(t);
  await page.route("**/api/control", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      paused: false,
      storageError: "模拟磁盘空间不足",
      maxConcurrency: 1,
      running: 0,
      queued: 0,
      pausedTasks: 0,
      pending: 0,
      blockedPlatforms: [],
      platformBlocks: [],
      cooldowns: {},
    }),
  }));

  await page.goto(url);

  await page.getByText("存储故障：模拟磁盘空间不足", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试保存并继续" }).waitFor();
});

test("任务不变时存储故障出现会禁用任务启动按钮", async (t) => {
  const { manager, page, url } = await fixture(t);
  const created = await manager.create({
    url: "https://www.instagram.com/storage_error_appears/",
    range: { preset: "week" },
  });
  const unchangedTask = JSON.stringify(manager.get(created.id));
  let storageError = null;
  await page.route("**/api/control", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(controlSnapshot(storageError)),
  }));
  await page.clock.install();
  await page.goto(url);
  const start = page.getByRole("button", { name: "开始", exact: true });
  assert.equal(await start.isDisabled(), false);

  storageError = "模拟磁盘空间不足";
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/control"));
  await page.clock.fastForward(15_000);
  await refreshed;
  await page.getByText("存储故障：模拟磁盘空间不足", { exact: true }).waitFor();

  assert.equal(await start.isDisabled(), true);
  assert.equal(JSON.stringify(manager.get(created.id)), unchangedTask);
});

test("任务不变时存储故障解除会恢复任务启动按钮", async (t) => {
  const { manager, page, url } = await fixture(t);
  const created = await manager.create({
    url: "https://www.instagram.com/storage_error_clears/",
    range: { preset: "week" },
  });
  const unchangedTask = JSON.stringify(manager.get(created.id));
  let storageError = "模拟磁盘空间不足";
  await page.route("**/api/control", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(controlSnapshot(storageError)),
  }));
  await page.clock.install();
  await page.goto(url);
  const start = page.getByRole("button", { name: "开始", exact: true });
  assert.equal(await start.isDisabled(), true);

  storageError = null;
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/control"));
  await page.clock.fastForward(15_000);
  await refreshed;
  await page.getByText("正常调度", { exact: true }).waitFor();

  assert.equal(await start.isDisabled(), false);
  assert.equal(JSON.stringify(manager.get(created.id)), unchangedTask);
});

test("任务卡片会提示跳过帖子和低分辨率预览图", async (t) => {
  const { manager, page, url } = await fixture(
    t,
    async (task) => ({ author: task.profileKey, notes: [{ id: "n1" }], warnings: ["帖子不可访问"] }),
    {
      exporter: async (task, _notes, _taskDir, { onProgress }) => {
        await onProgress({ imagesDownloaded: 1, previewImages: 2 });
        return path.join("output", task.profileKey);
      },
    },
  );
  const created = await manager.create({
    url: "https://www.instagram.com/quality_notice/",
    range: { preset: "week" },
  });
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));

  await page.goto(url);

  await page.getByText("采集完成，跳过 1 篇不可访问帖子").waitFor();
  await page.getByText("2 张图片仅获得平台预览尺寸").waitFor();
});

test("平台触发冷却时页面明确显示队列状态", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => {
    throw new PlatformTemporarilyUnavailableError("平台访问过于频繁", {
      retryAfterMs: 60_000,
      partialResult: { author: task.profileKey, notes: [], warnings: [] },
    });
  });
  const created = await manager.create({
    url: "https://www.instagram.com/cooldown_notice/",
    range: { preset: "week" },
  });
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).progress.stage, "平台冷却中，稍后自动继续"));

  await page.goto(url);

  await page.getByText("照片墙平台冷却中").waitFor();
});

test("浏览器受阻任务只显示重新检测入口并可整体恢复", async (t) => {
  let browserUnavailable = true;
  const { manager, page, url } = await fixture(t, async (task) => {
    if (browserUnavailable) throw new BrowserLaunchError([{ browser: "chrome", error: "系统终止浏览器" }]);
    return { author: task.profileKey, notes: [] };
  });
  const created = await manager.create({
    url: "https://www.instagram.com/browser_blocked_ui/",
    range: { preset: "week" },
  });
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "blocked"));

  await page.goto(url);

  await page.getByText("浏览器运行环境受阻", { exact: true }).first().waitFor();
  await page.getByText("浏览器运行环境受阻", { exact: true }).nth(1).waitFor();
  assert.equal(await page.getByRole("button", { name: "打开登录窗口" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "我已处理，继续" }).count(), 0);
  browserUnavailable = false;
  await page.getByRole("button", { name: "重新检测并继续" }).click();

  await page.locator('[data-status="completed"]').waitFor();
});
