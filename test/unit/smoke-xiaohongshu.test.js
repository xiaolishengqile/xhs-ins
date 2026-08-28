import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { extractInitialState, smokeProfile } from "../../scripts/smoke-xiaohongshu.js";

async function stateFixture() {
  return JSON.parse(
    await readFile(new URL("../fixtures/xiaohongshu/profile-state.json", import.meta.url), "utf8"),
  );
}

test("从服务端页面安全读取初始状态", async () => {
  const state = await stateFixture();
  const html = `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script></html>`;

  assert.deepEqual(extractInitialState(html), state);
});

test("公开主页冒烟检查报告作者、卡片数量和可用编号", async () => {
  const state = await stateFixture();
  const fetchImpl = async () => ({
    ok: true,
    text: async () => `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`,
  });

  const result = await smokeProfile(
    "https://www.xiaohongshu.com/user/profile/user-1?xsec_token=temporary",
    fetchImpl,
  );

  assert.deepEqual(result, {
    author: "测试博主",
    visibleCards: 3,
    usableIds: 3,
    requiresLogin: false,
  });
});

test("主页只返回空编号时明确报告需要登录", async () => {
  const state = await stateFixture();
  for (const item of state.data.notes) {
    item.note_id = "";
    item.id = "";
  }
  const serialized = `${JSON.stringify(state).slice(0, -1)},"extra":undefined}`;
  const fetchImpl = async () => ({
    ok: true,
    text: async () => `<script>window.__INITIAL_STATE__=${serialized}</script>`,
  });

  const result = await smokeProfile("https://www.xiaohongshu.com/user/profile/user-1", fetchImpl);

  assert.equal(result.visibleCards, 3);
  assert.equal(result.usableIds, 0);
  assert.equal(result.requiresLogin, true);
});
