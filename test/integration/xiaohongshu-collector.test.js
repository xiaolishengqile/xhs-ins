import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

import { XiaohongshuCollector } from "../../src/collectors/xiaohongshu/collector.js";
import { LoginRequiredError } from "../../src/collectors/errors.js";

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`../fixtures/xiaohongshu/${name}`, import.meta.url), "utf8"),
  );
}

class FakePage {
  constructor({ profile, details = {}, bodyText = "公开主页" }) {
    this.profile = profile;
    this.details = details;
    this.bodyText = bodyText;
    this.current = profile;
    this.visited = [];
    this.listeners = new Map();
    this.frontCount = 0;
    this.closed = false;
  }

  on(name, listener) {
    this.listeners.set(name, listener);
  }

  off(name) {
    this.listeners.delete(name);
  }

  async goto(url) {
    this.visited.push(url);
    const id = url.match(/\/explore\/([^?]+)/)?.[1];
    this.current = id ? this.details[id] : this.profile;
  }

  async evaluate(callback) {
    const source = String(callback);
    if (source.includes("innerText")) return this.bodyText;
    if (source.includes("scroll")) return undefined;
    if (source.includes("JSON.stringify")) return JSON.stringify(this.current);
    return this.current;
  }

  async waitForTimeout() {}

  async bringToFront() {
    this.frontCount += 1;
  }

  async close() {
    this.closed = true;
  }
}

function task() {
  return {
    profileUrl: "https://www.xiaohongshu.com/user/profile/user-1",
    profileKey: "user-1",
    from: "2026-08-22T00:00:00.000Z",
    to: "2026-08-28T23:59:59.999Z",
  };
}

test("采集范围内图文并跳过视频和旧笔记", async () => {
  const profile = await fixture("profile-state.json");
  const imageDetail = await fixture("note-detail.json");
  const videoDetail = structuredClone(imageDetail);
  const videoCard = videoDetail.data.items[0].note_card;
  Object.assign(videoCard, {
    note_id: "note-video-1",
    type: "video",
    title: "一条视频",
    cover: { url_default: "https://sns-webpic-qc.xhscdn.com/video-cover" },
    image_list: [],
  });
  const page = new FakePage({
    profile,
    details: { "note-image-1": imageDetail, "note-video-1": videoDetail },
  });
  const progress = [];
  const collector = new XiaohongshuCollector({ browserManager: { newPage: async () => page } });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async (value) => progress.push(value),
  });

  assert.equal(result.author, "测试博主");
  assert.deepEqual(result.notes.map((note) => note.id), ["note-image-1"]);
  assert.ok(!page.visited.some((url) => url.includes("note-video-1")));
  assert.ok(!page.visited.some((url) => url.includes("note-old-1")));
  assert.equal(page.closed, false);
  assert.ok(progress.some((value) => value.stage === "读取笔记详情" && value.current === 1 && value.total === 1));
});

test("主页没有可用笔记编号且显示登录提示时等待人工登录", async () => {
  const profile = await fixture("profile-state.json");
  for (const item of profile.data.notes) {
    item.note_id = "";
    item.id = "";
  }
  const page = new FakePage({ profile, bodyText: "扫码登录后查看更多内容" });
  const collector = new XiaohongshuCollector({
    browserManager: { newPage: async () => page },
  });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    LoginRequiredError,
  );
  assert.equal(page.frontCount, 0);
  assert.equal(page.closed, false);
});

test("读取笔记详情时不会抢占前台", async () => {
  const profile = await fixture("profile-state.json");
  profile.data.notes = [profile.data.notes[0]];
  const detail = await fixture("note-detail.json");
  const profilePage = new FakePage({ profile, details: { "note-image-1": detail } });
  const detailPage = new FakePage({ profile, details: { "note-image-1": detail } });
  const pages = [profilePage, detailPage];
  const collector = new XiaohongshuCollector({
    browserManager: { newPage: async () => pages.shift() },
  });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.deepEqual(result.notes.map((note) => note.id), ["note-image-1"]);
  assert.equal(profilePage.frontCount, 0);
  assert.ok(detailPage.visited.some((url) => url.includes("note-image-1")));
});

test("开始采集前取消会立即终止", async () => {
  const page = new FakePage({ profile: await fixture("profile-state.json") });
  const collector = new XiaohongshuCollector({ browserManager: { newPage: async () => page } });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => collector.collect(task(), { signal: controller.signal, onProgress: async () => {} }),
    { name: "AbortError" },
  );
});

test("登录后的响应式状态极深且存在循环引用时仍只读取业务数据", async (t) => {
  const profile = await fixture("profile-state.json");
  profile.data.notes = [profile.data.notes[0]];
  const detail = await fixture("note-detail.json");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://www.xiaohongshu.com/**", async (route) => {
    const isDetail = new URL(route.request().url()).pathname.startsWith("/explore/");
    const payload = isDetail ? detail : profile;
    const body = `<meta charset="utf-8"><body>公开主页</body><script>
      const payload = ${JSON.stringify(payload)};
      const state = ${isDetail
        ? `{ note: { noteDetailMap: { "note-image-1": payload } } }`
        : `{ user: { notes: { _rawValue: [payload.data.notes] } } }`};
      let current = state;
      for (let index = 0; index < 20000; index += 1) current = current.deep = {};
      current.circular = state;
      window.__INITIAL_STATE__ = state;
    </script>`;
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
  const collectorPage = {
    goto: (...args) => page.goto(...args),
    evaluate: (...args) => page.evaluate(...args),
    waitForTimeout: async () => {},
    on: (...args) => page.on(...args),
    off: (...args) => page.off(...args),
    close: () => page.close(),
  };
  const collector = new XiaohongshuCollector({
    browserManager: { newPage: async () => collectorPage },
  });

  const result = await collector.collect(task(), {
    signal: new AbortController().signal,
    onProgress: async () => {},
  });

  assert.equal(result.author, "测试博主");
  assert.deepEqual(result.notes.map((note) => note.id), ["note-image-1"]);
});
