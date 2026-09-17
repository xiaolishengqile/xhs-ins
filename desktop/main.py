"""采图台原生桌面入口；仅负责参数、实例与窗口装配。"""
import argparse
import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication, QMessageBox

from collector_desktop.backend import BackendClient, PROJECT_ROOT
from collector_desktop.instance import DesktopInstance
from collector_desktop.settings import load_settings
from collector_desktop.window import MainWindow


def main():
    parser = argparse.ArgumentParser(description="采图台原生桌面窗口")
    parser.add_argument("--data-dir", type=Path, default=PROJECT_ROOT / ".data", help="指定独立数据目录")
    parser.add_argument("--node", help="后台运行环境可执行文件路径")
    options = parser.parse_args()
    app = QApplication(sys.argv[:1])
    app.setApplicationName("采图台")
    app.setQuitOnLastWindowClosed(False)
    instance = None

    def secondary_done(ok):
        if not ok:
            QMessageBox.warning(None, "已有桌面实例", "无法唤起正在使用此数据目录的窗口。请检查已有窗口后重试；不会强行接管。")
        app.quit()
    try:
        instance = DesktopInstance(options.data_dir)
        instance.secondary_done.connect(secondary_done)
        if not instance.acquire():
            return app.exec()
        settings_path = options.data_dir.resolve() / "desktop-settings.json"
        settings = load_settings(settings_path)
    except (OSError, ValueError, RuntimeError) as error:
        QMessageBox.critical(None, "桌面启动失败", str(error))
        if instance:
            instance.close()
        return 1
    backend = BackendClient(options.data_dir, options.node)
    window = MainWindow(backend, settings, settings_path)
    instance.activated.connect(window.activate)
    window.exiting.connect(app.quit)
    app.aboutToQuit.connect(instance.close)
    window.show()
    QTimer.singleShot(0, window.connect_backend)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
