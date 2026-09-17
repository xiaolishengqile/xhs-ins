import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QMessageBox

from support import APP, LocalServer, wait_for
from collector_desktop.backend import BackendClient


class TasksTest(unittest.TestCase):
    def setUp(self):
        try:
            from collector_desktop.tasks import TasksPage
        except ImportError:
            self.fail("原生任务页尚未实现")
        self.rows = [{"id": f"00000000-0000-0000-0000-{i:012d}", "profileKey": f"person{i}", "status": "pending", "progress": {}} for i in range(35)]
        self.control = {"paused": True, "storageError": None, "cooldowns": []}

        def respond(method, path, body):
            if path == "/api/tasks" and method == "GET":
                return 200, {"tasks": self.rows}
            if path == "/api/control":
                return 200, self.control
            if path == "/api/profiles/builtin":
                return 200, {"profiles": [f"https://www.instagram.com/builtin{i}/" for i in range(719)]}
            if path == "/api/tasks/batch":
                return 202, {"tasks": [{"status": "pending"} for _ in body["entries"]], "rejected": [], "duplicates": 0}
            if path == "/api/link-files/parse":
                return 200, {"entries": [{"url": "https://www.instagram.com/imported/", "line": 1}]}
            return 200, {}

        self.server = LocalServer(respond)
        self.client = BackendClient(tempfile.gettempdir())
        self.client.set_status({"url": self.server.url, "outputDir": tempfile.gettempdir()})
        self.page = TasksPage(self.client, "year")
        self.page.show()
        wait_for(lambda: len(self.page.rows) == 35)

    def tearDown(self):
        if hasattr(self, "page"):
            self.page.hide()
            self.page.deleteLater()
            self.client.close()
            APP.processEvents()
            self.server.close()

    def test_real_controls_submit_default_year_and_builtin_batches(self):
        form = self.page.create_form
        form.urls.setPlainText("https://www.instagram.com/example/")
        QTest.mouseClick(form.submit, Qt.MouseButton.LeftButton)
        wait_for(lambda: any(c[1] == "/api/tasks/batch" for c in self.server.calls))
        wait_for(lambda: form.submit.isEnabled())
        first = next(c for c in self.server.calls if c[1] == "/api/tasks/batch")
        self.assertEqual(first[2]["range"], {"preset": "year"})
        self.assertFalse(any("start" in c[1] for c in self.server.calls))
        QTest.mouseClick(form.builtin, Qt.MouseButton.LeftButton)
        wait_for(lambda: len(form.urls.toPlainText().splitlines()) == 719)
        QTest.mouseClick(form.submit, Qt.MouseButton.LeftButton)
        wait_for(lambda: len([c for c in self.server.calls if c[1] == "/api/tasks/batch"]) == 3)
        self.assertEqual([len(c[2]["entries"]) for c in self.server.calls if c[1] == "/api/tasks/batch"], [1, 500, 219])

    def test_selection_survives_pagination_filter_and_confirmation(self):
        first_id = self.page.rows[0]["id"]
        self.page.table.item(0, 0).setCheckState(Qt.CheckState.Checked)
        QTest.mouseClick(self.page.next_page, Qt.MouseButton.LeftButton)
        self.page.table.item(0, 0).setCheckState(Qt.CheckState.Checked)
        second_id = self.page.rows[30]["id"]
        self.page.filter.setCurrentIndex(self.page.filter.findData("failed"))
        self.page.filter.setCurrentIndex(0)
        self.assertEqual(self.page.selected, {first_id, second_id})
        QTest.mouseClick(self.page.start_selected, Qt.MouseButton.LeftButton)
        wait_for(lambda: any(c[1] == "/api/tasks/start-batch" for c in self.server.calls))
        self.assertEqual(set(next(c[2]["ids"] for c in self.server.calls if c[1].endswith("start-batch"))), {first_id, second_id})
        wait_for(lambda: not self.page.busy)
        with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.No):
            QTest.mouseClick(self.page.delete_selected, Qt.MouseButton.LeftButton)
        self.assertFalse(any(c[0] == "DELETE" for c in self.server.calls))
        with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes):
            QTest.mouseClick(self.page.delete_selected, Qt.MouseButton.LeftButton)
        wait_for(lambda: len([c for c in self.server.calls if c[0] == "DELETE"]) == 2)

    def test_actions_storage_error_refresh_and_hidden_polling(self):
        self.rows[0]["status"] = "partial"
        self.rows[1]["status"] = "failed"
        self.control["paused"] = False
        self.page.refresh()
        wait_for(lambda: self.page.rows[0]["status"] == "partial" and not self.page.refreshing)
        self.assertIn(("补采失败图片", "retry"), self.page.actions_for(self.page.rows[0]))
        self.assertIn(("采集新增", "update"), self.page.actions_for(self.page.rows[0]))
        self.assertIn(("重试", "retry"), self.page.actions_for(self.page.rows[1]))
        self.assertFalse(self.page.control["paused"])
        self.control["storageError"] = "模拟写盘失败"
        self.page.refresh()
        wait_for(lambda: self.page.control.get("storageError"))
        self.assertFalse(self.page.start_selected.isEnabled())
        self.assertIn("存储故障", self.page.control_label.text())
        self.page.hide()
        self.assertFalse(self.page.timer.isActive())
        self.page.show()
        self.assertTrue(self.page.timer.isActive())

    def test_storage_error_recovery_button_always_resumes(self):
        self.control.update(paused=False, storageError="模拟写盘失败")
        self.page.refresh()
        wait_for(lambda: self.page.control.get("storageError") and not self.page.refreshing)

        self.assertEqual(self.page.pause.text(), "重试保存并继续")
        QTest.mouseClick(self.page.pause, Qt.MouseButton.LeftButton)

        wait_for(lambda: any(call[:2] == ("POST", "/api/control/resume") for call in self.server.calls))
        self.assertFalse(any(call[:2] == ("POST", "/api/control/pause") for call in self.server.calls))

    def test_file_import_uses_backend_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profiles.txt"
            path.write_bytes(b"https://www.instagram.com/imported/")
            self.page.create_form.import_file(str(path))
            wait_for(lambda: "imported" in self.page.create_form.urls.toPlainText())
        self.assertTrue(any(c[1] == "/api/link-files/parse" and isinstance(c[2], bytes) for c in self.server.calls))

    def test_partial_and_failed_actions_reach_backend_once(self):
        from PySide6.QtWidgets import QPushButton
        self.rows[0]["status"] = "partial"
        self.rows[1]["status"] = "failed"
        self.page.refresh()
        wait_for(lambda: not self.page.refreshing)
        retry = next(button for button in self.page.table.cellWidget(0, 5).findChildren(QPushButton) if button.text() == "补采失败图片")
        QTest.mouseClick(retry, Qt.MouseButton.LeftButton)
        self.page.act(self.rows[0]["id"], "retry")
        wait_for(lambda: not self.page.busy and not self.page.refreshing)
        self.assertEqual(len([call for call in self.server.calls if call[1].endswith("/retry")]), 1)
        update = next(button for button in self.page.table.cellWidget(0, 5).findChildren(QPushButton) if button.text() == "采集新增")
        QTest.mouseClick(update, Qt.MouseButton.LeftButton)
        wait_for(lambda: not self.page.busy and not self.page.refreshing)
        self.assertTrue(any(call[1] == f"/api/tasks/{self.rows[0]['id']}/update" for call in self.server.calls))

    def test_custom_range_invalid_dates_and_manual_limit(self):
        from PySide6.QtCore import QDate
        form = self.page.create_form
        form.urls.setPlainText("https://www.instagram.com/example/")
        form.preset.setCurrentIndex(form.preset.findData("custom"))
        form.from_date.setDate(QDate(2026, 2, 2))
        form.to_date.setDate(QDate(2026, 2, 1))
        QTest.mouseClick(form.submit, Qt.MouseButton.LeftButton)
        self.assertFalse(any(call[1] == "/api/tasks/batch" for call in self.server.calls))
        form.to_date.setDate(QDate(2026, 3, 1))
        QTest.mouseClick(form.submit, Qt.MouseButton.LeftButton)
        wait_for(lambda: not form.busy)
        request = next(call for call in self.server.calls if call[1] == "/api/tasks/batch")
        self.assertEqual(request[2]["range"], {"preset": "custom", "from": "2026-02-02", "to": "2026-03-01"})
        form.urls.setPlainText("\n".join(f"https://www.instagram.com/person{i}/" for i in range(501)))
        QTest.mouseClick(form.submit, Qt.MouseButton.LeftButton)
        self.assertIn("500", form.message.text())
        self.assertEqual(len([c for c in self.server.calls if c[1] == "/api/tasks/batch"]), 1)

    def test_operation_during_refresh_requests_fresh_snapshot(self):
        import copy
        import threading
        wait_for(lambda: not self.page.refreshing)
        original = self.server.responder
        reading, release = threading.Event(), threading.Event()
        first = True

        def respond(method, path, body):
            nonlocal first
            if path == "/api/tasks" and first:
                first = False
                old = copy.deepcopy(self.rows)
                reading.set()
                release.wait(2)
                return 200, {"tasks": old}
            if path.endswith("/cancel"):
                self.rows[0]["status"] = "cancelled"
                return 200, {}
            return original(method, path, body)

        self.server.responder = respond
        self.page.refresh()
        wait_for(reading.is_set)
        self.page.act(self.rows[0]["id"], "cancel")
        wait_for(lambda: not self.page.busy)
        release.set()
        wait_for(lambda: self.page.rows[0]["status"] == "cancelled", 1)

    def test_reconnection_clears_old_connection_error(self):
        wait_for(lambda: not self.page.refreshing)
        original = self.server.responder
        self.server.responder = lambda m, p, b: (503, {"error": "尚未连接后台"})
        self.page.refresh()
        wait_for(lambda: not self.page.refreshing)
        self.assertIn("尚未连接后台", self.page.message.text())
        self.server.responder = original
        self.page.refresh()
        wait_for(lambda: not self.page.refreshing)
        self.assertNotIn("尚未连接后台", self.page.message.text())
