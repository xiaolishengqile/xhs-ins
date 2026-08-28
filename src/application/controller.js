export class ApplicationController {
  constructor({ manager, browserManager }) {
    this.manager = manager;
    this.browserManager = browserManager;
  }

  async pauseAll() {
    await this.manager.pauseAll();
    await this.browserManager.close();
    return this.manager.controlStatus();
  }

  resumeAll() {
    return this.manager.resumeAll();
  }

  async openLogin(taskId) {
    const task = this.#waitingTask(taskId);
    await this.manager.prepareHumanAction(task.platform);
    await this.browserManager.openLogin(task.platform);
    return task;
  }

  async completeLogin(taskId) {
    const task = this.#waitingTask(taskId);
    await this.browserManager.closeLogin(task.platform);
    await this.manager.resumePlatform(task.platform);
    return this.manager.get(taskId);
  }

  #waitingTask(taskId) {
    const task = this.manager.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "waiting_user") throw new Error("该任务不需要人工登录");
    return task;
  }
}
