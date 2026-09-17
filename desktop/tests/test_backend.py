import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from support import LocalServer, wait_for


class BackendTest(unittest.TestCase):
    def backend_class(self):
        try:
            from collector_desktop.backend import BackendClient
            return BackendClient
        except ImportError:
            self.fail("异步后台客户端尚未实现")

    def test_loopback_requests_failures_and_timeout(self):
        BackendClient = self.backend_class()
        from collector_desktop.backend import validate_backend_url
        for url in ["https://example.com", "http://127.0.0.1.evil.test", "file:///tmp/x", "http://user@localhost", "http://localhost/path"]:
            with self.assertRaises(ValueError):
                validate_backend_url(url)
        server = LocalServer(lambda m, p, b: (time.sleep(.15) or (200, {"ok": True})) if p.endswith("slow") else (200, {"ok": True}))
        client = BackendClient(Path(tempfile.gettempdir()) / "unused-desktop-test")
        client.set_status({"url": server.url, "outputDir": tempfile.gettempdir()})
        results = []
        client.request("GET", "/api/health", callback=lambda v, e: results.append((v, e)))
        wait_for(lambda: results)
        self.assertEqual(results[0], ({"ok": True}, ""))
        client.request("GET", "/api/slow", timeout=30, callback=lambda v, e: results.append((v, e)))
        wait_for(lambda: len(results) == 2)
        self.assertIn("超时", results[-1][1])
        server.close()
        client.request("GET", "/api/health", callback=lambda v, e: results.append((v, e)))
        wait_for(lambda: len(results) == 3)
        self.assertTrue(results[-1][1])
        client.close()

    def test_old_backend_without_actual_output_directory_explains_upgrade(self):
        BackendClient = self.backend_class()
        client = BackendClient(Path(tempfile.gettempdir()) / "unused-desktop-test")
        with self.assertRaisesRegex(ValueError, "旧后台.*安全停止.*新版"):
            client.set_status({"url": "http://127.0.0.1:12345"})
        client.close()

    def test_real_isolated_backend_lifecycle_and_pending_task(self):
        BackendClient = self.backend_class()
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            args = ["node", str(root / "scripts/background.js")]
            common = ["--data-dir", directory, "--json"]
            status = json.loads(subprocess.check_output(args + ["start", "--port", "0"] + common, text=True))
            client = BackendClient(directory)
            result = []
            try:
                client.start(callback=lambda value, error: result.append((value, error)))
                wait_for(lambda: result, 15)
                self.assertEqual(client.status["url"], status["url"])
                self.assertEqual(client.status["dataDir"], directory)
                self.assertFalse(result[0][1])
                client.request("POST", "/api/tasks", {"url": "https://www.instagram.com/desktop_test/", "range": {"preset": "year"}}, callback=lambda v, e: result.append((v, e)))
                wait_for(lambda: len(result) == 2)
                self.assertEqual(result[-1][0]["task"]["status"], "pending")
                client.command("stop", callback=lambda v, e: result.append((v, e)))
                wait_for(lambda: len(result) == 3, 15)
                self.assertEqual(result[-1], ({"stopped": True}, ""))
            finally:
                client.close()
                subprocess.run(args + ["stop"] + common, capture_output=True, timeout=15)
