export class BrowserLaunchError extends Error {
  constructor(attempts, options = {}) {
    super("无法启动采集浏览器，请从系统终端重新启动本工具后再继续", options);
    this.name = "BrowserLaunchError";
    this.code = "BROWSER_LAUNCH_FAILED";
    this.attempts = attempts;
  }
}
