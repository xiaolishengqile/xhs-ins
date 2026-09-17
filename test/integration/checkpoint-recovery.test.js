import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "checkpoint-recovery-"));
  const managers = [];
  t.after(async () => {
    for (const manager of managers) await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return async (collect, exporter = async () => path.join(root, "images")) => {
    const manager = new TaskManager({ store: new TaskStore(root), collectorFactory: () => ({ collect }), exporter });
    managers.push(manager);
    await manager.init();
    return manager;
  };
}

const input = { url: "https://www.instagram.com/example/", range: { preset: "year" } };
const note = { id: "one", media: [{ url: "https://scontent.cdninstagram.com/one.jpg" }] };

test("默认低占用模式跨平台也只运行一个任务", async (t) => {
  const create = await fixture(t);
  let active = 0;
  const manager = await create(async (_task, { signal }) => {
    active += 1;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("停止", "AbortError")), { once: true }));
  });
  const first = await manager.create(input);
  const second = await manager.create({ ...input, url: "https://www.xiaohongshu.com/user/profile/second" });
  await manager.startBatch([first.id, second.id]);
  await eventually(() => assert.equal(active, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(second.id).status, "queued");
});

test("服务退出保留逐帖断点，重启继续而非取消", async (t) => {
  const create = await fixture(t);
  let saved = false;
  const first = await create(async (_task, { onCheckpoint, signal }) => {
    await onCheckpoint({ key: "one", note });
    saved = true;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("停止", "AbortError")), { once: true }));
  });
  const created = await first.create(input);
  await first.start(created.id);
  await eventually(() => assert.equal(saved, true));
  await first.shutdown();
  assert.equal(first.get(created.id).status, "paused");
  const second = await create(async (_task, { checkpoint }) => {
    assert.deepEqual(checkpoint.entries.one.note, note);
    return { author: "example", notes: [checkpoint.entries.one.note] };
  });
  await eventually(() => assert.equal(second.get(created.id).status, "completed"));
});

test("下载中退出后从已完成扫描恢复，不重新浏览主页", async (t) => {
  const create = await fixture(t);
  let exporting = false;
  const first = await create(async () => ({ author: "example", notes: [note] }), async (_task, _notes, _dir, { signal }) => {
    exporting = true;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return "images";
  });
  const created = await first.create(input);
  await first.start(created.id);
  await eventually(() => assert.equal(exporting, true));
  await first.shutdown();
  assert.equal(first.get(created.id).status, "paused");
  const second = await create(async () => { throw new Error("不应重新扫描"); });
  await eventually(() => assert.equal(second.get(created.id).status, "completed"));
});

test("图片下载失败标记部分完成，重试刷新失败帖并保留成功断点", async (t) => {
  const create = await fixture(t);
  let run = 0;
  const manager = await create(async (_task, { checkpoint, onCheckpoint }) => {
    run += 1;
    if (run === 2) {
      assert.equal(checkpoint.entries.one, undefined);
      assert.equal(checkpoint.entries.two.note.id, "two");
    }
    await onCheckpoint({ key: "one", note });
    await onCheckpoint({ key: "two", note: { ...note, id: "two" } });
    return { notes: [note, { ...note, id: "two" }] };
  }, async (_task, notes) => ({
    directory: "images", imagesFailed: run === 1 ? 1 : 0, imagesAvailable: run === 1 ? 1 : 2,
    notes: notes.map((item) => ({ ...item, media: [{ error: item.id === "one" && run === 1 ? "过期" : null }] })),
  }));
  const created = await manager.create(input);
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "partial"));
  assert.equal(manager.get(created.id).progress.imagesFailed, 1);
  assert.equal(manager.get(created.id).resultPath, "images");
  await manager.retry(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
});

test("完成后采集新增保留范围内断点但重新扫描主页", async (t) => {
  const create = await fixture(t);
  let runs = 0;
  const savedNote = { ...note, publishedAt: new Date().toISOString() };
  const manager = await create(async (_task, { checkpoint, onCheckpoint }) => {
    runs += 1;
    if (runs === 2) assert.equal(checkpoint.entries.one.note.id, "one");
    await onCheckpoint({ key: "one", note: savedNote, publishedAt: savedNote.publishedAt });
    return { notes: [savedNote] };
  });
  const created = await manager.create(input);
  await manager.start(created.id);
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
  await manager.update(created.id);
  await eventually(() => assert.equal(runs, 2));
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
});
