import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = new URL("../..", import.meta.url);

test("本机启动入口使用隔离目录启动或复用后台，并返回可打开的网页地址", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "collector-open-web-"));
  const dataDir = path.join(temp, "data");
  t.after(async () => {
    await run(process.execPath, ["scripts/background.js", "stop", "--data-dir", dataDir, "--json"], { cwd: root }).catch(() => {});
    await rm(temp, { recursive: true, force: true });
  });
  const args = ["scripts/open-web.js", "--data-dir", dataDir, "--port", "0", "--no-open"];
  const first = await run(process.execPath, args, { cwd: root });
  const url = first.stdout.trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const second = await run(process.execPath, args, { cwd: root });
  assert.equal(second.stdout.trim(), url);
});
