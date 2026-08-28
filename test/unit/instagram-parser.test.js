import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseInstagramPostHtml } from "../../src/collectors/instagram/parser.js";

test("帖子页面提取作者、时间、公开互动和图片", async () => {
  const html = await readFile(new URL("../fixtures/instagram/post.html", import.meta.url), "utf8");

  const note = parseInstagramPostHtml(html, "https://www.instagram.com/p/shortcode-1/");

  assert.equal(note.id, "shortcode-1");
  assert.equal(note.author, "test.creator");
  assert.equal(note.title, "A sunny day");
  assert.deepEqual(note.metrics, { likeCount: 1234, favoriteCount: null, commentCount: 56 });
  assert.deepEqual(note.media.map((item) => item.url), ["https://scontent.cdninstagram.com/photo-1.jpg"]);
});

test("页面没有公开互动数量时保持空值", () => {
  const html = `
    <meta property="og:title" content="Creator (@creator) on Instagram">
    <meta property="og:image" content="https://scontent.cdninstagram.com/hidden.jpg">
    <time datetime="2026-08-27T08:00:00Z"></time>
  `;

  const note = parseInstagramPostHtml(html, "https://www.instagram.com/p/hidden-counts/");

  assert.deepEqual(note.metrics, { likeCount: null, favoriteCount: null, commentCount: null });
});
