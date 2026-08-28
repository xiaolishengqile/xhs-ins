import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBuffer, readJson } from "./body.js";
import { createCompletedArchive } from "../export/completed-archive.js";
import { extractLinkEntriesFromFile } from "../import/link-file.js";

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function sendJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function statusForError(error) {
  if (error.statusCode) return error.statusCode;
  if (error.message === "任务不存在") return 404;
  if (/只有|不需要人工恢复/.test(error.message)) return 409;
  return 400;
}

async function sendStatic(response, publicDir, pathname) {
  const target = STATIC_FILES.get(pathname);
  if (!target) return false;
  try {
    const body = await readFile(path.join(publicDir, target[0]));
    response.writeHead(200, {
      "content-type": target[1],
      "content-length": body.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sendJson(response, 404, { error: "页面不存在" });
  }
  return true;
}

async function handleRequest(request, response, { manager, publicDir }) {
  const url = new URL(request.url, "http://127.0.0.1");
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, { status: "ok", maxConcurrency: manager.maxConcurrency });
  }
  if (request.method === "GET" && pathname === "/api/tasks") {
    return sendJson(response, 200, { tasks: manager.list() });
  }
  if (request.method === "GET" && pathname === "/api/control") {
    return sendJson(response, 200, manager.controlStatus());
  }
  if (request.method === "POST" && pathname === "/api/link-files/parse") {
    let fileName;
    try {
      fileName = decodeURIComponent(String(request.headers["x-file-name"] ?? ""));
    } catch {
      const error = new Error("文件名格式无效");
      error.statusCode = 400;
      throw error;
    }
    const entries = extractLinkEntriesFromFile({
      buffer: await readBuffer(request, 10 * 1024 * 1024),
      fileName,
    });
    return sendJson(response, 200, { entries });
  }
  if (request.method === "POST" && pathname === "/api/control/pause") {
    return sendJson(response, 200, await manager.pauseAll());
  }
  if (request.method === "POST" && pathname === "/api/control/resume") {
    return sendJson(response, 200, await manager.resumeAll());
  }
  if (request.method === "GET" && pathname === "/api/tasks/download-completed") {
    const archive = await createCompletedArchive(manager.list());
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="completed-tasks.zip"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    archive.outputStream.once("error", (error) => response.destroy(error));
    archive.outputStream.pipe(response);
    return;
  }
  if (request.method === "POST" && pathname === "/api/tasks") {
    const task = await manager.create(await readJson(request));
    return sendJson(response, 202, { task });
  }
  if (request.method === "POST" && pathname === "/api/tasks/batch") {
    const result = await manager.createBatch(await readJson(request));
    return sendJson(response, 202, { ...result, control: manager.controlStatus() });
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)(?:\/(cancel|retry|resume|download))?$/i);
  if (taskMatch) {
    const [, id, action] = taskMatch;
    const task = manager.get(id);
    if (!task) return sendJson(response, 404, { error: "任务不存在" });
    if (!action && request.method === "GET") return sendJson(response, 200, { task });
    if (!action && request.method === "DELETE") {
      await manager.delete(id);
      return sendJson(response, 200, { deleted: true });
    }
    if (["cancel", "retry", "resume"].includes(action) && request.method === "POST") {
      const updated = await manager[action](id);
      return sendJson(response, 200, { task: updated });
    }
    if (action === "download" && request.method === "GET") {
      if (task.status !== "completed" || !task.resultPath) {
        return sendJson(response, 409, { error: "任务尚未生成可下载结果" });
      }
      try {
        const details = await stat(task.resultPath);
        response.writeHead(200, {
          "content-type": "application/zip",
          "content-length": details.size,
          "content-disposition": `attachment; filename="result-${task.id}.zip"`,
          "x-content-type-options": "nosniff",
        });
        createReadStream(task.resultPath).pipe(response);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        sendJson(response, 404, { error: "结果文件不存在，请重试任务" });
      }
      return;
    }
  }

  if (request.method === "GET" && (await sendStatic(response, publicDir, pathname))) return;
  sendJson(response, 404, { error: "请求地址不存在" });
}

export function createApp({ manager, publicDir = DEFAULT_PUBLIC_DIR }) {
  return (request, response) => {
    handleRequest(request, response, { manager, publicDir }).catch((error) => {
      if (!response.headersSent) sendJson(response, statusForError(error), { error: error.message || "请求失败" });
      else response.destroy(error);
    });
  };
}
