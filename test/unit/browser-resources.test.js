import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserManager } from "../../src/browser/browser-manager.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(t, response, options = {}) {
  const profilesDir = await mkdtemp(path.join(tmpdir(), "browser-resources-"));
  const contexts = [];
  const manager = new BrowserManager({
    profilesDir, idleTimeoutMs: 25,
    browserLaunchOptions: async () => [{}],
    launchPersistentContext: async () => {
      const context = new EventEmitter();
      context.closed = false;
      context.newPage = async () => ({ close: async () => {} });
      context.request = { get: async () => response };
      context.close = async () => { context.closed = true; context.emit("close"); };
      contexts.push(context);
      return context;
    },
    ...options,
  });
  t.after(async () => { await manager.close(); await rm(profilesDir, { recursive: true, force: true }); });
  return { manager, contexts };
}

for (const mode of ["success", "http-error", "body-error"]) {
  test(`图片响应在 ${mode} 时都释放内存`, async (t) => {
    let disposed = 0;
    const { manager } = await fixture(t, {
      ok: () => mode !== "http-error", status: () => 403,
      body: async () => { if (mode === "body-error") throw new Error("读取失败"); return Buffer.from("image"); },
      dispose: async () => { disposed += 1; },
    });
    const result = manager.fetchBuffer("instagram", "https://scontent.cdninstagram.com/image.jpg");
    if (mode === "success") assert.deepEqual(await result, Buffer.from("image"));
    else await assert.rejects(result);
    assert.equal(disposed, 1);
  });
}

test("最后一个会话关闭后空闲释放浏览器，新任务会取消回收", async (t) => {
  const { manager, contexts } = await fixture(t);
  const first = await manager.createTaskSession("instagram", "first");
  await first.close();
  const second = await manager.createTaskSession("instagram", "second");
  await delay(60);
  assert.equal(contexts[0].closed, false);
  await second.close();
  await eventually(() => assert.equal(contexts[0].closed, true));
  const third = await manager.createTaskSession("instagram", "third");
  assert.equal(contexts.length, 2);
  await third.close();
});
