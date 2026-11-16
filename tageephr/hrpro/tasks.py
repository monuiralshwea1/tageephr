"""مهام مجدولة لنظام Tageep HRMS."""
from __future__ import annotations

import frappe

from . import engine, files, store


def daily_backup():
	"""نسخة أمان مشفرة يومية + ترحيل سجلات التدقيق القديمة."""
	try:
		state = store.load_state()
		result = files.create_backup(state, auto=True)
		frappe.logger("tageephr").info("نسخة احتياطية يومية: %s (%s بايت)" % (result["name"], result["size"]))
		engine.add_audit(state, {"userId": "system", "userName": "النظام", "action": "backup",
		                         "module": "settings", "collection": "settings", "recordId": "",
		                         "details": "نسخة احتياطية يومية تلقائية: %s" % result["name"], "ip": ""})
		store.commit(state)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "TageepHR daily backup")


def nightly_notifications():
	"""فحص الإشعارات الذكية لكل المستخدمين مرة يومياً."""
	try:
		state = store.load_state()
		for user in state.get("users") or []:
			if user.get("disabled"):
				continue
			engine.scan_notifications(state, user)
		store.commit(state)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "TageepHR nightly notifications")
