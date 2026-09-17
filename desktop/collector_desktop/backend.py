"""Qt 异步进程和网络；不会在界面线程等待后台。"""
import ipaddress
import json
import shutil
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from PySide6.QtCore import QObject, QProcess, QTimer, QUrl, Signal
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def validate_backend_url(value):
    try:
        parsed = urlsplit(value)
        local = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname).is_loopback
        if (not local or parsed.scheme != "http" or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment or not parsed.port):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("后台地址必须是带端口的本机回环地址") from None
    return value.rstrip("/")


class BackendClient(QObject):
    finished = Signal(str, object, str)
    status_changed = Signal(object)

    def __init__(self, data_dir, node=None, parent=None):
        super().__init__(parent)
        self.data_dir = Path(data_dir).resolve()
        self.node = node or shutil.which("node") or "node"
        self.status = {}
        self.network = QNetworkAccessManager(self)
        self.pending = {}
        self.processes = {}
        self.closed = False

    def set_status(self, value):
        value = dict(value)
        value["url"] = validate_backend_url(value["url"])
        if not Path(value.get("outputDir", "")).is_absolute():
            raise ValueError("旧后台未返回实际图片目录；请先显式安全停止旧后台，再打开新版")
        self.status = value
        self.status_changed.emit(value)

    def _deliver(self, identity, value, error, callback):
        if self.closed:
            return
        self.finished.emit(identity, value, error)
        if callback:
            callback(value, error)

    def start(self, output_dir="", callback=None):
        return self.command("start", output_dir=output_dir, callback=callback)

    def command(self, action, output_dir="", callback=None):
        if self.closed or action in self.processes:
            return None
        if action not in ("start", "status", "pause", "resume", "stop"):
            raise ValueError("未知后台命令")
        identity = uuid.uuid4().hex
        process = QProcess(self)
        timer = QTimer(process)
        timer.setSingleShot(True)
        timed_out = False
        done = False
        self.processes[action] = process
        args = [str(PROJECT_ROOT / "scripts/background.js"), action,
                "--data-dir", str(self.data_dir), "--json"]
        timeout = 120000 if action == "stop" else 30000
        args += ["--timeout", str(timeout)]
        if action == "start" and output_dir:
            args += ["--output-dir", output_dir]

        def finish(*unused):
            nonlocal done
            if done:
                return
            done = True
            timer.stop()
            self.processes.pop(action, None)
            result, error = None, ""
            try:
                if timed_out:
                    raise ValueError("等待后台命令超时，请检查后台状态")
                if process.exitCode() or process.error() == QProcess.ProcessError.FailedToStart:
                    # 不输出进程原始日志，避免意外暴露运行环境或凭证。
                    raise ValueError("后台命令失败，请检查运行环境及后台日志")
                result = json.loads(bytes(process.readAllStandardOutput()).decode("utf-8"))
                if action in ("start", "status"):
                    self.set_status(result)
            except (ValueError, KeyError, TypeError) as problem:
                error = str(problem)
            process.deleteLater()
            self._deliver(identity, result, error, callback)

        def expire():
            nonlocal timed_out
            timed_out = True
            process.kill()

        process.finished.connect(finish)
        process.errorOccurred.connect(lambda error: finish() if error == QProcess.ProcessError.FailedToStart else None)
        timer.timeout.connect(expire)
        process.setWorkingDirectory(str(PROJECT_ROOT))
        process.start(self.node, args)
        timer.start(timeout + 1000)
        return identity

    def request(self, method, path, payload=None, *, callback=None, timeout=15000, headers=None):
        identity = uuid.uuid4().hex
        if self.closed:
            return None
        if not path.startswith("/api/") or "#" in path or "\\" in path:
            raise ValueError("仅允许本机后台接口")
        if not self.status:
            QTimer.singleShot(0, lambda: self._deliver(identity, None, "尚未连接后台", callback))
            return identity
        request = QNetworkRequest(QUrl(self.status["url"] + path))
        request.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                             QNetworkRequest.RedirectPolicy.ManualRedirectPolicy)
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else b""
        request.setRawHeader(b"Content-Type", b"application/octet-stream" if isinstance(payload, bytes) else b"application/json")
        for key, value in (headers or {}).items():
            request.setRawHeader(key.encode(), value.encode())
        reply = self.network.sendCustomRequest(request, method.encode(), raw)
        timer = QTimer(reply)
        timer.setSingleShot(True)
        self.pending[identity] = reply
        timed_out = False

        def expire():
            nonlocal timed_out
            timed_out = True
            reply.abort()

        def finish():
            timer.stop()
            self.pending.pop(identity, None)
            if self.closed:
                reply.deleteLater()
                return
            result, error = None, ""
            try:
                if timed_out:
                    raise ValueError("后台请求超时")
                if reply.error() != QNetworkReply.NetworkError.NoError:
                    # HTTP 业务错误仍尝试读取中文错误描述。
                    body = bytes(reply.readAll())
                    try:
                        message = json.loads(body).get("error", "后台连接失败")
                    except (ValueError, AttributeError):
                        message = "后台连接失败，请检查服务是否运行"
                    raise ValueError(message)
                if reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute) not in range(200, 300):
                    raise ValueError("后台返回了无效响应或重定向")
                result = json.loads(bytes(reply.readAll()))
            except (ValueError, TypeError) as problem:
                error = str(problem)
            reply.deleteLater()
            self._deliver(identity, result, error, callback)

        timer.timeout.connect(expire)
        reply.finished.connect(finish)
        timer.start(timeout)
        return identity

    def close(self):
        self.closed = True
        for reply in list(self.pending.values()):
            reply.abort()
        for process in list(self.processes.values()):
            process.kill()
        self.deleteLater()
