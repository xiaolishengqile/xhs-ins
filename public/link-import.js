export function extractLinkEntries(text) {
  return String(text ?? "").split(/\r?\n/).flatMap((lineText, index) => {
    const matches = lineText.match(/https?:\/\/[^\s,"'<>]+/g) ?? [];
    return matches.map((url) => ({ line: index + 1, url: url.trim() }));
  });
}
