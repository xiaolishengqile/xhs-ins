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
    const match = url.pathname.match(/^\/(?:[^/]+\/)?p\/([^/]+)\/?/);
    return match ? `https://www.instagram.com/p/${match[1]}/` : null;
  } catch {
    return null;
  }
}

function isInRange(value, from, to) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return time >= new Date(from).getTime() && time <= new Date(to).getTime();
}

function mergeVisibleImages(note, images, hasVideo) {
  const metadataImages = hasVideo ? [] : note.media.map((item) => item.url);
  const urls = [...new Set([...metadataImages, ...images])];
  note.media = urls.map((url) => ({ url, type: "image", localPath: null, error: null }));
  return note;
}

async function readProfileSnapshot(page, signal) {
  let snapshot = { links: [], bodyText: "" };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    snapshot = await page.evaluate(() => ({
      links: [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].map((item) => item.href),
      bodyText: document.body?.innerText ?? "",
    }));
    if (snapshot.links.length > 0) return snapshot;
    checkPageText(snapshot.bodyText, true);
    await page.waitForTimeout(300);
    throwIfAborted(signal);
  }
  return snapshot;
}

async function readPostDetail(page, signal) {
  const images = new Set();
  let html = "";
  let bodyText = "";
  let previousSnapshot = "";
  let unchangedRounds = 0;
  let hasVideo = false;

  for (let step = 0; step < 50 && unchangedRounds < 2; step += 1) {
    throwIfAborted(signal);
    const snapshot = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      bodyText: document.body?.innerText ?? "",
      images: [...document.querySelectorAll("article img")]
        .filter((image) => image.naturalWidth >= 200 || image.width >= 200)
        .map((image) => image.currentSrc || image.src),
      hasVideo: Boolean(document.querySelector("article video")),
    }));
    html ||= snapshot.html;
    bodyText = snapshot.bodyText;
    checkPageText(bodyText, true);
    hasVideo ||= Boolean(snapshot.hasVideo);
    for (const url of snapshot.images ?? []) images.add(url);

    const signature = (snapshot.images ?? []).join("|");
    unchangedRounds = signature === previousSnapshot ? unchangedRounds + 1 : 0;
    previousSnapshot = signature;

    const nextButton = page.locator(
      'article button[aria-label="Next"], article button[aria-label="下一步"], article button[aria-label="下一张"]',
    ).last();
    if ((await nextButton.count()) === 0 || !(await nextButton.isVisible())) break;
    await nextButton.click();
    await page.waitForTimeout(400);
  }

  return { html, bodyText, images: [...images], hasVideo };
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
        const snapshot = await readProfileSnapshot(profilePage, signal);
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
          const detail = await readPostDetail(detailPage, signal);
          const note = mergeVisibleImages(
            parseInstagramPostHtml(detail.html, url),
            detail.images ?? [],
            detail.hasVideo,
          );
          author = note.author || author;
          if (note.media.length > 0 && isInRange(note.publishedAt, task.from, task.to)) {
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
    } catch (error) {
      throw error;
    }
  }
}
