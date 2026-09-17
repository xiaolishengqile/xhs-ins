import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

PRESETS = [("最近一周", "week"), ("最近一个月", "month"), ("最近半年", "halfYear"), ("最近一年", "year")]


@dataclass
class Settings:
    preset: str = "year"
    close_behavior: str = "hide"
    output_dir: str = ""

    def validate(self):
        if self.preset not in dict(PRESETS).values():
            raise ValueError("默认采集周期无效")
        if self.close_behavior not in ("hide", "quit"):
            raise ValueError("关闭窗口行为无效")
        if not isinstance(self.output_dir, str) or (self.output_dir and not Path(self.output_dir).is_absolute()):
            raise ValueError("图片目录必须是绝对路径")
        return self


def load_settings(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return Settings(**value).validate()
    except FileNotFoundError:
        return Settings()
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("桌面设置文件格式无效") from error


def save_settings(path, settings):
    settings.validate()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".desktop-settings-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(asdict(settings), handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
