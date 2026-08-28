# 本地静默采集与任务生命周期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 将现有的“提交即运行、浏览器频繁抢焦点、任务压缩包导出”流程，改造成“先创建待开始任务、用户明确启动、后台静默采集、需要登录时才打开独立窗口、图片按博主归档到固定本地目录”的完整桌面工作流。

**架构：** 保留任务管理器作为唯一状态机，在其上增加轻量应用控制器，统一协调任务调度、浏览器生命周期和本地输出。采集浏览器默认无头运行，登录窗口使用同一平台持久化资料目录但与采集上下文互斥。图片写入独立存储模块，业务状态与去重索引留在 `.data`，用户目录只出现博主文件夹和图片。

**技术栈：** Node.js 22、原生 HTTP、Playwright、浏览器端原生 JavaScript、Node.js 内置测试运行器。

**设计依据：** `docs/superpowers/specs/2026-08-28-task-lifecycle-and-silent-browser-design.md`

---

## 任务一：建立待开始状态和显式启动接口

**文件：**
- 修改：`src/tasks/task-states.js`
- 修改：`src/tasks/task-manager.js`
- 修改：`src/http/app.js`
- 测试：`test/integration/task-manager.test.js`
- 测试：`test/integration/api.test.js`

1. 先添加失败测试：新任务状态为 `pending`，不会自动进入队列；单任务和批量启动只接收待开始任务；暂停时拒绝启动。
2. 运行相关测试，确认失败原因来自缺少新状态和接口。
3. 为状态机增加 `PENDING`，将创建和启动职责拆开，并提供去重的批量启动结果。
4. 增加 `/api/tasks/:id/start` 与 `/api/tasks/start-batch`，返回明确的已启动和已跳过任务。
5. 再次运行相关测试，确认通过。
6. 提交：`实现任务待开始与显式启动流程`。

## 任务二：完善暂停、平台阻塞和登录恢复

**文件：**
- 新增：`src/application/controller.js`
- 修改：`src/tasks/task-manager.js`
- 修改：`src/http/app.js`
- 测试：`test/integration/task-manager.test.js`
- 测试：`test/integration/api.test.js`

1. 先添加失败测试：全局暂停会清空队列并中止运行任务；某平台需要登录时只阻塞同平台任务；其他平台仍可运行；处理完成后同平台任务恢复排队。
2. 运行相关测试并记录预期失败。
3. 在任务管理器增加平台阻塞集合、同平台任务收敛和恢复能力。
4. 新增应用控制器，统一执行暂停、恢复、登录准备和登录完成，避免 HTTP 层直接操作多个底层对象。
5. 让暂停关闭应用拥有的所有浏览器上下文，并保证删除任务不会删除外部图片。
6. 运行测试确认通过。
7. 提交：`完善暂停与平台登录恢复机制`。

## 任务三：实现静默采集和独立登录窗口

**文件：**
- 修改：`src/browser/browser-manager.js`
- 修改：`src/browser/task-browser-session.js`
- 修改：`src/collectors/instagram.js`
- 修改：`src/collectors/xiaohongshu.js`
- 修改：`src/http/app.js`
- 测试：`test/unit/collector-factory.test.js`
- 测试：`test/integration/instagram-collector.test.js`
- 测试：`test/integration/xiaohongshu-collector.test.js`

1. 先添加失败测试：采集默认无头；普通采集不调用置前；只有显式打开登录时才创建可见浏览器；重复打开登录复用窗口；关闭后可回到无头采集。
2. 运行相关测试确认失败。
3. 将采集上下文和登录上下文分离，并对同一平台严格互斥。
4. 删除采集器中的自动置前和保留异常页面逻辑；检测到登录需求时只上报状态。
5. 增加显式登录与“我已处理，继续”接口，由应用控制器协调窗口关闭和任务恢复。
6. 运行测试确认通过。
7. 提交：`实现静默采集与独立登录窗口`。

## 任务四：改为固定本地目录按博主归档图片

**文件：**
- 新增：`src/export/local-image-store.js`
- 新增：`src/system/open-path.js`
- 修改：`src/server.js`
- 修改：`src/application/controller.js`
- 修改：`src/http/app.js`
- 删除或停用：`src/export/archive.js`
- 删除或停用：`src/export/completed-archive.js`
- 删除或停用：`src/export/csv.js`
- 测试：`test/unit/export.test.js`
- 测试：`test/integration/api.test.js`

1. 先添加失败测试：输出固定到 `/Users/lijiawei/Pictures/博主图片采集/<账号名>`；文件名为 `账号名_六位序号_点赞数.扩展名`；未知点赞显示“点赞未知”；重复媒体不会下载；并发写入序号不冲突。
2. 添加失败测试：打开图片文件夹只能打开固定根目录；云环境启动采集时返回本地运行提示。
3. 运行相关测试确认失败。
4. 实现本地图片存储和内部去重索引，使用临时文件加原子改名，索引缺失时扫描已有序号。
5. 将服务端导出器改成直接保存图片，不再生成明细表、任务压缩包和汇总压缩包。
6. 增加 `/api/output/open`，使用操作系统安全命令打开固定目录。
7. 运行测试确认通过。
8. 提交：`实现按博主归档的本地图片存储`。

## 任务五：内置 719 名博主并重做前端完整流程

**文件：**
- 新增：`src/data/builtin-profiles.json`
- 修改：`src/http/app.js`
- 修改：`public/index.html`
- 修改：`public/app.js`
- 修改：`public/styles.css`
- 测试：`test/integration/api.test.js`
- 测试：`test/e2e/task-center.test.js`

1. 从 `INS博主主页链接汇总.docx` 解析、规范化并去重出 719 个 Instagram 主页链接，写入只读数据文件。
2. 先添加失败测试：内置接口返回 719 个唯一链接；加载内置博主和导入文件都只填充预览，不创建任务；手动提交上限 500；内置列表按 500 和 219 分批创建待开始任务。
3. 添加失败测试：任务卡支持单独开始、选中开始、批量删除、显式登录、继续采集和打开图片文件夹；不再出现下载结果按钮。
4. 运行相关测试确认失败。
5. 重做界面状态与按钮逻辑，增加 `pending` 统计和批量启动；仅活动任务轮询，待开始任务不触发后台请求风暴。
6. 运行测试确认通过。
7. 提交：`内置博主并完善任务中心操作流程`。

## 任务六：清理旧流程、更新文档并完整验证

**文件：**
- 修改：`README.md`
- 修改：`package.json`
- 修改：锁文件（如存在）
- 修改：与旧压缩包导出流程相关的测试和文档

1. 搜索并移除任务下载、汇总下载、导入即运行、自动置前及旧压缩包导出的残留引用。
2. 更新使用说明：加载或导入、加入待采集、选中启动、登录处理、本地目录结构和视频过滤。
3. 运行语法检查、单元测试、集成测试、端到端测试和完整测试。
4. 启动本地服务，验证健康接口、719 内置列表、待开始任务、暂停状态和固定输出目录接口。
5. 检查工作区仅含本次变更，无敏感登录资料和采集产物被提交。
6. 提交：`完成本地静默采集流程并更新文档`。

## 完成标准

- 导入文件、加载内置列表和手动输入均不会自动搜索。
- 用户可以单独或批量启动待开始任务，最多并发 5 个。
- 普通采集完全静默；只有用户明确点击登录时才出现浏览器窗口。
- 暂停会停止排队与运行并关闭应用浏览器，不影响用户日常浏览器。
- 仅采集图文图片，视频被过滤。
- 图片只保存到固定本地根目录中的博主子文件夹，不生成明细表和压缩包。
- 719 个内置 Instagram 博主可直接加载并分批加入待采集。
- 所有自动化测试通过，代码以中文提交信息提交。
