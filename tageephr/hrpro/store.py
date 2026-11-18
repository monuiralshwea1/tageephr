"""تخزين حالة نظام Tageep HRMS داخل قاعدة بيانات الفرابي.

كل مجموعة بيانات (collection) تُخزَّن كوثيقة JSON في جدول واحد — نفس تصميم
hrpro (documents(id, data)) لكن على MariaDB الخاصة بالموقع.

ضغط وتقسيم السجلات:
	data الخام لبعض المجموعات (سجلات الحضور والبصمات) يتجاوز `max_allowed_packet`
	في MariaDB فيفشل الإدراج بخطأ (1153). لذلك يُضغط كل سجل (zlib) ويُرمَّز
	(base64) ثم يُقسَّم إلى صفوف بحجم أقصى 3MB للصف:
		employees            ← الصف الأول (الجزء 0)
		employees#1          ← الجزء 1 ...
	ويعاد تجميع الأجزاء عند القراءة. الصيغة متوافقة مع البيانات القديمة
	غير المضغوطة (تُقرأ كما هي).
"""
from __future__ import annotations

import base64
import json
import zlib

import frappe

from .defaults import COLLECTIONS, DEFAULT_LEAVE_POLICY, DEFAULT_LEAVE_TYPES, DEFAULT_DOCUMENT_TYPES, DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS, defaults_clone

TABLE = "tabTageephr State"
_SECRET_KEY = "__secret"
_CACHE_KEY = "tageephr_state"

# حجم الجزء الواحد (بالحروف) — أصغر بكثير من max_allowed_packet الافتراضي (16MB)
_CHUNK_SIZE = 3 * 1024 * 1024
# بادئة تعني أن المحتوى مضغوط بـ zlib ومُرمَّز بـ base64
_PREFIX = "z1:"
_CHUNK_SEP = "#"


def ensure_table():
	if frappe.db.table_exists("Tageephr State", cached=False):
		return
	frappe.db.sql(
		"""CREATE TABLE IF NOT EXISTS `tabTageephr State` (
			`name` VARCHAR(100) NOT NULL PRIMARY KEY,
			`data` LONGTEXT NOT NULL,
			`modified` DATETIME(6) NOT NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"""
	)
	frappe.db.commit()


def ensure_state_row():
	ensure_table()
	if not frappe.db.sql("SELECT 1 FROM `tabTageephr State` WHERE name=%s", (COLLECTIONS[0],)):
		save(defaults_clone())


# ───────────────────────── الترميز والتقسيم ─────────────────────────
def _encode(value) -> str:
	"""JSON → UTF-8 → zlib → base64 (نص ASCII آمن للتخزين)."""
	raw = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
	return _PREFIX + base64.b64encode(zlib.compress(raw, 6)).decode("ascii")


def _decode(payload: str):
	text = payload or "null"
	if text.startswith(_PREFIX):
		text = zlib.decompress(base64.b64decode(text[len(_PREFIX):].encode("ascii"))).decode("utf-8")
	return json.loads(text)


def _split(payload: str) -> list:
	if not payload:
		return [""]
	return [payload[i:i + _CHUNK_SIZE] for i in range(0, len(payload), _CHUNK_SIZE)]


def _row_name(key: str, index: int) -> str:
	return key if index == 0 else "%s%s%d" % (key, _CHUNK_SEP, index)


def _read_docs() -> dict:
	ensure_table()
	chunks = {}
	for row in frappe.db.sql("SELECT name, data FROM `tabTageephr State`", as_dict=True):
		name = row.name or ""
		if name == _SECRET_KEY:
			continue
		base, sep, tail = name.partition(_CHUNK_SEP)
		if sep and tail.isdigit():
			chunks.setdefault(base, {})[int(tail)] = row.data or ""
		else:
			chunks.setdefault(base, {})[0] = row.data or ""

	docs = {}
	for base, parts in chunks.items():
		payload = "".join(parts[index] for index in sorted(parts))
		try:
			docs[base] = _decode(payload)
		except Exception:
			frappe.log_error("tageephr: تعذر قراءة المجموعة %s" % base, "Tageephr")
	return docs


def load_state() -> dict:
	cached = getattr(frappe.local, _CACHE_KEY, None)
	if cached is not None:
		return cached

	docs = _read_docs()
	state = defaults_clone()
	for key in COLLECTIONS:
		if docs.get(key) is not None:
			state[key] = docs[key]

	# دمج الإعدادات الجديدة مع المحفوظة
	state["settings"] = {**DEFAULT_SETTINGS, **(state.get("settings") or {})}
	state["settings"]["notifications"] = {**DEFAULT_SETTINGS["notifications"], **((state["settings"].get("notifications") or {}))}
	# ترحيل ألوان القائمة الجانبية القديمة إلى اللون الافتراضي الجديد
	_legacy_sidebars = {"#0b1526", "#3f51b5", "#283593"}
	if str(state["settings"].get("sidebarColor") or "").strip().lower() in _legacy_sidebars:
		state["settings"]["sidebarColor"] = DEFAULT_SETTINGS["sidebarColor"]
	state["payrollSettings"] = {**DEFAULT_PAYROLL_SETTINGS, **(state.get("payrollSettings") or {})}
	state["leavePolicy"] = {**DEFAULT_LEAVE_POLICY, **(state.get("leavePolicy") or {})}
	state["leavePolicy"]["lateConversion"] = {**DEFAULT_LEAVE_POLICY["lateConversion"], **((state["leavePolicy"].get("lateConversion") or {}))}
	if not state.get("leaveTypes"):
		state["leaveTypes"] = json.loads(json.dumps(DEFAULT_LEAVE_TYPES))
	if not state.get("documentTypes"):
		state["documentTypes"] = json.loads(json.dumps(DEFAULT_DOCUMENT_TYPES))
	if not state["settings"].get("attendanceStartDate"):
		from .utils import today_iso

		state["settings"]["attendanceStartDate"] = today_iso()

	setattr(frappe.local, _CACHE_KEY, state)
	return state


def save(state: dict):
	ensure_table()
	now = frappe.utils.now()
	for key in COLLECTIONS:
		payload = _encode(state.get(key))
		rows = _split(payload)
		# إزالة الأجزاء القديمة (بما فيها الجزء الأول) قبل كتابة الأجزاء الجديدة
		frappe.db.sql(
			"DELETE FROM `tabTageephr State` WHERE name = %s OR name LIKE %s",
			(key, key + _CHUNK_SEP + "%"),
		)
		for index, chunk in enumerate(rows):
			frappe.db.sql(
				"""INSERT INTO `tabTageephr State` (name, data, modified) VALUES (%s, %s, %s)
				   ON DUPLICATE KEY UPDATE data=VALUES(data), modified=VALUES(modified)""",
				(_row_name(key, index), chunk, now),
			)
	frappe.db.commit()
	setattr(frappe.local, _CACHE_KEY, state)


def commit(state: dict | None = None):
	save(state or load_state())


def get_secret() -> str:
	ensure_table()
	row = frappe.db.sql("SELECT data FROM `tabTageephr State` WHERE name=%s", (_SECRET_KEY,))
	if row:
		try:
			return json.loads(row[0][0])["value"]
		except Exception:
			pass
	import secrets

	value = secrets.token_hex(48)
	frappe.db.sql(
		"""INSERT INTO `tabTageephr State` (name, data, modified) VALUES (%s, %s, %s)
		   ON DUPLICATE KEY UPDATE data=VALUES(data)""",
		(_SECRET_KEY, json.dumps({"value": value}), frappe.utils.now()),
	)
	frappe.db.commit()
	return value


def reset_state():
	ensure_table()
	frappe.db.sql("DELETE FROM `tabTageephr State` WHERE name != %s", (_SECRET_KEY,))
	frappe.db.commit()
	setattr(frappe.local, _CACHE_KEY, None)
	return load_state()
