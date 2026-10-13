import test from "node:test";
import assert from "node:assert/strict";

import { InstagramCollector } from "../../src/collectors/instagram/collector.js";
import { LoginRequiredError } from "../../src/collectors/errors.js";

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);

function versions(code, index = 0) {
  return {
    candidates: [
      { url: `https://scontent.cdninstagram.com/${code}-${index}-640.jpg`, width: 640, height: 800 },
      { url: `https://scontent.cdninstagram.com/${code}-${index}-1080.jpg`, width: 1080, height: 1350 },
    ],
  };
}

function post(code, iso, { user = "test.creator", type = 1, children, pinned = false, coauthor } = {}) {
  return {
    code,
    taken_at: seconds(iso),
    media_type: type,
    user: { username: user },
    coauthor_producers: coauthor ? [{ username: coauthor }] : [],
    timeline_pinned_user_ids: pinned ? ["1"] : [],
    caption: { text: `caption ${code}` },
    like_count: 12,
    comment_count: 3,
    image_versions2: versions(code),
    carousel_media: children?.map((childType, index) => ({ media_type: childType, image_versions2: versions(code, index) })),
  };
}

class FeedPage {
  constructor(batches, bodyText = "test.creator\n120帖子") {
    this.batches = batches;
    this.bodyText = bodyText;
    this.listeners = [];
    this.loaded = 0;
    this.scrolls = 0;
  }

  on(_event, listener) { this.listeners.push(listener); }

  off() {}

  emit() {
    const batch = this.batches[this.loaded];
    if (!batch) return;
    this.loaded += 1;
    const payload = {
      data: {
        connection: {
          edges: batch.posts.map((node) => ({ node })),
          page_info: { has_next_page: batch.hasNext ?? true },
        },
      },
    };
    for (const listener of this.listeners) {
      listener({ url: () => "https://www.instagram.com/graphql/query", json: async () => payload });
    }
  }

  async goto() {
    this.emit();
    return { status: () => 200 };
  }

  async evaluate(callback) {
    if (String(callback).includes("scrollTo")) {
      this.scrolls += 1;
      this.emit();
      return undefined;
    }
    return this.bodyText;
  }

  async waitForTimeout() {
    await new Promise((resolve) => setImmediate(resolve));
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

function collectorFor(page, options = {}) {
  return new InstagramCollector({
    browserManager: { newPage: async () => page },
    navigationRetryDelays: [0, 0],
    scrollWaitMs: 1_000,
    maxIdleScrolls: 2,
    ...options,
  });
}

const run = (collector, extra = {}) => collector.collect(task(), {
  signal: new AbortController().signal,
  onProgress: async () => {},
  ...extra,
});

test("一直翻到早于开始日期，并按最大尺寸保留轮播中的全部图片", async () => {
  const page = new FeedPage([
    { posts: [post("newer", "2026-08-30T10:00:00Z"), post("carousel", "2026-08-27T10:00:00Z", { type: 8, children: [1, 2, 1] })] },
    { posts: [post("single", "2026-08-24T10:00:00Z"), post("someone-else", "2026-08-24T10:00:00Z", { user: "other" })] },
    { posts: [post("collab", "2026-08-23T10:00:00Z", { user: "partner", coauthor: "test.creator" })] },
    { posts: [post("old", "2026-08-10T10:00:00Z")] },
    { posts: [post("never-loaded", "2026-08-25T10:00:00Z")] },
  ]);
  const checkpoints = [];

  const result = await run(collectorFor(page), { onCheckpoint: async (entry) => checkpoints.push(entry.key) });

  assert.deepEqual(result.notes.map((note) => note.id), ["carousel", "single", "collab"]);
  assert.deepEqual(result.notes[0].media.map((item) => item.url), [
    "https://scontent.cdninstagram.com/carousel-0-1080.jpg",
    "https://scontent.cdninstagram.com/carousel-2-1080.jpg",
  ]);
  assert.equal(result.notes[0].media[0].sourceWidth, 1080);
  assert.equal(result.notes[0].publishedAt, "2026-08-27T10:00:00.000Z");
  assert.equal(result.notes[0].metrics.likeCount, 12);
  assert.equal(page.scrolls, 3);
  assert.equal(checkpoints.length, 3);
});

test("隐藏点赞数的帖子不使用平台占位数字", async () => {
  const hidden = { ...post("hidden", "2026-08-25T10:00:00Z"), like_count: 3, like_and_view_counts_disabled: true };
  const page = new FeedPage([{ posts: [hidden], hasNext: false }]);

  const result = await run(collectorFor(page));

  assert.equal(result.notes[0].metrics.likeCount, null);
});

test("置顶旧帖不会让扫描提前结束", async () => {
  const page = new FeedPage([
    { posts: [post("pinned-old", "2025-01-01T10:00:00Z", { pinned: true }), post("recent", "2026-08-27T10:00:00Z")] },
    { posts: [post("in-range", "2026-08-23T10:00:00Z"), post("old", "2026-08-01T10:00:00Z")] },
  ]);

  const result = await run(collectorFor(page));

  assert.deepEqual(result.notes.map((note) => note.id), ["recent", "in-range"]);
});

test("主页已到最后一页时正常结束", async () => {
  const page = new FeedPage([{ posts: [post("only", "2026-08-25T10:00:00Z")], hasNext: false }]);

  const result = await run(collectorFor(page));

  assert.deepEqual(result.notes.map((note) => note.id), ["only"]);
  assert.equal(page.scrolls, 0);
});

test("主页停在开始日期之前不能算完成，并保留已读到的图文", async () => {
  const page = new FeedPage([{ posts: [post("recent", "2026-08-27T10:00:00Z")] }]);

  await assert.rejects(() => run(collectorFor(page)), (error) => {
    assert.equal(error.code, "PLATFORM_TEMPORARILY_UNAVAILABLE");
    assert.match(error.message, /只加载到 2026-08-27/);
    assert.deepEqual(error.partialResult.notes.map((note) => note.id), ["recent"]);
    return true;
  });
});

test("读不到帖子列表且出现登录提示时等待人工登录", async () => {
  const page = new FeedPage([], "Log in to see photos and videos");

  await assert.rejects(() => run(collectorFor(page)), LoginRequiredError);
});

test("读不到帖子列表时标记失败而不是完成", async () => {
  const page = new FeedPage([], "test.creator\n120帖子");

  await assert.rejects(() => run(collectorFor(page)), /未能读取博主主页的帖子列表/);
});

test("零帖子的主页正常完成", async () => {
  const page = new FeedPage([], "test.creator\n0帖子\n10粉丝");

  const result = await run(collectorFor(page));

  assert.deepEqual(result.notes, []);
});

test("纯视频帖子不会返回", async () => {
  const page = new FeedPage([
    { posts: [post("video", "2026-08-25T10:00:00Z", { type: 2 }), post("old", "2026-08-01T10:00:00Z")] },
  ]);

  const result = await run(collectorFor(page));

  assert.deepEqual(result.notes, []);
});

test("待补帖子未出现在主页时保留原有记录", async () => {
  const saved = { id: "missing", url: "https://www.instagram.com/p/missing/", publishedAt: "2026-08-24T00:00:00.000Z", media: [{ url: "https://scontent.cdninstagram.com/expired.jpg", error: "过期" }] };
  const page = new FeedPage([{ posts: [post("fresh", "2026-08-25T10:00:00Z")], hasNext: false }]);

  const result = await run(collectorFor(page), {
    checkpoint: { entries: {}, pending: { [saved.url]: { key: saved.url, note: saved } } },
  });

  assert.deepEqual(result.notes.map((note) => note.id), ["fresh", "missing"]);
});

test("主页持续被平台拒绝时请求冷却", async () => {
  const page = new FeedPage([]);
  page.goto = async (url) => { throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${url}`); };

  await assert.rejects(() => run(collectorFor(page)), (error) => error.code === "PLATFORM_TEMPORARILY_UNAVAILABLE");
});

test("开始采集前取消不会创建浏览器页面", async () => {
  let pageCount = 0;
  const collector = new InstagramCollector({ browserManager: { newPage: async () => { pageCount += 1; } } });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => collector.collect(task(), { signal: controller.signal, onProgress: async () => {} }),
    { name: "AbortError" },
  );
  assert.equal(pageCount, 0);
});
