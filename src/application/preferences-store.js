import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const PRESETS = new Set(["week", "month", "halfYear", "year"]);
export const THROTTLE_DEFAULTS = Object.freeze({ imageDelaySeconds: 0.5, bloggerGapSeconds: 30, dailyBloggerLimit: 0 });
const THROTTLE_LIMITS = {
  imageDelaySeconds: [0, 60, "图片下载间隔"],
  bloggerGapSeconds: [0, 3600, "博主之间的间隔"],
  dailyBloggerLimit: [0, 10_000, "每日采集博主上限"],
};
const DEFAULTS = Object.freeze({ preset: "year", outputDir: "", ...THROTTLE_DEFAULTS });

function validate(value) {
  if (!value || typeof value !== "object" || !PRESETS.has(value.preset)) {
    throw new Error("默认采集周期无效");
  }
  if (typeof value.outputDir !== "string" || (value.outputDir && !path.isAbsolute(value.outputDir))) {
    throw new Error("图片目录必须是绝对路径或留空");
  }
  const throttle = {};
  for (const [key, [min, max, label]] of Object.entries(THROTTLE_LIMITS)) {
    const number = Number(value[key] ?? THROTTLE_DEFAULTS[key]);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
    throttle[key] = key === "dailyBloggerLimit" ? Math.round(number) : number;
  }
  return { preset: value.preset, outputDir: value.outputDir, ...throttle };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class PreferencesStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, "preferences.json");
    this.legacyFile = path.join(this.dataDir, "desktop-settings.json");
  }

  async load() {
    const current = await readJson(this.file);
    if (current) return validate(current);
    const legacy = await readJson(this.legacyFile);
    if (!legacy) return { ...DEFAULTS };
    return validate({ preset: legacy.preset, outputDir: legacy.output_dir ?? "" });
  }

  async save(value) {
    const settings = validate(value);
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
    return settings;
  }
}
