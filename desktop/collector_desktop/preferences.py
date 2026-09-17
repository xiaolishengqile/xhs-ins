import platform
import subprocess
from pathlib import Path

from PySide6 import __version__ as qt_version
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QComboBox, QFileDialog, QFormLayout, QHBoxLayout,
                              QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget)

from .backend import PROJECT_ROOT
from .jobs import Jobs
from .settings import PRESETS, Settings, save_settings


def dependencies(node):
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if platform.system() == "Windows" else {}
    try:
        result = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5, **flags)
        version = result.stdout.strip()
        valid = result.returncode == 0 and int(version.lstrip("v").split(".")[0]) >= 22
        runtime = f"后台运行环境：{version}（{'满足要求' if valid else '需要 22 或更高版本'}）"
    except (OSError, ValueError, subprocess.TimeoutExpired):
        runtime = "未找到可用的后台运行环境，请安装版本 22 或以上并检查启动路径"
    installed = (PROJECT_ROOT / "node_modules/playwright/package.json").exists()
    return f"界面运行环境：{platform.python_version()}\n桌面控件库：{qt_version}\n{runtime}\n采集依赖：{'已安装' if installed else '未安装，请执行项目依赖安装命令'}\n浏览器可用性由后台在明确开始任务时检测，本页不会启动浏览器。"


class PreferencesPage(QWidget):
    saved = Signal(object)
    reconnect = Signal()

    def __init__(self, backend, settings, path, parent=None):
        super().__init__(parent)
        self.backend, self.settings, self.path = backend, settings, path
        self.jobs = Jobs(self)
        self.saving = False
        layout = QVBoxLayout(self)
        form = QFormLayout()
        # 苹果默认只给字段自然宽度；显式增长，实际目录才能完整换行显示。
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        form.setFormAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        self.connection = QLabel("等待后台连接")
        self.data = QLabel(str(backend.data_dir))
        self.actual_output = QLabel("待后台确认")
        for label in (self.connection, self.data, self.actual_output):
            label.setTextInteractionFlags(label.textInteractionFlags() | Qt.TextInteractionFlag.TextSelectableByMouse)
            label.setWordWrap(True)
        form.addRow("后台连接", self.connection)
        form.addRow("数据目录", self.data)
        form.addRow("实际图片目录", self.actual_output)
        self.output = QLineEdit(settings.output_dir)
        self.output.setPlaceholderText("留空沿用后台默认图片目录")
        choose = QPushButton("选择目录")
        choose.clicked.connect(self.choose_directory)
        row = QHBoxLayout()
        row.addWidget(self.output)
        row.addWidget(choose)
        form.addRow("下次启动图片目录", row)
        self.preset = QComboBox()
        for label, value in PRESETS:
            self.preset.addItem(label, value)
        self.preset.setCurrentIndex(self.preset.findData(settings.preset))
        form.addRow("默认采集周期", self.preset)
        self.close_behavior = QComboBox()
        self.close_behavior.addItem("隐藏到托盘，后台继续", "hide")
        self.close_behavior.addItem("仅退出界面，后台继续", "quit")
        self.close_behavior.setCurrentIndex(self.close_behavior.findData(settings.close_behavior))
        form.addRow("关闭按钮行为", self.close_behavior)
        layout.addLayout(form)
        self.save_button = QPushButton("保存设置")
        self.save_button.clicked.connect(self.save)
        layout.addWidget(self.save_button)
        self.message = QLabel("目录变更仅在下次后台启动生效；已运行时请明确退出并停止采集，再重新打开软件。不会移动已有图片。")
        self.message.setWordWrap(True)
        layout.addWidget(self.message)
        reconnect = QPushButton("重新连接或启动后台")
        reconnect.clicked.connect(self.reconnect)
        layout.addWidget(reconnect)
        check = QPushButton("检查运行依赖")
        self.dependency_label = QLabel("尚未检查运行依赖")
        self.dependency_label.setWordWrap(True)
        check.clicked.connect(self.check_dependencies)
        layout.addWidget(check)
        layout.addWidget(self.dependency_label)
        layout.addStretch()
        backend.status_changed.connect(self.set_status)
        if backend.status:
            self.set_status(backend.status)

    def set_status(self, status):
        self.connection.setText("已连接 · " + status["url"])
        self.data.setText(status.get("dataDir", str(self.backend.data_dir)))
        self.actual_output.setText(status["outputDir"])

    def choose_directory(self):
        directory = QFileDialog.getExistingDirectory(self, "选择下次启动的图片保存目录", self.output.text())
        if directory:
            self.output.setText(directory)

    def save(self):
        if self.saving:
            return
        value = Settings(self.preset.currentData(), self.close_behavior.currentData(), self.output.text().strip())
        try:
            value.validate()
        except ValueError as error:
            self.message.setText(str(error))
            return
        self.saving = True
        self.save_button.setEnabled(False)

        def done(unused, error):
            self.saving = False
            self.save_button.setEnabled(True)
            if error:
                self.message.setText("设置保存失败：" + error)
                return
            self.settings = value
            self.saved.emit(value)
            self.message.setText("设置已保存。图片目录下次后台启动生效；请显式安全停止后台后重新打开软件，不会移动旧图片。")
        self.jobs.submit(lambda: save_settings(self.path, value), done)

    def check_dependencies(self):
        self.dependency_label.setText("正在检查运行依赖…")
        self.jobs.submit(lambda: dependencies(self.backend.node), lambda result, error: self.dependency_label.setText(error or result))
