import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireInstanceLock,
  backgroundPaths,
} from "../../src/background/state.js";

async function staleLock(dataDir) {
  const paths = backgroundPaths(dataDir);
  await mkdir(paths.lockDir, { recursive: true });
  await writeFile(paths.ownerFile, JSON.stringify({ pid: 999999, token: "stale", createdAt: "2000-01-01T00:00:00.000Z" }));
  return paths;
}

test("残留的回收锁会明确阻止自动抢锁", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-recovery-lock-"));
  const paths = await staleLock(dataDir);
  await mkdir(`${paths.lockDir}.recovery`);
  await writeFile(`${paths.lockDir}.recovery/owner.json`, JSON.stringify({
    pid: 999999,
    token: "crashed-recovery",
    createdAt: "2000-01-01T00:00:00.000Z",
  }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await assert.rejects(acquireInstanceLock(dataDir, "new-token"), /回收锁|人工处理/);
});

test("多个进程并发恢复旧锁时最多一个实例取得主锁", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "background-lock-race-"));
  await staleLock(dataDir);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const stateUrl = new URL("../../src/background/state.js", import.meta.url).href;
  const contenders = Array.from({ length: 12 }, (_, index) => {
    const token = `contender-${index}`;
    const script = `
      import { acquireInstanceLock, releaseInstanceLock } from ${JSON.stringify(stateUrl)};
      const dataDir = ${JSON.stringify(dataDir)};
      const token = ${JSON.stringify(token)};
      try {
        const lock = await acquireInstanceLock(dataDir, token);
        process.stdout.write("acquired\\n");
        await new Promise((done) => {
          process.stdin.once("data", done);
          process.stdin.once("end", done);
          process.stdin.resume();
        });
        await releaseInstanceLock(lock, token);
      } catch (error) {
        process.stdout.write("denied:" + error.code + "\\n");
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let readyDone;
    const ready = new Promise((resolve) => { readyDone = resolve; });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) readyDone(stdout.trim());
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve) => child.on("close", (code) => {
      readyDone(stdout.trim() || `closed:${code}`);
      resolve({ code, stdout, stderr });
    }));
    return { child, ready, closed };
  });
  t.after(async () => {
    for (const { child } of contenders) {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    }
    await Promise.all(contenders.map(async ({ child, closed }) => {
      const result = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]);
      if (!result && child.exitCode === null) child.kill("SIGTERM");
      await closed;
    }));
  });

  const outcomes = await Promise.all(contenders.map(({ ready }) => ready));
  const winners = contenders.filter((_contender, index) => outcomes[index] === "acquired");
  assert.equal(winners.length, 1);
  winners[0].child.stdin.end("release\n");
  const results = await Promise.all(contenders.map(({ closed }) => closed));
  assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\n"));
});
