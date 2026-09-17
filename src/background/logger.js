import { appendFile, rename, rm, stat } from "node:fs/promises";
import { format } from "node:util";

const MAX_LOG_BYTES = 512 * 1024;

export function createBoundedLogger({ stdoutLog, stderrLog, maxBytes = MAX_LOG_BYTES }) {
  let queue = Promise.resolve();
  async function append(file, values) {
    const line = `${new Date().toISOString()} ${format(...values)}\n`;
    const bytes = Buffer.byteLength(line);
    const size = await stat(file).then((value) => value.size).catch(() => 0);
    if (size + bytes > maxBytes) {
      await rm(`${file}.1`, { force: true });
      await rename(file, `${file}.1`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await appendFile(file, bytes > maxBytes ? Buffer.from(line).subarray(bytes - maxBytes) : line, { mode: 0o600 });
  }
  function write(file, values) {
    queue = queue.then(() => append(file, values)).catch(() => {});
    return queue;
  }
  return {
    install() {
      console.log = (...values) => { void write(stdoutLog, values); };
      console.info = console.log;
      console.error = (...values) => { void write(stderrLog, values); };
      console.warn = console.error;
    },
    info: (...values) => write(stdoutLog, values),
    error: (...values) => write(stderrLog, values),
    flush: () => queue,
  };
}
