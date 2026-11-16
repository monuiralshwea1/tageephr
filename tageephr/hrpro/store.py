"""تخزين حالة نظام Tageep HRMS داخل قاعدة بيانات الفرابي.

كل مجموعة بيانات (collection) تُخزَّن كوثيقة JSON في جدول واحد — نفس تصميم
hrpro (documents(id, data)) لكن على MariaDB الخاصة بالموقع.
"""
from __future__ import annotations

import json

import frappe

from .defaults import COLLECTIONS, DEFAULT_LEAVE_POLICY, DEFAULT_LEAVE_TYPES, DEFAULT_DOCUMENT_TYPES, DEFAULT_PAYROLL_SETTINGS, DEFAULT_SETTINGS, defaults_clone

TABLE = "tabTageephr State"
_SECRET_KEY = "__secret"
_CACHE_KEY = "tageephr_state"


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


def _read_docs() -> dict:
	ensure_table()
	docs = {}
	for row in frappe.db.sql("SELECT name, data FROM `tabTageephr State`", as_dict=True):
		try:
			docs[row.name] = json.loads(row.data)
		except Exception:
			frappe.log_error("tageephr: تعذر قراءة المجموعة %s" % row.name, "Tageephr")
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
		payload = json.dumps(state.get(key), ensure_ascii=False)
		frappe.db.sql(
			"""INSERT INTO `tabTageephr State` (name, data, modified) VALUES (%s, %s, %s)
			   ON DUPLICATE KEY UPDATE data=VALUES(data), modified=VALUES(modified)""",
			(key, payload, now),
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
