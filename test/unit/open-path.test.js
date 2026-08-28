import test from "node:test";
import assert from "node:assert/strict";

import { openPath } from "../../src/system/open-path.js";

test("macOS 使用系统打开命令且路径作为独立参数传递", async () => {
  const calls = [];

  await openPath("/Users/test/Pictures/博主图片采集", {
    platform: "darwin",
    execFile: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [["open", ["/Users/test/Pictures/博主图片采集"]]]);
});
