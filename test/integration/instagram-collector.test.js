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
  assert.equal(profilePage.frontCount, 1);
  assert.ok(progress.some((value) => value.stage === "读取帖子详情"));
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
  let retainedPage;
  const collector = new InstagramCollector({
    browserManager: {
      newPage: async () => pages.shift(),
      retainPageForHumanAction: async (_platform, value) => { retainedPage = value; },
    },
  });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    LoginRequiredError,
  );
  assert.equal(retainedPage, profilePage);
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
