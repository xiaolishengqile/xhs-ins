import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
    return this.current;
  }

  async waitForTimeout() {}

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

test("采集范围内图文和视频封面并跳过旧笔记", async () => {
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
  assert.deepEqual(result.notes.map((note) => note.id), ["note-image-1", "note-video-1"]);
  assert.equal(result.notes[1].media[0].type, "video-cover");
  assert.ok(!page.visited.some((url) => url.includes("note-old-1")));
  assert.equal(page.closed, true);
  assert.ok(progress.some((value) => value.stage === "读取笔记详情" && value.current === 2));
});

test("主页没有可用笔记编号且显示登录提示时等待人工登录", async () => {
  const profile = await fixture("profile-state.json");
  for (const item of profile.data.notes) {
    item.note_id = "";
    item.id = "";
  }
  const page = new FakePage({ profile, bodyText: "扫码登录后查看更多内容" });
  let retainedPage;
  const collector = new XiaohongshuCollector({
    browserManager: {
      newPage: async () => page,
      retainPageForHumanAction: async (_platform, value) => { retainedPage = value; },
    },
  });

  await assert.rejects(
    () => collector.collect(task(), { signal: new AbortController().signal, onProgress: async () => {} }),
    LoginRequiredError,
  );
  assert.equal(retainedPage, page);
  assert.equal(page.closed, false);
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
