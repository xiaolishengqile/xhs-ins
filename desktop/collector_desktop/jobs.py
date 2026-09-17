"""有界线程池，供本地文件读取与图片解码；结果始终回到主线程。"""
import uuid

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, Slot


class WorkerSignals(QObject):
    done = Signal(str, object, str)


class Worker(QRunnable):
    def __init__(self, identity, operation):
        super().__init__()
        self.identity, self.operation = identity, operation
        self.signals = WorkerSignals()
        self.cancelled = False

    def run(self):
        value, error = None, ""
        try:
            if not self.cancelled:
                value = self.operation()
        except Exception as problem:
            error = str(problem)
        self.signals.done.emit(self.identity, value, error)


class Jobs(QObject):
    def __init__(self, parent=None):
        super().__init__(parent)
        # 全局池持有运行中线程，关闭窗口不会在析构时同步等待解码。
        self.pool = QThreadPool.globalInstance()
        self.pool.setMaxThreadCount(2)
        self.pending = {}

    def submit(self, operation, callback):
        identity = uuid.uuid4().hex
        worker = Worker(identity, operation)
        worker.signals.done.connect(self._done)
        self.pending[identity] = (worker, callback)
        self.pool.start(worker)
        return identity

    @Slot(str, object, str)
    def _done(self, identity, value, error):
        entry = self.pending.pop(identity, None)
        if entry and not entry[0].cancelled:
            entry[1](value, error)

    def cancel(self):
        for worker, _ in self.pending.values():
            worker.cancelled = True
