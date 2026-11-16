"""إعداد تطبيق tageephr بعد التثبيت."""
from __future__ import annotations

import frappe

from . import store


def after_install():
	store.ensure_state_row()
	frappe.db.commit()
