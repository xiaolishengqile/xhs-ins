import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { controlBackground, discardStartError, getBackgroundStatus, stopBackground } from "./client.js";
import { defaultBackgroundDataDir, ensureBackgroundDir, takeStartError } from "./state.js";

const workerFile = fileURLToPath(new URL("./worker.js", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      "output-dir": { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "4310" },
      timeout: { type: "string", default: "30000" },
      json: { type: "boolean", default: false },
    },
  });
  const port = Number(values.port);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须是 0 到 65535 的整数");
  if (!Number.isFinite(timeout) || timeout < 100) throw new Error("等待时间必须不少于 100 毫秒");
  if (!["127.0.0.1", "localhost"].includes(values.host)) throw new Error("后台服务仅允许监听本机地址");
  return {
    command: positionals[0],
    dataDir: path.resolve(values["data-dir"] ?? defaultBackgroundDataDir()),
    outputDir: values["output-dir"] ? path.resolve(values["output-dir"]) : undefined,
    host: values.host,
    port,
    timeout,
    json: values.json,
  };
}

function print(io, options, value, message) {
  io.stdout.write(`${options.json ? JSON.stringify(value) : message}\n`);
}

async function waitForStart(options, launchId) {
  const deadline = Date.now() + options.timeout;
  while (Date.now() < deadline) {
    const error = await takeStartError(options.dataDir, launchId);
    if (error) throw new Error(error.error);
    const status = await getBackgroundStatus(options.dataDir, { timeout: 250 });
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待后台服务就绪超时，请查看后台错误日志");
}

async function start(options) {
  const current = await getBackgroundStatus(options.dataDir);
  if (current) return { ...current, alreadyRunning: true };
  await ensureBackgroundDir(options.dataDir);
  const launchId = randomBytes(10).toString("hex");
  await discardStartError(options.dataDir, launchId);
  const args = [
    workerFile,
    "--data-dir", options.dataDir,
    "--host", options.host,
    "--port", String(options.port),
    "--launch-id", launchId,
  ];
  if (options.outputDir) args.push("--output-dir", options.outputDir);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return waitForStart(options, launchId);
}

export async function runBackgroundCli(argv = process.argv.slice(2), io = process) {
  const options = parseOptions(argv);
  if (options.command === "start") {
    const status = await start(options);
    print(io, options, status, status.alreadyRunning ? `后台服务已在运行：${status.url}` : `后台服务已启动：${status.url}`);
    return 0;
  }
  if (options.command === "status") {
    const status = await getBackgroundStatus(options.dataDir);
    if (!status) throw new Error("后台服务未运行");
    print(io, options, status, `后台服务运行中：${status.url}`);
    return 0;
  }
  if (options.command === "stop") {
    const stopped = await stopBackground(options.dataDir, { timeout: options.timeout });
    if (!stopped) throw new Error("后台服务未运行");
    print(io, options, { stopped: true }, "后台服务已停止");
    return 0;
  }
  if (["pause", "resume"].includes(options.command)) {
    const status = await controlBackground(options.dataDir, options.command, { timeout: options.timeout });
    const message = options.command === "pause" ? "后台采集已暂停" : "后台采集已继续";
    print(io, options, status, message);
    return 0;
  }
  throw new Error("用法：node scripts/background.js <start|status|pause|resume|stop> [选项]");
}
