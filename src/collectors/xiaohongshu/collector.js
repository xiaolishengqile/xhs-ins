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
    const state = window.__INITIAL_STATE__ ?? null;
    const unwrap = (value) => value?._rawValue ?? value?._value ?? value;
    const profileNotes = unwrap(state?.user?.notes);
    const noteDetails = unwrap(state?.note?.noteDetailMap);
    const payload = profileNotes !== undefined || noteDetails !== undefined
      ? { profileNotes, noteDetails }
      : state;
    const seen = new WeakSet();
    return JSON.stringify(payload, function omitCircularReference(_key, value) {
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
  constructor({ browserManager, scrollWaitMs = 4_000, maxIdleScrolls = 4 }) {
    this.browserManager = browserManager;
    this.scrollWaitMs = scrollWaitMs;
    this.maxIdleScrolls = maxIdleScrolls;
  }

  async collect(task, { signal, onProgress, checkpoint = { entries: {} }, onCheckpoint = async () => {} }) {
    throwIfAborted(signal);
    const profilePage = await this.browserManager.newPage("xiaohongshu");
    let detailPage;
    const responsePayloads = [];
    const pendingResponses = new Set();
    const responseListener = (response) => {
      const url = response.url?.() ?? "";
      if (!url.includes("/api/sns/web/v1/user_posted") && !url.includes("/api/sns/web/v1/feed")) return;
      const pending = response.json().then((payload) => responsePayloads.push(payload)).catch(() => {});
      pendingResponses.add(pending);
      pending.finally(() => pendingResponses.delete(pending));
    };
    profilePage.on?.("response", responseListener);
    try {
      await profilePage.goto(task.profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await profilePage.waitForTimeout(800);
      throwIfAborted(signal);

      const candidates = new Map();
      let author = "";
      let unchangedRounds = 0;
      while (unchangedRounds < this.maxIdleScrolls) {
        await Promise.allSettled([...pendingResponses]);
        const payloads = responsePayloads.splice(0);
        payloads.push(await initialState(profilePage));
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
        if (unchangedRounds >= this.maxIdleScrolls) break;
        await profilePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        for (let waited = 0; waited < this.scrollWaitMs && responsePayloads.length === 0 && pendingResponses.size === 0; waited += 250) {
          await profilePage.waitForTimeout(250);
          throwIfAborted(signal);
        }
        throwIfAborted(signal);
      }

      const allCandidates = [...candidates.values()];
      const usable = allCandidates.filter((item) => item.id);
      if (allCandidates.length > 0 && usable.length === 0) await checkHumanAction(profilePage, true);
      if (allCandidates.length > 0 && usable.length === 0) throw new LoginRequiredError("公开主页未返回笔记编号，请先登录");
      await checkHumanAction(profilePage, usable.length === 0);
      if (usable.length === 0 && Object.keys(checkpoint.pending ?? {}).length === 0) {
        const text = await bodyText(profilePage);
        if (!/还没有发布|暂无笔记|没有发布任何|还没有笔记/.test(text)) {
          throw new Error("未能读取博主主页的笔记列表，请确认采集浏览器已登录小红书后重试");
        }
      }

      const pending = checkpoint.pending ?? {};
      const selected = usable.filter((item) => item.type !== "video" && inRange(item.publishedAt, task.from, task.to));
      for (const [id, entry] of Object.entries(pending)) {
        if (!selected.some((item) => item.id === id)) selected.push({ id, url: entry.note.url });
      }
      const notes = Object.values({ ...checkpoint.entries, ...pending }).map((entry) => entry.note).filter(Boolean);
      if (selected.length > 0) {
        detailPage = await this.browserManager.newPage("xiaohongshu");
        if (detailPage !== profilePage) detailPage.on?.("response", responseListener);
      }
      for (let index = 0; index < selected.length; index += 1) {
        throwIfAborted(signal);
        const item = selected[index];
        if (Object.hasOwn(checkpoint.entries, item.id)) continue;
        const url = item.url || detailUrl(item);
        responsePayloads.length = 0;
        await detailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await detailPage.waitForTimeout(600);
        await Promise.allSettled([...pendingResponses]);
        throwIfAborted(signal);
        const payloads = [
          ...responsePayloads.splice(0),
          await initialState(detailPage),
        ];
        let note = null;
        for (const payload of payloads) {
          note = parseNotePayload(payload, url);
          if (note) break;
        }
        if (!note) {
          await checkHumanAction(detailPage, true);
          throw new Error(`无法读取笔记详情：${item.title || item.id}`);
        }
        const included = note.type !== "video" && inRange(note.publishedAt, task.from, task.to);
        if (included) {
          const previous = notes.findIndex((entry) => entry.id === note.id);
          if (previous >= 0) notes.splice(previous, 1);
          notes.push(note);
        }
        await onCheckpoint({ key: item.id, note: included ? note : pending[item.id]?.note ?? null, author: note.author, publishedAt: note.publishedAt });
        await onProgress({ stage: "读取笔记详情", current: index + 1, total: selected.length });
      }

      return { author: author || notes[0]?.author || task.profileKey, notes };
    } catch (error) {
      throw error;
    } finally {
      profilePage.off?.("response", responseListener);
      if (detailPage && detailPage !== profilePage) detailPage.off?.("response", responseListener);
    }
  }
}
