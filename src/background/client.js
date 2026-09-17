import { rm } from "node:fs/promises";

import { sendControl } from "./control.js";
import { backgroundPaths, readState } from "./state.js";

export async function getBackgroundStatus(dataDir, options) {
  const state = await readState(dataDir);
  if (!state?.endpoint || !state?.token) return null;
  try {
    const response = await sendControl(state.endpoint, { action: "status", token: state.token }, options);
    return response.ok ? response.status : null;
  } catch {
    return null;
  }
}

export async function stopBackground(dataDir, options) {
  const state = await readState(dataDir);
  if (!state?.endpoint || !state?.token) return false;
  const deadline = Date.now() + (options?.timeout ?? 10_000);
  const response = await sendControl(state.endpoint, { action: "stop", token: state.token }, options);
  if (!response.ok) throw new Error("后台实例身份校验失败");
  while (Date.now() < deadline) {
    const current = await readState(dataDir);
    const stateRemoved = current?.token !== state.token;
    let healthy = false;
    try {
      const health = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(250) });
      healthy = health.ok;
    } catch {}
    if (stateRemoved && !healthy) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待后台停止超时");
}

export async function controlBackground(dataDir, action, options) {
  const state = await readState(dataDir);
  if (!state?.endpoint || !state?.token) throw new Error("后台服务未运行");
  const response = await sendControl(state.endpoint, { action, token: state.token }, options);
  if (!response.ok) throw new Error(response.error || "后台控制失败");
  return response.status;
}

export async function discardStartError(dataDir, launchId) {
  await rm(backgroundPaths(dataDir).startError(launchId), { force: true });
}
