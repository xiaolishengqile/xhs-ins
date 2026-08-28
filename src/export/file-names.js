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
    const parsed = new URL(url);
    const formatHint = `${parsed.pathname}${parsed.search}`.match(/(?:format[/=]|n)(jpe?g|png|webp|gif|avif)(?:\b|_)/i);
    if (formatHint) return `.${formatHint[1].toLowerCase().replace("jpeg", "jpg")}`;
    const match = parsed.pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (!match) return ".jpg";
    return `.${match[1].toLowerCase().replace("jpeg", "jpg")}`;
  } catch {
    return ".jpg";
  }
}
