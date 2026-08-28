import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mediaExtension, safeFileName } from "../../src/export/file-names.js";
import { LocalImageStore } from "../../src/export/local-image-store.js";

function task(profileKey = "test.creator") {
  return { platform: "instagram", profileKey };
}

function note(id, likeCount, urls) {
  return {
    id,
    metrics: { likeCount },
    media: urls.map((url) => ({ url, type: "image", localPath: null, error: null })),
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "collector-output-"));
  const rootDir = path.join(directory, "博主图片采集");
  const indexDir = path.join(directory, "indexes");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { rootDir, indexDir, store: new LocalImageStore({ rootDir, indexDir }) };
}

test("文件名会移除系统不允许的字符", () => {
  assert.equal(safeFileName(" 景甜:周末/分享?* "), "景甜-周末-分享");
  assert.equal(safeFileName("..."), "未命名");
});

test("小红书图片路径标记可以识别真实图片格式", () => {
  assert.equal(
    mediaExtension("https://sns-webpic-qc.xhscdn.com/photo!nc_n_nwebp_mw_1"),
    ".webp",
  );
});

test("图片按账号归档并使用序号和点赞数命名", async (t) => {
  const { rootDir, store } = await fixture(t);

  const result = await store.save(
    task("creator:name"),
    [
      note("post-1", 123, ["https://cdn.example/one.jpg"]),
      note("post-2", null, ["https://cdn.example/two.png"]),
    ],
    { fetchBuffer: async (url) => Buffer.from(url) },
  );

  const authorDir = path.join(rootDir, "creator-name");
  assert.equal(result.directory, authorDir);
  assert.deepEqual(await readdir(authorDir), [
    "creator-name_000001_点赞123.jpg",
    "creator-name_000002_点赞未知.png",
  ]);
  assert.equal(
    await readFile(path.join(authorDir, "creator-name_000001_点赞123.jpg"), "utf8"),
    "https://cdn.example/one.jpg",
  );
});

test("同一笔记图片重复采集时不会再次下载", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  let fetches = 0;
  const notes = [note("post-1", 8, ["https://cdn.example/one.jpg", "https://cdn.example/two.jpg"])];
  const options = {
    fetchBuffer: async () => {
      fetches += 1;
      return Buffer.from("image");
    },
  };

  await store.save(task(), notes, options);
  const repeated = await store.save(task(), notes, options);

  assert.equal(fetches, 2);
  assert.equal((await readdir(path.join(rootDir, "test.creator"))).length, 2);
  assert.ok(repeated.notes[0].media.every((media) => media.localPath));
  assert.equal((await readdir(rootDir)).includes("indexes"), false);
  assert.equal((await readdir(indexDir)).length, 1);
});

test("同一账号并发保存时序号不会冲突", async (t) => {
  const { rootDir, store } = await fixture(t);
  const options = { fetchBuffer: async () => Buffer.from("image") };

  await Promise.all([
    store.save(task(), [note("post-1", 1, ["https://cdn.example/one.jpg"])], options),
    store.save(task(), [note("post-2", 2, ["https://cdn.example/two.jpg"])], options),
  ]);

  assert.deepEqual(await readdir(path.join(rootDir, "test.creator")), [
    "test.creator_000001_点赞1.jpg",
    "test.creator_000002_点赞2.jpg",
  ]);
});

test("单张图片失败不会中断后续图片", async (t) => {
  const { store } = await fixture(t);
  const progress = [];

  const result = await store.save(
    task(),
    [note("post-1", 5, ["https://cdn.example/fail.jpg", "https://cdn.example/ok.jpg"])],
    {
      fetchBuffer: async (url) => {
        if (url.endsWith("fail.jpg")) throw new Error("下载失败");
        return Buffer.from("image");
      },
      onProgress: async (value) => progress.push(value),
    },
  );

  assert.equal(result.notes[0].media[0].error, "下载失败");
  assert.ok(result.notes[0].media[1].localPath);
  assert.equal(progress.at(-1).imagesDownloaded, 1);
});
