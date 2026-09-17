import tempfile
import time
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch

from PySide6.QtGui import QImage

from support import APP, wait_for


class ImagesTest(unittest.TestCase):
    def setUp(self):
        try:
            from collector_desktop import images
            self.module = images
        except ImportError:
            self.fail("安全图片读取及原生图片页尚未实现")
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "pictures"
        self.folder = self.root / "账号甲"
        self.folder.mkdir(parents=True)
        self.image = self.folder / "wide.png"
        image = QImage(400, 200, QImage.Format.Format_RGB32)
        image.fill(0xff3377aa)
        self.assertTrue(image.save(str(self.image)))

    def tearDown(self):
        if hasattr(self, "temp"):
            self.temp.cleanup()

    def test_boundary_corruption_and_decode_aspect(self):
        from collector_desktop.image_files import decode_image, scan_accounts, scan_images
        outside = Path(self.temp.name) / "outside.png"
        outside.write_bytes(self.image.read_bytes())
        (self.folder / "broken.png").write_bytes(b"not an image")
        (self.folder / "partial.part").write_bytes(b"temporary")
        try:
            (self.folder / "escape.png").symlink_to(outside)
            (self.root / "escape-account").symlink_to(outside.parent, target_is_directory=True)
        except OSError:
            pass  # 微软非管理员环境可能禁止创建链接；越界路径仍覆盖。
        self.assertEqual(scan_accounts(self.root), ["账号甲"])
        self.assertEqual({p.name for p in scan_images(self.root, "账号甲")}, {"wide.png", "broken.png"})
        for path in (outside, self.folder / "escape.png"):
            with self.assertRaises(ValueError):
                decode_image(self.root, path)
        with self.assertRaises(ValueError):
            decode_image(self.root, self.folder / "broken.png")
        result = decode_image(self.root, self.image)
        self.assertEqual((result.image.width(), result.image.height()), (400, 200))
        thumbnail = decode_image(self.root, self.image, 240)
        self.assertEqual((thumbnail.image.width(), thumbnail.image.height()), (240, 120))

    def test_paging_cache_and_stale_account_result(self):
        from collector_desktop.image_files import decode_image
        for i in range(65):
            (self.folder / f"copy{i:02}.png").write_bytes(self.image.read_bytes())
        other = self.root / "账号乙"
        other.mkdir(parents=True)
        (other / "second.png").write_bytes(self.image.read_bytes())
        page = self.module.ImagesPage()
        page.show()
        page.set_root(self.root)
        wait_for(lambda: page.accounts.count() == 2)
        page.accounts.setCurrentText("账号甲")
        wait_for(lambda: page.list.count() == 30)
        wait_for(lambda: len(page.cache) == 30)
        page.change_page(1)
        wait_for(lambda: len(page.cache) == 60)
        page.change_page(1)
        wait_for(lambda: page.list.count() == 6 and len(page.jobs.pending) == 0)
        self.assertLessEqual(len(page.cache), 60)
        with patch.object(self.module, "decode_image", side_effect=lambda *a: (time.sleep(.03), decode_image(*a))[1]):
            page.change_page(-2)
            page.accounts.setCurrentText("账号乙")
            wait_for(lambda: page.list.count() == 1 and page.list.item(0).text().startswith("second.png"))
            wait_for(lambda: not page.jobs.pending)
        self.assertEqual(page.list.count(), 1)
        page.hide()
        self.assertFalse(any(not worker.cancelled for worker, _ in page.jobs.pending.values()))
        page.deleteLater()
        APP.processEvents()

    def test_viewer_fit_original_and_zoom(self):
        from collector_desktop.image_files import decode_image
        from collector_desktop.image_viewer import ImageViewer
        dialog = ImageViewer(self.root, self.image)
        dialog.show()
        wait_for(lambda: dialog.item is not None)
        dialog.original()
        self.assertAlmostEqual(dialog.view.transform().m11(), 1)
        dialog.zoom(1.25)
        self.assertAlmostEqual(dialog.view.transform().m11(), 1.25)
        dialog.fit()
        self.assertAlmostEqual(dialog.view.transform().m11(), dialog.view.transform().m22())
        self.assertIn("400 × 200", dialog.info.text())
        dialog.close()
        APP.processEvents()

    def test_replacing_open_viewer_keeps_latest_reference(self):
        page = self.module.ImagesPage()
        page.show()
        page.set_root(self.root)
        wait_for(lambda: page.list.count() == 1)
        page.open_image(page.list.item(0))
        first = page.viewer
        page.open_image(page.list.item(0))
        second = page.viewer
        # 删除旧对话框的延迟事件不可清掉新窗口引用。
        from PySide6.QtCore import QCoreApplication, QEvent
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertIsNot(first, second)
        self.assertIs(page.viewer, second)
        page.hide()
        page.deleteLater()
        APP.processEvents()

    def test_large_image_scales_and_oversize_file_is_rejected(self):
        from collector_desktop.image_files import decode_image
        image = QImage(8001, 4000, QImage.Format.Format_RGB32)
        image.fill(0xff228844)
        large = self.folder / "large.jpg"
        self.assertTrue(image.save(str(large)))
        result = decode_image(self.root, large)
        self.assertLessEqual(result.image.width(), 4096)
        self.assertIn("安全缩小", result.warning)
        oversized = self.folder / "oversized.png"
        with oversized.open("wb") as handle:
            handle.truncate(64 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "64"):
            decode_image(self.root, oversized)

    def test_reads_files_created_by_existing_backend_image_store(self):
        from collector_desktop.backend import PROJECT_ROOT
        from collector_desktop.image_files import decode_image, scan_accounts, scan_images
        output = Path(self.temp.name) / "actual-backend-output"
        script = """
import { LocalImageStore } from './src/export/local-image-store.js';
import { readFile } from 'node:fs/promises';
const [rootDir, indexDir, source] = process.argv.slice(1);
const store = new LocalImageStore({ rootDir, indexDir });
await store.save({ platform: 'instagram', profileKey: 'contract_account' },
  [{ id: 'local-fixture', metrics: { likeCount: 2 }, media: [{ url: 'https://fixture.invalid/image' }] }],
  { fetchBuffer: () => readFile(source) });
"""
        subprocess.run(["node", "--input-type=module", "-e", script, str(output),
                        str(Path(self.temp.name) / "indexes"), str(self.image)],
                       cwd=PROJECT_ROOT, check=True, capture_output=True, timeout=10)
        self.assertEqual(scan_accounts(output), ["contract_account"])
        paths = scan_images(output, "contract_account")
        self.assertEqual(len(paths), 1)
        self.assertEqual(decode_image(output, paths[0]).image.size().width(), 400)
