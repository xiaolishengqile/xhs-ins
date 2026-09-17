import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PySide6.QtTest import QSignalSpy
from PySide6.QtTest import QTest

from support import APP, LocalServer, wait_for
from collector_desktop.backend import BackendClient
from collector_desktop.settings import Settings, load_settings


class WindowTest(unittest.TestCase):
    def classes(self):
        try:
            from collector_desktop.instance import DesktopInstance
            from collector_desktop.window import MainWindow
            return DesktopInstance, MainWindow
        except ImportError:
            self.fail("桌面单实例、窗口及生命周期尚未实现")

    def test_second_instance_activates_first_and_releases_lock(self):
        DesktopInstance, _ = self.classes()
        with tempfile.TemporaryDirectory() as directory:
            first = DesktopInstance(directory)
            activation = QSignalSpy(first.activated)
            self.assertTrue(first.acquire())
            second = DesktopInstance(Path(directory) / ".")
            acknowledged = QSignalSpy(second.secondary_done)
            self.assertFalse(second.acquire())
            wait_for(lambda: activation.count() == 1 and acknowledged.count() == 1)
            self.assertTrue(acknowledged.at(0)[0])
            second.close()
            first.close()
            third = DesktopInstance(directory)
            self.assertTrue(third.acquire())
            third.close()

    def test_close_hide_no_tray_stop_failure_and_ui_only_exit(self):
        _, MainWindow = self.classes()
        server = LocalServer(lambda m, p, b: (200, {"tasks": []} if p == "/api/tasks" else {"paused": False}))
        with tempfile.TemporaryDirectory() as directory:
            backend = BackendClient(directory, node="/definitely-missing-desktop-node")
            backend.set_status({"url": server.url, "dataDir": directory, "outputDir": directory})
            window = MainWindow(backend, Settings(), Path(directory) / "desktop-settings.json")
            exited = QSignalSpy(window.exiting)
            window.show()
            window.tray_available = True
            window.close()
            self.assertFalse(window.isVisible())
            self.assertEqual(exited.count(), 0)
            window.activate()
            self.assertTrue(window.isVisible())
            window.tray_available = False
            with patch.object(window, "choose_no_tray", return_value="stay"):
                window.close()
            self.assertTrue(window.isVisible())
            window.request_exit(stop=True)
            wait_for(lambda: not window.stopping)
            self.assertTrue(window.isVisible())
            self.assertEqual(exited.count(), 0)
            self.assertIn("失败", window.connection.text())
            window.request_exit(stop=False)
            self.assertEqual(exited.count(), 1)
            self.assertFalse(window.isVisible())
            self.assertFalse(any("stop" in call[1] for call in server.calls))
            window.deleteLater()
            APP.processEvents()
        server.close()

    def test_preferences_persist_without_start_or_moving_images(self):
        _, MainWindow = self.classes()
        server = LocalServer(lambda m, p, b: (200, {"tasks": []} if p == "/api/tasks" else {}))
        with tempfile.TemporaryDirectory() as directory:
            backend = BackendClient(directory)
            backend.set_status({"url": server.url, "dataDir": directory, "outputDir": directory})
            path = Path(directory) / "desktop-settings.json"
            window = MainWindow(backend, Settings(), path)
            preferences = window.preferences
            chosen = str(Path(directory) / "new-pictures")
            preferences.output.setText(chosen)
            preferences.preset.setCurrentIndex(preferences.preset.findData("week"))
            preferences.save()
            wait_for(lambda: path.exists())
            wait_for(lambda: not preferences.saving)
            self.assertEqual(load_settings(path).output_dir, chosen)
            self.assertEqual(window.tasks.preset.currentData(), "week")
            self.assertEqual(backend.status["outputDir"], directory)
            self.assertFalse(Path(chosen).exists())
            self.assertIn("下次", preferences.message.text())
            window.request_exit(False)
            window.deleteLater()
            APP.processEvents()
        server.close()

    def test_instance_activation_can_arrive_in_parts(self):
        from PySide6.QtCore import QTimer
        from PySide6.QtNetwork import QLocalSocket
        DesktopInstance, _ = self.classes()
        with tempfile.TemporaryDirectory() as directory:
            first = DesktopInstance(directory)
            self.assertTrue(first.acquire())
            activation = QSignalSpy(first.activated)
            socket = QLocalSocket()
            socket.connectToServer(first.name)
            wait_for(lambda: socket.state() == QLocalSocket.LocalSocketState.ConnectedState)
            socket.write(b"acti")
            socket.flush()
            QTimer.singleShot(50, lambda: socket.write(b"vate\n"))
            try:
                wait_for(lambda: activation.count() == 1, .5)
            finally:
                socket.abort()
                first.close()

    def test_invalid_data_directory_reports_startup_error(self):
        import main
        with tempfile.NamedTemporaryFile() as handle:
            with patch("sys.argv", ["desktop/main.py", "--data-dir", handle.name]), \
                    patch.object(main, "QApplication", return_value=APP), \
                    patch.object(main.QMessageBox, "critical") as message:
                try:
                    result = main.main()
                except OSError:
                    self.fail("无效数据目录应显示启动错误，不能抛出未捕获异常")
                self.assertEqual(result, 1)
                self.assertEqual(message.call_count, 1)

    def test_preferences_paths_use_available_width_and_wrap(self):
        _, MainWindow = self.classes()
        with tempfile.TemporaryDirectory() as directory:
            backend = BackendClient(directory)
            window = MainWindow(backend, Settings(), Path(directory) / "desktop-settings.json")
            window.preferences.set_status({"url": "http://127.0.0.1:12345", "dataDir": directory + "/很长的实际数据目录" * 10,
                                           "outputDir": directory + "/很长的实际图片目录" * 10})
            window.navigation.setCurrentRow(2)
            window.show()
            try:
                for width in (1240, 960):
                    window.resize(width, 820)
                    APP.processEvents()
                    for label in (window.preferences.connection, window.preferences.data, window.preferences.actual_output):
                        self.assertGreaterEqual(label.width(), window.preferences.width() - 250)
                        self.assertGreaterEqual(label.height(), label.heightForWidth(label.width()))
            finally:
                window.request_exit(False)
                window.deleteLater()
                APP.processEvents()

    def test_status_timer_does_not_poll_hidden_task_page(self):
        _, MainWindow = self.classes()
        server = LocalServer(lambda m, p, b: (200, {"tasks": []} if p == "/api/tasks" else {"paused": False}))
        with tempfile.TemporaryDirectory() as directory:
            backend = BackendClient(directory)
            backend.set_status({"url": server.url, "dataDir": directory, "outputDir": directory})
            window = MainWindow(backend, Settings(), Path(directory) / "desktop-settings.json")
            window.show()
            wait_for(lambda: not window.tasks.refreshing)
            # 隔离已另行集成测试的进程边界；列表请求仍实际通过本机 HTTP。
            with patch.object(backend, "command", side_effect=lambda action, callback: callback(backend.status, "")):
                try:
                    for index in (1, 2):
                        window.navigation.setCurrentRow(index)
                        wait_for(lambda: not window.tasks.refreshing)
                        server.calls.clear()
                        window.status_timer.start(20)
                        QTest.qWait(85)
                        self.assertTrue(window.status_timer.isActive())
                        self.assertFalse(window.tasks.timer.isActive())
                        self.assertEqual(server.calls, [])
                    window.hide()
                    window.start_result(backend.status, "")
                    QTest.qWait(30)
                    self.assertEqual(server.calls, [])
                    window.activate()
                    QTest.qWait(30)
                    self.assertEqual(server.calls, [])
                    window.navigation.setCurrentRow(0)
                    wait_for(lambda: any(path == "/api/tasks" for _, path, _ in server.calls))
                    self.assertTrue(window.tasks.timer.isActive())
                finally:
                    window.request_exit(False)
                    window.deleteLater()
                    APP.processEvents()
        server.close()

    def test_tray_resume_uses_explicit_action_after_external_pause(self):
        _, MainWindow = self.classes()
        control = {"paused": False}

        def respond(method, path, body):
            if method == "POST":
                control["paused"] = path.endswith("/pause")
            return 200, {"tasks": []} if path == "/api/tasks" else dict(control)

        server = LocalServer(respond)
        with tempfile.TemporaryDirectory() as directory:
            backend = BackendClient(directory)
            backend.set_status({"url": server.url, "dataDir": directory, "outputDir": directory})
            window = MainWindow(backend, Settings(), Path(directory) / "desktop-settings.json")
            window.show()
            wait_for(lambda: not window.tasks.refreshing)
            window.hide()
            self.assertFalse(window.tasks.control["paused"])
            control["paused"] = True  # 另一个入口在窗口隐藏后暂停。
            actions = window.tray.contextMenu().actions()
            resume = next(action for action in actions if action.text() in ("继续采集", "暂停 / 继续"))
            try:
                resume.trigger()
                wait_for(lambda: not window.tasks.busy and not window.tasks.refreshing)
                self.assertFalse(control["paused"])
                self.assertIn(("POST", "/api/control/resume", b""), server.calls)
                pause = next(action for action in actions if action.text() == "暂停采集")
                pause.trigger()
                wait_for(lambda: not window.tasks.busy and not window.tasks.refreshing)
                self.assertTrue(control["paused"])
                self.assertIn(("POST", "/api/control/pause", b""), server.calls)
            finally:
                window.request_exit(False)
                window.deleteLater()
                APP.processEvents()
        server.close()
