import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCount, normalizeNote } from "../../src/domain/note.js";

test("互动数量支持中文单位且缺失值保持为空", () => {
  assert.equal(normalizeCount("3.7万"), 37000);
  assert.equal(normalizeCount("1.2亿"), 120000000);
  assert.equal(normalizeCount("7,654"), 7654);
  assert.equal(normalizeCount("赞"), null);
  assert.equal(normalizeCount(undefined), null);
});

test("笔记标准化不会把未公开收藏数写成零", () => {
  const note = normalizeNote({
    platform: "instagram",
    id: "post-1",
    author: "creator",
    title: "一条帖子",
    publishedAt: "2026-08-28T08:00:00.000Z",
    url: "https://www.instagram.com/p/post-1/",
    metrics: { likeCount: "42", commentCount: 3 },
    media: [{ url: "https://cdn.example/photo.jpg" }],
  });

  assert.deepEqual(note.metrics, { likeCount: 42, favoriteCount: null, commentCount: 3 });
  assert.deepEqual(note.media, [
    { url: "https://cdn.example/photo.jpg", type: "image", localPath: null, error: null },
  ]);
});
