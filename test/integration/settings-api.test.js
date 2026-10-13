import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "../../src/http/app.js";
import { startServer } from "../../src/http/server.js";
import { createRuntime } from "../../src/server.js";
import { eventually } from "../helpers/eventually.js";

async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), "collector-settings-"));
  const dataDir = path.join(temp, "data");
  const runtime = await createRuntime({ dataDir });
  const stops = [];
  const instance = await startServer({
    handler: createApp({
      manager: runtime.manager,
      controller: runtime.controller,
      requestStop: () => { stops.push("stop"); },
    }),
    port: 0,
  });
  t.after(async () => {
    await instance.close();
    await runtime.close();
    await rm(temp, { recursive: true, force: true });
  });
  return { ...instance, temp, dataDir, runtime, stops };
}

test("网页设置保留运行中的真实目录，并在下一次启动应用新目录", async (t) => {
  const { url, temp, dataDir, runtime } = await fixture(t);
  const nextOutputDir = path.join(temp, "新图片目录");
  const currentOutputDir = runtime.controller.outputDir;
  const initial = await (await fetch(`${url}/api/settings`)).json();
  assert.equal(initial.preset, "year");
  assert.equal(initial.actualOutputDir, currentOutputDir);
  assert.equal(initial.dataDir, path.resolve(dataDir));

  const savedResponse = await fetch(`${url}/api/settings`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "month", outputDir: nextOutputDir }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.preset, "month");
  assert.equal(saved.outputDir, nextOutputDir);
  assert.equal(saved.actualOutputDir, currentOutputDir);
  assert.equal(saved.imageDelaySeconds, 0.5);
  assert.equal(saved.bloggerGapSeconds, 30);

  const throttled = await (await fetch(`${url}/api/settings`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "month", outputDir: nextOutputDir, imageDelaySeconds: 2, bloggerGapSeconds: 120, dailyBloggerLimit: 20 }),
  })).json();
  assert.equal(throttled.dailyBloggerLimit, 20);
  assert.deepEqual(runtime.manager.throttle, { imageDelayMs: 2000, bloggerGapMs: 120_000, dailyLimit: 20 });

  const restarted = await createRuntime({ dataDir });
  t.after(() => restarted.close());
  assert.equal(restarted.controller.outputDir, nextOutputDir);
});

test("设置拒绝无效周期和相对目录，不覆盖上次保存", async (t) => {
  const { url } = await fixture(t);
  for (const bad of [
    { preset: "forever", outputDir: "" },
    { preset: "week", outputDir: "relative/pictures" },
    { preset: "week", outputDir: "", imageDelaySeconds: -1 },
    { preset: "week", outputDir: "", dailyBloggerLimit: "很多" },
  ]) {
    const response = await fetch(`${url}/api/settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(bad),
    });
    assert.equal(response.status, 400);
  }
  const settings = await (await fetch(`${url}/api/settings`)).json();
  assert.equal(settings.preset, "year");
  assert.equal(settings.outputDir, "");
});

test("安全停止先响应网页，随后触发后台关闭；外部来源不能发起停止", async (t) => {
  const { url, stops } = await fixture(t);
  const denied = await fetch(`${url}/api/control/stop`, {
    method: "POST", headers: { origin: "https://other.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal(stops.length, 0);

  const response = await fetch(`${url}/api/control/stop`, { method: "POST", headers: { origin: url } });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { stopping: true });
  await eventually(() => assert.deepEqual(stops, ["stop"]));
});
