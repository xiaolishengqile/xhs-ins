import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowserManager } from "../../src/browser/browser-manager.js";
import { resolveSystemBrowserLaunchOptions } from "../../src/browser/system-browser.js";
import { createCollectorFactory } from "../../src/collectors/collector-factory.js";
import { LoginRequiredError, VerificationRequiredError } from "../../src/collectors/errors.js";

test("系统默认浏览器使用独立程序时会优先使用其安装路径", async () => {
  const launchOptions = await resolveSystemBrowserLaunchOptions({
    platform: "win32",
    readDefaultBrowser: async () => ({
      browserId: "SLBrowserHTML",
      command: '"C:\\Program Files (x86)\\Lenovo\\SLBrowser\\SLBrowser.exe" --single-argument %1',
    }),
  });

  assert.deepEqual(launchOptions, [
    { executablePath: "C:\\Program Files (x86)\\Lenovo\\SLBrowser\\SLBrowser.exe" },
    { channel: "chrome" },
    { channel: "msedge" },
  ]);
});

test("系统默认浏览器为微软浏览器时会优先使用对应通道", async () => {
  const launchOptions = await resolveSystemBrowserLaunchOptions({
    platform: "win32",
    readDefaultBrowser: async () => ({ browserId: "MSEdgeHTM", command: "" }),
  });

  assert.deepEqual(launchOptions, [{ channel: "msedge" }, { channel: "chrome" }]);
});

test("同一平台的多个页面复用一个持久浏览器会话", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const pages = [];
  let launches = 0;
  let contextClosed = false;
  const context = {
    newPage: async () => {
      const page = { closed: false, close: async () => { page.closed = true; } };
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

test("人工处理页面会保持打开并可在恢复成功后统一关闭", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const page = { closed: false, close: async () => { page.closed = true; } };
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async () => ({
      newPage: async () => page,
      request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
      close: async () => {},
    }),
  });
  t.after(() => manager.close());

  await manager.retainPageForHumanAction("xiaohongshu", page);
  assert.equal(page.closed, false);
  await manager.closeHumanActionPages("xiaohongshu");
  assert.equal(page.closed, true);
});

test("采集会直接使用系统默认浏览器路径而不启动测试浏览器", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const launchOptions = [];
  const context = {
    newPage: async () => ({ close: async () => {} }),
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {},
  };
  const manager = new BrowserManager({
    profilesDir,
    browserLaunchOptions: async () => [{ executablePath: "C:\\SystemBrowser\\browser.exe" }],
    launchPersistentContext: async (_directory, options) => {
      launchOptions.push(options);
      return context;
    },
  });
  t.after(() => manager.close());

  await manager.newPage("xiaohongshu");

  assert.equal(launchOptions.length, 1);
  assert.equal(launchOptions[0].executablePath, "C:\\SystemBrowser\\browser.exe");
  assert.equal(launchOptions[0].channel, undefined);
});

test("默认系统浏览器启动失败时会切换另一款系统浏览器", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const launchedChannels = [];
  const context = {
    newPage: async () => ({ close: async () => {} }),
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {},
  };
  const manager = new BrowserManager({
    profilesDir,
    browserLaunchOptions: async () => [{ channel: "chrome" }, { channel: "msedge" }],
    launchPersistentContext: async (_directory, options) => {
      launchedChannels.push(options.channel);
      if (options.channel === "chrome") throw new Error("spawn UNKNOWN");
      return context;
    },
  });
  t.after(() => manager.close());

  await assert.doesNotReject(() => manager.newPage("instagram"));

  assert.deepEqual(launchedChannels, ["chrome", "msedge"]);
});

test("持久浏览器启动后会复用自动生成的首个空白页", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const initialPage = {
    closed: false,
    url: () => "about:blank",
    close: async () => { initialPage.closed = true; },
  };
  const context = {
    pages: () => [initialPage],
    newPage: async () => ({ url: () => "about:blank", close: async () => {} }),
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {},
  };
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async () => context,
  });
  t.after(() => manager.close());

  const page = await manager.newPage("xiaohongshu");

  assert.equal(page, initialPage);
  assert.equal(initialPage.closed, false);
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
