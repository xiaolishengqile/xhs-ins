import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const runCommand = promisify(execFile);

export async function defaultPicturesDirectory({ platform = process.platform, home = homedir(), run = runCommand } = {}) {
  if (platform === "win32") {
    try {
      const { stdout } = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyPictures')",
      ], { windowsHide: true, timeout: 5000 });
      const pictures = stdout.trim();
      if (path.win32.isAbsolute(pictures)) return path.win32.join(pictures, "博主图片采集");
    } catch { /* 系统目录读取失败时沿用用户目录。 */ }
  }
  return (platform === "win32" ? path.win32 : path).join(home, "Pictures", "博主图片采集");
}
