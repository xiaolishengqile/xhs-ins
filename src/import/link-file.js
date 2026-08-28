import path from "node:path";

import { readSelectedZipEntries } from "./zip-reader.js";

const TEXT_EXTENSIONS = new Set([".txt", ".csv"]);
const LINK_PATTERN = /https?:\/\/[^\s,"'<>]+/gi;

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanUrl(value) {
  return value.trim().replace(/[，。；：！？、)\]}]+$/u, "");
}

export function extractLinkEntries(text) {
  return String(text ?? "").split(/\r?\n/).flatMap((lineText, index) => {
    const matches = lineText.match(LINK_PATTERN) ?? [];
    return matches.map((url) => ({ line: index + 1, url: cleanUrl(url) }));
  });
}

function textFromWordXml(xml) {
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi)];
  return paragraphs.map((paragraph) => [...paragraph[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)]
    .map((match) => decodeXml(match[1]))
    .join(""))
    .join("\n");
}

function linksFromRelationships(xml, startLine) {
  const entries = [];
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[1];
    const type = attributes.match(/\bType=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
    const target = attributes.match(/\bTarget=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
    if (type?.endsWith("/hyperlink") && target && /^https?:\/\//i.test(decodeXml(target))) {
      entries.push({ line: startLine + entries.length, url: cleanUrl(decodeXml(target)) });
    }
  }
  return entries;
}

function extractDocxEntries(buffer) {
  const parts = readSelectedZipEntries(buffer, (name) =>
    /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name) || /^word\/_rels\/.+\.rels$/i.test(name),
  );
  if (!parts.has("word/document.xml")) {
    const error = new Error("文档文件已损坏或不是有效的文档");
    error.statusCode = 400;
    throw error;
  }
  const textParts = [...parts]
    .filter(([name]) => name.endsWith(".xml"))
    .map(([, body]) => textFromWordXml(body.toString("utf8")));
  const textEntries = extractLinkEntries(textParts.join("\n"));
  const relationshipEntries = [...parts]
    .filter(([name]) => name.endsWith(".rels"))
    .flatMap(([, body]) => linksFromRelationships(body.toString("utf8"), textEntries.length + 1));
  return [...textEntries, ...relationshipEntries];
}

export function extractLinkEntriesFromFile({ buffer, fileName }) {
  const extension = path.extname(String(fileName ?? "")).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return extractLinkEntries(buffer.toString("utf8"));
  if (extension === ".docx") return extractDocxEntries(buffer);
  const error = new Error("仅支持文本、逗号分隔文件和 .docx 文档");
  error.statusCode = 415;
  throw error;
}
