import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../test/", import.meta.url));
const categories = process.argv[2] ? [process.argv[2]] : ["unit", "integration", "e2e"];
const files = [];
for (const category of categories) {
  if (!["unit", "integration", "e2e"].includes(category)) throw new Error("测试分类无效");
  const directory = path.join(root, category);
  for (const file of (await readdir(directory)).sort()) {
    if (file.endsWith(".test.js")) files.push(path.join(directory, file));
  }
}
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], {
  stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
