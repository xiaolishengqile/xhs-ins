import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBatchEntries } from "../../src/tasks/batch-input.js";

test("批量条目保留行号并对规范化链接去重", () => {
  const result = normalizeBatchEntries([
    { line: 2, url: "https://www.instagram.com/Test.User/" },
    { line: 3, url: "https://www.instagram.com/test.user/?igsh=abc" },
    { line: 4, url: "not-a-url" },
    { line: 5, url: "https://www.xiaohongshu.com/user/profile/user-1?xsec_token=temporary" },
  ]);

  assert.deepEqual(result.valid, [
    { line: 2, url: "https://www.instagram.com/test.user/" },
    { line: 5, url: "https://www.xiaohongshu.com/user/profile/user-1" },
  ]);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.rejected, [
    { line: 4, url: "not-a-url", reason: "请输入完整、安全的主页链接" },
  ]);
});

test("批量唯一链接不能超过五百条", () => {
  const entries = Array.from({ length: 501 }, (_value, index) => ({
    line: index + 1,
    url: `https://www.instagram.com/user_${index}/`,
  }));

  assert.throws(
    () => normalizeBatchEntries(entries),
    (error) => error.statusCode === 413 && /最多导入 500/.test(error.message),
  );
});

test("批量条目必须是数组", () => {
  assert.throws(() => normalizeBatchEntries(null), /批量链接格式无效/);
});
