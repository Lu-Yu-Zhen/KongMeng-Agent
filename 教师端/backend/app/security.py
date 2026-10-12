# -*- coding: utf-8 -*-
"""
安全模块：API Key 加解密
========================
本地桌面应用场景，模型 API Key 不应明文落盘，也不应每次由前端明文传输。
本模块用本机级密钥（优先 Windows DPAPI，回退为 Fernet 随机密钥，再回退为本地派生密钥）
对 API Key 做对称加密后存储；密钥不落盘于项目目录，尽量绑定用户会话。

安全说明：这是本地单机信任边界内的保护层——能挡住明文平铺在磁盘、误读与日志泄露。
DPAPI 绑定当前 Windows 用户；Fernet 回退使用随机密钥（存于用户目录，非项目目录）。
任何回退都会打日志告警，避免"静默降级到弱方案"而无人察觉。
"""
from __future__ import annotations

import base64
import logging
import os
import sys

log = logging.getLogger("teacher-backend.security")

try:
    # Windows DPAPI：密钥绑定当前 Windows 用户，最贴合本地桌面场景
    import ctypes
    import ctypes.wintypes as wt

    _DPAPI_OK = sys.platform == "win32"
except Exception:  # pragma: no cover
    _DPAPI_OK = False


def _dpapi_encrypt(plain: "str") -> str:
    """用 Windows DPAPI 加密，返回 base64 密文。"""
    try:
        from ctypes import byref, create_string_buffer

        data = plain.encode("utf-8")
        buf_in = create_string_buffer(data)
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        in_blob = DATA_BLOB(len(data), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptProtectData(
            byref(in_blob), "teacher-agent-key", None, None, None, 0, byref(out_blob)
        ):
            raise OSError("CryptProtectData failed")
        raw = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
        return base64.b64encode(raw).decode("ascii")
    except Exception:
        return ""


def _dpapi_decrypt(enc: "str") -> str:
    """解密 DPAPI 密文。"""
    try:
        from ctypes import byref, create_string_buffer

        raw = base64.b64decode(enc.encode("ascii"))
        buf_in = create_string_buffer(raw)
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        in_blob = DATA_BLOB(len(raw), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
        out_blob = DATA_BLOB()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            byref(in_blob), None, None, None, None, 0, byref(out_blob)
        ):
            raise OSError("CryptUnprotectData failed")
        out = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)
        return out.decode("utf-8")
    except Exception:
        return ""


# ---------------- Fernet 回退（随机密钥，存于用户目录而非项目目录） ----------------
_FERNET_KEY_FILE = os.path.join(os.path.expanduser("~"), ".teacher_agent_fernet.key")


def _fernet_available() -> bool:
    try:
        import cryptography.fernet  # noqa: F401
        return True
    except Exception:
        return False


def _fernet_key() -> bytes:
    """读取或生成本机随机 Fernet 密钥（仅 cryptography 可用时）。"""
    try:
        from cryptography.fernet import Fernet
    except Exception:
        return b""
    try:
        if os.path.exists(_FERNET_KEY_FILE):
            with open(_FERNET_KEY_FILE, "rb") as f:
                k = f.read().strip()
            if k:
                return k
        k = Fernet.generate_key()
        with open(_FERNET_KEY_FILE, "wb") as f:
            f.write(k)
        try:
            if os.name != "nt":
                os.chmod(_FERNET_KEY_FILE, 0o600)
        except Exception:
            pass
        return k
    except Exception:
        return b""


def _fernet_encrypt(plain: str) -> str:
    k = _fernet_key()
    if not k:
        return ""
    try:
        from cryptography.fernet import Fernet
        return Fernet(k).encrypt(plain.encode("utf-8")).decode("ascii")
    except Exception:
        return ""


def _fernet_decrypt(enc: str) -> str:
    k = _fernet_key()
    if not k:
        return ""
    try:
        from cryptography.fernet import Fernet
        return Fernet(k).decrypt(enc.encode("ascii")).decode("utf-8")
    except Exception:
        return ""


# ---------------- 最后的弱回退（仅混淆，明确告警） ----------------
def _local_key() -> bytes:
    salt = os.getenv("COMPUTERNAME", "") or os.getenv("HOSTNAME", "") or "teacher-agent"
    prefix = "TEACHER_AGENT_LOCAL_KEY_"
    return (prefix + salt).encode("utf-8")


def _xor_encrypt(plain: str) -> str:
    key = _local_key()
    data = plain.encode("utf-8")
    out = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return "xor:" + base64.b64encode(out).decode("ascii")


def _xor_decrypt(enc: str) -> str:
    if not enc.startswith("xor:"):
        return ""
    key = _local_key()
    raw = base64.b64decode(enc[4:].encode("ascii"))
    out = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
    try:
        return out.decode("utf-8")
    except Exception:
        return ""


def encrypt(plain: str) -> str:
    """加密明文，返回可安全存储的字符串。"""
    if not plain:
        return ""
    if _DPAPI_OK:
        enc = _dpapi_encrypt(plain)
        if enc:
            return "dpapi:" + enc
        log.warning("DPAPI 加密失败，回退到本地密钥方案")
    # 优先 Fernet（随机密钥，强度高）于 XOR
    fenc = _fernet_encrypt(plain)
    if fenc:
        return "fernet:" + fenc
    log.warning("cryptography 不可用，API Key 退回弱 XOR 混淆存储；建议 pip install cryptography")
    return _xor_encrypt(plain)


def decrypt(enc: str) -> str:
    """解密存储字符串，返回明文；失败返回空串。"""
    if not enc:
        return ""
    if enc.startswith("dpapi:"):
        out = _dpapi_decrypt(enc[6:])
        if not out:
            log.warning("DPAPI 解密失败（密钥/用户环境可能已变化）")
        return out
    if enc.startswith("fernet:"):
        out = _fernet_decrypt(enc[7:])
        if not out:
            log.warning("Fernet 解密失败（本机密钥文件可能缺失）")
        return out
    if enc.startswith("xor:"):
        return _xor_decrypt(enc)
    # 兼容早期明文存储：可用但告警，提示用户重新保存以升级为加密存储
    log.warning("检测到遗留明文 API Key，请重新保存该模型配置以升级为加密存储")
    return enc
