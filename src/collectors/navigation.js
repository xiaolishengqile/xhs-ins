import { PageUnavailableError, TransientNavigationError } from "./errors.js";

const TRANSIENT_ERROR = /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION_RESET|ERR_TIMED_OUT|Timeout/i;

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

function isTransientStatus(status) {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

function statusOf(response) {
  return typeof response?.status === "function" ? response.status() : null;
}

async function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  if (!milliseconds) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    }, { once: true });
  });
}

export async function navigateWithRetry(page, url, {
  signal,
  retryDelays = [5_000, 20_000],
  onRetry = async () => {},
  gotoOptions = { waitUntil: "domcontentloaded", timeout: 30_000 },
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await page.goto(url, gotoOptions);
      const status = statusOf(response);
      if (status !== null && status >= 400) {
        if (isTransientStatus(status)) throw new TransientNavigationError(url);
        throw new PageUnavailableError(url, status);
      }
      return response;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      const transient = error?.code === "TRANSIENT_NAVIGATION_FAILURE" || TRANSIENT_ERROR.test(error?.message ?? "");
      if (!transient) throw error;
      if (attempt >= retryDelays.length) {
        throw new TransientNavigationError(url, { cause: error });
      }
      await onRetry({ attempt: attempt + 1, url });
      await abortableDelay(retryDelays[attempt], signal);
    }
  }
}
