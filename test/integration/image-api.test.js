import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import sharp from "sharp";

import { createApp } from "../../src/http/app.js";
import { startServer } from "../../src/http/server.js";
import { ApplicationController } from "../../src/application/controller.js";
import { LocalImageLibrary } from "../../src/images/local-image-library.js";

const PNG = await sharp({ create: { width: 2, height: 1, channels: 3, background: "#cc3344" } }).png().toBuffer();

async function fixture(t, options = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "collector-images-"));
  const outputDir = path.join(temp, "图片");
  const accountDir = path.join(outputDir, "账号甲");
  await mkdir(accountDir, { recursive: true });
  await writeFile(path.join(accountDir, "第一张.png"), PNG);
  const controller = new ApplicationController({
    manager: {}, browserManager: {}, outputDir, openPath: options.openPath ?? (async () => {}),
  });
  const instance = await startServer({
    handler: createApp({ manager: {}, controller }), port: 0,
  });
  t.after(async () => {
    await instance.close();
    await rm(temp, { recursive: true, force: true });
  });
  return { ...instance, temp, outputDir, accountDir };
}

test("图片接口按账号分页并提供原图和小尺寸缩略图", async (t) => {
  const { url, accountDir } = await fixture(t);
  await writeFile(path.join(accountDir, "第二张.png"), PNG);
  const accounts = await (await fetch(`${url}/api/images/accounts`)).json();
  assert.deepEqual(accounts.accounts, ["账号甲"]);

  const list = await (await fetch(`${url}/api/images?account=${encodeURIComponent("账号甲")}&page=1`)).json();
  assert.equal(list.total, 2);
  assert.equal(list.pageCount, 1);
  assert.deepEqual(list.images.map((image) => image.name), ["第一张.png", "第二张.png"]);

  const original = await fetch(`${url}${list.images[0].url}`);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), PNG);
  const thumbnail = await fetch(`${url}${list.images[0].thumbnailUrl}`);
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get("content-type"), "image/webp");
  assert.ok((await thumbnail.arrayBuffer()).byteLength < 20_000);
});

test("图片接口拒绝目录越界、符号链接、损坏文件和超限文件", async (t) => {
  const { url, temp, outputDir, accountDir } = await fixture(t);
  await writeFile(path.join(temp, "outside.png"), PNG);
  await writeFile(path.join(accountDir, "损坏.png"), Buffer.from("not-an-image"));
  const huge = await open(path.join(accountDir, "超限.png"), "w");
  await huge.truncate(64 * 1024 * 1024 + 1);
  await huge.close();
  try {
    await symlink(path.join(temp, "outside.png"), path.join(accountDir, "快捷方式.png"));
    await symlink(temp, path.join(outputDir, "跳出目录"), "dir");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }

  const accounts = await (await fetch(`${url}/api/images/accounts`)).json();
  assert.deepEqual(accounts.accounts, ["账号甲"]);
  const list = await (await fetch(`${url}/api/images?account=${encodeURIComponent("账号甲")}&page=1`)).json();
  assert.ok(list.images.every((image) => image.name !== "快捷方式.png"));
  assert.equal((await fetch(`${url}/api/images?account=..&page=1`)).status, 400);
  assert.equal((await fetch(`${url}/api/images?account=${encodeURIComponent("../账号甲")}&page=1`)).status, 400);
  assert.equal((await fetch(`${url}/api/images?account=${encodeURIComponent("账号甲")}&page=0`)).status, 400);
  const fileUrl = (name) => `${url}/api/images/file?account=${encodeURIComponent("账号甲")}&name=${encodeURIComponent(name)}`;
  assert.equal((await fetch(fileUrl("../outside.png"))).status, 400);
  assert.equal((await fetch(fileUrl("快捷方式.png"))).status, 404);
  assert.equal((await fetch(fileUrl("损坏.png"))).status, 415);
  assert.equal((await fetch(fileUrl("超限.png"))).status, 413);
});

test("本机图片接口拒绝非回环主机名请求", async (t) => {
  const { url } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/images/accounts`, { headers: { host: "outside.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 403);
});

test("图片页码超过末页时收敛到最后一页", async (t) => {
  const { url, accountDir } = await fixture(t);
  for (let index = 1; index <= 30; index += 1) {
    await writeFile(path.join(accountDir, `补图${String(index).padStart(2, "0")}.png`), PNG);
  }
  const result = await (await fetch(`${url}/api/images?account=${encodeURIComponent("账号甲")}&page=99`)).json();
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.images.length, 1);
});

test("删除选中图片只影响账号目录内的图片文件", async (t) => {
  const { url, temp, accountDir } = await fixture(t);
  await writeFile(path.join(accountDir, "第二张.png"), PNG);
  await writeFile(path.join(accountDir, "说明.txt"), "keep");
  await writeFile(path.join(temp, "outside.png"), PNG);
  const remove = (body) => fetch(`${url}/api/images/delete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  assert.equal((await remove({ account: "账号甲", names: ["../outside.png"] })).status, 400);
  assert.equal((await remove({ account: "账号甲", names: [] })).status, 400);
  const result = await (await remove({ account: "账号甲", names: ["第一张.png", "说明.txt", "不存在.png"] })).json();

  assert.deepEqual(result, { deleted: 1, remaining: 1 });
  assert.deepEqual((await readdir(accountDir)).sort(), ["第二张.png", "说明.txt"]);
  assert.ok((await readdir(temp)).includes("outside.png"));
});

test("全部删除后清理空账号目录", async (t) => {
  const { url, outputDir } = await fixture(t);
  const result = await (await fetch(`${url}/api/images/delete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "账号甲", all: true }),
  })).json();

  assert.deepEqual(result, { deleted: 1, remaining: 0 });
  assert.deepEqual(await readdir(outputDir), []);
});

test("图片预览只能打开已确认的账号目录", async (t) => {
  const opened = [];
  const { url, accountDir } = await fixture(t, { openPath: async (directory) => opened.push(directory) });
  const valid = await fetch(`${url}/api/images/open-folder`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "账号甲" }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(opened, [accountDir]);
  const invalid = await fetch(`${url}/api/images/open-folder`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "../外部" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(opened, [accountDir]);
});

test("图片按帖子发布日期排序、可按日期筛选，删除后在索引中标记", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "collector-library-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const rootDir = path.join(temp, "图片");
  const indexDir = path.join(temp, "index");
  await mkdir(path.join(rootDir, "creator"), { recursive: true });
  await mkdir(indexDir, { recursive: true });
  for (const name of ["old.png", "new-1.png", "new-2.png", "loose.png"]) await writeFile(path.join(rootDir, "creator", name), PNG);
  const indexFile = path.join(indexDir, "instagram-creator.json");
  await writeFile(indexFile, JSON.stringify({
    nextSequence: 4,
    items: {
      "instagram:creator:OLD:0": { fileName: "old.png", noteId: "OLD", noteUrl: "https://www.instagram.com/p/OLD/", publishedAt: "2026-01-05T08:00:00.000Z" },
      "instagram:creator:NEW:0": { fileName: "new-1.png", noteId: "NEW", noteUrl: "https://www.instagram.com/p/NEW/", publishedAt: "2026-08-20T08:00:00.000Z" },
      "instagram:creator:NEW:1": { fileName: "new-2.png", noteId: "NEW", noteUrl: "https://www.instagram.com/p/NEW/", publishedAt: "2026-08-20T08:00:00.000Z" },
    },
  }));
  const library = new LocalImageLibrary(rootDir, indexDir);

  const all = await library.list("creator", 1);
  assert.deepEqual(all.images.map((image) => image.name), ["new-1.png", "new-2.png", "old.png", "loose.png"]);
  assert.equal(all.images[0].noteUrl, "https://www.instagram.com/p/NEW/");
  const august = await library.list("creator", 1, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(august.images.map((image) => image.name), ["new-1.png", "new-2.png"]);

  const removed = await library.remove("creator", null, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(removed, { deleted: 2, remaining: 2 });
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  assert.equal(index.items["instagram:creator:NEW:0"].deleted, true);
  assert.equal(index.items["instagram:creator:NEW:1"].deleted, true);
  assert.equal(index.items["instagram:creator:OLD:0"].deleted, undefined);
});
