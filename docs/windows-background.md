# 独立后台与 Windows 托盘

## 实现范围

后台服务使用独立 Node.js 进程，直接复用现有的 `createRuntime`、`createApp` 和 `startServer`。启动时先占用本机端口，再初始化任务运行时；因此端口冲突不会加载、恢复或修改真实任务队列。服务就绪后才发布状态，启动命令会等待控制通道和网页服务全部可用。

控制状态保存在数据目录的 `background/state.json`，文件权限在支持的平台上收紧为仅当前用户可读写。每次实例生成新的随机凭证，本机命名管道或 Unix 套接字必须验证该凭证后才接受查询和停止请求。停止命令不按名称查杀进程，也不依赖 Windows 信号，而是通知已认证实例依次关闭网页服务、任务运行时和浏览器资源。关闭期间控制通道继续返回“正在停止”，只有运行时关闭、原实例状态与锁完成清理后才确认停止；因此停止成功后可以立即重新启动，不会遇到旧锁尚未释放的问题。

启动锁使用原子目录创建来阻止重复实例。只有锁记录的进程已不存在且启动宽限期已过，才回收崩溃遗留锁；旧锁回收还会先取得独立的原子回收锁，竞争进程等待回收完成后重新检查主锁，不能移走另一实例刚创建的新锁。不会向状态文件中的未验证进程编号发送终止信号。后台尝试将自身调为较低优先级，失败时继续运行并写入日志。

后台模块通过 `console` 记录的应用运行日志分别写入：

- `background/background.log`
- `background/background-error.log`

每个日志最多约 512 KiB，并保留一个同名 `.1` 备份，避免长期运行无限增长。

## 命令入口

在项目目录运行：

```powershell
node scripts/background.js start
node scripts/background.js status
node scripts/background.js pause
node scripts/background.js resume
node scripts/background.js stop
```

可选参数：

```text
--data-dir <数据目录>
--output-dir <图片目录>
--host <127.0.0.1|localhost>
--port <端口，0 表示系统随机分配>
--timeout <等待毫秒数>
--json
```

参数作为独立进程参数传递，已覆盖中文和空格路径。服务只允许监听本机地址。

不传 `--output-dir` 时，后台先读取网页保存的下次启动图片目录；未设置时使用系统“图片”目录。正在运行的后台不会因网页保存设置而切换目录。

## Windows 托盘

直接双击以下文件即可无窗口启动托盘：

```text
scripts\windows\launch-tray.vbs
```

也可在 Windows PowerShell 中启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\background-tray.ps1"
```

托盘使用系统自带的 PowerShell WinForms `NotifyIcon`，没有新增桌面框架或第三方依赖。托盘自身使用项目路径派生的当前会话互斥锁，重复双击不会产生重复图标。VBS 入口隐藏 PowerShell 窗口；托盘调用后台命令时统一使用 `ProcessStartInfo` 的无窗口模式并重定向输出，所以三秒一次的状态检查不会闪出控制台。后台启动后不会自动打开浏览器；双击托盘或选择“打开管理界面”时才打开页面。托盘默认不传图片目录参数，因此网页设置可以在下次后台启动时生效。

“关闭托盘（后台继续）”只关闭托盘界面，不停止采集；“退出并停止后台”会经过认证控制通道优雅停止后台。托盘为停止操作提供最多两分钟的等待时间；失败或超时时会保留托盘并显示错误，可由用户重试，不会误报已停止。托盘还提供单独的启动、停止、暂停采集和继续采集菜单；暂停会释放浏览器资源，但保留后台与可恢复任务状态。所有 PowerShell 脚本使用带签名的 UTF-8 编码，兼容 Windows PowerShell 5.1 的中文读取。

## 可选登录启动

登录启动只在用户主动执行或点击托盘菜单时安装，不要求管理员权限：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\install-startup.ps1" -ProjectRoot "$PWD"
```

撤销：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\uninstall-startup.ps1"
```

安装脚本仅在当前用户的启动文件夹创建快捷方式；撤销脚本只删除该固定名称快捷方式。本次开发和测试没有在当前机器安装任何登录启动项。

如果此前安装的登录启动快捷方式固定传入旧图片目录，请撤销后重新安装，新的快捷方式才会遵从网页保存的图片目录设置。

## 流程变化

原流程需要前台运行 `src/server.js`，关闭终端或窗口通常会结束服务。新流程由命令入口启动无窗口、分离的后台实例：重复启动返回原实例，状态和停止均通过私有控制通道完成，托盘退出动作也区分“只关界面”和“停止后台”。网页管理界面仍使用原有 HTTP 应用，任务和图片数据结构没有另起一套。

## 验收记录

本机已执行：

```text
node --test --test-reporter=spec test/integration/background-control.test.js test/integration/background-lock.test.js test/integration/background-process.test.js
```

本轮结果为 10 项全部通过。覆盖真实独立进程启动、网页就绪、重复启动、认证拒绝、非法控制消息存活、暂停与继续、长关闭期间的“正在停止”状态、停止后立即重启、空闲控制连接回收、优雅停止、端口占用拒绝、端口冲突不初始化队列、异常旧锁恢复、多进程并发旧锁恢复，以及中文和空格目录。测试使用临时数据目录、临时输出目录和系统随机端口，不读取实际用户任务。

Windows 持续集成或目标机可执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\windows\test-background.ps1"
```

## 尚未验证的边界

当前开发机不是 Windows，原生 WinForms 托盘、VBS 隐藏窗口、启动文件夹快捷方式和 Windows 命名管道尚未做目标系统实机验收。跨平台 Node.js 集成测试可在 Windows 持续集成中直接运行，但不能替代托盘交互和登录启动的人工验收。异常退出时进行中的采集能否在可接受时间内完成暂停，取决于浏览器导航或下载操作响应取消的速度；停止命令会等待优雅关闭且不会强杀。

旧锁回收锁本身若在回收进程崩溃后残留，系统不会猜测其身份或再次自动抢锁，而会明确拒绝启动并要求人工处理。确认没有后台启动进程后，才能删除数据目录中的 `background/instance.lock.recovery` 再重试；这是为避免并发恢复产生双实例而保留的安全边界。
