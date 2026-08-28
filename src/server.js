import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createApp } from "./http/app.js";
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
    taskSessionFactory: (task) => browserManager.createTaskSession(task.platform, task.id),
    exporter: async (task, notes, taskDir, { signal, onProgress, browserSession }) => {
      const downloaded = await downloadMedia(
        notes,
        taskDir,
        (url) => browserSession.fetchBuffer(url),
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

let cloudRuntimePromise;
let cloudHandler;

export default async function handleCloudRequest(request, response) {
  cloudRuntimePromise ??= createRuntime();
  const runtime = await cloudRuntimePromise;
  cloudHandler ??= createApp({ manager: runtime.manager });
  return cloudHandler(request, response);
}

export async function main() {
  const runtime = await createRuntime();
  const instance = await startServer({ handler: createApp({ manager: runtime.manager }) });
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
if (isEntrypoint && process.env.VERCEL !== "1") {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
