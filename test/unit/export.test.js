import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { safeFileName } from "../../src/export/file-names.js";
import { LocalImageStore } from "../../src/export/local-image-store.js";

function pngBuffer(width, height, marker = 0) {
  const buffer = Buffer.alloc(25);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = marker;
  return buffer;
}

function jpegBuffer(width, height, marker = 0) {
  const buffer = Buffer.alloc(22);
  Buffer.from("ffd8ffc0001108", "hex").copy(buffer);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[21] = marker;
  return buffer;
}

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

test("图片按账号归档并使用序号和点赞数命名", async (t) => {
  const { rootDir, store } = await fixture(t);

  const result = await store.save(
    task("creator:name"),
    [
      note("post-1", 123, ["https://cdn.example/one.jpg"]),
      note("post-2", null, ["https://cdn.example/two.png"]),
    ],
    { fetchBuffer: async (url) => url.endsWith(".png") ? pngBuffer(1200, 800) : jpegBuffer(1200, 800) },
  );

  const authorDir = path.join(rootDir, "creator-name");
  assert.equal(result.directory, authorDir);
  assert.deepEqual(await readdir(authorDir), [
    "creator-name_000001_点赞123.jpg",
    "creator-name_000002_点赞未知.png",
  ]);
  assert.deepEqual(await readFile(path.join(authorDir, "creator-name_000001_点赞123.jpg")), jpegBuffer(1200, 800));
});

test("同一笔记图片重复采集时不会再次下载", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  let fetches = 0;
  const notes = [note("post-1", 8, ["https://cdn.example/one.jpg", "https://cdn.example/two.jpg"])];
  const options = {
    fetchBuffer: async (url) => {
      fetches += 1;
      return jpegBuffer(1200, 800, url.includes("two") ? 2 : 1);
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
  const options = {
    fetchBuffer: async (url) => jpegBuffer(1200, 800, url.includes("two") ? 2 : 1),
  };

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
        return jpegBuffer(1200, 800);
      },
      onProgress: async (value) => progress.push(value),
    },
  );

  assert.equal(result.notes[0].media[0].error, "下载失败");
  assert.ok(result.notes[0].media[1].localPath);
  assert.equal(progress.at(-1).imagesDownloaded, 1);
});

test("图片按真实内容确定格式并记录质量信息", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);

  const result = await store.save(
    task(),
    [note("post-1", 5, ["https://cdn.example/full-size.jpg"])],
    { fetchBuffer: async () => pngBuffer(1440, 1800) },
  );

  const media = result.notes[0].media[0];
  assert.match(media.localPath, /\.png$/);
  assert.equal(media.width, 1440);
  assert.equal(media.height, 1800);
  assert.equal(media.quality, "full");
  const index = JSON.parse(await readFile(path.join(indexDir, "instagram-test.creator.json"), "utf8"));
  const saved = index.items["instagram:test.creator:post-1:0"];
  assert.equal(saved.sourceUrl, "https://cdn.example/full-size.jpg");
  assert.equal(saved.width, 1440);
  assert.equal(saved.height, 1800);
  assert.equal(saved.contentType, "image/png");
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readdir(path.join(rootDir, "test.creator")), ["test.creator_000001_点赞5.png"]);
});

test("相同图片内容使用不同地址时只保存一个文件", async (t) => {
  const { rootDir, store } = await fixture(t);
  const image = pngBuffer(1200, 1200);

  const result = await store.save(
    task(),
    [
      note("post-1", 1, ["https://cdn.example/first.jpg"]),
      note("post-2", 2, ["https://cdn.example/second.jpg"]),
    ],
    { fetchBuffer: async () => image },
  );

  assert.equal((await readdir(path.join(rootDir, "test.creator"))).length, 1);
  assert.equal(result.notes[0].media[0].localPath, result.notes[1].media[0].localPath);
  assert.equal(result.imagesDownloaded, 1);
});

test("低分辨率图片会标记为预览图", async (t) => {
  const { store } = await fixture(t);
  const progress = [];

  const result = await store.save(
    task(),
    [note("post-1", 1, ["https://cdn.example/preview.jpg"])],
    {
      fetchBuffer: async () => pngBuffer(640, 640),
      onProgress: async (value) => progress.push(value),
    },
  );

  assert.equal(result.notes[0].media[0].quality, "preview");
  assert.equal(result.previewImages, 1);
  assert.equal(progress.at(-1).previewImages, 1);
});

test("旧索引中的预览图遇到更大候选时会原位升级", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  const authorDir = path.join(rootDir, "test.creator");
  const indexFile = path.join(indexDir, "instagram-test.creator.json");
  const fileName = "test.creator_000001_点赞1.jpg";
  await mkdir(authorDir, { recursive: true });
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(authorDir, fileName), jpegBuffer(640, 640, 1));
  await writeFile(indexFile, `${JSON.stringify({
    nextSequence: 2,
    items: { "instagram:test.creator:post-1:0": { fileName } },
  })}\n`);
  const notes = note("post-1", 1, ["https://cdn.example/photo.jpg?width=1440"]);
  notes.media[0].sourceWidth = 1440;

  const result = await store.save(
    task(),
    [notes],
    { fetchBuffer: async () => jpegBuffer(1440, 1440, 2) },
  );

  assert.equal(result.notes[0].media[0].width, 1440);
  assert.equal((await readdir(authorDir)).length, 1);
  assert.deepEqual(await readFile(path.join(authorDir, fileName)), jpegBuffer(1440, 1440, 2));
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  assert.equal(index.nextSequence, 2);
  assert.equal(index.items["instagram:test.creator:post-1:0"].width, 1440);
  assert.match(index.items["instagram:test.creator:post-1:0"].sha256, /^[0-9a-f]{64}$/);
});

test("旧索引中的高清图会补齐质量信息且不重复下载", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  const authorDir = path.join(rootDir, "test.creator");
  const indexFile = path.join(indexDir, "instagram-test.creator.json");
  const fileName = "test.creator_000001_点赞1.jpg";
  await mkdir(authorDir, { recursive: true });
  await mkdir(indexDir, { recursive: true });
  await writeFile(path.join(authorDir, fileName), jpegBuffer(1440, 1440, 1));
  await writeFile(indexFile, `${JSON.stringify({
    nextSequence: 2,
    items: { "instagram:test.creator:post-1:0": { fileName } },
  })}\n`);
  const notes = note("post-1", 1, ["https://cdn.example/photo.jpg?width=1440"]);
  notes.media[0].sourceWidth = 1440;
  let fetches = 0;

  const result = await store.save(task(), [notes], {
    fetchBuffer: async () => {
      fetches += 1;
      return jpegBuffer(1440, 1440, 2);
    },
  });

  assert.equal(fetches, 0);
  assert.equal(result.notes[0].media[0].quality, "full");
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  assert.equal(index.items["instagram:test.creator:post-1:0"].width, 1440);
  assert.equal(index.items["instagram:test.creator:post-1:0"].sourceUrl, notes.media[0].url);
});

test("共享低清文件中的单个图片升级不会破坏其他索引", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  const low = jpegBuffer(640, 640, 1);
  const high = jpegBuffer(1440, 1440, 2);
  await store.save(
    task(),
    [
      note("post-1", 1, ["https://cdn.example/low-1.jpg"]),
      note("post-2", 2, ["https://cdn.example/low-2.jpg"]),
    ],
    { fetchBuffer: async () => low },
  );
  const upgraded = note("post-1", 1, ["https://cdn.example/high.jpg"]);
  upgraded.media[0].sourceWidth = 1440;

  await store.save(task(), [upgraded], { fetchBuffer: async () => high });

  const authorDir = path.join(rootDir, "test.creator");
  const index = JSON.parse(await readFile(path.join(indexDir, "instagram-test.creator.json"), "utf8"));
  const first = index.items["instagram:test.creator:post-1:0"];
  const second = index.items["instagram:test.creator:post-2:0"];
  assert.notEqual(first.fileName, second.fileName);
  assert.deepEqual(await readFile(path.join(authorDir, first.fileName)), high);
  assert.deepEqual(await readFile(path.join(authorDir, second.fileName)), low);
  assert.equal(first.sha256, createHash("sha256").update(high).digest("hex"));
  assert.equal(second.sha256, createHash("sha256").update(low).digest("hex"));
});

test("升级图片命中已有摘要时会删除失去引用的低清文件", async (t) => {
  const { rootDir, indexDir, store } = await fixture(t);
  const low = jpegBuffer(640, 640, 1);
  const high = jpegBuffer(1440, 1440, 2);
  await store.save(
    task(),
    [
      note("post-low", 1, ["https://cdn.example/low.jpg"]),
      note("post-high", 2, ["https://cdn.example/high-existing.jpg"]),
    ],
    { fetchBuffer: async (url) => url.includes("high") ? high : low },
  );
  const upgraded = note("post-low", 1, ["https://cdn.example/high-upgrade.jpg"]);
  upgraded.media[0].sourceWidth = 1440;

  await store.save(task(), [upgraded], { fetchBuffer: async () => high });

  const authorDir = path.join(rootDir, "test.creator");
  const index = JSON.parse(await readFile(path.join(indexDir, "instagram-test.creator.json"), "utf8"));
  const lowEntry = index.items["instagram:test.creator:post-low:0"];
  const highEntry = index.items["instagram:test.creator:post-high:0"];
  assert.equal(lowEntry.fileName, highEntry.fileName);
  assert.deepEqual(await readdir(authorDir), [highEntry.fileName]);
});
