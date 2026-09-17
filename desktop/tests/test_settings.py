import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import support


class SettingsTest(unittest.TestCase):
    def test_defaults_validation_and_atomic_failure(self):
        try:
            from collector_desktop.settings import Settings, load_settings, save_settings
        except ImportError:
            self.fail("桌面设置尚未实现")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "desktop-settings.json"
            settings = load_settings(path)
            self.assertEqual(settings.preset, "year")
            self.assertEqual(settings.close_behavior, "hide")
            save_settings(path, settings)
            settings.preset = "week"
            with patch("os.replace", side_effect=OSError("模拟磁盘故障")):
                with self.assertRaises(OSError):
                    save_settings(path, settings)
            self.assertEqual(json.loads(path.read_text())["preset"], "year")
            self.assertEqual(list(Path(directory).iterdir()), [path])
            for invalid in [Settings(preset="bad"), Settings(close_behavior="bad"), Settings(output_dir="relative")]:
                with self.assertRaises(ValueError):
                    save_settings(path, invalid)
            path.write_text('{"preset":"bad"}')
            with self.assertRaises(ValueError):
                load_settings(path)
