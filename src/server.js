import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createApp } from "./http/app.js";
import { BrowserManager } from "./browser/browser-manager.js";
import { createCollectorFactory } from "./collectors/collector-factory.js";
import { InstagramCollector } from "./collectors/instagram/collector.js";
import { XiaohongshuCollector } from "./collectors/xiaohongshu/collector.js";
import { LocalImageStore } from "./export/local-image-store.js";
import { startServer } from "./http/server.js";
import { TaskManager } from "./tasks/task-manager.js";
import { TaskStore } from "./tasks/task-store.js";
import { SchedulerStateStore } from "./tasks/scheduler-state-store.js";
import { ApplicationController } from "./application/controller.js";

function defaultDataDir() {
  return process.env.VERCEL === "1" ? path.join(tmpdir(), "xhs-ins") : path.resolve(".data");
}

function defaultOutputDir() {
  return path.join(homedir(), "Pictures", "博主图片采集");
}

export async function createRuntime({ dataDir = defaultDataDir(), outputDir = defaultOutputDir() } = {}) {
  await mkdir(dataDir, { recursive: true });
  const store = new TaskStore(path.join(dataDir, "tasks"));
  const controlStore = new SchedulerStateStore(path.join(dataDir, "scheduler.json"));
  const browserManager = new BrowserManager({ profilesDir: path.join(dataDir, "browser-profiles") });
  const collectorFactory = createCollectorFactory({
    browserManager,
    collectors: { xiaohongshu: XiaohongshuCollector, instagram: InstagramCollector },
  });
  const imageStore = new LocalImageStore({
    rootDir: outputDir,
    indexDir: path.join(dataDir, "output-index"),
  });
  const manager = new TaskManager({
    store,
    controlStore,
    collectorFactory,
    taskSessionFactory: (task) => browserManager.createTaskSession(task.platform, task.id),
    exporter: async (task, notes, _taskDir, { signal, onProgress, browserSession }) => {
      const saved = await imageStore.save(task, notes, {
        fetchBuffer: (url) => browserSession.fetchBuffer(url),
        onProgress: (progress) => onProgress({ ...progress, stage: "下载图片" }),
        signal,
      });
      return saved.directory;
    },
  });
  await manager.init();
  const controller = new ApplicationController({ manager, browserManager, outputDir });
  return {
    manager,
    browserManager,
    controller,
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
  cloudHandler ??= createApp({ manager: runtime.manager, controller: runtime.controller });
  return cloudHandler(request, response);
}

export async function main() {
  const runtime = await createRuntime();
  const instance = await startServer({ handler: createApp({ manager: runtime.manager, controller: runtime.controller }) });
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
