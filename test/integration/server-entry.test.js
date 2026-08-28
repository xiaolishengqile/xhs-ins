import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("云平台以模块方式加载时自动启动服务器", async (t) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", 'import("./src/server.js")'], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, VERCEL: "1", PORT: "0", COLLECTOR_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("等待服务器启动超时")), 3_000).unref();
    }),
  ]);

  assert.match(output, /博主图片采集工具已启动/);
  const port = output.match(/:(\d+)/)?.[1];
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /公开博主图片采集/);
});
