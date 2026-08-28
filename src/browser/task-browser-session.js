export class TaskBrowserSession {
  constructor({ manager, platform, taskId }) {
    this.manager = manager;
    this.platform = platform;
    this.taskId = taskId;
    this.pages = new Set();
    this.retainedPages = new Set();
    this.closed = false;
  }

  async newPage() {
    if (this.closed) throw new Error("任务浏览器会话已关闭");
    const retained = this.retainedPages.values().next().value;
    if (retained) {
      this.retainedPages.delete(retained);
      return retained;
    }
    const page = await this.manager.createTaskPage(this.platform);
    this.pages.add(page);
    return page;
  }

  fetchBuffer(url) {
    if (this.closed) throw new Error("任务浏览器会话已关闭");
    return this.manager.fetchBuffer(this.platform, url);
  }

  async retainPageForHumanAction(_platform, page) {
    if (this.closed || !this.pages.has(page)) return;
    this.retainedPages.add(page);
  }

  async close({ preserveHumanAction = false } = {}) {
    if (this.closed) return;
    const keptPages = preserveHumanAction ? new Set(this.retainedPages) : new Set();
    const pagesToClose = [...this.pages].filter((page) => !keptPages.has(page));
    await Promise.allSettled(pagesToClose.map((page) => page.close()));
    this.pages = keptPages;
    this.retainedPages = new Set(keptPages);
    if (keptPages.size === 0) this.closed = true;
    this.manager.releaseTaskSession(this, { preserveHumanAction: keptPages.size > 0 });
  }
}
