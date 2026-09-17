"""只读后台确认的图片目录；不信任任务记录里的文件路径。"""
import os
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QSize, Qt
from PySide6.QtGui import QImage, QImageReader

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".heic"}
QImageReader.setAllocationLimit(128)


def safe_path(root, path):
    original_root = Path(root).absolute()
    root = original_root.resolve()
    path = Path(path)
    try:
        try:
            relative = path.absolute().relative_to(original_root)
        except ValueError:
            relative = path.absolute().relative_to(root)
        current = root
        for part in relative.parts:
            current /= part
            if part == ".." or current.is_symlink():
                raise ValueError()
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
        return resolved
    except (ValueError, OSError, RuntimeError):
        raise ValueError("拒绝读取图片根目录以外或符号链接文件") from None


def scan_accounts(root):
    root = Path(root).resolve()
    if not root.exists():
        return []
    accounts = []
    for path in root.iterdir():
        try:
            if safe_path(root, path).is_dir():
                accounts.append(path.name)
        except ValueError:
            continue
    return sorted(accounts)


def scan_images(root, account):
    if not account or Path(account).name != account:
        raise ValueError("账号目录无效")
    folder = safe_path(root, Path(root) / account)
    images = []
    for path in folder.iterdir():
        try:
            if path.suffix.lower() in EXTENSIONS and safe_path(root, path).is_file():
                images.append(path)
        except ValueError:
            continue
    return sorted(images)


@dataclass
class DecodedImage:
    image: QImage
    original_size: QSize
    warning: str = ""


def decode_image(root, path, thumbnail=None):
    path = safe_path(root, path)
    # 有界读取已保存文件，拒绝临时文件；末级链接还由操作系统再次检查。
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as handle:
        if os.fstat(handle.fileno()).st_size > 64 * 1024 * 1024:
            raise ValueError("图片文件超过 64 兆字节，已跳过以限制内存")
        raw = handle.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("图片文件过大，已跳过")
    buffer = QBuffer()
    buffer.setData(QByteArray(raw))
    buffer.open(QIODevice.OpenModeFlag.ReadOnly)
    reader = QImageReader(buffer)
    reader.setAutoTransform(True)
    size = reader.size()
    if not size.isValid() or not reader.canRead():
        raise ValueError("图片已损坏或当前桌面库不支持此格式")
    warning = ""
    limit = thumbnail
    if not thumbnail and size.width() * size.height() > 32_000_000:
        limit = 4096
        warning = "超大图片已安全缩小；原尺寸功能显示当前解码尺寸"
    if limit and (size.width() > limit or size.height() > limit):
        reader.setScaledSize(size.scaled(limit, limit, Qt.AspectRatioMode.KeepAspectRatio))
    image = reader.read()
    if image.isNull():
        raise ValueError("图片损坏、格式不支持或超出 128 兆字节解码限制，已跳过")
    return DecodedImage(image, size, warning)
