import { normalizeCount, normalizeNote } from "../../domain/note.js";

function* objects(root, seen = new Set()) {
  if (!root || typeof root !== "object" || seen.has(root)) return;
  seen.add(root);
  yield root;
  for (const value of Object.values(root)) {
    if (Array.isArray(value)) {
      for (const item of value) yield* objects(item, seen);
    } else {
      yield* objects(value, seen);
    }
  }
}

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric).toISOString();
}

function imageUrl(image) {
  const direct = image?.urlDefault ?? image?.url_default ?? image?.url;
  if (direct) return String(direct).replace(/^http:/, "https:");
  const info = image?.infoList ?? image?.info_list ?? [];
  const preferred = info.find((item) => (item.imageScene ?? item.image_scene) === "WB_DFT") ?? info.at(-1);
  return preferred?.url ? String(preferred.url).replace(/^http:/, "https:") : null;
}

function profileItem(value) {
  const card = value.noteCard ?? value.note_card ?? value;
  if (!card || typeof card !== "object") return null;
  const title = card.displayTitle ?? card.display_title ?? card.title;
  const publishedAt = timestamp(card.time ?? card.publishTime ?? card.publish_time ?? card.timestamp);
  const coverUrl = imageUrl(card.cover);
  if (!title && !publishedAt && !coverUrl) return null;
  const user = card.user ?? value.user ?? {};
  const interactions = card.interactInfo ?? card.interact_info ?? {};
  return {
    id: String(value.noteId ?? value.note_id ?? value.id ?? card.noteId ?? card.note_id ?? ""),
    token: String(value.xsecToken ?? value.xsec_token ?? card.xsecToken ?? card.xsec_token ?? ""),
    title: String(title ?? ""),
    publishedAt,
    type: card.type === "video" ? "video" : "image",
    author: String(user.nickname ?? user.nickName ?? user.nick_name ?? ""),
    authorId: String(user.userId ?? user.user_id ?? ""),
    likeCount: normalizeCount(interactions.likedCount ?? interactions.liked_count),
    pinned: Boolean(interactions.sticky ?? value.sticky),
    coverUrl,
  };
}

export function parseProfilePayload(payload) {
  const items = [];
  const keys = new Set();
  for (const value of objects(payload)) {
    if (!(value.noteCard || value.note_card)) continue;
    const item = profileItem(value);
    if (!item) continue;
    const key = item.id || `${item.title}|${item.publishedAt}`;
    if (keys.has(key)) continue;
    keys.add(key);
    items.push(item);
  }

  if (items.length === 0) {
    for (const value of objects(payload)) {
      const item = profileItem(value);
      if (!item?.id) continue;
      const key = item.id;
      if (keys.has(key)) continue;
      keys.add(key);
      items.push(item);
    }
  }

  items.sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));
  const author = items.find((item) => item.author)?.author ?? "";
  return { author, items };
}

function findDetailCard(payload) {
  for (const value of objects(payload)) {
    const card = value.noteCard ?? value.note_card ?? value;
    const hasId = card?.noteId ?? card?.note_id ?? value.noteId ?? value.note_id;
    const hasContent = card?.imageList || card?.image_list || card?.cover || card?.interactInfo || card?.interact_info;
    if (hasId && hasContent) return card;
  }
  return null;
}

export function parseNotePayload(payload, url) {
  const card = findDetailCard(payload);
  if (!card) return null;
  const id = card.noteId ?? card.note_id ?? card.id;
  const user = card.user ?? {};
  const interactions = card.interactInfo ?? card.interact_info ?? {};
  const type = card.type === "video" ? "video" : "image";
  const images = (card.imageList ?? card.image_list ?? []).map(imageUrl).filter(Boolean);
  const coverUrl = imageUrl(card.cover);
  const mediaUrls = type === "video" ? [coverUrl ?? images[0]].filter(Boolean) : images;
  const title = card.title ?? card.displayTitle ?? card.display_title ?? String(card.desc ?? "").split("\n")[0];

  return normalizeNote({
    platform: "xiaohongshu",
    id,
    type,
    author: user.nickname ?? user.nickName ?? user.nick_name ?? "",
    title,
    publishedAt: timestamp(card.time ?? card.publishTime ?? card.publish_time ?? card.timestamp),
    url,
    metrics: {
      likeCount: interactions.likedCount ?? interactions.liked_count,
      favoriteCount: interactions.collectedCount ?? interactions.collected_count,
      commentCount: interactions.commentCount ?? interactions.comment_count,
    },
    media: [...new Set(mediaUrls)].map((mediaUrl) => ({
      url: mediaUrl,
      type: type === "video" ? "video-cover" : "image",
    })),
  });
}
