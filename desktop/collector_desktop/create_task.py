from pathlib import Path
from urllib.parse import quote

from PySide6.QtCore import QDate, Signal
from PySide6.QtWidgets import (QComboBox, QDateEdit, QFileDialog, QHBoxLayout,
                              QLabel, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget)

from .jobs import Jobs
from .settings import PRESETS


def read_import(path):
    path = Path(path)
    if path.suffix.lower() not in (".txt", ".csv", ".docx"):
        raise ValueError("请选择文本、逗号分隔文件或办公文档")
    with path.open("rb") as handle:
        data = handle.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("导入文件不能超过 10 兆字节")
    return data


class CreateTaskForm(QWidget):
    created = Signal()

    def __init__(self, backend, preset="year", parent=None):
        super().__init__(parent)
        self.backend = backend
        self.jobs = Jobs(self)
        self.builtin_text = None
        self.busy = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.urls = QPlainTextEdit()
        self.urls.setPlaceholderText("每行一个博主主页链接，创建后进入待开始；手动输入及文件导入最多 500 个")
        self.urls.setMaximumHeight(105)
        layout.addWidget(self.urls)
        bar = QHBoxLayout()
        self.import_button = QPushButton("导入文件")
        self.builtin = QPushButton("加载内置名单（719）")
        self.preset = QComboBox()
        for label, value in PRESETS + [("自定义日期", "custom")]:
            self.preset.addItem(label, value)
        self.preset.setCurrentIndex(self.preset.findData(preset))
        self.from_date = QDateEdit(QDate.currentDate().addYears(-1))
        self.to_date = QDateEdit(QDate.currentDate())
        for field in (self.from_date, self.to_date):
            field.setCalendarPopup(True)
            field.setDisplayFormat("yyyy-MM-dd")
            field.hide()
        self.submit = QPushButton("加入待采集")
        for widget in (self.import_button, self.builtin, self.preset, self.from_date, self.to_date, self.submit):
            bar.addWidget(widget)
        layout.addLayout(bar)
        self.message = QLabel("创建任务不会自动开始。登录和验证仅在明确点击后打开浏览器。")
        self.message.setWordWrap(True)
        layout.addWidget(self.message)
        self.import_button.clicked.connect(self.choose_import)
        self.builtin.clicked.connect(self.load_builtin)
        self.submit.clicked.connect(self.create)
        self.preset.currentIndexChanged.connect(self.range_changed)

    def range_changed(self):
        for field in (self.from_date, self.to_date):
            field.setVisible(self.preset.currentData() == "custom")

    def set_busy(self, busy):
        self.busy = busy
        for widget in (self.urls, self.import_button, self.builtin, self.preset, self.from_date, self.to_date, self.submit):
            widget.setEnabled(not busy)

    def choose_import(self):
        path, _ = QFileDialog.getOpenFileName(self, "导入主页链接", "", "支持的文件 (*.txt *.csv *.docx)")
        if path:
            self.import_file(path)

    def import_file(self, path):
        if self.busy:
            return
        self.set_busy(True)
        self.message.setText("正在读取并解析文件…")

        def read_done(data, error):
            if error:
                return self.input_done(None, error)
            self.backend.request("POST", "/api/link-files/parse", data,
                                 headers={"X-File-Name": quote(Path(path).name)}, callback=self.input_done)
        self.jobs.submit(lambda: read_import(path), read_done)

    def load_builtin(self):
        if self.busy:
            return
        self.set_busy(True)
        self.backend.request("GET", "/api/profiles/builtin", callback=lambda value, error: self.input_done(value, error, builtin=True))

    def input_done(self, value, error, builtin=False):
        self.set_busy(False)
        if error:
            self.message.setText(error)
            return
        urls = value["profiles"] if builtin else [entry["url"] for entry in value["entries"]]
        text = "\n".join(dict.fromkeys(urls))
        self.builtin_text = text if builtin else None
        self.urls.setPlainText(text)
        self.message.setText(f"已载入 {len(text.splitlines())} 个链接，请检查后加入待采集。")

    def create(self):
        if self.busy:
            return
        text = self.urls.toPlainText().strip()
        urls = list(dict.fromkeys(line.strip() for line in text.splitlines() if line.strip()))
        builtin = self.builtin_text is not None and text == self.builtin_text
        if not urls or (len(urls) > 500 and not builtin):
            self.message.setText("请输入 1 至 500 个唯一主页链接；完整内置名单可自动分批。")
            return
        selected_range = {"preset": self.preset.currentData()}
        if selected_range["preset"] == "custom":
            if self.from_date.date() > self.to_date.date():
                self.message.setText("开始日期不能晚于结束日期")
                return
            selected_range.update({"from": self.from_date.date().toString("yyyy-MM-dd"), "to": self.to_date.date().toString("yyyy-MM-dd")})
        batches = [urls[index:index + 500] for index in range(0, len(urls), 500)]
        self.set_busy(True)
        counts = {"created": 0, "rejected": 0, "duplicates": 0}

        def submit_next(value=None, error=""):
            if error:
                self.set_busy(False)
                self.message.setText(f"已创建 {counts['created']} 个任务；{error}。请先检查任务列表，避免重复创建。")
                self.created.emit()
                return
            if value is not None:
                counts["created"] += len(value["tasks"])
                counts["rejected"] += len(value["rejected"])
                counts["duplicates"] += value["duplicates"]
            if not batches:
                self.set_busy(False)
                self.urls.clear()
                self.builtin_text = None
                self.message.setText(f"已创建 {counts['created']} 个待开始任务；无效 {counts['rejected']} 个，重复 {counts['duplicates']} 个。")
                self.created.emit()
                return
            batch = batches.pop(0)
            self.message.setText(f"正在创建任务…已完成 {counts['created']} 个")
            self.backend.request("POST", "/api/tasks/batch", {"entries": [{"line": i + 1, "url": url} for i, url in enumerate(batch)], "range": selected_range}, callback=submit_next, timeout=60000)

        submit_next()
