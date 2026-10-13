import {
  LoginRequiredError,
  PlatformTemporarilyUnavailableError,
  VerificationRequiredError,
} from "../errors.js";
import { navigateWithRetry } from "../navigation.js";
import { normalizeNote } from "../../domain/note.js";

const IMAGE = 1;
const CAROUSEL = 8;

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
}

function checkPageText(text, requireLogin = false) {
  if (/captcha|security check|安全验证|验证码|滑块/i.test(text)) throw new VerificationRequiredError();
  if (/private account|此帐户为私密帐户|此账户为私密账户/i.test(text)) throw new Error("该账号不是公开账号");
  if (requireLogin && /log in|sign up|登录|注册/i.test(text)) throw new LoginRequiredError();
}

function belongsTo(post, profileKey) {
  const owner = String(post?.user?.username ?? post?.owner?.username ?? "").toLowerCase();
  if (owner === profileKey) return true;
  return (post?.coauthor_producers ?? []).some((user) => String(user?.username ?? "").toLowerCase() === profileKey);
}

function largestCandidate(media) {
  let best = null;
  for (const candidate of media?.image_versions2?.candidates ?? []) {
    if (!candidate?.url) continue;
    const area = Number(candidate.width ?? 0) * Number(candidate.height ?? 0);
    if (!best || area > best.area) best = { ...candidate, area };
  }
  return best;
}

export function noteFromFeedPost(post, profileKey) {
  const items = post.media_type === CAROUSEL ? post.carousel_media ?? [] : [post];
  const images = items.filter((item) => item?.media_type === IMAGE).map(largestCandidate).filter(Boolean);
  const note = normalizeNote({
    platform: "instagram",
    id: post.code,
    type: images.length > 0 ? "image" : "video",
    author: post.user?.username ?? profileKey,
    title: post.caption?.text ?? "",
    publishedAt: post.taken_at * 1000,
    url: `https://www.instagram.com/p/${post.code}/`,
    metrics: {
      likeCount: post.like_and_view_counts_disabled ? null : post.like_count ?? null,
      favoriteCount: null,
      commentCount: post.comment_count ?? null,
    },
    media: [],
  });
  note.media = images.map((candidate) => ({
    url: candidate.url,
    type: "image",
    localPath: null,
    error: null,
    sourceWidth: candidate.width ?? null,
    sourceHeight: candidate.height ?? null,
  }));
  return note;
}

export function readFeedPayload(payload, profileKey, posts, state) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (Array.isArray(value.edges) && value.page_info && value.edges.some((edge) => belongsTo(edge?.node, profileKey))) {
      state.pageInfo = value.page_info;
    }
    if (typeof value.code === "string" && value.taken_at) {
      if (belongsTo(value, profileKey)) posts.set(value.code, value);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
}

function isPinned(post) {
  return (post.timeline_pinned_user_ids?.length ?? 0) > 0;
}

function formatDay(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export class InstagramCollector {
  constructor({
    browserManager,
    navigationRetryDelays = [5_000, 20_000],
    platformCooldownMs = 5 * 60_000,
    scrollWaitMs = 4_000,
    maxIdleScrolls = 5,
  }) {
    this.browserManager = browserManager;
    this.navigationRetryDelays = navigationRetryDelays;
    this.platformCooldownMs = platformCooldownMs;
    this.scrollWaitMs = scrollWaitMs;
    this.maxIdleScrolls = maxIdleScrolls;
  }

  async collect(task, { signal, onProgress, checkpoint = { entries: {} }, onCheckpoint = async () => {} }) {
    throwIfAborted(signal);
    const profileKey = String(task.profileKey).toLowerCase();
    const page = await this.browserManager.newPage("instagram");
    const posts = new Map();
    const state = { pageInfo: null, responses: 0 };
    const pendingReads = new Set();
    const onResponse = (response) => {
      const url = response.url?.() ?? "";
      if (!/instagram\.com\/(graphql\/query|api\/v1\/feed\/user)/.test(url)) return;
      const read = response.json()
        .then((payload) => {
          readFeedPayload(payload, profileKey, posts, state);
          state.responses += 1;
        })
        .catch(() => {});
      pendingReads.add(read);
      read.finally(() => pendingReads.delete(read));
    };
    const pending = checkpoint.pending ?? {};
    const from = Date.parse(task.from);
    const to = Date.parse(task.to);
    let author = task.profileKey;

    const waitForResponses = async () => {
      const before = state.responses;
      for (let waited = 0; waited < this.scrollWaitMs && state.responses === before; waited += 250) {
        await page.waitForTimeout(250);
        throwIfAborted(signal);
      }
      await Promise.allSettled([...pendingReads]);
    };
    const partialResult = () => ({ author, notes: this.#notesInRange(posts, profileKey, from, to, pending), warnings: [] });

    page.on?.("response", onResponse);
    try {
      await navigateWithRetry(page, task.profileUrl, {
        signal,
        retryDelays: this.navigationRetryDelays,
        onRetry: () => onProgress({ stage: "页面暂时不可用，正在重试" }),
      });
      await waitForResponses();

      let idle = 0;
      let reachedEnd = false;
      while (!reachedEnd) {
        throwIfAborted(signal);
        const before = posts.size;
        const chronological = [...posts.values()].filter((post) => !isPinned(post));
        const oldest = chronological.reduce((value, post) => Math.min(value, post.taken_at), Infinity);
        if (Number.isFinite(oldest) && oldest * 1000 < from) break;
        if (state.pageInfo?.has_next_page === false) {
          reachedEnd = true;
          break;
        }
        await onProgress({
          stage: Number.isFinite(oldest) ? `扫描博主主页，已读到 ${formatDay(oldest)}` : "扫描博主主页",
          current: posts.size,
          total: 0,
        });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await waitForResponses();
        idle = posts.size === before ? idle + 1 : 0;
        if (idle >= this.maxIdleScrolls) break;
      }

      const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (posts.size === 0) {
        checkPageText(bodyText, true);
        if (/(^|\n)\s*0\s*(帖子|posts?)(\s|$)/i.test(bodyText)) return { author, notes: [], warnings: [] };
        throw new Error("未能读取博主主页的帖子列表，请确认采集浏览器已登录 Instagram 后重试");
      }
      const chronological = [...posts.values()].filter((post) => !isPinned(post));
      const oldest = chronological.reduce((value, post) => Math.min(value, post.taken_at), Infinity);
      const complete = reachedEnd || state.pageInfo?.has_next_page === false || oldest * 1000 < from;
      if (!complete) {
        checkPageText(bodyText, true);
        throw new PlatformTemporarilyUnavailableError(
          `主页只加载到 ${formatDay(oldest)}，未到开始日期，稍后自动继续`,
          { retryAfterMs: this.platformCooldownMs, partialResult: partialResult() },
        );
      }

      const notes = this.#notesInRange(posts, profileKey, from, to, pending);
      author = [...posts.values()].find((post) => String(post.user?.username ?? "").toLowerCase() === profileKey)?.user?.username
        ?? author;
      for (const note of notes) {
        await onCheckpoint({ key: note.url, note, author, publishedAt: note.publishedAt });
      }
      await onProgress({ stage: "主页扫描完成", current: notes.length, total: notes.length });
      return { author, notes, warnings: [] };
    } catch (error) {
      if (error?.code === "TRANSIENT_NAVIGATION_FAILURE") {
        throw new PlatformTemporarilyUnavailableError("平台访问过于频繁，任务将在冷却后自动继续", {
          retryAfterMs: this.platformCooldownMs,
          partialResult: partialResult(),
          cause: error,
        });
      }
      throw error;
    } finally {
      page.off?.("response", onResponse);
    }
  }

  #notesInRange(posts, profileKey, from, to, pending) {
    const notes = [];
    const seen = new Set();
    for (const post of posts.values()) {
      const time = post.taken_at * 1000;
      if (time < from || time > to) continue;
      const note = noteFromFeedPost(post, profileKey);
      seen.add(note.url);
      if (note.media.length > 0) notes.push(note);
    }
    for (const [key, entry] of Object.entries(pending)) {
      if (entry?.note && !seen.has(key) && !seen.has(entry.note.url)) notes.push(entry.note);
    }
    return notes.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  }
}
