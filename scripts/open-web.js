import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openPath } from "../src/system/open-path.js";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const backgroundScript = path.join(projectRoot, "scripts", "background.js");

export async function openLocalWeb(argv = process.argv.slice(2)) {
  const noOpen = argv.includes("--no-open");
  const args = argv.filter((value) => value !== "--no-open");
  const { stdout } = await run(process.execPath, [backgroundScript, "start", "--json", ...args], {
    cwd: projectRoot,
    windowsHide: true,
  });
  const status = JSON.parse(stdout);
  if (!noOpen) await openPath(status.url);
  return status.url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  openLocalWeb().then((url) => console.log(url)).catch((error) => {
    console.error(`启动本机网页失败：${error.message}`);
    process.exitCode = 1;
  });
}
