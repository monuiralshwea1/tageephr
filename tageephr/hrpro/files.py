"""استيراد/تصدير Excel والنسخ الاحتياطية لنظام Tageep HRMS.

النسخ الاحتياطية تُخزَّن داخل مجلد الموقع الخاص (private/files) بنفس صيغة
ملفات hrpro الأصلية (‎.hrbak مشفّرة بـ AES-256-GCM + PBKDF2-SHA256) حتى تبقى
النسخ القديمة قابلة للاستعادة.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import time

import frappe

from .defaults import COLLECTIONS

BACKUP_SUBDIR = ("private", "files", "tageephr", "backups")


# ───────────────────────── Excel ─────────────────────────
def read_table(content: bytes, filename: str = "") -> list[dict]:
	"""قراءة أول ورقة من ملف xlsx أو csv إلى قائمة صفوف (dict)."""
	name = (filename or "").lower()
	if name.endswith(".csv") or (not name.endswith((".xlsx", ".xlsm")) and content[:2] not in (b"PK",)):
		text = content.decode("utf-8-sig", "replace")
		import csv

		return [dict(row) for row in csv.DictReader(io.StringIO(text))]

	from openpyxl import load_workbook

	workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
	sheet = workbook[workbook.sheetnames[0]]
	rows = sheet.iter_rows(values_only=True)
	try:
		headers = [str(cell).strip() if cell is not None else "" for cell in next(rows)]
	except StopIteration:
		return []
	out = []
	for values in rows:
		if values is None:
			continue
		row = {}
		for index, header in enumerate(headers):
			if not header:
				continue
			value = values[index] if index < len(values) else None
			row[header] = value
		if any(v not in (None, "") for v in row.values()):
			out.append(row)
	return out


def build_xlsx(columns, rows, sheet_title: str = "تقرير") -> bytes:
	from openpyxl import Workbook
	from openpyxl.styles import Alignment, Font, PatternFill
	from openpyxl.utils import get_column_letter

	workbook = Workbook()
	sheet = workbook.active
	sheet.title = (sheet_title or "تقرير")[:31]
	sheet.sheet_view.rightToLeft = True

	header_font = Font(bold=True, color="FFFFFF")
	header_fill = PatternFill("solid", fgColor="0D9488")
	headers = [c["label"] for c in columns]
	sheet.append(headers)
	for index in range(1, len(headers) + 1):
		cell = sheet.cell(row=1, column=index)
		cell.font = header_font
		cell.fill = header_fill
		cell.alignment = Alignment(horizontal="center", vertical="center")
		sheet.column_dimensions[get_column_letter(index)].width = max(14, min(30, len(headers[index - 1]) + 6))

	for row in rows:
		values = []
		for column in columns:
			value = row.get(column["key"])
			if isinstance(value, (dict, list)):
				value = json.dumps(value, ensure_ascii=False)
			values.append(value if value is not None else "")
		sheet.append(values)
	sheet.freeze_panes = "A2"

	buffer = io.BytesIO()
	workbook.save(buffer)
	return buffer.getvalue()


def build_csv(columns, rows) -> bytes:
	lines = [",".join(['"%s"' % c["label"].replace('"', "'") for c in columns])]
	for row in rows:
		cells = []
		for column in columns:
			value = row.get(column["key"])
			if value is None:
				value = ""
			if isinstance(value, (dict, list)):
				value = json.dumps(value, ensure_ascii=False)
			cells.append('"%s"' % str(value).replace('"', "'"))
		lines.append(",".join(cells))
	return ("\ufeff" + "\r\n".join(lines)).encode("utf-8")


# ───────────────────────── النسخ الاحتياطية ─────────────────────────
def backup_dir() -> str:
	path = frappe.get_site_path(*BACKUP_SUBDIR)
	os.makedirs(path, exist_ok=True)
	return path


def _payload(state: dict) -> dict:
	return {
		"format": "tageep-backup",
		"version": 3,
		"createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
		"app": "Tageep HRMS",
		"dbType": "frappe",
		"collections": {key: state.get(key) for key in COLLECTIONS},
		"checksum": hashlib.sha256(json.dumps({key: state.get(key) for key in COLLECTIONS},
		                                      ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
	}


def _fallback_secret() -> str:
	from .store import get_secret

	return get_secret()


def create_backup(state: dict, passphrase: str | None = None, encrypt: bool = True, auto: bool = False):
	payload = _payload(state)
	plain = json.dumps(payload, ensure_ascii=False)
	stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
	if not encrypt:
		buffer = plain.encode("utf-8")
		ext = ".json"
	else:
		from cryptography.hazmat.primitives.ciphers.aead import AESGCM

		secret = str(passphrase or _fallback_secret())
		salt = os.urandom(16)
		iv = os.urandom(12)
		key = hashlib.pbkdf2_hmac("sha256", secret.encode(), salt, 210000, 32)
		ciphertext = AESGCM(key).encrypt(iv, plain.encode("utf-8"), None)
		envelope = {
			"format": "tageep-encrypted-backup",
			"version": 1,
			"encrypted": True,
			"algorithm": "aes-256-gcm",
			"kdf": "pbkdf2-sha256",
			"iterations": 210000,
			"salt": base64.b64encode(salt).decode(),
			"iv": base64.b64encode(iv).decode(),
			"tag": "",
			"checksum": payload["checksum"],
			"createdAt": payload["createdAt"],
			"data": base64.b64encode(ciphertext).decode(),
		}
		buffer = json.dumps(envelope).encode("utf-8")
		ext = ".hrbak"

	filename = "%s-%s%s" % ("auto" if auto else "backup", stamp, ext)
	path = os.path.join(backup_dir(), filename)
	with open(path, "wb") as handle:
		handle.write(buffer)
	prune_backups(keep=20 if auto else 50)
	return {"name": filename, "size": len(buffer), "createdAt": payload["createdAt"],
	        "encrypted": encrypt, "buffer": buffer}


def prune_backups(keep=20):
	try:
		files = [f for f in os.listdir(backup_dir()) if f.startswith("auto-")]
		files.sort(key=lambda f: os.path.getmtime(os.path.join(backup_dir(), f)), reverse=True)
		for name in files[keep:]:
			os.remove(os.path.join(backup_dir(), name))
	except Exception:
		frappe.log_error(frappe.get_traceback(), "TageepHR prune backups")


def list_backups() -> list[dict]:
	out = []
	for name in os.listdir(backup_dir()):
		if not name.endswith((".hrbak", ".json")):
			continue
		full = os.path.join(backup_dir(), name)
		stat = os.stat(full)
		out.append({"name": name, "size": stat.st_size,
		            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(stat.st_mtime)),
		            "encrypted": name.endswith(".hrbak")})
	out.sort(key=lambda item: item["createdAt"], reverse=True)
	return out


def read_backup_file(name: str) -> bytes:
	safe = "".join(ch for ch in str(name) if ch.isalnum() or ch in "._-")
	path = os.path.join(backup_dir(), safe)
	if not safe or not os.path.exists(path):
		raise FileNotFoundError("النسخة غير موجودة")
	with open(path, "rb") as handle:
		return handle.read()


# ───────────────────────── الأرشيف الإلكتروني ─────────────────────────
ARCHIVE_SUBDIR = ("private", "files", "tageephr", "archive")
ARCHIVE_MAX_BYTES = 25 * 1024 * 1024
ARCHIVE_EXTENSIONS = {
	"pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "svg",
	"doc", "docx", "xls", "xlsx", "csv", "txt", "rtf", "ppt", "pptx", "odt", "ods",
	"zip", "rar", "7z", "eml", "msg",
}


def archive_dir() -> str:
	path = frappe.get_site_path(*ARCHIVE_SUBDIR)
	os.makedirs(path, exist_ok=True)
	return path


def archive_extension(filename: str) -> str:
	name = os.path.basename(str(filename or "")).strip()
	ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
	return "".join(ch for ch in ext if ch.isalnum())[:8]


def save_archive_file(content: bytes, filename: str, item_id: str = "") -> dict:
	"""حفظ ملف الأرشيف داخل private/files/tageephr/archive وإرجاع بياناته الوصفية."""
	if not content:
		raise ValueError("الملف فارغ")
	if len(content) > ARCHIVE_MAX_BYTES:
		raise ValueError("حجم الملف يتجاوز الحد الأقصى %s ميجابايت" % (ARCHIVE_MAX_BYTES // (1024 * 1024)))
	ext = archive_extension(filename)
	if ext and ext not in ARCHIVE_EXTENSIONS:
		raise ValueError("نوع الملف غير مسموح: %s" % ext)
	from .utils import uid

	stored = "%s.%s" % (item_id or uid("ar_"), ext) if ext else (item_id or uid("ar_"))
	stored = "".join(ch for ch in stored if ch.isalnum() or ch in "._-")
	with open(os.path.join(archive_dir(), stored), "wb") as handle:
		handle.write(content)
	return {"storedName": stored, "fileName": os.path.basename(str(filename or stored))[:180],
	        "ext": ext, "size": len(content)}


def archive_file_path(stored_name: str) -> str:
	safe = os.path.basename(str(stored_name or ""))
	if not safe:
		return ""
	path = os.path.join(archive_dir(), safe)
	return path if os.path.exists(path) else ""


def delete_archive_file(stored_name: str) -> bool:
	try:
		path = archive_file_path(stored_name)
		if path:
			os.remove(path)
			return True
	except Exception:
		frappe.log_error(frappe.get_traceback(), "TageepHR delete archive file")
	return False


def archive_usage() -> int:
	total = 0
	for name in os.listdir(archive_dir()):
		try:
			total += os.path.getsize(os.path.join(archive_dir(), name))
		except OSError:
			continue
	return total


def restore_from_buffer(buffer: bytes, passphrase: str | None = None) -> dict:
	text = buffer.decode("utf-8-sig", "replace")
	try:
		payload = json.loads(text)
	except Exception:
		raise ValueError("ملف النسخة الاحتياطية غير صالح")
	if payload.get("format") == "tageep-encrypted-backup" and payload.get("encrypted"):
		if not passphrase:
			raise ValueError("هذه النسخة مشفرة، أدخل كلمة مرور النسخة")
		from cryptography.hazmat.primitives.ciphers.aead import AESGCM

		iterations = int(payload.get("iterations") or 210000)
		salt = base64.b64decode(payload["salt"])
		iv = base64.b64decode(payload["iv"])
		key = hashlib.pbkdf2_hmac("sha256", str(passphrase).encode(), salt, iterations, 32)
		try:
			plain = AESGCM(key).decrypt(iv, base64.b64decode(payload["data"]), None)
		except Exception:
			raise ValueError("كلمة مرور النسخة غير صحيحة أو الملف تالف")
		payload = json.loads(plain.decode("utf-8"))
	state = payload.get("collections") or payload.get("state") or payload
	if not isinstance(state, dict) or "settings" not in state:
		raise ValueError("النسخة لا تحتوي بيانات نظام صالحة")
	return state
