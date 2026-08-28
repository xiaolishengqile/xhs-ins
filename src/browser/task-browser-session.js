export class TaskBrowserSession {
  constructor({ manager, platform, taskId }) {
    this.manager = manager;
    this.platform = platform;
    this.taskId = taskId;
    this.pages = new Set();
    this.closed = false;
  }

  async newPage() {
    if (this.closed) throw new Error("任务浏览器会话已关闭");
    const page = await this.manager.createTaskPage(this.platform);
    this.pages.add(page);
    return page;
  }

  fetchBuffer(url) {
    if (this.closed) throw new Error("任务浏览器会话已关闭");
    return this.manager.fetchBuffer(this.platform, url);
  }

  async close() {
    if (this.closed) return;
    await Promise.allSettled([...this.pages].map((page) => page.close()));
    this.pages.clear();
    this.closed = true;
    this.manager.releaseTaskSession(this);
  }
}
