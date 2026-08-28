import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNotePayload, parseProfilePayload } from "../../src/collectors/xiaohongshu/parser.js";

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`../fixtures/xiaohongshu/${name}`, import.meta.url), "utf8"),
  );
}

test("主页数据兼容下划线与驼峰字段", async () => {
  const result = parseProfilePayload(await fixture("profile-state.json"));

  assert.equal(result.author, "测试博主");
  assert.deepEqual(
    result.items.map((item) => [item.id, item.token, item.title, item.likeCount]),
    [
      ["note-image-1", "token-image", "周末图片分享", 37000],
      ["note-video-1", "token-video", "一条视频", 120],
      ["note-old-1", "token-old", "范围外旧笔记", 9],
    ],
  );
});

test("详情数据提取全部图片与三项互动数量", async () => {
  const note = parseNotePayload(
    await fixture("note-detail.json"),
    "https://www.xiaohongshu.com/explore/note-image-1",
  );

  assert.equal(note.id, "note-image-1");
  assert.equal(note.title, "周末图片分享");
  assert.deepEqual(note.metrics, { likeCount: 37000, favoriteCount: 1200, commentCount: 88 });
  assert.deepEqual(
    note.media.map((item) => item.url),
    ["https://sns-webpic-qc.xhscdn.com/image-1", "https://sns-webpic-qc.xhscdn.com/image-2"],
  );
});
