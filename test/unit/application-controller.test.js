import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationController } from "../../src/application/controller.js";

test("暂停任务后关闭应用拥有的浏览器", async () => {
  const events = [];
  const controller = new ApplicationController({
    manager: {
      pauseAll: async () => events.push("pause"),
      controlStatus: () => ({ paused: true }),
    },
    browserManager: { close: async () => events.push("close-browser") },
  });

  const status = await controller.pauseAll();

  assert.deepEqual(events, ["pause", "close-browser"]);
  assert.deepEqual(status, { paused: true });
});

test("登录窗口只为等待人工处理的任务显式打开和关闭", async () => {
  const events = [];
  const task = { id: "task-1", platform: "instagram", status: "waiting_user" };
  const controller = new ApplicationController({
    manager: {
      get: () => task,
      prepareHumanAction: async (platform) => events.push(`block:${platform}`),
      resumePlatform: async (platform) => events.push(`resume:${platform}`),
    },
    browserManager: {
      openLogin: async (platform) => events.push(`open:${platform}`),
      closeLogin: async (platform) => events.push(`close:${platform}`),
    },
  });

  await controller.openLogin(task.id);
  await controller.completeLogin(task.id);

  assert.deepEqual(events, [
    "block:instagram",
    "open:instagram",
    "close:instagram",
    "resume:instagram",
  ]);
});

test("普通任务不能打开登录窗口", async () => {
  const controller = new ApplicationController({
    manager: { get: () => ({ id: "task-1", platform: "instagram", status: "pending" }) },
    browserManager: {},
  });

  await assert.rejects(() => controller.openLogin("task-1"), /不需要人工登录/);
});
