from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import uuid
from datetime import date, datetime, timedelta

import frappe


# ───────────────────────── أدوات التاريخ والأرقام ─────────────────────────
def pad2(n) -> str:
	return str(n).zfill(2)


def today_iso(d=None) -> str:
	d = d or datetime.now()
	return "%04d-%02d-%02d" % (d.year, d.month, d.day)


def date_only(value) -> str:
	if not value:
		return ""
	if isinstance(value, (datetime, date)):
		return today_iso(value)
	s = str(value)
	m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
	if m:
		return m.group(0)
	return ""


def parse_time_to_minutes(value):
	if value is None or value == "":
		return None
	if isinstance(value, (int, float)):
		return float(value)
	s = str(value)
	if "T" in s:
		try:
			d = datetime.fromisoformat(s.replace("Z", "+00:00"))
			return d.hour * 60 + d.minute + d.second / 60.0
		except Exception:
			pass
	m = re.search(r"(\d{1,2}):(\d{2})", s)
	if not m:
		return None
	return int(m.group(1)) * 60 + int(m.group(2))


def add_days(date_str, n):
	base = datetime.strptime(date_only(date_str), "%Y-%m-%d")
	return today_iso(base + timedelta(days=int(n)))


def days_between(frm, to):
	a = datetime.strptime(date_only(frm), "%Y-%m-%d")
	b = datetime.strptime(date_only(to), "%Y-%m-%d")
	return int(round((b - a).total_seconds() / 86400)) + 1


def month_range(year, month):
	y, m = int(year), int(month)
	from_date = "%04d-%02d-01" % (y, m)
	next_month = date(y + (m // 12), (m % 12) + 1, 1)
	to_date = today_iso(next_month - timedelta(days=1))
	return {"from": from_date, "to": to_date}


def each_date(frm, to):
	out = []
	cur, end = date_only(frm), date_only(to)
	if not cur or not end or cur > end:
		return out
	guard = 0
	while cur <= end and guard < 4000:
		out.append(cur)
		cur = add_days(cur, 1)
		guard += 1
	return out


def round2(n) -> float:
	return round((float(n or 0)) + 1e-9, 2)


def num(value, fallback=0):
	if value is None or value == "":
		return fallback
	try:
		return float(value)
	except (TypeError, ValueError):
		return fallback


def uid(prefix=""):
	return "%s%s" % (prefix, uuid.uuid4())


def day_of_week(date_str):
	return datetime.strptime(date_only(date_str), "%Y-%m-%d").weekday()  # Mon=0


def js_day_of_week(date_str):
	"""" مثل JS: الأحد = 0 """
	return (day_of_week(date_str) + 1) % 7


def is_workday(date_str, settings):
	weekly_off = (settings or {}).get("weeklyOffDays")
	if not isinstance(weekly_off, list):
		weekly_off = ["5"]
	return str(js_day_of_week(date_str)) not in [str(x) for x in weekly_off]


def working_dates(frm, to, holidays=None, settings=None):
	holiday_set = {date_only(h.get("date") if isinstance(h, dict) else h) for h in (holidays or [])}
	return [d for d in each_date(frm, to) if is_workday(d, settings) and d not in holiday_set]


# ───────────────────────── التشفير والتوقيع ─────────────────────────
def _b64u(raw: bytes) -> str:
	return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64u(text: str) -> bytes:
	pad = "=" * (-len(text) % 4)
	return base64.urlsafe_b64decode(text + pad)


def hash_password(password: str) -> str:
	salt = os.urandom(16)
	digest = hashlib.scrypt(str(password).encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
	return "scrypt$%s$%s" % (base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def verify_password(password, stored) -> bool:
	if not stored:
		return False
	stored = str(stored)
	if not stored.startswith("scrypt$"):
		return str(password) == stored
	try:
		_, salt_b64, hash_b64 = stored.split("$")
		salt = base64.b64decode(salt_b64)
		expected = base64.b64decode(hash_b64)
		actual = hashlib.scrypt(str(password).encode(), salt=salt, n=16384, r=8, p=1, dklen=len(expected))
		return hmac.compare_digest(expected, actual)
	except Exception:
		return False


def is_legacy_plain(stored) -> bool:
	return bool(stored) and not str(stored).startswith("scrypt$")


def sign_token(secret: str, payload: dict, ttl_seconds=12 * 3600) -> str:
	import time

	header = {"alg": "HS256", "typ": "JWT"}
	now = int(time.time())
	body = dict(payload)
	body.update({"iat": now, "exp": now + int(ttl_seconds), "jti": uuid.uuid4().hex[:24]})
	p1 = _b64u(json.dumps(header, separators=(",", ":")).encode())
	p2 = _b64u(json.dumps(body, separators=(",", ":")).encode())
	sig = _b64u(hmac.new(secret.encode(), ("%s.%s" % (p1, p2)).encode(), hashlib.sha256).digest())
	return "%s.%s.%s" % (p1, p2, sig)


def verify_token(secret: str, token: str):
	if not token or token.count(".") != 2:
		return None
	try:
		p1, p2, sig = token.split(".")
		expected = _b64u(hmac.new(secret.encode(), ("%s.%s" % (p1, p2)).encode(), hashlib.sha256).digest())
		if not hmac.compare_digest(sig, expected):
			return None
		body = json.loads(_unb64u(p2))
	except Exception:
		return None
	import time

	if not body.get("exp") or int(body["exp"]) < int(time.time()):
		return None
	return body
