import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TaskStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  taskDir(id) {
    if (!UUID_PATTERN.test(id)) throw new Error("任务编号格式无效");
    return path.join(this.rootDir, id);
  }

  async save(task) {
    const directory = this.taskDir(task.id);
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, "task.json");
    const temporary = path.join(directory, `.task-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }

  async loadAll() {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      try {
        const content = await readFile(path.join(this.taskDir(entry.name), "task.json"), "utf8");
        tasks.push(JSON.parse(content));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return tasks.sort((left, right) => left.createdAt?.localeCompare(right.createdAt ?? "") ?? 0);
  }

  async remove(id) {
    await rm(this.taskDir(id), { recursive: true, force: true });
  }
}
