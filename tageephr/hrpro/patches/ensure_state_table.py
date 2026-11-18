"""إنشاء جدول حالة tageephr وصفّ الحالة الافتراضي إن لم يوجد."""
from __future__ import annotations

import frappe

from .. import store


def execute():
	store.ensure_table()
	if not frappe.db.sql("SELECT 1 FROM `tabTageephr State` LIMIT 1"):
		store.save(store.load_state())
	frappe.db.commit()
