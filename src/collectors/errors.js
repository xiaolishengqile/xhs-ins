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
