import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("云平台可以通过默认导出处理网页请求", async (t) => {
  const script = `
    import { createServer } from "node:http";
    import handler from "./src/server.js";
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, VERCEL: "1", COLLECTOR_HEADLESS: "1" },
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

  const port = output.trim();
  assert.match(port, /^\d+$/);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /公开博主图片采集/);
});
