import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

import { InstagramCollector } from "../../src/collectors/instagram/collector.js";
import { LoginRequiredError } from "../../src/collectors/errors.js";

class ProfilePage {
  constructor(links, bodyText = "Public profile") {
    this.links = links;
    this.bodyText = bodyText;
    this.frontCount = 0;
    this.closed = false;
  }

  async goto() {}

  async evaluate(callback) {
    if (String(callback).includes("scrollTo")) return undefined;
    return { links: this.links, bodyText: this.bodyText };
  }

  async waitForTimeout() {}

  async bringToFront() {
    this.frontCount += 1;
  }

  async close() {
    this.closed = true;
  }
}

class DetailPage {
  constructor(details) {
    this.details = details;
    this.currentUrl = "";
    this.currentIndex = 0;
    this.visited = [];
    this.closed = false;
  }

  async goto(url) {
    this.currentUrl = url;
    this.currentIndex = 0;
    this.visited.push(url);
  }

  async evaluate() {
    const value = this.details[this.currentUrl];
    return Array.isArray(value) ? value[this.currentIndex] : value;
  }

  async waitForTimeout() {}

  locator() {
    const page = this;
    return {
      last() { return this; },
      async count() {
        const value = page.details[page.currentUrl];
        return Array.isArray(value) && page.currentIndex < value.length - 1 ? 1 : 0;
      },
      async isVisible() { return true; },
      async click() { page.currentIndex += 1; },
    };
  }

  async close() {
    this.closed = true;
  }
}

function task() {
  return {
    profileUrl: "https://www.instagram.com/test.creator/",
    profileKey: "test.creator",
    from: "2026-08-22T00:00:00.000Z",
    to: "2026-08-28T23:59:59.999Z",
  };
}

test("滚动主页并只保留范围内公开帖子图片", async () => {
  const inRangeHtml = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const oldHtml = inRangeHtml
    .replaceAll("shortcode-1", "old-post")
    .replaceAll("2026-08-27T08:00:00+08:00", "2025-12-01T08:00:00+08:00")
    .replaceAll("August 27, 2026", "December 1, 2025");
  const inRangeUrl = "https://www.instagram.com/p/shortcode-1/";
  const oldUrl = "https://www.instagram.com/p/old-post/";
  const profilePage = new ProfilePage([inRangeUrl, oldUrl]);
  const detailPage = new DetailPage({
    [inRangeUrl]: {
      html: inRangeHtml,
      bodyText: "Public post",
      images: [
        "https://scontent.cdninstagram.com/photo-1.jpg",
        "https://scontent.cdninstagram.com/photo-2.jpg",
      ],
    },
    [oldUrl]: { html: oldHtml, bodyText: "Public post", images: [] },
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });
  const progress = [];

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async (value) => progress.push(value),
  });

  assert.equal(result.author, "test.creator");
  assert.deepEqual(result.notes.map((note) => note.id), ["shortcode-1"]);
  assert.deepEqual(
    result.notes[0].media.map((item) => item.url),
    ["https://scontent.cdninstagram.com/photo-1.jpg", "https://scontent.cdninstagram.com/photo-2.jpg"],
  );
  assert.equal(profilePage.closed, false);
  assert.equal(detailPage.closed, false);
  assert.equal(profilePage.frontCount, 0);
  assert.ok(progress.some((value) => value.stage === "读取帖子详情"));
});

test("帖子页面临时响应失败时退避重试后继续采集", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/shortcode-1/";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-1.jpg"] },
  });
  const originalGoto = detailPage.goto.bind(detailPage);
  let attempts = 0;
  detailPage.goto = async (url) => {
    attempts += 1;
    if (attempts < 3) throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${url}`);
    return originalGoto(url);
  };
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({
    browserManager: { newPage: async () => pages.shift() },
    navigationRetryDelays: [0, 0],
  });
  const progress = [];

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async (value) => progress.push(value),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result.notes.map((note) => note.id), ["shortcode-1"]);
  assert.ok(progress.some((value) => value.stage === "页面暂时不可用，正在重试"));
});

test("帖子持续被平台拒绝时保留已采集内容并请求平台冷却", async () => {
  const firstHtml = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const secondHtml = firstHtml.replaceAll("shortcode-1", "shortcode-2");
  const firstUrl = "https://www.instagram.com/p/shortcode-1/";
  const secondUrl = "https://www.instagram.com/p/shortcode-2/";
  const profilePage = new ProfilePage([firstUrl, secondUrl]);
  const detailPage = new DetailPage({
    [firstUrl]: { html: firstHtml, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-1.jpg"] },
    [secondUrl]: { html: secondHtml, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-2.jpg"] },
  });
  const originalGoto = detailPage.goto.bind(detailPage);
  detailPage.goto = async (url) => {
    if (url === secondUrl) throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${url}`);
    return originalGoto(url);
  };
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({
    browserManager: { newPage: async () => pages.shift() },
    navigationRetryDelays: [0, 0],
  });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    (error) => {
      assert.equal(error.code, "PLATFORM_TEMPORARILY_UNAVAILABLE");
      assert.deepEqual(error.partialResult.notes.map((note) => note.id), ["shortcode-1"]);
      return true;
    },
  );
});

test("单篇帖子已经失效时跳过该篇并继续后续内容", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const missingUrl = "https://www.instagram.com/p/missing-post/";
  const healthyUrl = "https://www.instagram.com/p/shortcode-1/";
  const profilePage = new ProfilePage([missingUrl, healthyUrl]);
  const detailPage = new DetailPage({
    [missingUrl]: { html, bodyText: "Not found", images: [] },
    [healthyUrl]: { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-1.jpg"] },
  });
  const originalGoto = detailPage.goto.bind(detailPage);
  detailPage.goto = async (url) => {
    await originalGoto(url);
    if (url === missingUrl) return { status: () => 404, ok: () => false };
    return { status: () => 200, ok: () => true };
  };
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes.map((note) => note.id), ["shortcode-1"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /missing-post.*404/);
});

test("帖子返回未登录状态时不能静默跳过", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/login-required/";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: { html, bodyText: "Log in", images: [] },
  });
  const originalGoto = detailPage.goto.bind(detailPage);
  detailPage.goto = async (url) => {
    await originalGoto(url);
    return { status: () => 401, ok: () => false };
  };
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    LoginRequiredError,
  );
});

test("延迟出现且包含博主名的帖子链接可以采集", async (t) => {
  const postHtml = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const profilePage = await browser.newPage();
  const detailPage = await browser.newPage();
  await Promise.all([profilePage, detailPage].map((page) => page.route("https://www.instagram.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/test.creator/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<body>Public profile<script>
          setTimeout(() => {
            const link = document.createElement("a");
            link.href = "/test.creator/p/shortcode-1/";
            link.textContent = "post";
            document.body.append(link);
          }, 2200);
        </script></body>`,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/html", body: postHtml });
  })));
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({
    browserManager: { newPage: async () => pages.shift() },
  });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes.map((note) => note.id), ["shortcode-1"]);
});

test("公开主页被登录墙遮挡时等待人工登录", async () => {
  const profilePage = new ProfilePage([], "Log in to see photos and videos");
  const detailPage = new DetailPage({});
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({
    browserManager: { newPage: async () => pages.shift() },
  });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    LoginRequiredError,
  );
  assert.equal(profilePage.frontCount, 0);
  assert.equal(profilePage.closed, false);
  assert.equal(detailPage.closed, false);
});

test("短视频链接不会打开或返回", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const reelUrl = "https://www.instagram.com/reel/video-1/";
  const profilePage = new ProfilePage([reelUrl]);
  const detailPage = new DetailPage({
    [reelUrl]: { html, bodyText: "Public video", images: [], hasVideo: true },
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes, []);
  assert.deepEqual(detailPage.visited, []);
});

test("普通帖子链接中的纯视频不会返回", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/video-only/";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: { html, bodyText: "Public video", images: [], hasVideo: true },
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes, []);
});

test("混合轮播只保留其中的图片", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/mixed-post/";
  const imageUrl = "https://scontent.cdninstagram.com/mixed-image.jpg";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: [
      { html, bodyText: "Public mixed post", images: [], hasVideo: true },
      { html, bodyText: "Public mixed post", images: [imageUrl], hasVideo: false },
    ],
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.equal(result.notes.length, 1);
  assert.deepEqual(result.notes[0].media.map((item) => item.url), [imageUrl]);
});

test("轮播帖子会点击下一张并收集后续加载图片", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/shortcode-1/";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: [
      { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-1.jpg"] },
      { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-2.jpg"] },
      { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/photo-3.jpg"] },
    ],
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(
    result.notes[0].media.map((item) => item.url),
    [
      "https://scontent.cdninstagram.com/photo-1.jpg",
      "https://scontent.cdninstagram.com/photo-2.jpg",
      "https://scontent.cdninstagram.com/photo-3.jpg",
    ],
  );
});

test("结构化图片候选不会导致长轮播提前停止", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/shortcode-1/";
  const image = (index) => ({
    src: `https://scontent.cdninstagram.com/photo-${index}.jpg`,
    currentSrc: `https://scontent.cdninstagram.com/photo-${index}.jpg`,
    srcset: `https://scontent.cdninstagram.com/photo-${index}.jpg 1440w`,
    naturalWidth: 1440,
    naturalHeight: 1440,
  });
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: [1, 2, 3, 4].map((index) => ({
      html,
      bodyText: "Public post",
      images: [image(index)],
    })),
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(
    result.notes[0].media.map((item) => item.url),
    [1, 2, 3, 4].map((index) => `https://scontent.cdninstagram.com/photo-${index}.jpg`),
  );
});

test("同一图片存在多个展示尺寸时只保留最高分辨率地址", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const postUrl = "https://www.instagram.com/p/shortcode-1/";
  const small = "https://scontent.cdninstagram.com/media/full-photo.jpg?width=640";
  const large = "https://scontent.cdninstagram.com/media/full-photo.jpg?width=1440";
  const profilePage = new ProfilePage([postUrl]);
  const detailPage = new DetailPage({
    [postUrl]: [
      {
        html,
        bodyText: "Public post",
        images: [{
          src: small,
          currentSrc: small,
          srcset: `${small} 640w, ${large} 1440w`,
          naturalWidth: 640,
          naturalHeight: 640,
        }],
      },
      {
        html,
        bodyText: "Public post",
        images: [{
          src: large,
          currentSrc: large,
          srcset: `${large} 1440w`,
          naturalWidth: 1440,
          naturalHeight: 1440,
        }],
      },
    ],
  });
  const pages = [profilePage, detailPage];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes[0].media.map((item) => item.url), [large]);
  assert.equal(result.notes[0].media[0].sourceWidth, 1440);
});

test("开始采集前取消不会创建浏览器页面", async () => {
  let pageCount = 0;
  const collector = new InstagramCollector({
    browserManager: { newPage: async () => { pageCount += 1; } },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => collector.collect(task(), { signal: controller.signal, onProgress: async () => {} }),
    { name: "AbortError" },
  );
  assert.equal(pageCount, 0);
});

test("逐帖断点在中断后复用，已解析帖子不再次打开", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");
  const firstUrl = "https://www.instagram.com/p/shortcode-1/";
  const secondUrl = "https://www.instagram.com/p/shortcode-2/";
  const details = {
    [firstUrl]: { html, bodyText: "Public post", images: ["https://scontent.cdninstagram.com/one.jpg"] },
    [secondUrl]: { html: html.replaceAll("shortcode-1", "shortcode-2"), bodyText: "Public post", images: ["https://scontent.cdninstagram.com/two.jpg"] },
  };
  const checkpoint = { entries: {} };
  const aborted = new AbortController();
  const firstPages = [new ProfilePage([firstUrl, secondUrl]), new DetailPage(details)];
  const first = new InstagramCollector({ browserManager: { newPage: async () => firstPages.shift() } });
  await assert.rejects(first.collect(task(), {
    signal: aborted.signal, onProgress: async () => {},
    onCheckpoint: async (entry) => { checkpoint.entries[entry.key] = entry; aborted.abort(); },
  }), { name: "AbortError" });
  const detailPage = new DetailPage(details);
  const secondPages = [new ProfilePage([firstUrl, secondUrl]), detailPage];
  const second = new InstagramCollector({ browserManager: { newPage: async () => secondPages.shift() } });
  const result = await second.collect(task(), {
    signal: new AbortController().signal, onProgress: async () => {}, checkpoint,
  });
  assert.deepEqual(detailPage.visited, [secondUrl]);
  assert.deepEqual(result.notes.map((item) => item.id), ["shortcode-1", "shortcode-2"]);
});

test("待补帖子即使主页不再返回也会重试并保留失败图片", async () => {
  const missing = "https://www.instagram.com/p/missing/";
  const saved = { id: "missing", url: missing, media: [{ url: "https://scontent.cdninstagram.com/expired.jpg", error: "过期" }] };
  const profile = new ProfilePage([]);
  const detail = new DetailPage({});
  detail.goto = async (url) => { detail.visited.push(url); return { ok: () => false, status: () => 404 }; };
  const pages = [profile, detail];
  const collector = new InstagramCollector({ browserManager: { newPage: async () => pages.shift() } });
  const result = await collector.collect(task(), {
    signal: new AbortController().signal, onProgress: async () => {},
    checkpoint: { entries: {}, pending: { [missing]: { key: missing, note: saved } } },
  });
  assert.deepEqual(detail.visited, [missing]);
  assert.deepEqual(result.notes, [saved]);
});
