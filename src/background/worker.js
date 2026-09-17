import { chmod, rm } from "node:fs/promises";
import os from "node:os";
import { parseArgs } from "node:util";

import { createApp } from "../http/app.js";
import { startServer } from "../http/server.js";
import { createRuntime } from "../server.js";
import { startControlServer } from "./control.js";
import { createBoundedLogger } from "./logger.js";
import {
  acquireInstanceLock,
  backgroundPaths,
  createInstanceToken,
  releaseInstanceLock,
  removeStateIfOwned,
  writePrivateJson,
  writeStartError,
} from "./state.js";

function workerOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      "output-dir": { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "4310" },
      "launch-id": { type: "string" },
    },
  });
  return {
    dataDir: values["data-dir"],
    outputDir: values["output-dir"],
    host: values.host,
    port: Number(values.port),
    launchId: values["launch-id"],
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeOwnedConnections?.();
  });
}

export async function runWorker(argv = process.argv.slice(2)) {
  const options = workerOptions(argv);
  if (!options.dataDir) throw new Error("缺少后台数据目录");
  const token = createInstanceToken();
  const paths = backgroundPaths(options.dataDir, token);
  const logger = createBoundedLogger(paths);
  logger.install();
  let lock;
  let runtime;
  let web;
  let control;
  let stopping = false;
  let stoppingPromise;
  let exiting = false;

  function stopResources() {
    stopping = true;
    stoppingPromise ??= (async () => {
      await web?.close();
      await runtime?.close();
      await removeStateIfOwned(paths, token);
      if (lock) await releaseInstanceLock(paths, token);
    })();
    return stoppingPromise;
  }

  async function finishExit(exitCode = 0) {
    if (exiting) return;
    exiting = true;
    await closeServer(control).catch((error) => logger.error(error));
    if (process.platform !== "win32") await rm(paths.endpoint, { force: true }).catch(() => {});
    await logger.info("后台服务已停止");
    await logger.flush();
    process.exit(exitCode);
  }

  async function shutdownFromSignal() {
    if (stopping) return;
    stopping = true;
    await closeServer(control).catch((error) => logger.error(error));
    await stopResources().catch((error) => logger.error(error));
    await finishExit(0);
  }

  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    await logger.info("无法降低进程优先级，继续运行：", error.message);
  }

  try {
    lock = await acquireInstanceLock(options.dataDir, token);
    let appHandler = (_request, response) => {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":"后台服务正在启动"}');
    };
    web = await startServer({
      handler: (request, response) => appHandler(request, response),
      host: options.host,
      port: options.port,
    });
    runtime = await createRuntime({ dataDir: options.dataDir, outputDir: options.outputDir });
    appHandler = createApp({ manager: runtime.manager, controller: runtime.controller });
    const baseStatus = {
      running: true,
      pid: process.pid,
      url: web.url,
      startedAt: new Date().toISOString(),
    };
    const status = () => ({ ...baseStatus, paused: runtime.manager.controlStatus().paused, stopping });
    control = await startControlServer({
      endpoint: paths.endpoint,
      token,
      status,
      onPause: () => runtime.controller.pauseAll(),
      onResume: () => runtime.controller.resumeAll(),
      onStop: stopResources,
      afterStop: () => { void finishExit(0); },
    });
    if (process.platform !== "win32") await chmod(paths.endpoint, 0o600);
    await writePrivateJson(paths.stateFile, { ...status(), endpoint: paths.endpoint, token });
    await logger.info(`后台服务已启动：${web.url}`);
    process.once("SIGINT", () => { void shutdownFromSignal(); });
    process.once("SIGTERM", () => { void shutdownFromSignal(); });
  } catch (error) {
    await logger.error(error);
    await writeStartError(options.dataDir, options.launchId, error).catch(() => {});
    if (control) await closeServer(control).catch(() => {});
    await web?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    await removeStateIfOwned(paths, token).catch(() => {});
    if (lock) await releaseInstanceLock(paths, token).catch(() => {});
    await logger.flush();
    process.exit(1);
  }
}

runWorker().catch(() => process.exit(1));
