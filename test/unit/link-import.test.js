import test from "node:test";
import assert from "node:assert/strict";

import { extractLinkEntries } from "../../src/import/link-file.js";

test("文本和逗号分隔内容会提取链接并保留原始行号", () => {
  const entries = extractLinkEntries([
    "姓名,链接",
    "甲,https://www.instagram.com/one/",
    "https://www.xiaohongshu.com/user/profile/two",
    "乙,https://www.instagram.com/three/,备注,https://www.instagram.com/four/",
  ].join("\n"));

  assert.deepEqual(entries, [
    { line: 2, url: "https://www.instagram.com/one/" },
    { line: 3, url: "https://www.xiaohongshu.com/user/profile/two" },
    { line: 4, url: "https://www.instagram.com/three/" },
    { line: 4, url: "https://www.instagram.com/four/" },
  ]);
});

test("空文件或不含链接的文件返回空列表", () => {
  assert.deepEqual(extractLinkEntries("姓名,账号\n甲,one"), []);
  assert.deepEqual(extractLinkEntries(null), []);
});
