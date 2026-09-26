import test from "node:test";
import assert from "node:assert/strict";

import { defaultPicturesDirectory } from "../../src/system/pictures-directory.js";

test("微软系统优先使用系统返回的重定向图片目录", async () => {
  const directory = await defaultPicturesDirectory({
    platform: "win32",
    home: "C:\\Users\\sample",
    run: async () => ({ stdout: "D:\\照片\\我的图片\r\n" }),
  });
  assert.equal(directory, "D:\\照片\\我的图片\\博主图片采集");
});

test("系统图片目录检查失败时回退到用户目录", async () => {
  const directory = await defaultPicturesDirectory({
    platform: "win32",
    home: "C:\\Users\\sample",
    run: async () => { throw new Error("PowerShell 不可用"); },
  });
  assert.equal(directory, "C:\\Users\\sample\\Pictures\\博主图片采集");
});
