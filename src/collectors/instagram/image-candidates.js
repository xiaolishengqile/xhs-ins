function candidate(url, width = 0, height = null) {
  if (!url) return null;
  const numericHeight = height === null || height === undefined ? null : Number(height);
  return {
    url: String(url),
    width: Number.isFinite(Number(width)) ? Number(width) : 0,
    height: Number.isFinite(numericHeight) ? numericHeight : null,
  };
}

function srcsetCandidates(value) {
  return String(value ?? "")
    .split(/,\s*(?=https?:\/\/)/)
    .map((entry) => entry.trim().match(/^(\S+)(?:\s+(\d+)w)?$/))
    .map((match) => match && candidate(match[1], match[2]))
    .filter(Boolean);
}

function candidatesForImage(image) {
  if (typeof image === "string") return [candidate(image)];
  if (!image || typeof image !== "object") return [];
  return [
    ...srcsetCandidates(image.srcset),
    candidate(image.currentSrc, image.naturalWidth, image.naturalHeight),
    candidate(image.src, image.naturalWidth, image.naturalHeight),
  ].filter(Boolean);
}

function identity(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function selectLargestImageCandidates(images) {
  const selected = new Map();
  for (const image of images ?? []) {
    for (const item of candidatesForImage(image)) {
      const key = identity(item.url);
      const existing = selected.get(key);
      if (!existing || item.width > existing.width) selected.set(key, item);
    }
  }
  return [...selected.values()];
}
