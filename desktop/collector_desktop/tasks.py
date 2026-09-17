from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (QAbstractItemView, QComboBox, QHBoxLayout, QHeaderView,
                              QLabel, QMessageBox, QPushButton, QTableWidget,
                              QTableWidgetItem, QVBoxLayout, QWidget)

from .create_task import CreateTaskForm

STATES = {"pending": "待开始", "queued": "等待中", "running": "运行中", "paused": "已暂停",
          "waiting_user": "等待登录或验证", "blocked": "运行环境受阻", "completed": "已完成",
          "partial": "部分完成", "failed": "失败", "cancelled": "已取消"}


class TasksPage(QWidget):
    control_changed = Signal(object)

    def __init__(self, backend, preset="year", parent=None):
        super().__init__(parent)
        self.backend = backend
        self.rows, self.selected = [], set()
        self.control = {}
        self.page, self.busy, self.refreshing = 0, False, False
        self.refresh_requested = False
        self.refresh_error = ""
        layout = QVBoxLayout(self)
        self.create_form = CreateTaskForm(backend, preset)
        self.preset = self.create_form.preset
        self.create_form.created.connect(self.refresh)
        layout.addWidget(self.create_form)
        bar = QHBoxLayout()
        self.filter = QComboBox()
        self.filter.addItem("全部状态", "")
        for key, label in STATES.items():
            self.filter.addItem(label, key)
        self.filter.currentIndexChanged.connect(self.filter_changed)
        self.select_all = QPushButton("勾选筛选结果全部页")
        self.clear_selection = QPushButton("清空勾选")
        self.start_selected = QPushButton("批量开始")
        self.delete_selected = QPushButton("删除勾选任务")
        self.pause = QPushButton("暂停全部")
        self.reload = QPushButton("刷新")
        for widget in (self.filter, self.select_all, self.clear_selection, self.start_selected, self.delete_selected, self.pause, self.reload):
            bar.addWidget(widget)
        layout.addLayout(bar)
        self.control_label = QLabel()
        self.control_label.setWordWrap(True)
        self.message = QLabel()
        self.message.setWordWrap(True)
        layout.addWidget(self.control_label)
        layout.addWidget(self.message)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["勾选", "账号", "状态", "已保存 / 失败", "进度与提示", "操作"])
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self.table.itemChanged.connect(self.checked)
        layout.addWidget(self.table)
        pager = QHBoxLayout()
        self.previous_page, self.next_page = QPushButton("上一页"), QPushButton("下一页")
        self.page_label = QLabel()
        for widget in (self.previous_page, self.page_label, self.next_page):
            pager.addWidget(widget)
        layout.addLayout(pager)
        self.previous_page.clicked.connect(lambda: self.change_page(-1))
        self.next_page.clicked.connect(lambda: self.change_page(1))
        self.select_all.clicked.connect(self.check_all)
        self.clear_selection.clicked.connect(self.uncheck_all)
        self.start_selected.clicked.connect(self.start_batch)
        self.delete_selected.clicked.connect(lambda: self.delete_tasks(list(self.selected)))
        self.pause.clicked.connect(self.toggle_pause)
        self.reload.clicked.connect(self.refresh)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.setInterval(15000)

    def showEvent(self, event):
        super().showEvent(event)
        self.timer.start()
        self.refresh()

    def hideEvent(self, event):
        self.timer.stop()
        super().hideEvent(event)

    def refresh(self):
        if self.refreshing:
            self.refresh_requested = True
            return
        self.refreshing = True
        remaining = {"tasks", "control"}
        errors = []

        def received(kind, value, error):
            remaining.discard(kind)
            if error:
                errors.append(error)
                self.refresh_error = error
                self.message.setText(error)
            elif kind == "tasks":
                self.rows = value["tasks"]
                self.selected.intersection_update(row["id"] for row in self.rows)
                self.render()
            else:
                self.control = value
                self.update_control()
                self.control_changed.emit(value)
            if not remaining:
                if not errors:
                    if self.message.text() == self.refresh_error:
                        self.message.clear()
                    self.refresh_error = ""
                self.refreshing = False
                active = any(row["status"] in ("running", "queued") for row in self.rows)
                self.timer.setInterval(3000 if active else 15000)
                if self.refresh_requested:
                    self.refresh_requested = False
                    self.refresh()
        for kind in ("tasks", "control"):
            self.backend.request("GET", f"/api/{kind}", callback=lambda v, e, kind=kind: received(kind, v, e))

    def update_control(self):
        paused = self.control.get("paused", False)
        storage = self.control.get("storageError")
        text = "已暂停调度" if paused else "后台正常"
        if storage:
            text = f"存储故障，已安全暂停：{storage}；修复目录或磁盘后点击继续。"
        cooldowns = self.control.get("cooldowns", [])
        if cooldowns:
            text += " · 平台冷却中，后台将按保存的时间恢复"
        self.control_label.setText(text)
        self.pause.setText("重试保存并继续" if storage else "继续全部" if paused else "暂停全部")
        self.start_selected.setEnabled(not self.busy and not storage)
        self.render()

    def filtered(self):
        return [row for row in self.rows if not self.filter.currentData() or row["status"] == self.filter.currentData()]

    def filter_changed(self):
        self.page = 0
        self.render()

    def change_page(self, offset):
        self.page += offset
        self.render()

    def check_all(self):
        self.selected.update(row["id"] for row in self.filtered())
        self.render()

    def uncheck_all(self):
        self.selected.clear()
        self.render()

    def checked(self, item):
        if item.column() == 0:
            identity = item.data(Qt.ItemDataRole.UserRole)
            if item.checkState() == Qt.CheckState.Checked:
                self.selected.add(identity)
            else:
                self.selected.discard(identity)
            self.page_label.setText(f"第 {self.page + 1} 页 · 已勾选 {len(self.selected)} 个")

    @staticmethod
    def actions_for(row):
        status = row["status"]
        actions = []
        if status == "pending":
            actions.append(("开始", "start"))
        if status in ("queued", "running", "paused", "waiting_user", "blocked"):
            actions.append(("取消", "cancel"))
        if status in ("failed", "cancelled", "partial"):
            actions.append(("补采失败图片" if status == "partial" else "重试", "retry"))
        if status in ("completed", "partial"):
            actions.append(("采集新增", "update"))
        if status == "waiting_user":
            actions += [("打开登录窗口", "login"), ("我已处理，继续", "resume")]
        if status == "blocked" and row.get("blockReason") == "browser":
            actions.append(("重新检测并继续", "recover"))
        return actions + [("删除", "delete")]

    def render(self):
        rows = self.filtered()
        pages = max(1, (len(rows) + 29) // 30)
        self.page = min(max(0, self.page), pages - 1)
        visible = rows[self.page * 30:(self.page + 1) * 30]
        self.table.blockSignals(True)
        self.table.setRowCount(len(visible))
        for index, row in enumerate(visible):
            check = QTableWidgetItem()
            check.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsUserCheckable)
            check.setData(Qt.ItemDataRole.UserRole, row["id"])
            check.setCheckState(Qt.CheckState.Checked if row["id"] in self.selected else Qt.CheckState.Unchecked)
            self.table.setItem(index, 0, check)
            progress = row.get("progress", {})
            saved = progress.get("imagesAvailable", progress.get("imagesDownloaded", 0))
            failed = progress.get("imagesFailed", 0) + progress.get("imagesUpgradeFailed", 0)
            texts = [row.get("author") or row.get("profileKey", ""), STATES.get(row["status"], "未知状态"),
                     f"{saved} / {failed}", row.get("error") or progress.get("stage", "")]
            for column, text in enumerate(texts, 1):
                item = QTableWidgetItem(str(text))
                item.setToolTip(str(text))
                self.table.setItem(index, column, item)
            widget = QWidget()
            actions = QHBoxLayout(widget)
            actions.setContentsMargins(2, 2, 2, 2)
            for label, action in self.actions_for(row):
                button = QPushButton(label)
                button.setEnabled(not self.busy and not (self.control.get("storageError") and action in ("start", "retry", "update", "resume", "recover")))
                button.clicked.connect(lambda checked=False, identity=row["id"], action=action: self.act(identity, action))
                actions.addWidget(button)
            self.table.setCellWidget(index, 5, widget)
        self.table.blockSignals(False)
        self.table.resizeRowsToContents()
        self.previous_page.setEnabled(self.page > 0)
        self.next_page.setEnabled(self.page + 1 < pages)
        self.page_label.setText(f"第 {self.page + 1} / {pages} 页 · {len(rows)} 个任务 · 已勾选 {len(self.selected)} 个")

    def set_busy(self, busy):
        self.busy = busy
        self.delete_selected.setEnabled(not busy)
        self.pause.setEnabled(not busy)
        self.update_control()

    def operation(self, method, path, payload=None, after=None):
        if self.busy:
            return
        self.set_busy(True)

        def done(value, error):
            self.set_busy(False)
            self.message.setText(error or "操作完成")
            if after and not error:
                after()
            self.refresh()
        self.backend.request(method, path, payload, callback=done, timeout=120000)

    def start_batch(self):
        if self.selected and not self.control.get("storageError"):
            self.operation("POST", "/api/tasks/start-batch", {"ids": list(self.selected)})

    def toggle_pause(self):
        self.operation("POST", "/api/control/" + ("resume" if self.control.get("paused") or self.control.get("storageError") else "pause"))

    def act(self, identity, action):
        if action == "delete":
            self.delete_tasks([identity])
        elif not (self.control.get("storageError") and action in ("start", "retry", "update", "resume", "recover")):
            self.operation("POST", f"/api/tasks/{identity}/{action}")

    def delete_tasks(self, identities):
        if self.busy or not identities:
            return
        if QMessageBox.question(self, "确认删除任务", f"删除 {len(identities)} 个任务记录？已保存图片会保留。") != QMessageBox.StandardButton.Yes:
            return
        self.set_busy(True)
        queue = list(identities)

        def next_one(value=None, error=""):
            if error or not queue:
                self.set_busy(False)
                self.message.setText(error or "已删除任务，图片保留")
                self.refresh()
                return
            identity = queue.pop(0)
            self.backend.request("DELETE", f"/api/tasks/{identity}", callback=next_one, timeout=120000)
        next_one()
