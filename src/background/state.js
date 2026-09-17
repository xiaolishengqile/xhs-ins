import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const STARTING_GRACE_MS = 15_000;
const RECOVERY_WAIT_MS = 5_000;

export function defaultBackgroundDataDir() {
  return path.resolve(".data");
}

export function createInstanceToken() {
  return randomBytes(24).toString("base64url");
}

export function backgroundPaths(dataDir, token = "") {
  const root = path.join(path.resolve(dataDir), "background");
  const suffix = token.slice(0, 12);
  const identity = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\xhs-ins-${identity}-${suffix}`
    : path.join(tmpdir(), `xhs-ins-${identity}-${suffix}.sock`);
  return {
    root,
    lockDir: path.join(root, "instance.lock"),
    ownerFile: path.join(root, "instance.lock", "owner.json"),
    recoveryDir: path.join(root, "instance.lock.recovery"),
    recoveryOwnerFile: path.join(root, "instance.lock.recovery", "owner.json"),
    stateFile: path.join(root, "state.json"),
    endpoint,
    stdoutLog: path.join(root, "background.log"),
    stderrLog: path.join(root, "background-error.log"),
    startError: (launchId) => path.join(root, `start-${launchId}.json`),
  };
}

export async function ensureBackgroundDir(dataDir) {
  const { root } = backgroundPaths(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => {});
  return root;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readState(dataDir) {
  return readJson(backgroundPaths(dataDir).stateFile);
}

export async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function recoveryBlocked() {
  const error = new Error("旧锁回收锁未释放，请确认没有后台启动进程后人工处理");
  error.code = "BACKGROUND_RECOVERY_BLOCKED";
  return error;
}

async function waitForRecovery(paths) {
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  while (true) {
    const recovery = await stat(paths.recoveryDir).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!recovery) return;
    const owner = await readJson(paths.recoveryOwnerFile);
    if (owner && !processExists(owner.pid)) throw recoveryBlocked();
    if (!owner && Date.now() - recovery.mtimeMs >= STARTING_GRACE_MS) throw recoveryBlocked();
    if (Date.now() >= deadline) throw recoveryBlocked();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function createMainLock(paths, token) {
  await mkdir(paths.lockDir, { mode: 0o700 });
  await writePrivateJson(paths.ownerFile, { pid: process.pid, token, createdAt: new Date().toISOString() });
  return paths;
}

async function releaseRecoveryLock(paths, token) {
  const owner = await readJson(paths.recoveryOwnerFile);
  if (owner?.token === token) await rm(paths.recoveryDir, { recursive: true, force: true });
}

export async function acquireInstanceLock(dataDir, token) {
  const paths = backgroundPaths(dataDir, token);
  await ensureBackgroundDir(dataDir);
  const recovering = await stat(paths.recoveryDir).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (recovering) {
    await waitForRecovery(paths);
    return acquireInstanceLock(dataDir, token);
  }
  try {
    return await createMainLock(paths, token);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readJson(paths.ownerFile);
    const lockCreatedAt = await stat(paths.lockDir).then((value) => value.mtimeMs).catch(() => Date.now());
    const age = Date.now() - (Date.parse(owner?.createdAt ?? "") || lockCreatedAt);
    if (processExists(owner?.pid) || age < STARTING_GRACE_MS) {
      const busy = new Error("后台服务正在运行或启动中");
      busy.code = "BACKGROUND_BUSY";
      throw busy;
    }
    try {
      await mkdir(paths.recoveryDir, { mode: 0o700 });
      await writePrivateJson(paths.recoveryOwnerFile, {
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      });
    } catch (recoveryError) {
      if (recoveryError.code !== "EEXIST") throw recoveryError;
      await waitForRecovery(paths);
      return acquireInstanceLock(dataDir, token);
    }
    const stale = `${paths.lockDir}.stale-${randomBytes(5).toString("hex")}`;
    try {
      const currentOwner = await readJson(paths.ownerFile);
      const currentCreatedAt = await stat(paths.lockDir).then((value) => value.mtimeMs).catch(() => Date.now());
      const currentAge = Date.now() - (Date.parse(currentOwner?.createdAt ?? "") || currentCreatedAt);
      if (processExists(currentOwner?.pid) || currentAge < STARTING_GRACE_MS) {
        const busy = new Error("后台服务正在运行或启动中");
        busy.code = "BACKGROUND_BUSY";
        throw busy;
      }
      await rename(paths.lockDir, stale);
      await rm(stale, { recursive: true, force: true });
      return await createMainLock(paths, token);
    } catch (recoveryError) {
      if (recoveryError.code !== "ENOENT") throw recoveryError;
    } finally {
      await releaseRecoveryLock(paths, token);
    }
    return acquireInstanceLock(dataDir, token);
  }
}

export async function releaseInstanceLock(paths, token) {
  const owner = await readJson(paths.ownerFile);
  if (owner?.token === token) await rm(paths.lockDir, { recursive: true, force: true });
}

export async function removeStateIfOwned(paths, token) {
  const state = await readJson(paths.stateFile);
  if (state?.token === token) await rm(paths.stateFile, { force: true });
}

export async function writeStartError(dataDir, launchId, error) {
  if (!launchId) return;
  await ensureBackgroundDir(dataDir);
  const code = typeof error?.code === "string" ? `${error.code}: ` : "";
  await writePrivateJson(backgroundPaths(dataDir).startError(launchId), {
    error: `${code}${error?.message || "后台启动失败"}`,
  });
}

export async function takeStartError(dataDir, launchId) {
  const file = backgroundPaths(dataDir).startError(launchId);
  const value = await readJson(file);
  if (value) await rm(file, { force: true });
  return value;
}
