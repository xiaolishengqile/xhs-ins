from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices, QPainter, QPixmap
from PySide6.QtWidgets import (QDialog, QGraphicsScene, QGraphicsView, QHBoxLayout,
                              QLabel, QPushButton, QVBoxLayout)

from .image_files import decode_image, safe_path
from .jobs import Jobs


class ImageViewer(QDialog):
    def __init__(self, root, path, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.setWindowTitle("完整图片预览")
        self.resize(1000, 760)
        self.root, self.path = root, path
        self.item = None
        self.fitting = True
        self.jobs = Jobs(self)
        layout = QVBoxLayout(self)
        self.info = QLabel("正在读取已保存图片…")
        self.info.setWordWrap(True)
        layout.addWidget(self.info)
        self.scene = QGraphicsScene(self)
        self.view = QGraphicsView(self.scene)
        self.view.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        self.view.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        layout.addWidget(self.view)
        buttons = QHBoxLayout()
        for label, callback in (("适应窗口", self.fit), ("原始比例", self.original),
                                ("放大", lambda: self.zoom(1.25)), ("缩小", lambda: self.zoom(.8)),
                                ("打开所在目录", self.open_folder)):
            button = QPushButton(label)
            button.clicked.connect(callback)
            buttons.addWidget(button)
        layout.addLayout(buttons)
        self.jobs.submit(lambda: decode_image(root, path), self.loaded)

    def loaded(self, result, error):
        if error:
            self.info.setText(error)
            return
        self.item = self.scene.addPixmap(QPixmap.fromImage(result.image))
        size = result.original_size
        self.info.setText(f"{self.path.name} · {size.width()} × {size.height()} 像素 · {result.warning or '已保存的完整图片'}")
        self.fit()

    def fit(self):
        self.fitting = True
        if self.item:
            self.view.fitInView(self.item, Qt.AspectRatioMode.KeepAspectRatio)

    def original(self):
        self.fitting = False
        self.view.resetTransform()

    def zoom(self, factor):
        self.fitting = False
        scale = self.view.transform().m11() * factor
        if .02 <= scale <= 8:
            self.view.scale(factor, factor)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self.fitting:
            self.fit()

    def open_folder(self):
        def checked(path, error):
            if error:
                self.info.setText(error)
            else:
                QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))
        self.jobs.submit(lambda: safe_path(self.root, self.path).parent, checked)

    def closeEvent(self, event):
        self.jobs.cancel()
        super().closeEvent(event)
