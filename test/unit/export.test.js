import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toCsv } from "../../src/export/csv.js";
import { safeFileName } from "../../src/export/file-names.js";
import { downloadMedia } from "../../src/export/media-downloader.js";
import { createTaskArchive } from "../../src/export/archive.js";

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
  const entries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
  assert.match(entries, /notes\.csv/);
  assert.match(entries, /images\/2026-08-28-n1\/01\.jpg/);
});
