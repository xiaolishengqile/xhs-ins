import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_STATE = Object.freeze({ paused: false, updatedAt: null, cooldowns: {} });

function cooldowns(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, until]) => typeof until === "string"));
}

export class SchedulerStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.saveQueue = Promise.resolve();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      return {
        paused: value.paused === true,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
        cooldowns: cooldowns(value.cooldowns),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { ...DEFAULT_STATE, cooldowns: {} };
      throw error;
    }
  }

  async save(state) {
    const content = `${JSON.stringify({
      paused: state.paused === true,
      updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null,
      cooldowns: cooldowns(state.cooldowns),
    }, null, 2)}\n`;
    const saving = this.saveQueue.catch(() => {}).then(async () => {
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `.scheduler-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporary, content, "utf8");
      await rename(temporary, this.filePath);
    });
    this.saveQueue = saving;
    await saving;
  }
}
