"""ترحيلات تطبيق tageephr."""

from . import store


def ensure_state_table():
	store.ensure_state_row()
