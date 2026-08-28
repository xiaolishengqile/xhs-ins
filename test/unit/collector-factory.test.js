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
  assert.equal(pages.length, 3);
  assert.equal(contextClosed, false);
  assert.equal(first, pages[1]);
  assert.equal(second, pages[2]);
});

test("恢复单个平台只关闭该平台浏览器上下文", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const contexts = new Map();
  const launches = new Map();
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async (directory) => {
      const platform = path.basename(directory);
      launches.set(platform, (launches.get(platform) ?? 0) + 1);
      const context = {
        closed: false,
        newPage: async () => ({ close: async () => {} }),
        request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
        close: async () => { context.closed = true; },
      };
      contexts.set(platform, context);
      return context;
    },
  });
  t.after(() => manager.close());
  await manager.newPage("instagram");
  await manager.newPage("xiaohongshu");
  const xiaohongshuContext = contexts.get("xiaohongshu");

  await manager.closePlatform("instagram");

  assert.equal(contexts.get("instagram").closed, true);
  assert.equal(xiaohongshuContext.closed, false);
  await manager.newPage("instagram");
  assert.equal(launches.get("instagram"), 2);
  assert.equal(launches.get("xiaohongshu"), 1);
});

test("平台首个空白页只用于保持浏览器且任务使用新页面", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const initialPage = {
    closed: false,
    url: () => "about:blank",
    close: async () => { initialPage.closed = true; },
  };
  const createdPages = [];
  const context = {
    pages: () => [initialPage, ...createdPages],
    newPage: async () => {
      const page = {
        closed: false,
        url: () => "about:blank",
        close: async () => { page.closed = true; },
      };
      createdPages.push(page);
      return page;
    },
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {},
  };
  const manager = new BrowserManager({ profilesDir, launchPersistentContext: async () => context });
  t.after(() => manager.close());

  const session = await manager.createTaskSession("instagram", "task-1");
  const taskPage = await session.newPage();

  assert.notEqual(taskPage, initialPage);
  await session.close();
  await session.close();
  assert.equal(taskPage.closed, true);
  assert.equal(initialPage.closed, false);
});

test("采集默认无头运行且登录窗口显式可见", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const launches = [];
  const loginEvents = [];
  const contexts = [];
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async (directory, options) => {
      const page = {
        url: () => "about:blank",
        close: async () => {},
        goto: async (url) => loginEvents.push(`goto:${url}`),
        bringToFront: async () => loginEvents.push("front"),
      };
      const context = {
        closed: false,
        pages: () => [page],
        newPage: async () => page,
        request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
        close: async () => { context.closed = true; },
      };
      launches.push({ directory, options });
      contexts.push(context);
      return context;
    },
  });
  t.after(() => manager.close());

  await manager.newPage("instagram");
  assert.equal(launches[0].options.headless, true);

  await manager.openLogin("instagram");
  await manager.openLogin("instagram");

  assert.equal(contexts[0].closed, true);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].options.headless, false);
  assert.equal(launches[1].directory, launches[0].directory);
  assert.deepEqual(loginEvents, ["goto:https://www.instagram.com/accounts/login/", "front", "front"]);

  await manager.closeLogin("instagram");
  assert.equal(contexts[1].closed, true);
  await manager.newPage("instagram");
  assert.equal(launches[2].options.headless, true);
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

test("所有系统浏览器启动失败时返回可识别的候选诊断", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const manager = new BrowserManager({
    profilesDir,
    browserLaunchOptions: async () => [{ channel: "chrome" }, { channel: "msedge" }],
    launchPersistentContext: async (_directory, options) => {
      throw new Error(`启动 ${options.channel} 失败\nCall log`);
    },
  });
  t.after(() => manager.close());
  let captured;

  await assert.rejects(
    () => manager.newPage("instagram"),
    (error) => {
      captured = error;
      return error.code === "BROWSER_LAUNCH_FAILED";
    },
  );

  assert.deepEqual(captured.attempts, [
    { browser: "chrome", error: "启动 chrome 失败" },
    { browser: "msedge", error: "启动 msedge 失败" },
  ]);
});

test("持久浏览器启动后会保留自动生成的首个空白页", async (t) => {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "collector-browser-"));
  t.after(() => rm(profilesDir, { recursive: true, force: true }));
  const initialPage = {
    closed: false,
    url: () => "about:blank",
    close: async () => { initialPage.closed = true; },
  };
  let taskPage;
  const context = {
    pages: () => [initialPage],
    newPage: async () => {
      taskPage = { url: () => "about:blank", close: async () => {} };
      return taskPage;
    },
    request: { get: async () => ({ ok: () => true, body: async () => Buffer.from("image") }) },
    close: async () => {},
  };
  const manager = new BrowserManager({
    profilesDir,
    launchPersistentContext: async () => context,
  });
  t.after(() => manager.close());

  const page = await manager.newPage("xiaohongshu");

  assert.equal(page, taskPage);
  assert.notEqual(page, initialPage);
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

test("采集器工厂可以为单次任务注入浏览器会话", () => {
  class InstagramCollector {
    constructor(options) {
      this.options = options;
    }
  }
  const platformBrowserManager = { name: "platform" };
  const taskBrowserSession = { name: "task" };
  const factory = createCollectorFactory({
    browserManager: platformBrowserManager,
    collectors: { instagram: InstagramCollector },
  });

  assert.equal(factory("instagram", taskBrowserSession).options.browserManager, taskBrowserSession);
  assert.equal(factory("instagram").options.browserManager, platformBrowserManager);
});

test("人工登录和验证码错误具有统一任务标记", () => {
  for (const error of [new LoginRequiredError(), new VerificationRequiredError()]) {
    assert.equal(error.code, "HUMAN_ACTION_REQUIRED");
    assert.match(error.message, /登录|验证/);
  }
});
