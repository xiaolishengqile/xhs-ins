# Batch Task Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复浏览器请求上下文提前销毁的问题，并交付浏览器常驻、任务页统一回收、全局暂停继续、文件批量导入及已完成任务汇总下载。

**Architecture:** 浏览器管理器只拥有平台级持久上下文和常驻页，每个任务通过独立会话登记页面并贯穿采集与导出。任务管理器拥有会话和调度状态，新增小型原子状态存储；批量输入解析和汇总压缩分别放入独立模块，页面只负责交互与调用接口。

**Tech Stack:** Node.js 22、原生 HTTP 服务、Playwright 1.62、yazl 3.3、原生 Node.js 测试运行器、浏览器端原生 JavaScript。

**Spec:** `docs/superpowers/specs/2026-08-28-batch-task-control-design.md`

## Global Constraints

- 每个平台只有一个持久浏览器上下文和一个不可分配给任务的常驻空白页。
- 正常任务必须在采集、媒体下载和单任务归档全部完成后才关闭任务页。
- 暂停、取消和失败必须关闭任务页；等待人工处理只保留验证页。
- 全局暂停冻结队列；继续后已暂停任务从头执行；最大并发数固定为 5。
- 文件单次最多导入 500 个唯一链接；无效项跳过并返回行号和原因。
- 汇总下载只包含点击时已完成且结果文件存在的任务。
- 不增加数据库和前端框架，不改变现有单任务接口的含义。
- 所有用户可见提示使用中文；每个可独立验证的改造使用中文提交信息。

---

## File Structure

### 新建文件

- `src/browser/task-browser-session.js`：登记单个任务拥有的页面、复用人工验证页、代理媒体请求并执行幂等清理。
- `src/tasks/scheduler-state-store.js`：原子保存和读取全局暂停状态。
- `src/tasks/batch-input.js`：校验批量条目、保留行号、去重并限制 500 条。
- `src/export/completed-archive.js`：为已完成任务生成流式汇总压缩包和清单。
- `public/link-import.js`：从文本或逗号分隔内容中提取带行号的链接。
- `test/helpers/zip.js`：跨平台读取压缩包条目，移除测试对系统解压命令的依赖。
- `test/unit/batch-input.test.js`：批量输入规则测试。
- `test/unit/link-import.test.js`：文件文本提取测试。

### 修改文件

- `src/browser/browser-manager.js`：创建常驻页、创建任务会话、处理上下文意外关闭。
- `src/collectors/collector-factory.js`：允许为一次任务注入任务浏览器会话。
- `src/collectors/instagram/collector.js`：不再自行关闭任务页，只标记人工验证页。
- `src/collectors/xiaohongshu/collector.js`：不再自行关闭任务页，只移除响应监听并标记人工验证页。
- `src/tasks/task-states.js`：增加 `paused` 状态及重启恢复集合。
- `src/tasks/task-manager.js`：拥有任务会话、全局暂停状态、批量创建和统一资源清理。
- `src/export/archive.js`：保持单任务归档行为并配合跨平台压缩测试。
- `src/server.js`：注入调度状态存储和任务会话，将媒体下载绑定到任务会话。
- `src/http/app.js`：增加批量创建、控制状态、暂停继续和汇总下载接口。
- `public/index.html`：增加文件导入和全局控制区。
- `public/app.js`：增加文件解析、批量提交、调度状态渲染和汇总下载交互。
- `public/styles.css`：增加文件导入和控制区样式及响应式布局。
- `README.md`：更新使用流程、数据位置和新能力。
- `test/unit/collector-factory.test.js`：覆盖常驻页和任务会话。
- `test/unit/task-store.test.js`：覆盖调度状态原子持久化。
- `test/unit/export.test.js`：覆盖汇总压缩并改为跨平台解析。
- `test/integration/instagram-collector.test.js`：断言采集器不再关闭任务页。
- `test/integration/xiaohongshu-collector.test.js`：断言采集器不再关闭任务页。
- `test/integration/task-manager.test.js`：覆盖任务会话、导出顺序、暂停继续和并发上限。
- `test/integration/api.test.js`：覆盖新增接口和兼容接口。
- `test/e2e/task-center.test.js`：覆盖文件导入、暂停继续和汇总下载按钮。

---

### Task 1: 平台常驻页与任务浏览器会话

**Files:**
- Create: `src/browser/task-browser-session.js`
- Modify: `src/browser/browser-manager.js`
- Test: `test/unit/collector-factory.test.js`

**Interfaces:**
- Consumes: `BrowserManager.#context(platform): Promise<BrowserContext>` 和现有媒体地址校验。
- Produces: `BrowserManager.createTaskSession(platform, taskId): Promise<TaskBrowserSession>`；`TaskBrowserSession.newPage()`；`TaskBrowserSession.fetchBuffer(url)`；`TaskBrowserSession.retainPageForHumanAction(platform, page)`；`TaskBrowserSession.close({ preserveHumanAction }): Promise<void>`。

- [ ] **Step 1: 写常驻页不被分配和任务会话幂等清理的失败测试**

```js
test("平台首个空白页只用于保持浏览器且任务使用新页面", async (t) => {
  const initialPage = fakePage("about:blank");
  const createdPages = [];
  const context = fakeContext({ initialPage, createdPages });
  const manager = new BrowserManager({ profilesDir, launchPersistentContext: async () => context });
  t.after(() => manager.close());

  const session = await manager.createTaskSession("instagram", "task-1");
  const taskPage = await session.newPage();

  assert.notEqual(taskPage, initialPage);
  await session.close();
  assert.equal(taskPage.closed, true);
  assert.equal(initialPage.closed, false);
});

test("等待人工处理只保留被标记页面并可由下一次会话复用", async () => {
  const session = await manager.createTaskSession("instagram", "task-1");
  const profile = await session.newPage();
  const verification = await session.newPage();
  await session.retainPageForHumanAction("instagram", verification);
  await session.close({ preserveHumanAction: true });
  assert.equal(profile.closed, true);
  assert.equal(verification.closed, false);

  const resumed = await manager.createTaskSession("instagram", "task-1");
  assert.equal(await resumed.newPage(), verification);
  await resumed.close();
  assert.equal(verification.closed, true);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test --test-name-pattern="常驻|等待人工处理只保留" test/unit/collector-factory.test.js`

Expected: FAIL，提示 `createTaskSession` 不存在，或旧逻辑错误复用首个空白页。

- [ ] **Step 3: 实现任务会话和常驻页所有权**

```js
// src/browser/task-browser-session.js
export class TaskBrowserSession {
  constructor({ manager, platform, taskId, retainedPages = [] }) {
    this.manager = manager;
    this.platform = platform;
    this.taskId = taskId;
    this.pages = new Set(retainedPages);
    this.retainedPages = new Set(retainedPages);
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
    return this.manager.fetchBuffer(this.platform, url);
  }

  async retainPageForHumanAction(_platform, page) {
    if (this.pages.has(page)) this.retainedPages.add(page);
  }

  async close({ preserveHumanAction = false } = {}) {
    if (this.closed) return;
    const keep = preserveHumanAction ? this.retainedPages : new Set();
    await Promise.allSettled([...this.pages].filter((page) => !keep.has(page)).map((page) => page.close()));
    this.pages = new Set(keep);
    if (keep.size === 0) this.closed = true;
    this.manager.releaseTaskSession(this, { preserveHumanAction });
  }
}
```

在 `BrowserManager.#launch()` 中把启动后已有的首个空白页保存到 `keepalivePages`；若浏览器未自动创建页面，则主动创建一个。`createTaskPage()` 始终调用上下文的 `newPage()`。`createTaskSession()` 按任务编号恢复人工验证页，但不会把常驻页放入会话。监听上下文 `close` 事件并清理对应缓存，确保下次任务可重新启动。

- [ ] **Step 4: 运行浏览器管理器测试**

Run: `node --test test/unit/collector-factory.test.js`

Expected: PASS；原“复用自动生成首个空白页”测试已改为断言该空白页保持常驻且任务获得新页面。

- [ ] **Step 5: 提交完整浏览器会话能力**

```bash
git add src/browser/task-browser-session.js src/browser/browser-manager.js test/unit/collector-factory.test.js
git commit -m "实现任务浏览器会话与常驻页面"
```

---

### Task 2: 采集器移交页面生命周期

**Files:**
- Modify: `src/collectors/collector-factory.js`
- Modify: `src/collectors/instagram/collector.js`
- Modify: `src/collectors/xiaohongshu/collector.js`
- Test: `test/integration/instagram-collector.test.js`
- Test: `test/integration/xiaohongshu-collector.test.js`

**Interfaces:**
- Consumes: Task 1 的任务会话，其表面接口兼容采集器当前使用的 `newPage()` 与 `retainPageForHumanAction()`。
- Produces: `createCollectorFactory(...)(platform, browserSession)`；采集器返回后页面仍由会话持有，不自行关闭。

- [ ] **Step 1: 把正常采集测试改为断言采集器不关闭页面**

```js
const result = await collector.collect(task(), options);
assert.deepEqual(result.notes.map((note) => note.id), ["note-image-1"]);
assert.equal(profilePage.closed, false);
assert.equal(detailPage.closed, false);
```

人工验证测试继续断言活动页被调用 `retainPageForHumanAction()`，同时非活动页也暂不由采集器直接关闭。

- [ ] **Step 2: 运行两个采集器测试并确认失败**

Run: `node --test test/integration/instagram-collector.test.js test/integration/xiaohongshu-collector.test.js`

Expected: FAIL，现有 `finally` 会关闭页面。

- [ ] **Step 3: 删除采集器页面关闭职责并调整工厂注入**

```js
export function createCollectorFactory({ browserManager, collectors }) {
  return (platform, browserSession = browserManager) => {
    const Collector = collectors[platform];
    if (!Collector) throw new Error(`不支持的平台：${platform}`);
    return new Collector({ browserManager: browserSession });
  };
}
```

Instagram 采集器移除 `finally` 中的 `page.close()`；小红书采集器的 `finally` 只解绑响应监听，不关闭页面。两者保留对活动验证页的标记，不再调用平台级统一关闭人工页面的方法。

- [ ] **Step 4: 运行采集器与工厂测试**

Run: `node --test test/integration/instagram-collector.test.js test/integration/xiaohongshu-collector.test.js test/unit/collector-factory.test.js`

Expected: PASS。

- [ ] **Step 5: 提交页面生命周期移交**

```bash
git add src/collectors/collector-factory.js src/collectors/instagram/collector.js src/collectors/xiaohongshu/collector.js test/integration/instagram-collector.test.js test/integration/xiaohongshu-collector.test.js
git commit -m "统一采集任务页面生命周期"
```

---

### Task 3: 任务会话贯穿采集、下载和归档

**Files:**
- Modify: `src/tasks/task-manager.js`
- Modify: `src/server.js`
- Test: `test/integration/task-manager.test.js`

**Interfaces:**
- Consumes: `taskSessionFactory(task): Promise<TaskBrowserSession>`；`collectorFactory(platform, session)`；`exporter(task, notes, taskDir, { signal, onProgress, browserSession })`。
- Produces: 任务管理器在 `finally` 中调用 `browserSession.close({ preserveHumanAction })`，保证正常导出完成前页面仍存活。

- [ ] **Step 1: 写“导出完成前不关闭页面”的失败回归测试**

```js
test("任务页面在媒体导出后才关闭", async (t) => {
  const events = [];
  const browserSession = {
    close: async () => events.push("close"),
    fetchBuffer: async () => {
      events.push("fetch");
      return Buffer.from("image");
    },
  };
  const manager = await managerFixture(t, async () => {
    events.push("collect");
    return { author: "测试博主", notes: [] };
  }, {
    taskSessionFactory: async () => browserSession,
    exporter: async (_task, _notes, taskDir, { browserSession: activeSession }) => {
      await activeSession.fetchBuffer("https://example.com/image.jpg");
      events.push("archive");
      return path.join(taskDir, "result.zip");
    },
  });
  const created = await manager.create(input(0));
  await eventually(() => assert.equal(manager.get(created.id).status, "completed"));
  assert.deepEqual(events, ["collect", "fetch", "archive", "close"]);
});
```

```js
test("失败取消会清理会话而人工验证只保留验证页", async (t) => {
  const closeOptions = [];
  const session = { close: async (options = {}) => closeOptions.push(options) };
  const failing = await managerFixture(t, async () => { throw new Error("页面失败"); }, {
    taskSessionFactory: async () => session,
  });
  const failedTask = await failing.create(input(0));
  await eventually(() => assert.equal(failing.get(failedTask.id).status, "failed"));
  assert.deepEqual(closeOptions.shift(), { preserveHumanAction: false });

  const waiting = await managerFixture(t, async () => { throw new LoginRequiredError(); }, {
    taskSessionFactory: async () => session,
  });
  const waitingTask = await waiting.create(input(1));
  await eventually(() => assert.equal(waiting.get(waitingTask.id).status, "waiting_user"));
  assert.deepEqual(closeOptions.shift(), { preserveHumanAction: true });
});
```

- [ ] **Step 2: 运行回归测试并确认失败**

Run: `node --test --test-name-pattern="任务页面|人工验证保留" test/integration/task-manager.test.js`

Expected: FAIL，现有任务管理器没有创建、传递或关闭任务会话。

- [ ] **Step 3: 在任务管理器集中管理会话**

```js
// TaskManager constructor
this.taskSessionFactory = taskSessionFactory ?? (async () => null);

// #run
let browserSession = null;
let preserveHumanAction = false;
try {
  browserSession = await this.taskSessionFactory(clone(task));
  const collector = this.collectorFactory(task.platform, browserSession);
  const result = await collector.collect(clone(task), { signal: controller.signal, onProgress });
  task.resultPath = await this.exporter(task, result.notes ?? [], this.store.taskDir(task.id), {
    signal: controller.signal,
    onProgress,
    browserSession,
  });
  task.status = TASK_STATUS.COMPLETED;
} catch (error) {
  preserveHumanAction = error?.code === "HUMAN_ACTION_REQUIRED";
  if (controller.signal.aborted || error?.name === "AbortError") {
    task.status = TASK_STATUS.CANCELLED;
    task.error = null;
    task.progress.stage = "已取消";
  } else if (preserveHumanAction) {
    task.status = TASK_STATUS.WAITING_USER;
    task.error = errorMessage(error);
    task.progress.stage = "等待人工登录或验证";
  } else {
    task.status = TASK_STATUS.FAILED;
    task.error = errorMessage(error);
    task.progress.stage = "采集失败";
  }
} finally {
  await browserSession?.close({ preserveHumanAction });
  task.updatedAt = this.now().toISOString();
  this.running.delete(task.id);
  await this.store.save(task);
  this.#requestSchedule();
}
```

`src/server.js` 注入 `taskSessionFactory: (task) => browserManager.createTaskSession(task.platform, task.id)`；导出器只使用传入的 `browserSession.fetchBuffer(url)`，不再直接从全局浏览器管理器取请求上下文。

- [ ] **Step 4: 运行任务管理器回归测试**

Run: `node --test test/integration/task-manager.test.js test/unit/export.test.js`

Expected: PASS，事件顺序固定为采集、下载、归档、关闭。

- [ ] **Step 5: 提交贯穿式任务会话**

```bash
git add src/tasks/task-manager.js src/server.js test/integration/task-manager.test.js
git commit -m "修复媒体下载上下文提前关闭"
```

---

### Task 4: 持久化全局暂停并从头恢复任务

**Files:**
- Create: `src/tasks/scheduler-state-store.js`
- Modify: `src/tasks/task-states.js`
- Modify: `src/tasks/task-manager.js`
- Modify: `src/server.js`
- Test: `test/unit/task-store.test.js`
- Test: `test/integration/task-manager.test.js`

**Interfaces:**
- Consumes: `SchedulerStateStore.load(): Promise<{ paused: boolean, updatedAt: string | null }>`；`save(state): Promise<void>`。
- Produces: `TaskManager.controlStatus()`；`pauseAll()`；`resumeAll()`；任务状态 `TASK_STATUS.PAUSED`。

- [ ] **Step 1: 写调度状态原子存储失败测试**

```js
test("调度暂停状态可原子保存并重新读取", async (t) => {
  const filePath = path.join(rootDir, "scheduler.json");
  const store = new SchedulerStateStore(filePath);
  assert.deepEqual(await store.load(), { paused: false, updatedAt: null });
  await store.save({ paused: true, updatedAt: "2026-08-28T12:00:00.000Z" });
  assert.deepEqual(await store.load(), { paused: true, updatedAt: "2026-08-28T12:00:00.000Z" });
  assert.deepEqual((await readdir(rootDir)).filter((name) => name.endsWith(".tmp")), []);
});
```

- [ ] **Step 2: 写暂停、冻结队列、继续重跑和重启保持暂停的失败测试**

```js
test("暂停全部会停止运行任务并冻结队列直到继续", async (t) => {
  const manager = await managerFixture(t, blockingCollector, { maxConcurrency: 1, controlStore });
  const first = await manager.create(input(0));
  const second = await manager.create(input(1));
  await eventually(() => assert.equal(manager.get(first.id).status, "running"));

  await manager.pauseAll();
  assert.equal(manager.get(first.id).status, "paused");
  assert.equal(manager.get(second.id).status, "queued");
  assert.equal(manager.controlStatus().paused, true);

  await manager.resumeAll();
  await eventually(() => assert.equal(manager.get(first.id).status, "running"));
  assert.equal(runCounts.get(first.id), 2);
});
```

```js
test("服务重启后保持暂停且运行中任务转为已暂停", async (t) => {
  await controlStore.save({ paused: true, updatedAt: "2026-08-28T12:00:00.000Z" });
  await taskStore.save(savedRunningTask);
  let runs = 0;
  const manager = new TaskManager({
    store: taskStore,
    controlStore,
    collectorFactory: () => ({ collect: async () => { runs += 1; return { author: "恢复", notes: [] }; } }),
    exporter: async () => resultPath,
  });
  t.after(() => manager.shutdown());

  await manager.init();
  assert.equal(manager.get(savedRunningTask.id).status, "paused");
  assert.equal(runs, 0);
  await manager.resumeAll();
  await eventually(() => assert.equal(manager.get(savedRunningTask.id).status, "completed"));
  assert.equal(runs, 1);
});
```

- [ ] **Step 3: 运行新增测试并确认失败**

Run: `node --test test/unit/task-store.test.js test/integration/task-manager.test.js`

Expected: FAIL，暂停状态、存储和方法尚不存在。

- [ ] **Step 4: 实现状态存储与调度语义**

```js
export const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  WAITING_USER: "waiting_user",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});
```

`SchedulerStateStore` 使用与 `TaskStore.save()` 相同的临时文件加重命名方式。任务管理器初始化时先读取控制状态，再加载任务；`#schedule()` 在 `this.paused` 时直接返回。`pauseAll()` 先持久化暂停状态，再标记运行任务的暂停意图并中止，等待这些运行承诺结束后返回。中止捕获根据暂停意图写入 `paused`，而非 `cancelled`。`resumeAll()` 先把暂停任务重置为排队、进度归零、结果路径清空，再持久化解除暂停并调度。

- [ ] **Step 5: 运行调度和存储测试**

Run: `node --test test/unit/task-store.test.js test/integration/task-manager.test.js`

Expected: PASS；任何时刻运行任务不超过配置上限。

- [ ] **Step 6: 提交暂停继续能力**

```bash
git add src/tasks/scheduler-state-store.js src/tasks/task-states.js src/tasks/task-manager.js src/server.js test/unit/task-store.test.js test/integration/task-manager.test.js
git commit -m "实现全局暂停与继续调度"
```

---

### Task 5: 批量链接校验与创建接口

**Files:**
- Create: `src/tasks/batch-input.js`
- Create: `test/unit/batch-input.test.js`
- Modify: `src/tasks/task-manager.js`
- Modify: `src/http/app.js`
- Test: `test/integration/api.test.js`

**Interfaces:**
- Consumes: 请求 `{ entries: Array<{ line: number, url: string }>, range }` 和现有 `TaskManager.create({ url, range })`。
- Produces: `normalizeBatchEntries(entries, { maxUnique: 500 })`；`TaskManager.createBatch({ entries, range })`；`POST /api/tasks/batch`。

- [ ] **Step 1: 写带行号去重和数量限制的失败单元测试**

```js
test("批量条目保留行号并对规范化链接去重", () => {
  const result = normalizeBatchEntries([
    { line: 2, url: "https://www.instagram.com/test.user/" },
    { line: 3, url: "https://www.instagram.com/test.user/?igsh=abc" },
    { line: 4, url: "not-a-url" },
  ]);
  assert.equal(result.valid.length, 1);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.rejected, [{ line: 4, url: "not-a-url", reason: "仅支持小红书或 Instagram 的公开博主主页链接" }]);
});

test("批量唯一链接不能超过五百条", () => {
  const entries = Array.from({ length: 501 }, (_, index) => ({
    line: index + 1,
    url: `https://www.instagram.com/user_${index}/`,
  }));
  assert.throws(() => normalizeBatchEntries(entries), /最多导入 500/);
});
```

- [ ] **Step 2: 运行批量输入测试并确认失败**

Run: `node --test test/unit/batch-input.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯批量校验函数**

```js
export function normalizeBatchEntries(entries, { maxUnique = 500 } = {}) {
  if (!Array.isArray(entries)) throw new Error("批量链接格式无效");
  const seen = new Set();
  const valid = [];
  const rejected = [];
  let duplicates = 0;
  for (const [index, entry] of entries.entries()) {
    const line = Number.isInteger(entry?.line) && entry.line > 0 ? entry.line : index + 1;
    try {
      const profile = normalizeProfileUrl(entry?.url);
      if (seen.has(profile.url)) { duplicates += 1; continue; }
      seen.add(profile.url);
      if (seen.size > maxUnique) throw Object.assign(new Error(`单次最多导入 ${maxUnique} 个唯一链接`), { statusCode: 413 });
      valid.push({ line, url: profile.url });
    } catch (error) {
      if (error.statusCode === 413) throw error;
      rejected.push({ line, url: String(entry?.url ?? ""), reason: error.message });
    }
  }
  return { valid, rejected, duplicates };
}
```

- [ ] **Step 4: 写并运行批量接口失败测试**

```js
const result = await json(await fetch(`${url}/api/tasks/batch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    entries: [
      { line: 1, url: "https://www.instagram.com/one/" },
      { line: 2, url: "broken" },
      { line: 3, url: "https://www.instagram.com/two/" },
    ],
    range: { preset: "week" },
  }),
}));
assert.equal(result.response.status, 202);
assert.equal(result.body.tasks.length, 2);
assert.equal(result.body.rejected[0].line, 2);
```

Run: `node --test --test-name-pattern="批量" test/integration/api.test.js`

Expected: FAIL，接口返回 404。

- [ ] **Step 5: 实现批量创建并返回部分成功摘要**

```js
async createBatch({ entries, range }) {
  const normalized = normalizeBatchEntries(entries);
  const tasks = [];
  for (const entry of normalized.valid) {
    try {
      tasks.push(await this.create({ url: entry.url, range }));
    } catch (error) {
      normalized.rejected.push({ line: entry.line, url: entry.url, reason: errorMessage(error) });
    }
  }
  return { tasks, rejected: normalized.rejected, duplicates: normalized.duplicates };
}
```

路由在单任务创建路由之前处理 `/api/tasks/batch`：

```js
if (request.method === "POST" && pathname === "/api/tasks/batch") {
  const result = await manager.createBatch(await readJson(request));
  return sendJson(response, 202, { ...result, control: manager.controlStatus() });
}
```

全局暂停时新任务仍创建为排队，但 `#schedule()` 不会启动它们。

- [ ] **Step 6: 运行批量模块和接口测试**

Run: `node --test test/unit/batch-input.test.js test/integration/api.test.js test/integration/task-manager.test.js`

Expected: PASS。

- [ ] **Step 7: 提交批量创建接口**

```bash
git add src/tasks/batch-input.js src/tasks/task-manager.js src/http/app.js test/unit/batch-input.test.js test/integration/api.test.js
git commit -m "增加文件链接批量创建接口"
```

---

### Task 6: 控制接口与已完成任务汇总下载

**Files:**
- Create: `src/export/completed-archive.js`
- Create: `test/helpers/zip.js`
- Modify: `src/http/app.js`
- Modify: `test/unit/export.test.js`
- Modify: `test/integration/api.test.js`

**Interfaces:**
- Consumes: `manager.controlStatus()`；`manager.pauseAll()`；`manager.resumeAll()`；`manager.list()` 中 `completed` 且存在 `resultPath` 的任务。
- Produces: `createCompletedArchive(tasks): Promise<{ outputStream, included, missing }>`；`GET /api/control`；`POST /api/control/pause`；`POST /api/control/resume`；`GET /api/tasks/download-completed`。

- [ ] **Step 1: 先用跨平台压缩读取辅助函数替换系统命令**

```js
// test/helpers/zip.js
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("压缩包中央目录不存在");
}

export async function readZipEntries(filePath) {
  const buffer = await readFile(filePath);
  const entries = new Map();
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("压缩包中央目录损坏");
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const body = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (body === null) throw new Error(`不支持的压缩方式：${method}`);
    entries.set(name, body);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
```

修改现有“压缩包包含数据表和已下载图片”测试：

```js
const entries = await readZipEntries(archivePath);
assert.ok([...entries.keys()].some((name) => name.endsWith("/notes.csv")));
assert.ok([...entries.keys()].some((name) => name.endsWith("/images/2026-08-28-n1/01.jpg")));
```

- [ ] **Step 2: 运行现有导出测试确认跨平台辅助函数有效**

Run: `node --test test/unit/export.test.js`

Expected: PASS，且不再依赖系统中的 `unzip` 命令。

- [ ] **Step 3: 写汇总压缩包失败测试**

```js
test("汇总压缩只加入存在的完成任务并写入遗漏清单", async (t) => {
  const firstPath = path.join(rootDir, "first.zip");
  await writeFile(firstPath, "first-result");
  const archive = await createCompletedArchive([
    { id: "first-id", status: "completed", platform: "instagram", author: "作者", resultPath: firstPath },
    { id: "missing-id", status: "completed", platform: "instagram", author: "缺失", resultPath: path.join(rootDir, "missing.zip") },
    { id: "running-id", status: "running", resultPath: firstPath },
  ]);
  const target = path.join(rootDir, "all.zip");
  await pipeline(archive.outputStream, createWriteStream(target));
  const entries = await readZipEntries(target);
  assert.equal([...entries.keys()].filter((name) => name.endsWith(".zip")).length, 1);
  assert.match(entries.get("manifest.json").toString("utf8"), /missing-id/);
});
```

- [ ] **Step 4: 运行汇总导出测试并确认失败**

Run: `node --test --test-name-pattern="汇总" test/unit/export.test.js`

Expected: FAIL，汇总压缩模块不存在。

- [ ] **Step 5: 实现流式汇总压缩**

```js
export async function createCompletedArchive(tasks) {
  const zip = new yazl.ZipFile();
  const included = [];
  const missing = [];
  for (const task of tasks.filter((item) => item.status === "completed" && item.resultPath)) {
    try {
      await stat(task.resultPath);
      const fileName = safeFileName(`${task.platform}-${task.author ?? task.profileKey}-${task.id}`) + ".zip";
      zip.addFile(task.resultPath, `results/${fileName}`);
      included.push({ id: task.id, fileName });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push({ id: task.id, reason: "结果文件不存在" });
    }
  }
  if (included.length === 0) throw Object.assign(new Error("当前没有可下载的已完成任务"), { statusCode: 409 });
  zip.addBuffer(Buffer.from(JSON.stringify({ included, missing }, null, 2)), "manifest.json");
  zip.end();
  return { outputStream: zip.outputStream, included, missing };
}
```

- [ ] **Step 6: 写新增控制和下载接口测试**

```js
assert.deepEqual((await json(await fetch(`${url}/api/control`))).body, {
  paused: false, maxConcurrency: 5, running: 0, queued: 0, pausedTasks: 0,
});
assert.equal((await fetch(`${url}/api/control/pause`, { method: "POST" })).status, 200);
assert.equal((await fetch(`${url}/api/control/resume`, { method: "POST" })).status, 200);

const archiveResponse = await fetch(`${url}/api/tasks/download-completed`);
assert.equal(archiveResponse.status, 200);
assert.match(archiveResponse.headers.get("content-disposition"), /attachment/);
```

同时断言没有完成任务时下载接口返回 409。

- [ ] **Step 7: 实现控制路由和汇总下载路由**

```js
if (request.method === "GET" && pathname === "/api/control") {
  return sendJson(response, 200, manager.controlStatus());
}
if (request.method === "POST" && pathname === "/api/control/pause") {
  return sendJson(response, 200, await manager.pauseAll());
}
if (request.method === "POST" && pathname === "/api/control/resume") {
  return sendJson(response, 200, await manager.resumeAll());
}
if (request.method === "GET" && pathname === "/api/tasks/download-completed") {
  const archive = await createCompletedArchive(manager.list());
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="completed-tasks.zip"',
    "x-content-type-options": "nosniff",
  });
  archive.outputStream.pipe(response);
  return;
}
```

汇总下载在调用 `manager.list()` 时取得点击快照；流式响应不设置未知的内容长度。

- [ ] **Step 8: 运行导出和接口测试**

Run: `node --test test/unit/export.test.js test/integration/api.test.js`

Expected: PASS。

- [ ] **Step 9: 提交控制与汇总下载接口**

```bash
git add src/export/completed-archive.js test/helpers/zip.js src/http/app.js test/unit/export.test.js test/integration/api.test.js
git commit -m "增加全局控制与汇总下载接口"
```

---

### Task 7: 文件解析与页面全局控制区

**Files:**
- Create: `public/link-import.js`
- Create: `test/unit/link-import.test.js`
- Modify: `src/http/app.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `test/e2e/task-center.test.js`

**Interfaces:**
- Consumes: `extractLinkEntries(text)`；Task 5、6 的批量与控制接口。
- Produces: 文件选择器、导入摘要、“暂停全部／继续全部”和“下载已完成任务（数量）”交互。

- [ ] **Step 1: 写文件内容提取失败测试**

```js
test("文本和逗号分隔内容会提取链接并保留原始行号", () => {
  assert.deepEqual(extractLinkEntries([
    "姓名,链接",
    "甲,https://www.instagram.com/one/",
    "https://www.xiaohongshu.com/user/profile/two",
  ].join("\n")), [
    { line: 2, url: "https://www.instagram.com/one/" },
    { line: 3, url: "https://www.xiaohongshu.com/user/profile/two" },
  ]);
});
```

- [ ] **Step 2: 运行解析测试并确认失败**

Run: `node --test test/unit/link-import.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现无界面依赖的链接提取函数并开放静态文件**

```js
export function extractLinkEntries(text) {
  return String(text ?? "").split(/\r?\n/).flatMap((lineText, index) => {
    const matches = lineText.match(/https?:\/\/[^\s,"'<>]+/g) ?? [];
    return matches.map((url) => ({ line: index + 1, url: url.trim() }));
  });
}
```

在静态文件表中加入 `/link-import.js`，以便 `public/app.js` 使用模块导入。

- [ ] **Step 4: 写页面端失败测试**

```js
test("上传链接文件会创建多任务并保持五个并发", async (t) => {
  await page.goto(url);
  await page.getByLabel("链接文件").setInputFiles({
    name: "links.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(Array.from({ length: 8 }, (_, index) =>
      `https://www.instagram.com/file_user_${index}/`).join("\n")),
  });
  await page.getByRole("button", { name: "导入文件" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-status="running"]').length === 5);
  assert.equal(manager.list().length, 8);
});

test("暂停全部和继续全部会更新任务卡片与控制按钮", async () => {
  await page.getByRole("button", { name: "暂停全部" }).click();
  await page.getByText("队列已暂停").waitFor();
  assert.equal(await page.locator('[data-status="paused"]').count(), 5);
  await page.getByRole("button", { name: "继续全部" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-status="running"]').length === 5);
});
```

```js
test("汇总下载按钮显示完成数量且无结果时禁用", async (t) => {
  const { manager, page, url } = await fixture(t, async (task) => ({ author: task.profileKey, notes: [] }));
  await page.goto(url);
  const downloadAll = page.getByRole("link", { name: "下载已完成任务（1）" });
  assert.equal(await page.getByRole("button", { name: "下载已完成任务（0）" }).isDisabled(), true);
  await manager.create({ url: "https://www.instagram.com/all_download/", range: { preset: "week" } });
  await eventually(() => assert.equal(manager.list()[0].status, "completed"));
  await page.reload();
  assert.equal(await downloadAll.getAttribute("href"), "/api/tasks/download-completed");
});
```

- [ ] **Step 5: 运行页面测试并确认失败**

Run: `node --test --test-name-pattern="上传链接文件|暂停全部|下载已完成" test/e2e/task-center.test.js`

Expected: FAIL，页面控件不存在。

- [ ] **Step 6: 实现页面结构和状态渲染**

`index.html` 在日期范围下方增加文件选择器和导入按钮；任务概览增加“已暂停”；任务列表标题区域增加全局控制按钮和汇总下载链接。

`app.js`：

```js
import { extractLinkEntries } from "/link-import.js";

async function refresh() {
  const [taskResult, control] = await Promise.all([
    request("/api/tasks"),
    request("/api/control"),
  ]);
  render(taskResult.tasks, control);
}

fileImportButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file) return showMessage("请选择链接文件");
  const entries = extractLinkEntries(await file.text());
  if (entries.length === 0) return showMessage("文件中没有找到链接");
  const result = await request("/api/tasks/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries, range: selectedRange() }),
  });
  showMessage(`已创建 ${result.tasks.length} 个任务，跳过 ${result.rejected.length} 个无效链接和 ${result.duplicates} 个重复链接。`);
  await refresh();
});
```

暂停按钮根据控制状态调用 `/api/control/pause` 或 `/api/control/resume`。汇总下载链接指向 `/api/tasks/download-completed`，完成数为零时使用禁用按钮。`paused` 加入状态文案、活动任务轮询范围和任务卡片样式。

- [ ] **Step 7: 运行页面解析与端到端测试**

Run: `node --test test/unit/link-import.test.js test/e2e/task-center.test.js`

Expected: PASS。

- [ ] **Step 8: 提交页面批量操作能力**

```bash
git add public/link-import.js test/unit/link-import.test.js src/http/app.js public/index.html public/app.js public/styles.css test/e2e/task-center.test.js
git commit -m "实现文件导入与任务全局控制界面"
```

---

### Task 8: 文档更新与完整回归验证

**Files:**
- Modify: `README.md`
- Verify: all changed source, public, unit, integration, and end-to-end tests

**Interfaces:**
- Consumes: Tasks 1-7 的最终用户行为和数据目录。
- Produces: 与实际行为一致的安装、操作、暂停恢复、文件导入、下载及数据说明。

- [ ] **Step 1: 更新能力、使用流程和数据目录**

README 明确：

- 手工输入仍可快速创建任务，文件可导入最多 500 个唯一链接；
- 最多 5 个任务并发，其余排队；
- “暂停全部”会停止运行任务并冻结队列，“继续全部”会让暂停任务从头采集；
- 浏览器在服务运行期间保持打开，任务完成后只关闭任务标签页；
- 可下载单任务结果或点击一次下载当前所有已完成结果；
- `.data/scheduler.json` 保存全局暂停状态。

- [ ] **Step 2: 运行所有测试**

Run: `node --test --test-reporter=spec test/**/*.test.js`

Expected: 全部 PASS；不再因为 Windows 缺少 `unzip` 失败。

- [ ] **Step 3: 检查所有 JavaScript 语法**

Run: `Get-ChildItem src,public,scripts -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }`

Expected: 每个文件退出码均为 0，无语法错误。

- [ ] **Step 4: 检查差异和仓库状态**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 只显示本任务预期修改的 README；其他代码均已在前序任务提交。

- [ ] **Step 5: 提交文档与最终验证结果**

```bash
git add README.md
git commit -m "更新批量采集与暂停使用说明"
```

- [ ] **Step 6: 最终确认提交记录和工作区**

Run: `git status --short --branch && git log --oneline -10`

Expected: 工作区干净；提交记录包含 Tasks 1-8 的中文功能提交。
