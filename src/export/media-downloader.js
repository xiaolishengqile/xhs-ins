import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { mediaExtension, safeFileName } from "./file-names.js";

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

export async function downloadMedia(
  notes,
  taskDir,
  fetchBuffer,
  onProgress = async () => {},
  signal,
) {
  const result = structuredClone(notes);
  const uniqueUrls = new Set(result.flatMap((note) => note.media.map((item) => item.url)));
  const cached = new Map();
  let current = 0;

  for (const note of result) {
    const date = note.publishedAt?.slice(0, 10) ?? "未知日期";
    const folder = `${date}-${safeFileName(note.id)}`;
    for (let index = 0; index < note.media.length; index += 1) {
      throwIfAborted(signal);
      const media = note.media[index];
      if (cached.has(media.url)) {
        Object.assign(media, cached.get(media.url));
        continue;
      }

      const fileName = `${String(index + 1).padStart(2, "0")}${mediaExtension(media.url)}`;
      const localPath = path.posix.join("media", folder, fileName);
      try {
        const buffer = await fetchBuffer(media.url);
        throwIfAborted(signal);
        await mkdir(path.dirname(path.join(taskDir, localPath)), { recursive: true });
        await writeFile(path.join(taskDir, localPath), buffer);
        Object.assign(media, { localPath, error: null });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        Object.assign(media, { localPath: null, error: error instanceof Error ? error.message : String(error) });
      }
      cached.set(media.url, { localPath: media.localPath, error: media.error });
      current += 1;
      await onProgress({ current, total: uniqueUrls.size, imagesDownloaded: current });
    }
  }
  return result;
}
