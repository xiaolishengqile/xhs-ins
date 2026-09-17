from collections import OrderedDict
from pathlib import Path

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QIcon, QPixmap
from PySide6.QtWidgets import (QComboBox, QHBoxLayout, QLabel, QListView,
                              QListWidget, QListWidgetItem, QPushButton, QVBoxLayout, QWidget)

from .image_files import decode_image, scan_accounts, scan_images
from .image_viewer import ImageViewer
from .jobs import Jobs


class ImagesPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.root, self.paths, self.page = None, [], 0
        self.generation = 0
        self.cache = OrderedDict()
        self.jobs = Jobs(self)
        self.viewer = None
        layout = QVBoxLayout(self)
        bar = QHBoxLayout()
        self.accounts = QComboBox()
        self.accounts.setMinimumWidth(220)
        self.refresh_button = QPushButton("刷新本地图片")
        bar.addWidget(QLabel("账号"))
        bar.addWidget(self.accounts)
        bar.addWidget(self.refresh_button)
        bar.addStretch()
        layout.addLayout(bar)
        self.message = QLabel("连接后台后浏览本地已保存的完整图片。双击图片打开预览。")
        self.message.setWordWrap(True)
        layout.addWidget(self.message)
        self.list = QListWidget()
        self.list.setViewMode(QListView.ViewMode.IconMode)
        self.list.setResizeMode(QListView.ResizeMode.Adjust)
        self.list.setIconSize(QSize(240, 180))
        self.list.setGridSize(QSize(265, 225))
        self.list.setWordWrap(True)
        layout.addWidget(self.list)
        pager = QHBoxLayout()
        self.previous, self.next = QPushButton("上一页"), QPushButton("下一页")
        self.page_label = QLabel()
        for widget in (self.previous, self.page_label, self.next):
            pager.addWidget(widget)
        layout.addLayout(pager)
        self.previous.clicked.connect(lambda: self.change_page(-1))
        self.next.clicked.connect(lambda: self.change_page(1))
        self.refresh_button.clicked.connect(self.refresh)
        self.accounts.currentTextChanged.connect(self.load_account)
        self.list.itemDoubleClicked.connect(self.open_image)

    def invalidate(self):
        self.generation += 1
        self.jobs.cancel()
        return self.generation

    def set_root(self, root):
        root = Path(root)
        if root != self.root:
            self.root = root
            self.cache.clear()
            self.refresh()

    def refresh(self):
        if not self.root:
            return
        generation = self.invalidate()
        root = self.root
        previous = self.accounts.currentText()
        self.cache.clear()
        self.list.clear()
        self.message.setText("正在扫描账号目录…")

        def loaded(accounts, error):
            if generation != self.generation:
                return
            if error:
                self.message.setText(error)
                return
            self.accounts.blockSignals(True)
            self.accounts.clear()
            self.accounts.addItems(accounts)
            if previous in accounts:
                self.accounts.setCurrentText(previous)
            self.accounts.blockSignals(False)
            self.message.setText("双击打开完整图片；不支持或损坏的文件会明确提示。" if accounts else "当前图片目录还没有账号图片。")
            self.load_account(self.accounts.currentText())
        self.jobs.submit(lambda: scan_accounts(root), loaded)

    def load_account(self, account):
        generation = self.invalidate()
        self.paths, self.page = [], 0
        self.list.clear()
        if not account or not self.root:
            self.render()
            return
        root = self.root

        def loaded(paths, error):
            if generation != self.generation:
                return
            if error:
                self.message.setText(error)
                return
            self.paths = paths
            self.render()
        self.jobs.submit(lambda: scan_images(root, account), loaded)

    def change_page(self, offset):
        self.page += offset
        self.render()

    def render(self):
        generation = self.invalidate()
        self.list.clear()
        pages = max(1, (len(self.paths) + 29) // 30)
        self.page = min(max(0, self.page), pages - 1)
        self.previous.setEnabled(self.page > 0)
        self.next.setEnabled(self.page + 1 < pages)
        self.page_label.setText(f"第 {self.page + 1} / {pages} 页 · {len(self.paths)} 张图片")
        for path in self.paths[self.page * 30:(self.page + 1) * 30]:
            item = QListWidgetItem(path.name)
            item.setData(Qt.ItemDataRole.UserRole, path)
            self.list.addItem(item)
            if path in self.cache:
                item.setIcon(self.cache[path])
                self.cache.move_to_end(path)
                continue
            root = self.root

            def loaded(result, error, item=item, path=path):
                if generation != self.generation:
                    return
                if error:
                    item.setText(path.name + "\n无法预览")
                    item.setToolTip(error)
                    return
                icon = QIcon(QPixmap.fromImage(result.image))
                item.setIcon(icon)
                self.cache[path] = icon
                while len(self.cache) > 60:
                    self.cache.popitem(last=False)
            self.jobs.submit(lambda path=path, root=root: decode_image(root, path, 240), loaded)

    def open_image(self, item):
        if self.viewer:
            self.viewer.close()
        viewer = ImageViewer(self.root, item.data(Qt.ItemDataRole.UserRole), self)
        self.viewer = viewer
        viewer.destroyed.connect(lambda: setattr(self, "viewer", None) if self.viewer is viewer else None)
        viewer.show()

    def hideEvent(self, event):
        self.invalidate()
        if self.viewer:
            self.viewer.close()
        super().hideEvent(event)

    def showEvent(self, event):
        super().showEvent(event)
        if self.root:
            self.refresh()
