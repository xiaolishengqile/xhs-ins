import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createApp } from "./app.js";
import { BrowserManager } from "./browser/browser-manager.js";
import { createCollectorFactory } from "./collectors/collector-factory.js";
import { InstagramCollector } from "./collectors/instagram/collector.js";
import { XiaohongshuCollector } from "./collectors/xiaohongshu/collector.js";
import { createTaskArchive } from "./export/archive.js";
import { downloadMedia } from "./export/media-downloader.js";
import { startServer } from "./http/server.js";
import { TaskManager } from "./tasks/task-manager.js";
import { TaskStore } from "./tasks/task-store.js";

function defaultDataDir() {
  return process.env.VERCEL === "1" ? path.join(tmpdir(), "xhs-ins") : path.resolve(".data");
}

export async function createRuntime({ dataDir = defaultDataDir() } = {}) {
  await mkdir(dataDir, { recursive: true });
  const store = new TaskStore(path.join(dataDir, "tasks"));
  const browserManager = new BrowserManager({ profilesDir: path.join(dataDir, "browser-profiles") });
  const collectorFactory = createCollectorFactory({
    browserManager,
    collectors: { xiaohongshu: XiaohongshuCollector, instagram: InstagramCollector },
  });
  const manager = new TaskManager({
    store,
    collectorFactory,
    exporter: async (task, notes, taskDir, { signal, onProgress }) => {
      const downloaded = await downloadMedia(
        notes,
        taskDir,
        (url) => browserManager.fetchBuffer(task.platform, url),
        (progress) => onProgress({ ...progress, stage: "下载图片" }),
        signal,
      );
      await writeFile(path.join(taskDir, "notes.json"), `${JSON.stringify(downloaded, null, 2)}\n`, "utf8");
      return createTaskArchive(task, downloaded, taskDir);
    },
  });
  await manager.init();
  return {
    manager,
    browserManager,
    close: async () => {
      await manager.shutdown();
      await browserManager.close();
    },
  };
}

export async function main() {
  const runtimePromise = createRuntime();
  let handler;
  const cloud = process.env.VERCEL === "1";
  const instance = await startServer({
    handler: (request, response) => {
      runtimePromise.then((runtime) => {
        handler ??= createApp({ manager: runtime.manager });
        handler(request, response);
      }).catch((error) => response.destroy(error));
    },
    host: cloud ? "0.0.0.0" : "127.0.0.1",
    port: Number(process.env.PORT ?? 4310),
  });
  const runtime = await runtimePromise;
  console.log(`博主图片采集工具已启动：${instance.url}`);
  const shutdown = async () => {
    await instance.close();
    await runtime.close();
  };
  process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  return { ...instance, runtime };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint || process.env.VERCEL === "1") {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
