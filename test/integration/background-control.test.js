import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stopBackground } from "../../src/background/client.js";
import { sendControl, startControlServer } from "../../src/background/control.js";
import { backgroundPaths, ensureBackgroundDir, writePrivateJson } from "../../src/background/state.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("停止响应等待运行时和网页服务关闭，并在期间报告正在停止", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-stop-"));
  await ensureBackgroundDir(dataDir);
  const token = "test-token";
  const paths = backgroundPaths(dataDir, token);
  const closing = deferred();
  let stopping = false;
  const web = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${web.address().port}`;
  let control;
  control = await startControlServer({
    endpoint: paths.endpoint,
    token,
    status: () => ({ running: true, stopping, url }),
    onStop: async () => {
      stopping = true;
      await closing.promise;
      await new Promise((resolve) => web.close(resolve));
      await rm(paths.stateFile, { force: true });
    },
  });
  await writePrivateJson(paths.stateFile, { endpoint: paths.endpoint, token, url });
  t.after(async () => {
    closing.resolve();
    await new Promise((resolve) => control.close(resolve));
    await rm(paths.endpoint, { force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  let stopped = false;
  const stoppingPromise = sendControl(paths.endpoint, { action: "stop", token }, { timeout: 3_000 })
    .then(() => { stopped = true; });
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, 5));
  const status = await sendControl(paths.endpoint, { action: "status", token });
  assert.equal(status.status.stopping, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false);

  closing.resolve();
  await stoppingPromise;
  assert.equal(stopped, true);
  await assert.rejects(fetch(url));
});

test("客户端不会把控制通道提前断开误判为安全停止", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-client-stop-"));
  await ensureBackgroundDir(dataDir);
  const token = "client-token";
  const paths = backgroundPaths(dataDir, token);
  const closing = deferred();
  const web = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${web.address().port}`;
  let control;
  control = await startControlServer({
    endpoint: paths.endpoint,
    token,
    status: () => ({ running: true, url }),
    onStop: async () => {
      control.close();
      await closing.promise;
      await new Promise((resolve) => web.close(resolve));
      await rm(paths.stateFile, { force: true });
    },
  });
  await writePrivateJson(paths.stateFile, { endpoint: paths.endpoint, token, url });
  t.after(async () => {
    closing.resolve();
    if (web.listening) await new Promise((resolve) => web.close(resolve));
    await rm(paths.endpoint, { force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  let stopped = false;
  const stoppingPromise = stopBackground(dataDir, { timeout: 3_000 }).then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopped, false);
  assert.equal((await fetch(url)).status, 200);

  closing.resolve();
  await stoppingPromise;
  assert.equal(stopped, true);
});

test("控制服务会回收未发送请求的空闲连接", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-idle-"));
  const token = "idle-token";
  const paths = backgroundPaths(dataDir, token);
  const control = await startControlServer({
    endpoint: paths.endpoint,
    token,
    status: () => ({ running: true }),
    onStop: async () => {},
  });
  const socket = net.createConnection(paths.endpoint);
  await once(socket, "connect");
  t.after(async () => {
    socket.destroy();
    if (control.listening) await new Promise((resolve) => control.close(resolve));
    await rm(paths.endpoint, { force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  const closed = new Promise((resolve) => control.close(() => resolve(true)));
  const result = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 2_500)),
  ]);
  assert.equal(result, true);
});

test("控制服务拒绝 null 请求后仍可响应认证状态查询", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-invalid-"));
  const token = "invalid-token";
  const paths = backgroundPaths(dataDir, token);
  const control = await startControlServer({
    endpoint: paths.endpoint,
    token,
    status: () => ({ running: true }),
    onStop: async () => {},
  });
  t.after(async () => {
    if (control.listening) await new Promise((resolve) => control.close(resolve));
    await rm(paths.endpoint, { force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.deepEqual(await sendControl(paths.endpoint, null), { ok: false, error: "invalid_request" });
  assert.deepEqual(await sendControl(paths.endpoint, []), { ok: false, error: "invalid_request" });
  assert.deepEqual(await sendControl(paths.endpoint, { action: "status", token }), {
    ok: true,
    status: { running: true },
  });
});
