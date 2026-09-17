import hashlib
import os
from pathlib import Path

from PySide6.QtCore import QObject, QLockFile, QTimer, Signal
from PySide6.QtNetwork import QLocalServer, QLocalSocket


class DesktopInstance(QObject):
    activated = Signal()
    secondary_done = Signal(bool)

    def __init__(self, data_dir, parent=None):
        super().__init__(parent)
        directory = Path(data_dir).resolve()
        directory.mkdir(parents=True, exist_ok=True)
        identity = os.path.normcase(str(directory))
        self.name = "collector-desktop-" + hashlib.sha256(identity.encode()).hexdigest()[:24]
        self.lock = QLockFile(str(directory / "desktop.lock"))
        self.lock.setStaleLockTime(0)
        self.server = QLocalServer(self)
        self.server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        self.server.newConnection.connect(self.accept)
        self.socket = None
        self.response = bytearray()
        self.primary = False
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.timeout.connect(lambda: self.secondary_done.emit(False))

    def acquire(self):
        if self.lock.tryLock(0):
            # 只在持有锁时清理崩溃残留，永不抢占活实例的端点。
            QLocalServer.removeServer(self.name)
            if not self.server.listen(self.name):
                self.lock.unlock()
                raise RuntimeError("无法建立桌面实例唤起通道")
            self.primary = True
            return True
        self.socket = QLocalSocket(self)
        self.socket.connected.connect(lambda: self.socket.write(b"activate\n"))
        self.socket.readyRead.connect(self.acknowledged)
        self.socket.errorOccurred.connect(self.retry)
        self.timer.start(3000)
        self.socket.connectToServer(self.name)
        return False

    def retry(self, error):
        if self.timer.isActive():
            QTimer.singleShot(100, self.connect_again)

    def connect_again(self):
        if self.timer.isActive() and self.socket.state() == QLocalSocket.LocalSocketState.UnconnectedState:
            self.socket.connectToServer(self.name)

    def acknowledged(self):
        self.response.extend(bytes(self.socket.readAll()))
        if b"ok\n" in self.response:
            self.timer.stop()
            self.secondary_done.emit(True)

    def accept(self):
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            data = bytearray()

            def read(socket=socket, data=data):
                data.extend(bytes(socket.readAll()))
                if data == b"activate\n":
                    self.activated.emit()
                    socket.write(b"ok\n")
                    socket.flush()
                    socket.disconnectFromServer()
                elif len(data) > 32:
                    socket.abort()
            socket.readyRead.connect(read)
            socket.disconnected.connect(socket.deleteLater)

    def close(self):
        self.timer.stop()
        if self.socket:
            self.socket.abort()
        if self.primary:
            self.server.close()
            self.lock.unlock()
            self.primary = False
        self.deleteLater()
