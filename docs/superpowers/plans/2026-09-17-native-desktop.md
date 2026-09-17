# 原生桌面客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.
> 中文说明：按子任务驱动开发流程逐项实现，每项均做测试和独立审查。

**Goal:** 直接运行项目即可打开带任务、图片和设置的原生桌面软件。
**Architecture:** 原生控件桌面端仅负责交互，通过本机接口控制现有后台；后台唯一写任务、断点和索引。后台可脱离桌面运行，客户端不嵌入网页、不重写采集逻辑。
**Tech Stack:** Python、PySide6、Node.js；测试使用现有节点测试工具与 Python 标准库 unittest。
**Spec:** `docs/superpowers/specs/2026-09-17-native-desktop-design.md`

## Global Constraints

- 支持苹果和微软桌面系统；不制作安装包，不重写已有采集引擎。
- 开发验证仅使用临时数据，不运行用户真实队列。
- 默认采集周期一年，全局默认并发一，不安装登录自启项。
- 使用原生控件，不嵌入网页；登录验证仅用户显式点击后开专用浏览器。
- 桌面端不直接改任务文件；删除任务不删除图片；目录变更不移动已有图片。
- 主线程不得同步执行网络、子进程等待、目录扫描或图片解码。
- 保留当前功能分支和目录；不推送、不合并、不改变实际数据。
- 每项完整功能测试后中文提交；不提交缓存、虚拟环境或依赖目录。

## Task 1: 后台存储保护及桌面连接契约

**Files:**
- 修改 `src/tasks/task-manager.js`，必要时新增专职的小型存储保护模块于 `src/tasks/`。
- 修改 `src/background/worker.js`，补充后台状态。
- 修改 `public/app.js`，补低频空闲检查与存储错误显示。
- 新增 `test/integration/storage-fault.test.js`。
- 修改 `test/integration/background-process.test.js`、`test/e2e/task-center.test.js`。

**Interfaces:**
- 后台已认证 `status` 返回新增 `dataDir`、`outputDir` 两个绝对路径，来自运行时配置实际值；默认图片目录与 `createRuntime` 保持一致，不暴露凭证。
- `manager.controlStatus()` 新增 `storageError: string|null`；为非空时不得开始或继续调度。恢复必须经用户明确继续并先成功写回状态，不因单次自动轮询解除故障。
- 保持现有任务接口参数和响应兼容；桌面读取现有 `/api/tasks` 和 `/api/control`。

- [ ] 写并运行红色回归：运行前第一次状态保存失败、任务结束保存失败、期间进度保存失败均不得产生未处理异步拒绝，不泄漏运行占位，不执行下一个任务。
  测试构造真实任务管理器，持久层只在指定保存时抛错；异常进程探针可用 `execFile` 执行模块脚本，以退出状态和任务/控制状态确认，不靠吞掉全局错误通过测试。
  ```js
  const store = new TaskStore(tempDir);
  const save = store.save.bind(store);
  store.save = async (task) => {
    if (task.status === 'running') throw Object.assign(new Error('模拟磁盘空间不足'), { code: 'ENOSPC' });
    return save(task);
  };
  // 启动后应停止调度，running.size 为 0，storageError 非空，第二项保持未运行。
  ```
- [ ] 最小实现统一保护：将任务首次写盘纳入资源清理范围，最终清理不依赖写盘成功，调度的异步失败必须有接收方。存储故障时中止运行任务并冻结调度；不把磁盘故障当平台冷却，不循环重试。
  ```js
  try { await saveTask(); /* 执行采集 */ }
  finally { /* 先释放运行资源；安全尝试最终持久化；仅健康时再调度 */ }
  ```
- [ ] 先写状态契约断言，再加入真实后台路径；验证自定义路径、默认路径与中文空格路径。
  ```js
  assert.equal(status.dataDir, path.resolve(dataDir));
  assert.equal(status.outputDir, path.resolve(outputDir));
  ```
- [ ] 先用可控制的浏览器时钟写“外部恢复后页面刷新”失败测试，再实现空闲可见页面每 15 秒检查，活动页面仍每 3 秒刷新，隐藏时不轮询，避免请求重入；原“空闲不频繁轮询”测试继续成立。
- [ ] 运行专项、`npm test`、`npm run check` 和差异检查，提交中文说明；报告红绿测试证据。

## Task 2: 原生桌面软件完整首版

**Files:**
- 新建 `desktop/requirements.txt`：锁定实际验证可安装的 PySide6 版本。
- 新建 `desktop/main.py`：项目入口及参数解析；只做装配。
- 新建 `desktop/collector_desktop/__init__.py`。
- 新建 `desktop/collector_desktop/backend.py`：后台命令和本机接口客户端、后台作业调度。
- 新建 `desktop/collector_desktop/settings.py`：设置验证、原子保存、默认值。
- 新建 `desktop/collector_desktop/instance.py`：桌面单实例与唤起。
- 新建 `desktop/collector_desktop/window.py`：主窗口、导航、托盘和退出流程。
- 新建 `desktop/collector_desktop/tasks.py`：任务表、筛选、分页、多选及操作。
- 新建 `desktop/collector_desktop/create_task.py`：导入/新建表单，复用后台导入与内置名单。
- 新建 `desktop/collector_desktop/images.py`：安全本地图片扫描、限额解码与图片页面。
- 新建 `desktop/collector_desktop/preferences.py`：设置页面。
- 新建 `desktop/tests/test_backend.py`、`test_settings.py`、`test_images.py`、`test_window.py`、`test_tasks.py`。
- 修改 `.gitignore` 排除 `.venv-desktop/`、Python 缓存。
- 新建 `scripts/start-desktop.command`、`scripts/windows/start-desktop.vbs`，只启动项目桌面入口，不制作安装包。
- 修改 `README.md`、新建 `docs/desktop.md`，补依赖安装、运行、关闭语义、原生验证边界；原网页兼容说明保留。
- 修改 `.github/workflows/test.yml` 增加桌面依赖安装及无显示测试，包含苹果执行环境。

**Interfaces:**
- 桌面启动参数：`--data-dir`（默认项目 `.data`，供隔离验收）、`--node`（可选运行环境路径），数据目录选择不进入普通设置页面。
- 后台命令沿用 `node scripts/background.js start|status|stop|pause|resume --data-dir DIR --json`，启动附加选择的图片目录；仅停止使用最长 120 秒等待。
- 后台状态读取 Task 1 中的实际目录和地址；地址仅接受回环地址。图片根目录来自已确认的后台状态，不从任意任务字段取得。
- `BackendClient` 提供异步 `start`、`command(action)`、`request(method,path,payload)`，结果/异常通过信号交还主线程；有超时、防重入、退出清理，不调用外壳字符串。
- 窗口与各页面通过明确的信号或回调通信，后台逻辑不引用窗口。每个新源文件目标不超过约 350 行；超过时按职责拆分并在报告说明。

- [ ] 环境准备：在 `.venv-desktop` 建立独立环境安装锁定桌面库；不改系统 Python，不在启动脚本自动安装依赖。
  ```sh
  python3 -m venv .venv-desktop
  .venv-desktop/bin/python -m pip install -r desktop/requirements.txt
  ```
- [ ] 先写行为测试并观察失败：设置默认一年/原子保存/非法设置；后端使用真实临时本机服务验证成功、断开、超时及拒绝非回环地址；通过真实后台隔离进程验证启动和关闭，不访问平台。
  ```python
  self.assertEqual(settings.preset, 'year')
  self.assertRaises(ValueError, validate_backend_url, 'https://example.com')
  ```
- [ ] 实现后台客户端与设置，窗口只在主线程创建/更新控件。长作业使用线程池或原生异步进程/网络机制，结果带请求身份以丢弃过期请求。
- [ ] 先写原生任务界面测试：提交默认一年、待开始不自动运行、719 条分批创建、多选批量开始/确认删除、失败/部分完成操作、外部恢复后刷新、分页筛选不丢勾选。
  ```python
  self.assertEqual(window.tasks.preset.currentData(), 'year')
  # 对真实控件输入并触发提交，检查本机测试服务收到的业务参数，不能只断言模拟对象存在。
  ```
- [ ] 实现新建表单、任务表与操作，使用中文状态。可见窗口活动刷新 3 秒、空闲 15 秒，隐藏停止任务列表轮询；恢复可见立即刷新。单次创建最多 500，内置 719 分两批创建；操作完成立即刷新，重复点击禁用。
- [ ] 先写图片测试：扫描仅限根目录内、拒绝越界符号链接、损坏图片可跳过、不等比图完整显示、缩放和原尺寸视图、切换账号丢弃旧异步结果。
  ```python
  # 生成 400×200 的测试图：适配预览仍为 2:1，原尺寸显示 400×200。
  self.assertEqual((image.width(), image.height()), (400, 200))
  ```
- [ ] 实现图片页面：账号选择、每页 30 张缩略图和独立大图视图；限制解码峰值（超大图先安全缩放并明确提示），缩略图缓存最多 60 项，原图按需单张加载；不读取外部文件、不重新下载平台内容、不提供删除。
- [ ] 先写生命周期测试：同一数据目录第二实例唤起前者、关闭窗口默认隐藏、无托盘可用时明确选择、仅退出界面后台仍在、停止失败保留界面。不会在打开或最小化窗口时默认打开浏览器。
- [ ] 实现跨平台托盘与单实例：优先使用桌面库本地服务/锁；同一目录身份一致，处理崩溃残留不得误抢仍活跃实例。首次隐藏提示；取消退出不杀后台。原微软脚本托盘仍可用，但新入口不启动它。
- [ ] 实现设置与启动脚本：展示真实目录、依赖检测；图片目录改动下次后台启动生效，已运行时提示需显式安全重启，不移动文件。原启动入口不受影响。
- [ ] 执行所有桌面测试与原有全套测试；在临时数据目录本机打开实际窗口，检查三页、托盘和完整图片，再安全关闭。记录实测与未实测范围；提交中文说明。
  ```sh
  QT_QPA_PLATFORM=offscreen .venv-desktop/bin/python -m unittest discover -s desktop/tests -v
  npm test
  npm run check
  git diff --check
  ```

## 执行记录

- 2026-09-17：用户确认实施；现有基线 169 项测试全部通过。
- 独立子任务按顺序实施并独立审查，主任务同时检查环境、集成契约和验收准备，避免多个实施者修改同一代码。
- Task 1: pending
- Task 2: pending
