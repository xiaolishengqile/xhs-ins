from PySide6.QtCore import QEvent, Qt, QTimer, Signal
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (QHBoxLayout, QLabel, QListWidget, QMainWindow,
                              QMenu, QMessageBox, QStackedWidget, QStyle,
                              QSystemTrayIcon, QVBoxLayout, QWidget)

from .images import ImagesPage
from .preferences import PreferencesPage
from .tasks import TasksPage


class MainWindow(QMainWindow):
    exiting = Signal()

    def __init__(self, backend, settings, settings_path):
        super().__init__()
        self.backend, self.settings = backend, settings
        self.stopping, self.finished, self.hidden_notice = False, False, False
        self.setWindowTitle("采图台")
        self.resize(1240, 820)
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        self.connection = QLabel("正在连接本机后台…")
        self.connection.setWordWrap(True)
        layout.addWidget(self.connection)
        body = QHBoxLayout()
        self.navigation = QListWidget()
        self.navigation.addItems(["任务", "图片", "设置"])
        self.navigation.setFixedWidth(115)
        body.addWidget(self.navigation)
        self.pages = QStackedWidget()
        self.tasks = TasksPage(backend, settings.preset)
        self.images = ImagesPage()
        self.preferences = PreferencesPage(backend, settings, settings_path)
        for page in (self.tasks, self.images, self.preferences):
            self.pages.addWidget(page)
        body.addWidget(self.pages)
        layout.addLayout(body)
        self.navigation.currentRowChanged.connect(self.pages.setCurrentIndex)
        self.navigation.setCurrentRow(0)
        self.preferences.saved.connect(self.apply_settings)
        self.preferences.reconnect.connect(self.connect_backend)
        self.backend.status_changed.connect(self.connected)
        self.tasks.control_changed.connect(self.control_changed)
        self.tray_available = QSystemTrayIcon.isSystemTrayAvailable()
        icon = self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        self.setWindowIcon(icon)
        self.tray = QSystemTrayIcon(icon, self)
        self.tray.setToolTip("采图台：本机图片采集")
        menu = QMenu(self)
        for text, callback in (("显示主窗口", self.activate),
                               ("暂停采集", lambda: self.tasks.operation("POST", "/api/control/pause")),
                               ("继续采集", lambda: self.tasks.operation("POST", "/api/control/resume")),
                               ("仅退出界面", lambda: self.request_exit(False)),
                               ("退出并停止采集", lambda: self.request_exit(True))):
            action = QAction(text, self)
            action.triggered.connect(callback)
            menu.addAction(action)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(lambda reason: self.activate() if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick) else None)
        if self.tray_available:
            self.tray.show()
        file_menu = self.menuBar().addMenu("软件")
        file_menu.addAction("仅退出界面", lambda: self.request_exit(False))
        file_menu.addAction("退出并停止采集", lambda: self.request_exit(True))
        self.status_timer = QTimer(self)
        self.status_timer.setInterval(15000)
        self.status_timer.timeout.connect(self.refresh_status)
        if backend.status:
            self.connected(backend.status)

    def connect_backend(self):
        if self.stopping:
            return
        self.connection.setText("正在连接或启动本机后台…")
        self.backend.start(self.settings.output_dir, callback=self.start_result)

    def start_result(self, value, error):
        if error:
            self.connection.setText(error + "；可在设置页检查依赖后重新连接。")
            self.preferences.connection.setText("连接失败")
        elif self.tasks.isVisible() and not self.isMinimized():
            self.tasks.refresh()

    def connected(self, status):
        self.connection.setText("已连接本机后台 · " + status["url"])
        self.images.set_root(status["outputDir"])

    def refresh_status(self):
        if not self.stopping:
            self.backend.command("status", callback=self.start_result)

    def control_changed(self, value):
        if value.get("storageError"):
            self.connection.setText("存储故障，调度已安全暂停。请查看任务页。")

    def apply_settings(self, settings):
        self.settings = settings
        self.tasks.preset.setCurrentIndex(self.tasks.preset.findData(settings.preset))

    def activate(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()
        if self.tasks.isVisible():
            self.tasks.refresh()

    def showEvent(self, event):
        super().showEvent(event)
        self.status_timer.start()

    def hideEvent(self, event):
        self.status_timer.stop()
        super().hideEvent(event)

    def changeEvent(self, event):
        super().changeEvent(event)
        if event.type() == QEvent.Type.WindowStateChange:
            if self.isMinimized():
                self.tasks.timer.stop()
                self.status_timer.stop()
                self.images.invalidate()
            elif self.isVisible():
                self.status_timer.start()
                if self.tasks.isVisible():
                    self.tasks.timer.start()
                    self.tasks.refresh()

    def choose_no_tray(self):
        dialog = QMessageBox(self)
        dialog.setWindowTitle("当前系统没有可用托盘")
        dialog.setText("窗口无法隐藏到托盘。请选择保留窗口、仅退出界面，或退出并停止采集。")
        stay = dialog.addButton("保留窗口", QMessageBox.ButtonRole.RejectRole)
        quit_ui = dialog.addButton("仅退出界面", QMessageBox.ButtonRole.AcceptRole)
        stop = dialog.addButton("退出并停止采集", QMessageBox.ButtonRole.DestructiveRole)
        dialog.setDefaultButton(stay)
        dialog.exec()
        return "quit" if dialog.clickedButton() == quit_ui else "stop" if dialog.clickedButton() == stop else "stay"

    def closeEvent(self, event):
        event.ignore()
        if self.stopping:
            return
        if self.settings.close_behavior == "quit":
            self.request_exit(False)
        elif self.tray_available:
            self.hide()
            if not self.hidden_notice:
                self.tray.showMessage("采图台仍在运行", "关闭按钮仅隐藏窗口，后台采集继续。通过托盘菜单重新打开或安全停止。")
                self.hidden_notice = True
        else:
            choice = self.choose_no_tray()
            if choice != "stay":
                self.request_exit(choice == "stop")

    def request_exit(self, stop=False):
        if self.stopping or self.finished:
            return
        if stop:
            self.stopping = True
            self.activate()
            self.centralWidget().setEnabled(False)
            self.connection.setText("正在安全停止采集并保存进度，最多等待两分钟…")

            def stopped(value, error):
                self.stopping = False
                self.centralWidget().setEnabled(True)
                if error:
                    self.connection.setText("停止失败，界面已保留：" + error)
                else:
                    self.request_exit(False)
            self.backend.command("stop", callback=stopped)
            return
        self.finished = True
        self.tasks.timer.stop()
        self.tasks.create_form.jobs.cancel()
        self.preferences.jobs.cancel()
        self.images.invalidate()
        self.status_timer.stop()
        self.tray.hide()
        self.hide()
        self.backend.close()
        self.exiting.emit()
