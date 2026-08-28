# 公开博主图片采集工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本机网页工具，可同时运行 5 个小红书或 Instagram 公开博主图片采集任务，并导出图片压缩包和笔记数据表。

**Architecture:** 使用 Node.js 单进程提供本地网页和接口，通过容量固定为 5 的任务管理器调度独立采集任务。平台采集器复用持久化浏览器会话但使用独立页面，任务状态和下载结果按任务目录隔离保存。

**Tech Stack:** Node.js 22、原生网页技术、Playwright 1.62.1、yazl 3.3.1、Node.js 内置测试运行器

**Spec:** `docs/superpowers/specs/2026-08-28-social-media-image-collector-design.md`

## Global Constraints

- 服务只监听 `127.0.0.1`，只允许小红书和 Instagram 已知域名。
- 同时运行上限固定为 5；第 6 个任务必须等待且提交请求不能阻塞。
- 图文笔记下载全部公开图片，视频笔记只保存公开封面，不下载视频。
- 未公开互动字段保存为空，不把缺失值写成零。
- 不绕过验证码；检测到登录或验证页面时将任务置为等待人工处理。
- 业务模块保持小文件、低耦合，平台差异限制在采集器目录内。
- 每个任务完成一个可测试交付物后使用中文提交信息提交。

---

### Task 1: 项目基础、链接识别与日期范围

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/domain/platform.js`
- Create: `src/domain/date-range.js`
- Test: `test/unit/platform.test.js`
- Test: `test/unit/date-range.test.js`

**Interfaces:**
- Produces: `detectPlatform(url): "xiaohongshu" | "instagram"`
- Produces: `normalizeProfileUrl(url): { platform, url, profileKey }`
- Produces: `resolveDateRange(input, now?): { from, to }`

- [ ] **Step 1: Write failing platform tests**

```js
assert.deepEqual(normalizeProfileUrl("https://www.xiaohongshu.com/user/profile/abc?xsec_token=temp"), {
  platform: "xiaohongshu",
  url: "https://www.xiaohongshu.com/user/profile/abc",
  profileKey: "abc",
});
assert.equal(detectPlatform("https://www.instagram.com/example/"), "instagram");
assert.throws(() => detectPlatform("http://127.0.0.1/private"), /仅支持/);
```

- [ ] **Step 2: Run tests and confirm missing modules fail**

Run: `npm test -- test/unit/platform.test.js test/unit/date-range.test.js`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Implement strict domain validation and inclusive local date ranges**

Use `new URL()` and exact host allowlists. Convert date-only input to local start-of-day and end-of-day values; presets compute 7 days, 1 month and 6 months from `now`.

- [ ] **Step 4: Run unit tests**

Run: `npm test -- test/unit/platform.test.js test/unit/date-range.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore src/domain test/unit
git commit -m "建立项目基础与输入校验"
```

### Task 2: 任务存储和五任务并发调度

**Files:**
- Create: `src/tasks/task-store.js`
- Create: `src/tasks/task-manager.js`
- Create: `src/tasks/task-states.js`
- Test: `test/unit/task-store.test.js`
- Test: `test/integration/task-manager.test.js`

**Interfaces:**
- Consumes: `normalizeProfileUrl()` and `resolveDateRange()`
- Produces: `TaskStore.loadAll()`, `TaskStore.save(task)`, `TaskStore.taskDir(id)`
- Produces: `TaskManager.create(input)`, `list()`, `get(id)`, `cancel(id)`, `retry(id)`, `resume(id)`, `init()`
- Collector dependency: `collectorFactory(platform).collect(task, controls)`
- Export dependency: `exportTask(task, notes, taskDir)`

- [ ] **Step 1: Write a failing six-task concurrency test**

```js
for (let index = 0; index < 6; index += 1) await manager.create(validInput(index));
await eventually(() => assert.equal(tracker.active, 5));
assert.equal(tracker.maxActive, 5);
tracker.releaseOne();
await eventually(() => assert.equal(tracker.started, 6));
```

Also assert creation returns before a collector resolves, cancellation frees a slot, one failure does not stop other tasks, and restarting changes stale `running` tasks back to `queued`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- test/unit/task-store.test.js test/integration/task-manager.test.js`
Expected: FAIL with missing task classes.

- [ ] **Step 3: Implement atomic per-task persistence**

Write `<task>.tmp`, then rename it to `task.json`. Keep task JSON serializable and include `id`, `platform`, `profileUrl`, `profileKey`, `from`, `to`, `status`, progress, error, timestamps and result path.

- [ ] **Step 4: Implement the scheduler**

Maintain a FIFO queue, `running` map and `maxConcurrency = 5`. Schedule in a microtask so `create()` returns immediately. Use one `AbortController` per running task; release the slot in `finally` and schedule the next task.

- [ ] **Step 5: Run task tests**

Run: `npm test -- test/unit/task-store.test.js test/integration/task-manager.test.js`
Expected: PASS with `tracker.maxActive === 5`.

- [ ] **Step 6: Commit**

```bash
git add src/tasks test/unit/task-store.test.js test/integration/task-manager.test.js
git commit -m "实现五任务并发调度与持久化"
```

### Task 3: 标准数据、图片下载和结果导出

**Files:**
- Create: `src/domain/note.js`
- Create: `src/export/file-names.js`
- Create: `src/export/csv.js`
- Create: `src/export/archive.js`
- Create: `src/export/media-downloader.js`
- Test: `test/unit/note.test.js`
- Test: `test/unit/export.test.js`

**Interfaces:**
- Produces: `normalizeNote(raw): Note`
- Produces: `downloadMedia(notes, destination, fetchBuffer, onProgress, signal)`
- Produces: `createTaskArchive(task, notes, taskDir): Promise<string>`

- [ ] **Step 1: Write failing normalization and export tests**

```js
const note = normalizeNote({ platform: "xiaohongshu", id: "n1", title: "标题", metrics: {} });
assert.equal(note.metrics.favoriteCount, null);
assert.match(toCsv([note]), /"标题"/);
assert.ok((await fs.stat(archivePath)).size > 0);
```

Verify duplicate media URLs are downloaded once, unsafe file characters are replaced, cancellation stops downloads, and the archive contains `notes.csv` plus `images/` files.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- test/unit/note.test.js test/unit/export.test.js`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement normalized note shape and comma-separated export**

Use nullable numeric metrics, ISO timestamps, stable media records and RFC-compatible quote escaping. Do not coerce missing counts to zero.

- [ ] **Step 4: Implement bounded sequential media downloads per task and zip output**

Use `yazl.ZipFile`; write images to the task media directory first, then add the data table and successful files to `result.zip`.

- [ ] **Step 5: Run export tests**

Run: `npm test -- test/unit/note.test.js test/unit/export.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/note.js src/export test/unit/note.test.js test/unit/export.test.js
git commit -m "实现图片下载与采集结果导出"
```

### Task 4: 浏览器会话和采集器契约

**Files:**
- Create: `src/browser/browser-manager.js`
- Create: `src/collectors/errors.js`
- Create: `src/collectors/collector-factory.js`
- Create: `src/collectors/page-utils.js`
- Test: `test/unit/collector-factory.test.js`

**Interfaces:**
- Produces: `BrowserManager.page(platform): Promise<PageHandle>`
- Produces: `BrowserManager.fetchBuffer(platform, url): Promise<Buffer>`
- Produces: `LoginRequiredError`, `VerificationRequiredError`
- Produces: `createCollectorFactory({ browserManager })`

- [ ] **Step 1: Write failing factory and lifecycle tests**

Assert supported platforms create different adapters, unknown platforms throw, two pages share the same platform context, and closing one page leaves the other usable.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- test/unit/collector-factory.test.js`
Expected: FAIL with missing collector factory.

- [ ] **Step 3: Implement lazy persistent contexts**

Use one user-data directory per platform under `.data/browser-profiles/`. Default to a headed browser for local login; honor `COLLECTOR_HEADLESS=1` for tests and automation.

- [ ] **Step 4: Implement collector factory and human-action errors**

Factory methods return adapters with `collect(task, controls)` and close only the page created for that call.

- [ ] **Step 5: Run factory tests**

Run: `npm test -- test/unit/collector-factory.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser src/collectors/errors.js src/collectors/collector-factory.js src/collectors/page-utils.js test/unit/collector-factory.test.js
git commit -m "建立浏览器会话与平台采集契约"
```

### Task 5: 小红书采集器

**Files:**
- Create: `src/collectors/xiaohongshu/parser.js`
- Create: `src/collectors/xiaohongshu/collector.js`
- Create: `test/fixtures/xiaohongshu/profile-state.json`
- Create: `test/fixtures/xiaohongshu/note-detail.json`
- Test: `test/unit/xiaohongshu-parser.test.js`
- Test: `test/integration/xiaohongshu-collector.test.js`

**Interfaces:**
- Produces: `parseProfilePayload(payload): ProfilePage`
- Produces: `parseNotePayload(payload): Note`
- Produces: `XiaohongshuCollector.collect(task, controls): Promise<CollectionResult>`

- [ ] **Step 1: Add sanitized fixtures and failing parser tests**

Assert profile parsing reads note identifiers, temporary navigation tokens, titles, timestamps and likes. Assert detail parsing reads all image URLs plus likes, favorites and comments while preserving missing fields as null.

- [ ] **Step 2: Run parser tests and confirm failure**

Run: `npm test -- test/unit/xiaohongshu-parser.test.js`
Expected: FAIL with missing parser.

- [ ] **Step 3: Implement defensive payload parsing**

Accept both camel-case and snake-case field names used by server-rendered state and page responses. Keep traversal helpers local to the platform directory.

- [ ] **Step 4: Write failing collector tests with a fake page**

Simulate profile response pages, scrolling, detail responses, an old timestamp stopping condition, cancellation and a login page. Assert login produces `LoginRequiredError`.

- [ ] **Step 5: Implement browser-driven collection**

Listen for page responses containing `/api/sns/web/v1/user_posted` and `/api/sns/web/v1/feed`; let the loaded page create signed requests. Scroll until no new cards remain or the oldest non-pinned content is before the start date. Open details sequentially within each task and report progress.

- [ ] **Step 6: Run small-red-book tests**

Run: `npm test -- test/unit/xiaohongshu-parser.test.js test/integration/xiaohongshu-collector.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/collectors/xiaohongshu test/fixtures/xiaohongshu test/unit/xiaohongshu-parser.test.js test/integration/xiaohongshu-collector.test.js
git commit -m "实现小红书公开笔记采集器"
```

### Task 6: Instagram 采集器

**Files:**
- Create: `src/collectors/instagram/parser.js`
- Create: `src/collectors/instagram/collector.js`
- Create: `test/fixtures/instagram/profile.html`
- Create: `test/fixtures/instagram/post.html`
- Test: `test/unit/instagram-parser.test.js`
- Test: `test/integration/instagram-collector.test.js`

**Interfaces:**
- Produces: `parseInstagramPostHtml(html, url): Note`
- Produces: `InstagramCollector.collect(task, controls): Promise<CollectionResult>`

- [ ] **Step 1: Add sanitized fixtures and failing parser tests**

Assert the parser reads author, caption, publish time, likes, comments and public image metadata. Assert favorite count is null for other public accounts.

- [ ] **Step 2: Run parser tests and confirm failure**

Run: `npm test -- test/unit/instagram-parser.test.js`
Expected: FAIL with missing parser.

- [ ] **Step 3: Implement metadata and visible-page parsing**

Prefer structured script data, then Open Graph metadata, then visible article content. Merge repeated image URLs and ignore avatars and interface icons.

- [ ] **Step 4: Write failing fake-page collector tests**

Simulate scrolling profile post links, carousel next buttons, date filtering, hidden like counts, cancellation and login-required pages.

- [ ] **Step 5: Implement profile and post traversal**

Collect `/p/` and `/reel/` links until scrolling yields no new items. Visit links in profile order, collect visible carousel images, stop after the chronological range has been passed, and report missing public metrics as null.

- [ ] **Step 6: Run Instagram tests**

Run: `npm test -- test/unit/instagram-parser.test.js test/integration/instagram-collector.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/collectors/instagram test/fixtures/instagram test/unit/instagram-parser.test.js test/integration/instagram-collector.test.js
git commit -m "实现海外公开帖子采集器"
```

### Task 7: 本地接口和任务运行组装

**Files:**
- Create: `src/http/body.js`
- Create: `src/http/router.js`
- Create: `src/app.js`
- Create: `src/server.js`
- Test: `test/integration/api.test.js`

**Interfaces:**
- Consumes: `TaskManager` public methods
- Produces: `createApp(dependencies): (request, response) => void`
- Produces: `startServer(options): Promise<{ server, url, close }>`

- [ ] **Step 1: Write failing interface tests**

Use an in-memory manager. Assert health, create, list, detail, cancel, retry, resume, archive download, invalid JSON, unknown task and invalid domain responses.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- test/integration/api.test.js`
Expected: FAIL with missing app module.

- [ ] **Step 3: Implement the small explicit router**

Use exact method/path matching and a request body size limit. Send JSON errors with stable Chinese messages. Stream archive files only from a task's resolved directory.

- [ ] **Step 4: Assemble production dependencies**

Create store, browser manager, platform collector factory, media downloader, archive exporter and task manager. Initialize task recovery before accepting requests.

- [ ] **Step 5: Run interface tests**

Run: `npm test -- test/integration/api.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http src/app.js src/server.js test/integration/api.test.js
git commit -m "实现本地任务接口与应用组装"
```

### Task 8: 网页任务中心

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`
- Test: `test/e2e/task-center.test.js`

**Interfaces:**
- Consumes: `/api/tasks` routes
- Produces: always-enabled task form, summary counters, task cards and per-task actions

- [ ] **Step 1: Write a failing browser test**

Open the local test server, submit six links, assert the form remains enabled, five cards show running state, one card shows waiting state, and cancel/retry/download buttons call only the selected task route.

- [ ] **Step 2: Run test and confirm failure**

Run: `npm run test:e2e`
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement accessible semantic markup and task form**

Provide URL field, preset range selector, conditional custom date fields and a submit button. Use Chinese labels and status descriptions.

- [ ] **Step 4: Implement polling and isolated task actions**

Poll once per second while the page is visible. Render with DOM APIs and `textContent`; do not inject server strings as HTML. Never disable the task form because tasks are running.

- [ ] **Step 5: Implement responsive styles**

Use a restrained single-column task dashboard on narrow screens and two-column task cards on wide screens. Clearly distinguish running, waiting-human, complete and failed states.

- [ ] **Step 6: Run browser test**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add public test/e2e/task-center.test.js
git commit -m "实现并发采集任务中心网页"
```

### Task 9: 完整验证、使用说明和真实页面冒烟测试

**Files:**
- Create: `README.md`
- Create: `scripts/smoke-xiaohongshu.js`
- Modify: `package.json`
- Test: all files under `test/`

**Interfaces:**
- Produces: documented install, browser install, start, test and local data cleanup commands
- Produces: `npm run smoke:xhs -- <公开主页链接>`

- [ ] **Step 1: Write usage and limitation documentation**

Document Node.js 22 requirement, `npm install`, `npm run install:browser`, `npm start`, local URL, first-login flow, five-task concurrency, output location, captcha behavior and public-content limitations.

- [ ] **Step 2: Run static and full automated checks**

Run: `npm test`
Expected: all unit, integration and browser tests PASS.

Run: `npm run check`
Expected: syntax checks PASS and no ignored promise or unresolved import is reported by the project script.

- [ ] **Step 3: Run local application smoke test**

Run: `COLLECTOR_HEADLESS=1 npm start`
Expected: `/api/health` returns status `ok`, the task center loads, and the server binds only to `127.0.0.1`.

- [ ] **Step 4: Run the supplied public-profile read-only smoke test**

Run: `npm run smoke:xhs -- '<用户提供的小红书公开主页链接>'`
Expected: reports the profile author and visible card count, or reports the explicit `等待人工登录或验证` state without crashing.

- [ ] **Step 5: Verify requirement coverage and repository cleanliness**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only intended documentation changes remain before the final commit.

- [ ] **Step 6: Commit**

```bash
git add README.md scripts package.json package-lock.json
git commit -m "完善使用说明并完成全流程验证"
```
