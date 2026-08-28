import { normalizeProfileUrl } from "../domain/platform.js";

export const MAX_BATCH_LINKS = 500;

export function normalizeBatchEntries(entries, { maxUnique = MAX_BATCH_LINKS } = {}) {
  if (!Array.isArray(entries)) throw new Error("批量链接格式无效");
  const seen = new Set();
  const valid = [];
  const rejected = [];
  let duplicates = 0;

  for (const [index, entry] of entries.entries()) {
    const line = Number.isInteger(entry?.line) && entry.line > 0 ? entry.line : index + 1;
    const rawUrl = String(entry?.url ?? "").trim();
    try {
      const profile = normalizeProfileUrl(rawUrl);
      if (seen.has(profile.url)) {
        duplicates += 1;
        continue;
      }
      if (seen.size >= maxUnique) {
        const error = new Error(`单次最多导入 ${maxUnique} 个唯一链接`);
        error.statusCode = 413;
        throw error;
      }
      seen.add(profile.url);
      valid.push({ line, url: profile.url });
    } catch (error) {
      if (error.statusCode === 413) throw error;
      rejected.push({
        line,
        url: rawUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { valid, rejected, duplicates };
}
