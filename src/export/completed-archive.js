import { stat } from "node:fs/promises";
import yazl from "yazl";

import { safeFileName } from "./file-names.js";

export async function createCompletedArchive(tasks) {
  const zip = new yazl.ZipFile();
  const included = [];
  const missing = [];
  const completed = tasks.filter((task) => task.status === "completed" && task.resultPath);

  for (const task of completed) {
    const fileName = `${safeFileName(`${task.platform}-${task.author ?? task.profileKey ?? "博主"}-${task.id}`)}.zip`;
    try {
      await stat(task.resultPath);
      zip.addFile(task.resultPath, `results/${fileName}`);
      included.push({
        id: task.id,
        platform: task.platform,
        author: task.author ?? task.profileKey ?? null,
        fileName,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push({
        id: task.id,
        platform: task.platform,
        author: task.author ?? task.profileKey ?? null,
        reason: "结果文件不存在",
      });
    }
  }

  if (included.length === 0) {
    const error = new Error("当前没有可下载的已完成任务");
    error.statusCode = 409;
    throw error;
  }

  zip.addBuffer(
    Buffer.from(`${JSON.stringify({ included, missing }, null, 2)}\n`, "utf8"),
    "manifest.json",
  );
  zip.end();
  return { outputStream: zip.outputStream, included, missing };
}
