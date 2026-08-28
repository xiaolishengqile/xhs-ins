import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";

import { toCsv } from "./csv.js";
import { safeFileName } from "./file-names.js";

export async function createTaskArchive(task, notes, taskDir) {
  await mkdir(taskDir, { recursive: true });
  const archivePath = path.join(taskDir, "result.zip");
  const rootName = safeFileName(
    `${task.platform}-${task.author ?? task.profileKey ?? "博主"}-${task.from.slice(0, 10)}-${task.to.slice(0, 10)}`,
  );
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(toCsv(notes), "utf8"), `${rootName}/notes.csv`);

  for (const note of notes) {
    for (const media of note.media ?? []) {
      if (!media.localPath) continue;
      const absolutePath = path.resolve(taskDir, media.localPath);
      if (!absolutePath.startsWith(`${path.resolve(taskDir)}${path.sep}`)) continue;
      const archiveMediaPath = media.localPath.replace(/^media[\\/]/, "images/").replaceAll(path.sep, "/");
      zip.addFile(absolutePath, `${rootName}/${archiveMediaPath}`);
    }
  }

  const output = createWriteStream(archivePath);
  const writing = pipeline(zip.outputStream, output);
  zip.end();
  await writing;
  return archivePath;
}
