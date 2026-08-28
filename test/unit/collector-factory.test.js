import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserManager } from "../../src/browser/browser-manager.js";
import { createCollectorFactory } from "../../src/collectors/collector-factory.js";
import { LoginRequiredError, VerificationRequiredError } from "../../src/collectors/errors.js";

test("同一平台的多个页面复用一个持久浏览器会话", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const pages = [];
  let launches = 0;
  let contextClosed = false;
  const context = {
    newPage: async () => {
      const page = { close: async () => {} };
      pages.push(page);
      return page;
    },
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {
      contextClosed = true;
    },
  };
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async () => {
      launches += 1;
      return context;
    },
  });
  t.after(() => manager.close());

  const first = await manager.newPage("xiaohongshu");
  const second = await manager.newPage("xiaohongshu");
  await first.close();

  assert.equal(launches, 1);
  assert.equal(pages.length, 2);
  assert.equal(contextClosed, false);
  assert.equal(second, pages[1]);
});

test("媒体下载只允许对应平台的公开图片域名", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async () => ({
      newPage: async () => ({}),
      request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
      close: async () => {},
    }),
  });
  t.after(() => manager.close());

  assert.deepEqual(await manager.fetchBuffer("xiaohongshu", "https://sns-webpic-qc.xhscdn.com/photo"), Buffer.from("image"));
  await assert.rejects(() => manager.fetchBuffer("xiaohongshu", "http://127.0.0.1/private"), /图片地址/);
  await assert.rejects(() => manager.fetchBuffer("instagram", "https://evil.example/photo.jpg"), /图片地址/);
});

test("采集器工厂按平台创建实例并拒绝未知平台", () => {
  class XiaohongshuCollector {
    constructor(options) {
      this.options = options;
    }
  }
  class InstagramCollector {}
  const browserManager = {};
  const factory = createCollectorFactory({
    browserManager,
    collectors: { xiaohongshu: XiaohongshuCollector, instagram: InstagramCollector },
  });

  assert.equal(factory("xiaohongshu").options.browserManager, browserManager);
  assert.ok(factory("instagram") instanceof InstagramCollector);
  assert.throws(() => factory("unknown"), /不支持的平台/);
});

test("人工登录和验证码错误具有统一任务标记", () => {
  for (const error of [new LoginRequiredError(), new VerificationRequiredError()]) {
    assert.equal(error.code, "HUMAN_ACTION_REQUIRED");
    assert.match(error.message, /登录|验证/);
  }
});
