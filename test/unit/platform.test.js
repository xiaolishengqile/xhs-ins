import test from "node:test";
import assert from "node:assert/strict";

import { detectPlatform, normalizeProfileUrl } from "../../src/domain/platform.js";

test("小红书主页链接会移除临时参数并保留用户编号", () => {
  assert.deepEqual(
    normalizeProfileUrl(
      "https://www.xiaohongshu.com/user/profile/5ae2cfe54eacab66ef5ae712?xsec_token=temp&xsec_source=pc_search",
    ),
    {
      platform: "xiaohongshu",
      url: "https://www.xiaohongshu.com/user/profile/5ae2cfe54eacab66ef5ae712",
      profileKey: "5ae2cfe54eacab66ef5ae712",
    },
  );
});

test("Instagram 主页链接会标准化用户名大小写与末尾斜杠", () => {
  assert.deepEqual(normalizeProfileUrl("https://instagram.com/OpenAI/"), {
    platform: "instagram",
    url: "https://www.instagram.com/openai/",
    profileKey: "openai",
  });
});

test("只接受两个平台的安全主页链接", () => {
  assert.equal(detectPlatform("https://www.xiaohongshu.com/user/profile/abc"), "xiaohongshu");
  assert.equal(detectPlatform("https://www.instagram.com/example/"), "instagram");

  for (const url of [
    "http://127.0.0.1/private",
    "https://www.xiaohongshu.com.evil.example/user/profile/abc",
    "https://www.instagram.com/p/post-id/",
    "ftp://www.instagram.com/example/",
  ]) {
    assert.throws(() => normalizeProfileUrl(url), /仅支持|主页|安全/);
  }
});
