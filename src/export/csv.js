const HEADERS = [
  "平台",
  "笔记编号",
  "博主",
  "标题",
  "发布时间",
  "原文链接",
  "点赞数",
  "收藏数",
  "评论数",
  "图片数量",
  "图片路径",
  "错误",
];

function cell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(notes) {
  const rows = notes.map((note) => [
    note.platform,
    note.id,
    note.author,
    note.title,
    note.publishedAt,
    note.url,
    note.metrics?.likeCount,
    note.metrics?.favoriteCount,
    note.metrics?.commentCount,
    note.media?.length ?? 0,
    (note.media ?? []).map((item) => item.localPath).filter(Boolean).join(";"),
    note.error ?? (note.media ?? []).map((item) => item.error).filter(Boolean).join(";"),
  ]);
  return `\ufeff${[HEADERS, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
