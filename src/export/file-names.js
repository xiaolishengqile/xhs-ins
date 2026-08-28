export function safeFileName(value, fallback = "未命名") {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function mediaExtension(url) {
  try {
    const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (!match) return ".jpg";
    return `.${match[1].toLowerCase().replace("jpeg", "jpg")}`;
  } catch {
    return ".jpg";
  }
}
