class HumanActionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    this.code = "HUMAN_ACTION_REQUIRED";
  }
}

export class LoginRequiredError extends HumanActionRequiredError {
  constructor(message = "请在采集浏览器中完成登录") {
    super(message);
  }
}

export class VerificationRequiredError extends HumanActionRequiredError {
  constructor(message = "请在采集浏览器中完成人工验证") {
    super(message);
  }
}

export class PageUnavailableError extends Error {
  constructor(url, status) {
    super(`帖子不可访问：${url}（状态码 ${status}）`);
    this.name = "PageUnavailableError";
    this.code = "PAGE_UNAVAILABLE";
    this.url = url;
    this.status = status;
  }
}

export class TransientNavigationError extends Error {
  constructor(url, options = {}) {
    super(`平台暂时拒绝页面访问：${url}`, options);
    this.name = "TransientNavigationError";
    this.code = "TRANSIENT_NAVIGATION_FAILURE";
    this.url = url;
  }
}

export class PlatformTemporarilyUnavailableError extends Error {
  constructor(message, { retryAfterMs, partialResult, cause } = {}) {
    super(message, { cause });
    this.name = "PlatformTemporarilyUnavailableError";
    this.code = "PLATFORM_TEMPORARILY_UNAVAILABLE";
    this.retryAfterMs = retryAfterMs;
    this.partialResult = partialResult;
  }
}
