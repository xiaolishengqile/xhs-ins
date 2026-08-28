# 浏览器运行环境熔断实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浏览器无法启动时只触发一次平台级熔断，并允许用户或服务重启后整体恢复受阻任务。

**Architecture:** 浏览器层抛出带稳定错误码的启动错误；任务层用带原因的平台阻塞映射调度任务；应用层仅暴露与阻塞原因匹配的恢复动作。保留现有登录阻塞和平台冷却流程。

**Tech Stack:** Node.js 22、Playwright、原生测试运行器、原生浏览器页面。

**Spec:** `docs/superpowers/specs/2026-08-29-browser-runtime-circuit-breaker-design.md`

## Global Constraints

- 不增加运行依赖。
- 不改变采集器、平台冷却和图片导出策略。
- 现有 `waiting_user` 任务兼容为登录阻塞。
- 浏览器故障只阻塞同平台，其他平台继续调度。

---

### Task 1: 浏览器启动错误分类

**Files:**
- Create: `src/browser/errors.js`
- Modify: `src/browser/browser-manager.js`
- Test: `test/unit/collector-factory.test.js`

**Interfaces:**
- Produces: `BrowserLaunchError`，错误码为 `BROWSER_LAUNCH_FAILED`，属性 `attempts` 保存候选名称和单行错误信息。
- Consumes: `resolveSystemBrowserLaunchOptions()` 返回的候选启动参数。

- [ ] **Step 1: Write the failing test**

新增测试：两个浏览器候选都启动失败时，`manager.newPage("instagram")` 拒绝并返回 `BROWSER_LAUNCH_FAILED`；`attempts` 精确包含两个候选和去除换行后的错误信息。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-reporter=spec test/unit/collector-factory.test.js`

Expected: FAIL，因为当前错误没有稳定错误码和候选诊断。

- [ ] **Step 3: Write minimal implementation**

创建错误类：

```js
export class BrowserLaunchError extends Error {
  constructor(attempts, options = {}) {
    super("无法启动采集浏览器，请从系统终端重新启动本工具后再继续", options);
    this.name = "BrowserLaunchError";
    this.code = "BROWSER_LAUNCH_FAILED";
    this.attempts = attempts;
  }
}
```

浏览器管理器循环中记录 `{ browser, error }`，全部失败后抛出该错误，最后一个原始错误保留为 `cause`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-reporter=spec test/unit/collector-factory.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/browser/errors.js src/browser/browser-manager.js test/unit/collector-factory.test.js
git commit -m "分类浏览器启动故障"
```

### Task 2: 平台级运行环境熔断

**Files:**
- Modify: `src/tasks/task-states.js`
- Modify: `src/tasks/task-manager.js`
- Test: `test/integration/task-manager.test.js`

**Interfaces:**
- Consumes: 错误码 `BROWSER_LAUNCH_FAILED`。
- Produces: 任务状态 `blocked`；任务字段 `blockReason`; `controlStatus().platformBlocks`; `recoverPlatform(platform)`。

- [ ] **Step 1: Write the failing tests**

新增四个行为测试：

1. 第一个照片墙任务出现浏览器启动错误后，同平台第二个任务不执行并统一进入 `blocked`，另一平台完成。
2. 平台受阻后启动新的待开始任务，该任务直接进入 `blocked`。
3. `recoverPlatform("instagram")` 把同平台全部 `blocked` 任务重新排队并清除熔断。
4. 磁盘中的 `blocked` 任务在服务重启时自动转为排队并完成。

断言实际任务状态、运行次数和控制状态，不断言内部集合。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-reporter=spec test/integration/task-manager.test.js`

Expected: FAIL，因为不存在 `blocked` 状态、阻塞原因和恢复方法。

- [ ] **Step 3: Write minimal implementation**

- 在 `TASK_STATUS` 与 `RESTARTABLE_STATUS` 中加入 `BLOCKED`。
- 新任务保存 `blockReason: null`。
- 将 `blockedPlatforms` 集合替换为 `platformBlocks` 映射，映射值固定为 `{ reason, message }`。
- 登录错误使用 `login` 阻塞和 `waiting_user` 状态；浏览器错误使用 `browser` 阻塞和 `blocked` 状态。
- 用每个任务的中断阻塞信息替换仅登录使用的中断集合，确保同平台运行任务被中止后进入正确状态。
- `recoverPlatform(platform)` 只恢复 `browser` 阻塞和 `blocked` 任务。
- 初始化时把旧 `waiting_user` 识别为登录阻塞，把 `blocked` 识别为可恢复任务并重新排队。
- `controlStatus()` 同时返回兼容的 `blockedPlatforms` 和结构化 `platformBlocks`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-reporter=spec test/integration/task-manager.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tasks/task-states.js src/tasks/task-manager.js test/integration/task-manager.test.js
git commit -m "增加平台运行环境熔断"
```

### Task 3: 显式恢复接口与界面

**Files:**
- Modify: `src/application/controller.js`
- Modify: `src/http/app.js`
- Modify: `public/app.js`
- Modify: `README.md`
- Test: `test/unit/application-controller.test.js`
- Test: `test/integration/api.test.js`
- Test: `test/e2e/task-center.test.js`

**Interfaces:**
- Consumes: 任务 `blockReason === "browser"` 和 `manager.recoverPlatform(platform)`。
- Produces: `POST /api/tasks/:id/recover` 与任务卡片“重新检测并继续”动作。

- [ ] **Step 1: Write the failing tests**

新增三个行为测试：

1. 控制器恢复浏览器阻塞时先关闭浏览器上下文，再恢复平台；登录任务不能调用该操作。
2. 恢复接口调用控制器并返回更新后的任务。
3. 网页对浏览器阻塞任务只显示“重新检测并继续”，不显示登录按钮，并在控制栏显示“浏览器运行环境受阻”。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-reporter=spec test/unit/application-controller.test.js test/integration/api.test.js test/e2e/task-center.test.js`

Expected: FAIL，因为恢复控制器、接口和界面动作不存在。

- [ ] **Step 3: Write minimal implementation**

- 控制器新增 `recoverBrowser(taskId)`，校验 `blocked/browser`，关闭浏览器管理器后调用任务管理器恢复平台。
- 路由动作加入 `recover`。
- 页面状态字典加入 `blocked`，受阻卡片仅显示取消、恢复和删除；控制栏优先显示浏览器受阻。
- 页面把 `blocked` 排除在持续轮询条件外，避免无意义请求。
- 文档写明：macOS 应从系统终端运行 `npm start`，不要从受限的编辑器任务进程启动。

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test --test-reporter=spec test/unit/application-controller.test.js test/integration/api.test.js test/e2e/task-center.test.js`

Expected: PASS。

- [ ] **Step 5: Run full verification**

Run: `npm test && npm run check && git diff --check`

Expected: 全部通过且退出码为 0。

- [ ] **Step 6: Commit**

```bash
git add src/application/controller.js src/http/app.js public/app.js README.md test/unit/application-controller.test.js test/integration/api.test.js test/e2e/task-center.test.js
git commit -m "提供浏览器故障整体恢复入口"
```

### Task 4: 运行态交付

**Files:**
- No repository changes.

**Interfaces:**
- Consumes: 已提交且验证通过的当前分支。
- Produces: 系统终端中的新服务进程和健康检查结果。

- [ ] **Step 1: Stop the existing service safely**

读取监听 `127.0.0.1:4310` 的进程，只终止命令属于当前项目服务的进程。

- [ ] **Step 2: Start from macOS Terminal**

用系统终端在项目目录执行 `npm start`，避免进程继承桌面开发环境沙箱。

- [ ] **Step 3: Verify runtime**

Run: `curl -fsS http://127.0.0.1:4310/api/health && curl -fsS http://127.0.0.1:4310/api/control`

Expected: 健康接口返回 `status: ok`，控制接口可读取且没有运行任务。
