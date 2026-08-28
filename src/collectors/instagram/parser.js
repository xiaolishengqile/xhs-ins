import { normalizeCount, normalizeNote } from "../../domain/note.js";

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3]);
  }
  return result;
}

function metadata(html) {
  const result = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = attrs.property ?? attrs.name;
    if (key && attrs.content) result.set(key.toLowerCase(), attrs.content);
  }
  return result;
}

function structuredData(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(decodeHtml(match[1]).trim());
      const candidates = Array.isArray(value) ? value : [value, ...(value["@graph"] ?? [])];
      const found = candidates.find((item) => item?.uploadDate || item?.dateCreated || item?.contentUrl);
      if (found) return found;
    } catch {
      // Ignore malformed third-party structured data and fall back to visible metadata.
    }
  }
  return {};
}

function metric(description, names) {
  const namePattern = names.join("|");
  const match = description.match(new RegExp(`([\\d,.万亿]+)\\s*(?:${namePattern})`, "i"));
  return normalizeCount(match?.[1]);
}

function postId(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/(?:p|reel)\/([^/]+)/);
  if (!match) throw new Error("帖子链接格式无效");
  return match[1];
}

export function parseInstagramPostHtml(html, url) {
  const meta = metadata(html);
  const structured = structuredData(html);
  const description = meta.get("og:description") ?? "";
  const titleMeta = meta.get("og:title") ?? "";
  const author = String(
    structured.author?.alternateName ?? titleMeta.match(/\(@([^)]+)\)/)?.[1] ?? structured.author?.name ?? "",
  ).replace(/^@/, "");
  const publishedAt =
    structured.uploadDate ??
    structured.dateCreated ??
    html.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] ??
    null;
  const title = structured.caption ?? description.match(/:\s*["“]([\s\S]*?)["”]\s*$/)?.[1] ?? "";
  const mediaUrl = structured.contentUrl ?? structured.thumbnailUrl ?? meta.get("og:image");

  return normalizeNote({
    platform: "instagram",
    id: postId(url),
    type: new URL(url).pathname.startsWith("/reel/") ? "video" : "image",
    author,
    title,
    publishedAt,
    url,
    metrics: {
      likeCount: metric(description, ["likes?", "个赞", "次赞"]),
      favoriteCount: null,
      commentCount: metric(description, ["comments?", "条评论", "评论"]),
    },
    media: mediaUrl
      ? [{ url: mediaUrl, type: new URL(url).pathname.startsWith("/reel/") ? "video-cover" : "image" }]
      : [],
  });
}
