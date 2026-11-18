"""سياق صفحة Tageep HRMS (www/hrpro.html).

الغرض:
	- تزويد الصفحة برمز CSRF صالح دائمًا؛ فبدونه ترفض الفرابي كل طلب POST
	  بـ «400 Invalid Request»، ومنها طلب تسجيل الدخول في النظام.
	- منع تخزين الصفحة مؤقتًا حتى لا يُخدَم رمز CSRF قديم من جلسة أخرى
	  (وهو سبب متكرر لخطأ 400 عند تسجيل الدخول).
"""
from __future__ import annotations

import frappe


def get_context(context):
	context.no_cache = 1
	no_cache = 1  # noqa: F841 — يقرأها نظام مواقع الفرابي
	try:
		context.csrf_token = frappe.sessions.get_csrf_token()
	except Exception:
		frappe.log_error(frappe.get_traceback(), "TageepHR: csrf_token")
		context.csrf_token = ""
	return context
