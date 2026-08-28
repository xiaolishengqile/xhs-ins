import { LoginRequiredError, VerificationRequiredError } from "../errors.js";
import { parseNotePayload, parseProfilePayload } from "./parser.js";

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

async function initialState(page) {
  const serialized = await page.evaluate(() => {
    const seen = new WeakSet();
    return JSON.stringify(window.__INITIAL_STATE__ ?? null, function omitCircularReference(_key, value) {
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return undefined;
      seen.add(value);
      return value;
    });
  });
  return JSON.parse(serialized);
}

async function checkHumanAction(page, requireLogin = false) {
  const text = await bodyText(page);
  if (/验证码|安全验证|滑块|captcha/i.test(text)) throw new VerificationRequiredError();
  if (requireLogin && /扫码登录|登录后|请登录|log in|sign up/i.test(text)) throw new LoginRequiredError();
}

function inRange(value, from, to) {
  if (!value) return true;
  const time = new Date(value).getTime();
  return time >= new Date(from).getTime() && time <= new Date(to).getTime();
}

function detailUrl(item) {
  const token = item.token ? `?xsec_token=${encodeURIComponent(item.token)}&xsec_source=pc_user` : "";
  return `https://www.xiaohongshu.com/explore/${encodeURIComponent(item.id)}${token}`;
}

export class XiaohongshuCollector {
  constructor({ browserManager }) {
    this.browserManager = browserManager;
  }

  async collect(task, { signal, onProgress }) {
    throwIfAborted(signal);
    const page = await this.browserManager.newPage("xiaohongshu");
    const responsePayloads = [];
    const pendingResponses = new Set();
    const responseListener = (response) => {
      const url = response.url?.() ?? "";
      if (!url.includes("/api/sns/web/v1/user_posted") && !url.includes("/api/sns/web/v1/feed")) return;
      const pending = response.json().then((payload) => responsePayloads.push(payload)).catch(() => {});
      pendingResponses.add(pending);
      pending.finally(() => pendingResponses.delete(pending));
    };
    page.on?.("response", responseListener);
    let retainedForHumanAction = false;

    try {
      await page.goto(task.profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(800);
      throwIfAborted(signal);

      const candidates = new Map();
      let author = "";
      let unchangedRounds = 0;
      while (unchangedRounds < 2) {
        await Promise.allSettled([...pendingResponses]);
        const payloads = responsePayloads.splice(0);
        payloads.push(await initialState(page));
        const before = candidates.size;
        const addedThisRound = [];
        for (const payload of payloads) {
          const parsed = parseProfilePayload(payload);
          author ||= parsed.author;
          for (const item of parsed.items) {
            const key = item.id || `${item.title}|${item.publishedAt}`;
            if (!candidates.has(key)) addedThisRound.push(item);
            candidates.set(key, item);
          }
        }
        await onProgress({ stage: "扫描博主主页", current: candidates.size, total: 0 });
        unchangedRounds = candidates.size === before ? unchangedRounds + 1 : 0;
        const chronological = addedThisRound.filter((item) => !item.pinned && item.publishedAt);
        if (chronological.length > 0 && chronological.every((item) => new Date(item.publishedAt) < new Date(task.from))) break;
        if (unchangedRounds >= 2) break;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
        throwIfAborted(signal);
      }

      const allCandidates = [...candidates.values()];
      const usable = allCandidates.filter((item) => item.id);
      if (allCandidates.length > 0 && usable.length === 0) await checkHumanAction(page, true);
      if (allCandidates.length > 0 && usable.length === 0) throw new LoginRequiredError("公开主页未返回笔记编号，请先登录");
      await checkHumanAction(page, usable.length === 0);

      const selected = usable.filter((item) => inRange(item.publishedAt, task.from, task.to));
      const notes = [];
      for (let index = 0; index < selected.length; index += 1) {
        throwIfAborted(signal);
        const item = selected[index];
        const url = detailUrl(item);
        responsePayloads.length = 0;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(600);
        await Promise.allSettled([...pendingResponses]);
        throwIfAborted(signal);
        const payloads = [
          ...responsePayloads.splice(0),
          await initialState(page),
        ];
        let note = null;
        for (const payload of payloads) {
          note = parseNotePayload(payload, url);
          if (note) break;
        }
        if (!note) {
          await checkHumanAction(page, true);
          throw new Error(`无法读取笔记详情：${item.title || item.id}`);
        }
        if (inRange(note.publishedAt, task.from, task.to)) notes.push(note);
        await onProgress({ stage: "读取笔记详情", current: index + 1, total: selected.length });
      }

      await this.browserManager.closeHumanActionPages?.("xiaohongshu");
      return { author: author || notes[0]?.author || task.profileKey, notes };
    } catch (error) {
      if (error?.code === "HUMAN_ACTION_REQUIRED") {
        retainedForHumanAction = true;
        await this.browserManager.retainPageForHumanAction?.("xiaohongshu", page);
      }
      throw error;
    } finally {
      page.off?.("response", responseListener);
      if (!retainedForHumanAction) await page.close();
    }
  }
}
