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
  await page.waitForFunction(() => document.querySelectorAll('[data-status="running"]').length === 5);
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
