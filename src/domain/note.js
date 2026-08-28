function nullableCount(value) {
  const normalized = normalizeCount(value);
  return normalized === null ? null : normalized;
}

export function normalizeCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const match = value.trim().replaceAll(",", "").match(/^(\d+(?:\.\d+)?)\s*(万|亿|[kKmM])?$/);
  if (!match) return null;
  const multiplier = { 万: 10_000, 亿: 100_000_000, k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000 }[
    match[2]
  ] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

export function normalizeNote(raw) {
  if (!raw?.platform || !raw?.id || !raw?.url) throw new Error("笔记缺少必要字段");
  return {
    platform: raw.platform,
    id: String(raw.id),
    type: raw.type === "video" ? "video" : "image",
    author: raw.author ? String(raw.author) : "",
    title: raw.title ? String(raw.title) : "",
    publishedAt: raw.publishedAt ? new Date(raw.publishedAt).toISOString() : null,
    url: String(raw.url),
    metrics: {
      likeCount: nullableCount(raw.metrics?.likeCount),
      favoriteCount: nullableCount(raw.metrics?.favoriteCount),
      commentCount: nullableCount(raw.metrics?.commentCount),
    },
    media: (raw.media ?? []).map((item) => ({
      url: String(item.url),
      type: item.type === "video-cover" ? "video-cover" : "image",
      localPath: item.localPath ?? null,
      error: item.error ?? null,
    })),
    error: raw.error ?? null,
  };
}
