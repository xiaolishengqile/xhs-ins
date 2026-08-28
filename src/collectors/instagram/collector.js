import { LoginRequiredError, VerificationRequiredError } from "../errors.js";
import { parseInstagramPostHtml } from "./parser.js";

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException("已取消", "AbortError");
}

function checkPageText(text, requireLogin = false) {
  if (/captcha|security check|安全验证|验证码|滑块/i.test(text)) throw new VerificationRequiredError();
  if (/private account|此帐户为私密帐户|此账户为私密账户/i.test(text)) throw new Error("该账号不是公开账号");
  if (requireLogin && /log in|sign up|登录|注册/i.test(text)) throw new LoginRequiredError();
}

function normalizedPostUrl(value) {
  try {
    const url = new URL(value, "https://www.instagram.com/");
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(p|reel)\/([^/]+)\/?/);
    return match ? `https://www.instagram.com/${match[1]}/${match[2]}/` : null;
  } catch {
    return null;
  }
}

function isInRange(value, from, to) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return time >= new Date(from).getTime() && time <= new Date(to).getTime();
}

function mergeVisibleImages(note, images) {
  const type = note.type === "video" ? "video-cover" : "image";
  const urls = [...new Set([...note.media.map((item) => item.url), ...images])];
  note.media = urls.map((url) => ({ url, type, localPath: null, error: null }));
  return note;
}

export class InstagramCollector {
  constructor({ browserManager }) {
    this.browserManager = browserManager;
  }

  async collect(task, { signal, onProgress }) {
    throwIfAborted(signal);
    const profilePage = await this.browserManager.newPage("instagram");
    let detailPage;
    try {
      detailPage = await this.browserManager.newPage("instagram");
      await profilePage.goto(task.profileUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await profilePage.waitForTimeout(800);
      const seen = new Set();
      const notes = [];
      let author = task.profileKey;
      let unchangedRounds = 0;
      let consecutiveOld = 0;
      let stop = false;

      while (unchangedRounds < 2 && !stop) {
        throwIfAborted(signal);
        const snapshot = await profilePage.evaluate(() => ({
          links: [...document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]')].map((item) => item.href),
          bodyText: document.body?.innerText ?? "",
        }));
        const links = snapshot.links.map(normalizedPostUrl).filter(Boolean);
        const fresh = links.filter((url) => !seen.has(url));
        checkPageText(snapshot.bodyText, seen.size === 0 && fresh.length === 0);
        for (const url of fresh) seen.add(url);
        unchangedRounds = fresh.length === 0 ? unchangedRounds + 1 : 0;
        await onProgress({ stage: "扫描博主主页", current: seen.size, total: 0 });

        for (const url of fresh) {
          throwIfAborted(signal);
          await detailPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await detailPage.waitForTimeout(600);
          const detail = await detailPage.evaluate(() => ({
            html: document.documentElement.outerHTML,
            bodyText: document.body?.innerText ?? "",
            images: [...document.querySelectorAll("article img")]
              .filter((image) => image.naturalWidth >= 200 || image.width >= 200)
              .map((image) => image.currentSrc || image.src),
          }));
          checkPageText(detail.bodyText, true);
          const note = mergeVisibleImages(parseInstagramPostHtml(detail.html, url), detail.images ?? []);
          author = note.author || author;
          if (isInRange(note.publishedAt, task.from, task.to)) {
            notes.push(note);
            consecutiveOld = 0;
          } else if (note.publishedAt && new Date(note.publishedAt) < new Date(task.from)) {
            consecutiveOld += 1;
          }
          await onProgress({ stage: "读取帖子详情", current: seen.size, total: 0 });
          if (consecutiveOld >= 6) {
            stop = true;
            break;
          }
        }

        if (!stop && unchangedRounds < 2) {
          await profilePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await profilePage.waitForTimeout(800);
        }
      }
      return { author, notes };
    } finally {
      await Promise.allSettled([profilePage?.close(), detailPage?.close()].filter(Boolean));
    }
  }
}
