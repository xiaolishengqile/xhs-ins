import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function openPath(target, { platform = process.platform, execFile: run = execFile } = {}) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "explorer" : "xdg-open";
  await run(command, [target]);
}
