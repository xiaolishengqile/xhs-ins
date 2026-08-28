import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { toCsv } from "../../src/export/csv.js";
import { mediaExtension, safeFileName } from "../../src/export/file-names.js";
import { downloadMedia } from "../../src/export/media-downloader.js";
import { createTaskArchive } from "../../src/export/archive.js";
import { createCompletedArchive } from "../../src/export/completed-archive.js";
import { readZipEntries } from "../helpers/zip.js";

test("数据表正确转义中文标题、逗号和换行", () => {
  const csv = toCsv([
    {
      platform: "xiaohongshu",
      id: "n1",
      author: "作者",
      title: "标题,带逗号\n和换行",
      publishedAt: "2026-08-28T08:00:00.000Z",
      url: "https://example.com/n1",
      metrics: { likeCount: 10, favoriteCount: null, commentCount: 2 },
      media: [],
      error: null,
    },
  ]);

  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /"标题,带逗号\n和换行"/);
  assert.match(csv, /,10,,2,/);
});

test("文件名会移除系统不允许的字符", () => {
  assert.equal(safeFileName(' 景甜:周末/分享?* '), "景甜-周末-分享");
  assert.equal(safeFileName("..."), "未命名");
});

test("小红书图片路径标记可以识别真实图片格式", () => {
  assert.equal(
    mediaExtension("https://sns-webpic-qc.xhscdn.com/photo!nc_n_nwebp_mw_1"),
    ".webp",
  );
});

test("重复图片只下载一次且单图失败不会中断其他图片", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-media-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  const notes = [
    {
      id: "n1",
      publishedAt: "2026-08-28T08:00:00.000Z",
      media: [
        { url: "https://cdn.example/shared.jpg", type: "image", localPath: null, error: null },
        { url: "https://cdn.example/fail.jpg", type: "image", localPath: null, error: null },
      ],
    },
    {
      id: "n2",
      publishedAt: "2026-08-27T08:00:00.000Z",
      media: [{ url: "https://cdn.example/shared.jpg", type: "image", localPath: null, error: null }],
    },
  ];

  const result = await downloadMedia(notes, rootDir, async (url) => {
    calls.push(url);
    if (url.endsWith("fail.jpg")) throw new Error("下载失败");
    return Buffer.from("image-body");
  });

  assert.deepEqual(calls, ["https://cdn.example/shared.jpg", "https://cdn.example/fail.jpg"]);
  assert.equal(result[0].media[1].error, "下载失败");
  assert.equal(result[1].media[0].localPath, result[0].media[0].localPath);
  assert.equal(await readFile(path.join(rootDir, result[0].media[0].localPath), "utf8"), "image-body");
});

test("压缩包包含数据表和已下载图片", async (t) => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "collector-archive-"));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const notes = await downloadMedia(
    [
      {
        platform: "xiaohongshu",
        id: "n1",
        author: "景甜",
        title: "周末分享",
        publishedAt: "2026-08-28T08:00:00.000Z",
        url: "https://example.com/n1",
        metrics: { likeCount: 10, favoriteCount: 2, commentCount: 1 },
        media: [{ url: "https://cdn.example/photo.jpg", type: "image", localPath: null, error: null }],
        error: null,
      },
    ],
    taskDir,
    async () => Buffer.from("image-body"),
  );
  const task = {
    platform: "xiaohongshu",
    author: "景甜",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-28T23:59:59.999Z",
  };

  const archivePath = await createTaskArchive(task, notes, taskDir);

  assert.ok((await stat(archivePath)).size > 0);
  const entries = await readZipEntries(archivePath);
  assert.ok([...entries.keys()].some((name) => name.endsWith("/notes.csv")));
  assert.ok([...entries.keys()].some((name) => name.endsWith("/images/2026-08-28-n1/01.jpg")));
});

test("汇总压缩只加入存在的完成任务并写入遗漏清单", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "collector-completed-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const firstPath = path.join(rootDir, "first.zip");
  await writeFile(firstPath, "first-result");

  const archive = await createCompletedArchive([
    {
      id: "first-id",
      status: "completed",
      platform: "instagram",
      author: "作者",
      profileKey: "author",
      resultPath: firstPath,
    },
    {
      id: "missing-id",
      status: "completed",
      platform: "instagram",
      author: "缺失",
      profileKey: "missing",
      resultPath: path.join(rootDir, "missing.zip"),
    },
    { id: "running-id", status: "running", resultPath: firstPath },
  ]);
  const target = path.join(rootDir, "all.zip");
  await pipeline(archive.outputStream, createWriteStream(target));

  const entries = await readZipEntries(target);
  assert.equal([...entries.keys()].filter((name) => name.endsWith(".zip")).length, 1);
  assert.equal(entries.get([...entries.keys()].find((name) => name.endsWith(".zip"))).toString(), "first-result");
  assert.match(entries.get("manifest.json").toString("utf8"), /missing-id/);
  assert.equal(archive.included.length, 1);
  assert.equal(archive.missing.length, 1);
});

test("没有可用完成结果时不生成空汇总压缩包", async () => {
  await assert.rejects(
    () => createCompletedArchive([{ id: "running", status: "running", resultPath: null }]),
    (error) => error.statusCode === 409 && /没有可下载/.test(error.message),
  );
});
