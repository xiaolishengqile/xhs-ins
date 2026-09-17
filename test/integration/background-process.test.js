import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const command = path.join(projectRoot, "scripts", "background.js");

async function run(args, { reject = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [command, ...args, "--json"], {
      cwd: projectRoot,
      env: { ...process.env, COLLECTOR_HEADLESS: "1" },
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    if (reject) throw error;
    return {
      code: error.code ?? 1,
      stdout: error.stdout?.trim() ?? "",
      stderr: error.stderr?.trim() ?? "",
    };
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "采集后台 空格-"));
  const dataDir = path.join(root, "用户 数据");
  const outputDir = path.join(root, "输出 图片");
  const common = ["--data-dir", dataDir, "--output-dir", outputDir];
  t.after(async () => {
    await run(["stop", ...common]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, outputDir, common };
}

function parse(output) {
  return JSON.parse(output);
}

async function sendControl(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("end", () => resolve(JSON.parse(response.trim())));
  });
}

test("后台进程就绪后可查询，重复启动复用实例，并能经过控制通道停止", async (t) => {
  const { common } = await fixture(t);

  const started = parse((await run(["start", ...common, "--port", "0"], { reject: true })).stdout);
  assert.equal(started.running, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${started.url}/api/health`)).status, 200);

  const repeated = parse((await run(["start", ...common, "--port", "0"], { reject: true })).stdout);
  assert.equal(repeated.pid, started.pid);
  assert.equal(repeated.alreadyRunning, true);

  const status = parse((await run(["status", ...common], { reject: true })).stdout);
  assert.equal(status.pid, started.pid);
  assert.equal(status.url, started.url);

  const paused = parse((await run(["pause", ...common], { reject: true })).stdout);
  assert.equal(paused.paused, true);
  assert.equal(parse((await run(["status", ...common], { reject: true })).stdout).paused, true);
  const resumed = parse((await run(["resume", ...common], { reject: true })).stdout);
  assert.equal(resumed.paused, false);

  const stopped = parse((await run(["stop", ...common], { reject: true })).stdout);
  assert.equal(stopped.stopped, true);
  const afterStop = await run(["status", ...common]);
  assert.notEqual(afterStop.code, 0);

  const restarted = parse((await run(["start", ...common, "--port", "0"], { reject: true })).stdout);
  assert.notEqual(restarted.pid, started.pid);
  assert.equal(parse((await run(["stop", ...common], { reject: true })).stdout).stopped, true);
});

test("控制通道拒绝错误实例凭证且不会停止后台", async (t) => {
  const { dataDir, common } = await fixture(t);
  const started = parse((await run(["start", ...common, "--port", "0"], { reject: true })).stdout);
  const state = JSON.parse(await readFile(path.join(dataDir, "background", "state.json"), "utf8"));

  const denied = await sendControl(state.endpoint, { action: "stop", token: "错误凭证" });
  assert.deepEqual(denied, { ok: false, error: "unauthorized" });
  const status = parse((await run(["status", ...common], { reject: true })).stdout);
  assert.equal(status.pid, started.pid);
});

test("端口已占用时拒绝启动且不初始化任务队列", async (t) => {
  const { dataDir, common } = await fixture(t);
  const occupied = createServer((_request, response) => response.end("occupied"));
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;

  const result = await run(["start", ...common, "--port", String(port)]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /EADDRINUSE|端口.*占用/);
  assert.notEqual((await run(["status", ...common])).code, 0);
  await assert.rejects(access(path.join(dataDir, "tasks")), { code: "ENOENT" });
});

test("崩溃遗留的旧锁与状态不会阻止下次启动", async (t) => {
  const { dataDir, common } = await fixture(t);
  const backgroundDir = path.join(dataDir, "background");
  const lockDir = path.join(backgroundDir, "instance.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));
  await writeFile(path.join(backgroundDir, "state.json"), JSON.stringify({
    pid: 999999,
    token: "stale",
    endpoint: process.platform === "win32" ? "\\\\.\\pipe\\missing-xhs-ins" : path.join(dataDir, "missing.sock"),
  }));

  const started = parse((await run(["start", ...common, "--port", "0"], { reject: true })).stdout);
  assert.equal(started.running, true);
  assert.notEqual(started.pid, 999999);
});
