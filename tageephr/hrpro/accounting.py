"""وحدة إدارة الحسابات لنظام Tageep HRMS.

شجرة حسابات مرقّمة تلقائيًا/يدويًا + سندات قبض وصرف وقيود يومية وقيود
افتتاحية + كشف حساب + ميزان مراجعة ودفتر أستاذ وميزانية عمومية وقائمة
دخل وأرصدة العملاء (مدينة) والموردين (دائنة) وأعمار الديون وسجل القيود.

البيانات تُخزَّن داخل مجموعتَي ``accounts`` و``vouchers`` في نفس حالة النظام
المحفوظة في قاعدة بيانات الفرابي، ولا تحتاج أي إعداد إضافي.
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from .utils import date_only, num, round2, today_iso

ACCOUNT_TYPES = {
	"asset": "أصول",
	"liability": "التزامات",
	"equity": "حقوق ملكية",
	"revenue": "إيرادات",
	"expense": "مصروفات",
}

# النوع الطبيعي للرصيد: الأصول والمصروفات مدينة، والباقي دائنة
DEBIT_TYPES = ("asset", "expense")

VOUCHER_TYPES = {
	"receipt": {"label": "سند قبض", "prefix": "RV"},
	"payment": {"label": "سند صرف", "prefix": "PV"},
	"journal": {"label": "قيد يومية", "prefix": "JV"},
	"opening": {"label": "قيد افتتاحي", "prefix": "OB"},
}

PARTY_TYPES = {"": "بدون", "customer": "عميل", "supplier": "مورد", "employee": "موظف", "other": "أخرى"}


DEFAULT_ACCOUNTS = [
	{"id": "acc_1", "code": "1", "name": "الأصول", "type": "asset", "parentId": "", "isGroup": True, "nature": "debit", "description": "جميع ممتلكات المنشأة"},
	{"id": "acc_11", "code": "11", "name": "الأصول المتداولة", "type": "asset", "parentId": "acc_1", "isGroup": True, "nature": "debit"},
	{"id": "acc_1101", "code": "1101", "name": "النقدية بالصندوق", "type": "asset", "parentId": "acc_11", "isGroup": False, "nature": "debit"},
	{"id": "acc_1102", "code": "1102", "name": "النقدية بالبنك", "type": "asset", "parentId": "acc_11", "isGroup": False, "nature": "debit"},
	{"id": "acc_1103", "code": "1103", "name": "العملاء (مدينون)", "type": "asset", "parentId": "acc_11", "isGroup": False, "nature": "debit", "partyType": "customer"},
	{"id": "acc_1104", "code": "1104", "name": "المخزون", "type": "asset", "parentId": "acc_11", "isGroup": False, "nature": "debit"},
	{"id": "acc_1105", "code": "1105", "name": "سلف وأمانات موظفين", "type": "asset", "parentId": "acc_11", "isGroup": False, "nature": "debit"},
	{"id": "acc_12", "code": "12", "name": "الأصول الثابتة", "type": "asset", "parentId": "acc_1", "isGroup": True, "nature": "debit"},
	{"id": "acc_1201", "code": "1201", "name": "الأثاث والمعدات", "type": "asset", "parentId": "acc_12", "isGroup": False, "nature": "debit"},
	{"id": "acc_1202", "code": "1202", "name": "أجهزة الحاسوب", "type": "asset", "parentId": "acc_12", "isGroup": False, "nature": "debit"},
	{"id": "acc_1209", "code": "1209", "name": "مجمع الإهلاك", "type": "asset", "parentId": "acc_12", "isGroup": False, "nature": "credit"},
	{"id": "acc_2", "code": "2", "name": "الالتزامات", "type": "liability", "parentId": "", "isGroup": True, "nature": "credit", "description": "ما على المنشأة من مستحقات للغير"},
	{"id": "acc_21", "code": "21", "name": "الالتزامات المتداولة", "type": "liability", "parentId": "acc_2", "isGroup": True, "nature": "credit"},
	{"id": "acc_2101", "code": "2101", "name": "الموردون (دائنون)", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit", "partyType": "supplier"},
	{"id": "acc_2102", "code": "2102", "name": "رواتب مستحقة", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit"},
	{"id": "acc_2103", "code": "2103", "name": "ضرائب مستحقة", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit"},
	{"id": "acc_2104", "code": "2104", "name": "تأمينات اجتماعية مستحقة", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit"},
	{"id": "acc_2105", "code": "2105", "name": "أمانات وعهد", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit"},
	{"id": "acc_3", "code": "3", "name": "حقوق الملكية", "type": "equity", "parentId": "", "isGroup": True, "nature": "credit"},
	{"id": "acc_3101", "code": "3101", "name": "رأس المال", "type": "equity", "parentId": "acc_3", "isGroup": False, "nature": "credit"},
	{"id": "acc_3102", "code": "3102", "name": "الأرباح المحتجزة", "type": "equity", "parentId": "acc_3", "isGroup": False, "nature": "credit"},
	{"id": "acc_3103", "code": "3103", "name": "جاري الشركاء", "type": "equity", "parentId": "acc_3", "isGroup": False, "nature": "credit"},
	{"id": "acc_4", "code": "4", "name": "الإيرادات", "type": "revenue", "parentId": "", "isGroup": True, "nature": "credit"},
	{"id": "acc_4101", "code": "4101", "name": "إيرادات المبيعات", "type": "revenue", "parentId": "acc_4", "isGroup": False, "nature": "credit"},
	{"id": "acc_4102", "code": "4102", "name": "إيرادات خدمات", "type": "revenue", "parentId": "acc_4", "isGroup": False, "nature": "credit"},
	{"id": "acc_4103", "code": "4103", "name": "إيرادات أخرى", "type": "revenue", "parentId": "acc_4", "isGroup": False, "nature": "credit"},
	{"id": "acc_5", "code": "5", "name": "المصروفات", "type": "expense", "parentId": "", "isGroup": True, "nature": "debit"},
	{"id": "acc_5101", "code": "5101", "name": "الرواتب والأجور", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5102", "code": "5102", "name": "الإيجارات", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5103", "code": "5103", "name": "مصروفات عمومية وإدارية", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5104", "code": "5104", "name": "مصروفات تشغيلية", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5105", "code": "5105", "name": "مصروفات تسويق وإعلان", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
]


def default_accounts() -> list[dict]:
	out = []
	for index, account in enumerate(DEFAULT_ACCOUNTS):
		row = dict(account)
		row.setdefault("description", "")
		row.setdefault("partyType", "")
		row.setdefault("active", True)
		row["level"] = len(str(row.get("code") or "")) // 2 or 1
		row["createdAt"] = "2026-01-01T00:00:00.000Z"
		row["builtin"] = True
		out.append(row)
	return out


# ───────────────────────── أدوات الشجرة ─────────────────────────
def accounts(state) -> list[dict]:
	rows = state.get("accounts")
	if not isinstance(rows, list) or not rows:
		return default_accounts()
	return rows


def by_id(state) -> dict:
	return {a.get("id"): a for a in accounts(state)}


def by_code(state) -> dict:
	return {str(a.get("code")): a for a in accounts(state)}


def children(state, parent_id) -> list[dict]:
	return sorted([a for a in accounts(state) if (a.get("parentId") or "") == (parent_id or "")],
	              key=lambda a: str(a.get("code")))


def descendants(state, account, include_self=True) -> list[dict]:
	out = [account] if include_self else []
	for child in children(state, account.get("id")):
		out.extend(descendants(state, child, True))
	return out


def account_level(state, account) -> int:
	level, current, guard = 1, account, 0
	while current.get("parentId") and guard < 20:
		parent = by_id(state).get(current["parentId"])
		if not parent:
			break
		level += 1
		current = parent
		guard += 1
	return level


def next_code(state, parent_id="") -> str:
	"""أول كود متاح تحت الأب (أو ضمن الجذور)."""
	used = {str(a.get("code")) for a in accounts(state)}
	if not parent_id:
		for n in range(1, 10):
			if str(n) not in used:
				return str(n)
		return str(len(used) + 1)
	parent = by_id(state).get(parent_id)
	if not parent:
		raise ValueError("الحساب الأب غير موجود")
	base = str(parent.get("code") or "")
	for n in range(1, 100):
		candidate = base + ("%02d" % n)
		if candidate not in used:
			return candidate
	raise ValueError("لا يمكن إضافة المزيد من الحسابات الفرعية لهذا الحساب")


# ───────────────────────── الأرصدة ─────────────────────────
def _posted_vouchers(state):
	return [v for v in (state.get("vouchers") or []) if (v.get("status") or "draft") == "posted"]


def totals_map(state, date_from="", date_to="") -> dict:
	out = {}
	for voucher in _posted_vouchers(state):
		day = date_only(voucher.get("date"))
		if date_from and day and day < date_from:
			continue
		if date_to and day and day > date_to:
			continue
		for line in voucher.get("lines") or []:
			account_id = line.get("accountId")
			if not account_id:
				continue
			row = out.setdefault(account_id, {"debit": 0.0, "credit": 0.0})
			row["debit"] += num(line.get("debit"))
			row["credit"] += num(line.get("credit"))
	return out


def aggregate(state, account, totals) -> dict:
	row = {"debit": 0.0, "credit": 0.0}
	# الحساب الرئيسي يجمع فروعه، والحساب الفرعي يُحسب بحركته فقط حتى لا
	# تتكرر المبالغ عند الجمع بين مستويات الشجرة.
	scope = descendants(state, account) if account.get("isGroup") else [account]
	for item in scope:
		part = totals.get(item.get("id")) or {}
		row["debit"] += num(part.get("debit"))
		row["credit"] += num(part.get("credit"))
	row["debit"] = round2(row["debit"])
	row["credit"] = round2(row["credit"])
	row["balance"] = round2(row["debit"] - row["credit"])
	return row


def _natural(account, balance):
	"""الرصيد بصيغته الطبيعية: موجب يعني رصيدًا طبيعيًا للحساب."""
	balance = round2(balance)
	return balance if account.get("type") in DEBIT_TYPES else round2(-balance)


def tree(state, date_from="", date_to="") -> list[dict]:
	totals = totals_map(state, date_from, date_to)
	out = []
	for account in sorted(accounts(state), key=lambda a: str(a.get("code"))):
		agg = aggregate(state, account, totals)
		out.append({
			"id": account.get("id"), "code": account.get("code"), "name": account.get("name"),
			"nameEn": account.get("nameEn") or "", "type": account.get("type"),
			"typeLabel": ACCOUNT_TYPES.get(account.get("type") or "", ""),
			"parentId": account.get("parentId") or "", "isGroup": bool(account.get("isGroup")),
			"nature": account.get("nature") or ("debit" if account.get("type") in DEBIT_TYPES else "credit"),
			"partyType": account.get("partyType") or "", "active": account.get("active", True),
			"description": account.get("description") or "", "level": account_level(state, account),
			"debit": agg["debit"], "credit": agg["credit"], "balance": agg["balance"],
			"naturalBalance": _natural(account, agg["balance"]),
		})
	return out


def summary(state) -> dict:
	accounts_index = accounts(state)
	totals = totals_map(state)
	buckets = {"asset": 0.0, "liability": 0.0, "equity": 0.0, "revenue": 0.0, "expense": 0.0}
	for account in accounts_index:
		if account.get("isGroup"):
			continue
		agg = aggregate(state, account, totals)
		buckets[account.get("type", "asset")] = buckets.get(account.get("type", "asset"), 0.0) + _natural(account, agg["balance"])
	profit = round2(buckets.get("revenue", 0.0) - buckets.get("expense", 0.0))
	vouchers = state.get("vouchers") or []
	cash = 0.0
	for account in accounts_index:
		if str(account.get("code")) in ("1101", "1102"):
			cash += aggregate(state, account, totals)["balance"]
	return {
		"assets": round2(buckets["asset"]), "liabilities": round2(buckets["liability"]),
		"equity": round2(buckets["equity"]), "revenue": round2(buckets["revenue"]),
		"expense": round2(buckets["expense"]), "profit": profit, "cash": round2(cash),
		"accounts": len(accounts_index), "groups": len([a for a in accounts_index if a.get("isGroup")]),
		"vouchers": len(vouchers),
		"posted": len([v for v in vouchers if v.get("status") == "posted"]),
		"draft": len([v for v in vouchers if (v.get("status") or "draft") == "draft"]),
		"opening": len([v for v in vouchers if v.get("isOpening") or v.get("type") == "opening"]),
	}


# ───────────────────────── السندات ─────────────────────────
def next_voucher_number(state, vtype: str, date: str = "") -> str:
	prefix = (VOUCHER_TYPES.get(vtype) or {}).get("prefix") or "VC"
	year = (date_only(date) or today_iso())[:4]
	pattern = re.compile(r"^%s-%s-(\d+)$" % (re.escape(prefix), year))
	highest = 0
	for voucher in state.get("vouchers") or []:
		match = pattern.match(str(voucher.get("number") or ""))
		if match:
			highest = max(highest, int(match.group(1)))
	return "%s-%s-%04d" % (prefix, year, highest + 1)


def _clean_lines(lines) -> list[dict]:
	out = []
	for line in lines or []:
		debit = round2(num(line.get("debit")))
		credit = round2(num(line.get("credit")))
		if not line.get("accountId") and not debit and not credit:
			continue
		out.append({
			"accountId": line.get("accountId") or "",
			"description": str(line.get("description") or "").strip(),
			"debit": debit, "credit": credit,
			"partyType": line.get("partyType") or "",
			"party": str(line.get("party") or "").strip(),
			"dueDate": date_only(line.get("dueDate")),
		})
	return out


def validate_voucher(state, payload, existing_id=None, require_balance=True) -> list[dict]:
	vtype = payload.get("type") or "journal"
	if vtype not in VOUCHER_TYPES:
		raise ValueError("نوع السند غير صالح")
	if not date_only(payload.get("date")):
		raise ValueError("تاريخ السند مطلوب")
	lines = _clean_lines(payload.get("lines"))
	if len(lines) < 1:
		raise ValueError("أضف سطرًا واحدًا على الأقل")
	index = by_id(state)
	for line in lines:
		account = index.get(line["accountId"])
		if not account:
			raise ValueError("أحد السطور بدون حساب صحيح")
		if account.get("isGroup"):
			raise ValueError("لا يمكن التسجيل على حساب رئيسي/تجميعي: %s" % account.get("name"))
		if line["debit"] < 0 or line["credit"] < 0:
			raise ValueError("لا يمكن أن يكون المبلغ سالبًا")
		if line["debit"] and line["credit"]:
			raise ValueError("لا يمكن إدخال مدين ودائن في نفس السطر")
	debit = round2(sum(l["debit"] for l in lines))
	credit = round2(sum(l["credit"] for l in lines))
	if require_balance and round(abs(debit - credit), 2) > 0.009:
		raise ValueError("السند غير متوازن: المدين %s والدائن %s" % (debit, credit))
	number = str(payload.get("number") or "").strip()
	if not number:
		number = next_voucher_number(state, vtype, payload.get("date"))
	dup = next((v for v in state.get("vouchers") or []
	            if str(v.get("number")) == number and v.get("id") != existing_id), None)
	if dup:
		raise ValueError("رقم السند مستخدم بالفعل: %s" % number)
	payload["number"] = number
	payload["lines"] = lines
	payload["debit"] = debit
	payload["credit"] = credit
	return lines


def post_voucher(state, voucher) -> dict:
	validate_voucher(state, voucher, voucher.get("id"), require_balance=True)
	voucher["status"] = "posted"
	voucher["postedAt"] = datetime.now().isoformat(timespec="seconds")
	return voucher


# ───────────────────────── كشف الحساب ─────────────────────────
def statement(state, account_id, date_from="", date_to="") -> dict:
	account = by_id(state).get(account_id)
	if not account:
		raise ValueError("الحساب غير موجود")
	scope = {a.get("id") for a in descendants(state, account)}
	rows = []
	opening = 0.0
	for voucher in sorted(_posted_vouchers(state), key=lambda v: (date_only(v.get("date")), str(v.get("number")))):
		day = date_only(voucher.get("date"))
		for line in voucher.get("lines") or []:
			if line.get("accountId") not in scope:
				continue
			debit, credit = round2(num(line.get("debit"))), round2(num(line.get("credit")))
			delta = round2(debit - credit)
			if date_from and day and day < date_from:
				opening += delta
				continue
			if date_to and day and day > date_to:
				continue
			rows.append({
				"id": voucher.get("id"), "number": voucher.get("number"), "date": day,
				"type": voucher.get("type"), "typeLabel": (VOUCHER_TYPES.get(voucher.get("type")) or {}).get("label") or "",
				"description": line.get("description") or voucher.get("description") or "",
				"party": line.get("party") or voucher.get("party") or "",
				"account": (by_id(state).get(line.get("accountId")) or {}).get("name") or "",
				"debit": debit, "credit": credit, "amount": delta,
			})
	running = round2(opening)
	for row in rows:
		running = round2(running + row["amount"])
		row["balance"] = running
	return {
		"account": {"id": account.get("id"), "code": account.get("code"), "name": account.get("name"),
		            "type": account.get("type"), "isGroup": bool(account.get("isGroup"))},
		"from": date_only(date_from), "to": date_only(date_to),
		"opening": round2(opening), "closing": round2(running),
		"totalDebit": round2(sum(r["debit"] for r in rows)),
		"totalCredit": round2(sum(r["credit"] for r in rows)),
		"rows": rows,
	}


# ───────────────────────── التقارير ─────────────────────────
REPORTS = [
	{"id": "trial_balance", "name": "ميزان المراجعة", "description": "أرصدة كل الحسابات مدينًا ودائنًا خلال الفترة"},
	{"id": "general_ledger", "name": "دفتر الأستاذ العام", "description": "حركة الحسابات تفصيلًا مع الرصيد المتحرك"},
	{"id": "balance_sheet", "name": "الميزانية العمومية", "description": "الأصول والالتزامات وحقوق الملكية في تاريخ محدد"},
	{"id": "income_statement", "name": "قائمة الدخل", "description": "الإيرادات والمصروفات وصافي الربح خلال الفترة"},
	{"id": "receivables", "name": "الحسابات المدينة (العملاء)", "description": "أرصدة العملاء المستحقة على الغير"},
	{"id": "payables", "name": "الحسابات الدائنة (الموردون)", "description": "أرصدة الموردين المستحقة للمنشأة"},
	{"id": "aging", "name": "أعمار الديون", "description": "تقسيم أرصدة العملاء حسب مدة التأخير"},
	{"id": "journal_register", "name": "سجل السندات والقيود", "description": "كل السندات والقيود في الفترة مع حالتها"},
]


def _col(key, label, type_="text"):
	return {"key": key, "label": label, "type": type_}


def _report(report_id, title, from_, to_, columns, rows, totals=None):
	return {"id": report_id, "title": title, "from": date_only(from_), "to": date_only(to_),
	        "columns": columns, "rows": rows, "totals": totals or {}, "count": len(rows)}


def _account_rows(state, date_from="", date_to=""):
	return tree(state, date_from, date_to)


def run_report(state, report_id, filters=None) -> dict:
	filters = filters or {}
	date_from = date_only(filters.get("from"))
	date_to = date_only(filters.get("to"))
	if report_id == "trial_balance":
		rows = []
		totals = {"opening": 0.0, "debit": 0.0, "credit": 0.0, "balance": 0.0}
		opening_sums = totals_map(state, "", date_from) if date_from else {}
		period_sums = totals_map(state, date_from, date_to)
		for account in _account_rows(state, "", date_to):
			opening = aggregate(state, account, opening_sums)["balance"] if date_from else 0.0
			agg = aggregate(state, account, period_sums)
			balance = round2(agg["balance"])
			rows.append({
				"code": account["code"], "name": ("    " * (account["level"] - 1)) + account["name"],
				"type": account["typeLabel"], "level": account["level"],
				"opening": _natural({"type": account["type"]}, opening),  # noqa: E501
				"debit": agg["debit"], "credit": agg["credit"],
				"balance": _natural({"type": account["type"]}, balance),
			})
			if not account["isGroup"]:
				totals["debit"] = round2(totals["debit"] + agg["debit"])
				totals["credit"] = round2(totals["credit"] + agg["credit"])
		return _report(report_id, "ميزان المراجعة", date_from, date_to,
		               [_col("code", "الكود"), _col("name", "الحساب"), _col("type", "النوع"),
		                _col("opening", "رصيد افتتاحي", "money"), _col("debit", "مدين", "money"),
		                _col("credit", "دائن", "money"), _col("balance", "الرصيد", "money")],
		               rows, totals)

	if report_id == "general_ledger":
		account_id = filters.get("accountId") or ""
		rows = []
		totals = {"debit": 0.0, "credit": 0.0, "balance": 0.0}
		targets = [by_id(state)[account_id]] if account_id and account_id in by_id(state) else \
			[a for a in accounts(state) if not a.get("isGroup")]
		for account in targets:
			data = statement(state, account.get("id"), date_from, date_to)
			if data["opening"]:
				rows.append({"account": "%s — %s" % (account.get("code"), account.get("name")),
				             "date": date_from or "—", "number": "رصيد افتتاحي", "description": "",
				             "debit": 0, "credit": 0, "balance": data["opening"]})
			for item in data["rows"]:
				rows.append({"account": "%s — %s" % (account.get("code"), account.get("name")),
				             "date": item["date"], "number": item["number"],
				             "description": item["description"], "debit": item["debit"],
				             "credit": item["credit"], "balance": item["balance"]})
			totals["debit"] = round2(totals["debit"] + data["totalDebit"])
			totals["credit"] = round2(totals["credit"] + data["totalCredit"])
		return _report(report_id, "دفتر الأستاذ العام", date_from, date_to,
		               [_col("account", "الحساب"), _col("date", "التاريخ", "date"), _col("number", "المستند"),
		                _col("description", "البيان"), _col("debit", "مدين", "money"),
		                _col("credit", "دائن", "money"), _col("balance", "الرصيد", "money")],
		               rows, totals)

	if report_id == "balance_sheet":
		rows, totals = [], {"asset": 0.0, "liability": 0.0, "equity": 0.0, "profit": 0.0}
		sums = totals_map(state, "", date_to)
		for account in sorted(accounts(state), key=lambda a: str(a.get("code"))):
			if account.get("type") not in ("asset", "liability", "equity"):
				continue
			agg = aggregate(state, account, sums)
			amount = _natural(account, agg["balance"])
			if not account.get("isGroup") and not amount:
				continue
			rows.append({"section": ACCOUNT_TYPES.get(account.get("type")), "code": account.get("code"),
			             "name": ("    " * (account_level(state, account) - 1)) + account.get("name"),
			             "amount": amount})
			if not account.get("isGroup"):
				totals[account.get("type")] = round2(totals.get(account.get("type"), 0.0) + amount)
		revenue = round2(sum(_natural(a, aggregate(state, a, sums)["balance"]) for a in accounts(state)
		                     if a.get("type") == "revenue" and not a.get("isGroup")))
		expense = round2(sum(_natural(a, aggregate(state, a, sums)["balance"]) for a in accounts(state)
		                     if a.get("type") == "expense" and not a.get("isGroup")))
		profit = round2(revenue - expense)
		totals["profit"] = profit
		rows.append({"section": "حقوق الملكية", "code": "", "name": "صافي ربح/خسارة الفترة", "amount": profit})
		rows.append({"section": "", "code": "", "name": "إجمالي الأصول", "amount": totals["asset"]})
		rows.append({"section": "", "code": "", "name": "إجمالي الالتزامات وحقوق الملكية",
		             "amount": round2(totals["liability"] + totals["equity"] + profit)})
		return _report(report_id, "الميزانية العمومية", "", date_to,
		               [_col("section", "القسم"), _col("code", "الكود"), _col("name", "الحساب"),
		                _col("amount", "المبلغ", "money")], rows, totals)

	if report_id == "income_statement":
		dates = month_range_safe(filters, date_from, date_to)
		date_from, date_to = dates
		rows, totals = [], {"revenue": 0.0, "expense": 0.0, "profit": 0.0}
		sums = totals_map(state, date_from, date_to)
		for account in sorted(accounts(state), key=lambda a: str(a.get("code"))):
			if account.get("type") not in ("revenue", "expense") or account.get("isGroup"):
				continue
			amount = _natural(account, aggregate(state, account, sums)["balance"])
			if not amount:
				continue
			rows.append({"section": ACCOUNT_TYPES.get(account.get("type")), "code": account.get("code"),
			             "name": account.get("name"), "amount": amount})
			totals[account.get("type")] = round2(totals.get(account.get("type"), 0.0) + amount)
		totals["profit"] = round2(totals.get("revenue", 0.0) - totals.get("expense", 0.0))
		rows.append({"section": "", "code": "", "name": "صافي الربح", "amount": totals["profit"]})
		return _report(report_id, "قائمة الدخل", date_from, date_to,
		               [_col("section", "القسم"), _col("code", "الكود"), _col("name", "البند"),
		                _col("amount", "المبلغ", "money")], rows, totals)

	if report_id in ("receivables", "payables"):
		party_type = "customer" if report_id == "receivables" else "supplier"
		sign = 1 if party_type == "customer" else -1
		parties = {}
		for voucher in _posted_vouchers(state):
			day = date_only(voucher.get("date"))
			if date_from and day < date_from:
				continue
			if date_to and day > date_to:
				continue
			for line in voucher.get("lines") or []:
				account = by_id(state).get(line.get("accountId")) or {}
				# نعتمد على الحساب الأصلي للطرف (حساب العملاء/الموردين) وليس على كل
				# سطور السند، حتى لا تُحسب سطور الإيراد/المصروف مرتين.
				account_party = account.get("partyType") or ""
				if account_party != party_type:
					if account_party or (line.get("partyType") or "") != party_type:
						continue
					if account.get("type") not in ("asset", "liability"):
						continue
				party = line.get("party") or voucher.get("party") or "غير محدد"
				row = parties.setdefault(party, {"party": party, "debit": 0.0, "credit": 0.0})
				row["debit"] = round2(row["debit"] + num(line.get("debit")))
				row["credit"] = round2(row["credit"] + num(line.get("credit")))
		rows = []
		for party in sorted(parties):
			row = parties[party]
			balance = round2((row["debit"] - row["credit"]) * sign)
			rows.append({"party": party, "debit": row["debit"], "credit": row["credit"], "balance": balance})
		total = round2(sum(r["balance"] for r in rows))
		title = "الحسابات المدينة (العملاء)" if report_id == "receivables" else "الحسابات الدائنة (الموردون)"
		return _report(report_id, title, date_from, date_to,
		               [_col("party", "الاسم"), _col("debit", "مدين", "money"),
		                _col("credit", "دائن", "money"), _col("balance", "الرصيد", "money")],
		               rows, {"balance": total})

	if report_id == "aging":
		as_of = date_to or today_iso()
		parties = {}
		for voucher in _posted_vouchers(state):
			day = date_only(voucher.get("date"))
			for line in voucher.get("lines") or []:
				account = by_id(state).get(line.get("accountId")) or {}
				if (account.get("partyType") or "") != "customer":
					if (line.get("partyType") or "") != "customer" or account.get("type") not in ("asset", "liability"):
						continue
				amount = round2(num(line.get("debit")) - num(line.get("credit")))
				if not amount:
					continue
				due = line.get("dueDate") or day
				days = _days_between(due, as_of)
				party = (by_id(state).get(line.get("accountId")) or {}).get("name")
				key = line.get("party") or voucher.get("party") or "غير محدد"
				row = parties.setdefault(key, {"party": key, "current": 0.0, "d1_30": 0.0, "d31_60": 0.0,
				                               "d61_90": 0.0, "over90": 0.0, "total": 0.0})
				if days <= 0:
					row["current"] = round2(row["current"] + amount)
				elif days <= 30:
					row["d1_30"] = round2(row["d1_30"] + amount)
				elif days <= 60:
					row["d31_60"] = round2(row["d31_60"] + amount)
				elif days <= 90:
					row["d61_90"] = round2(row["d61_90"] + amount)
				else:
					row["over90"] = round2(row["over90"] + amount)
				row["total"] = round2(row["total"] + amount)
		rows = [parties[key] for key in sorted(parties)]
		return _report(report_id, "أعمار الديون (العملاء)", date_from, as_of,
		               [_col("party", "العميل"), _col("current", "غير مستحق", "money"),
		                _col("d1_30", "1-30 يوم", "money"), _col("d31_60", "31-60 يوم", "money"),
		                _col("d61_90", "61-90 يوم", "money"), _col("over90", "أكثر من 90", "money"),
		                _col("total", "الإجمالي", "money")],
		               rows, {"total": round2(sum(r["total"] for r in rows))})

	if report_id == "journal_register":
		vtype = filters.get("voucherType") or ""
		rows = []
		for voucher in sorted(state.get("vouchers") or [], key=lambda v: (date_only(v.get("date")), str(v.get("number")))):
			day = date_only(voucher.get("date"))
			if date_from and day < date_from:
				continue
			if date_to and day > date_to:
				continue
			if vtype and voucher.get("type") != vtype:
				continue
			rows.append({
				"number": voucher.get("number"), "date": day,
				"type": (VOUCHER_TYPES.get(voucher.get("type")) or {}).get("label") or voucher.get("type"),
				"description": voucher.get("description") or "",
				"party": voucher.get("party") or "",
				"debit": round2(num(voucher.get("debit"))),
				"credit": round2(num(voucher.get("credit"))),
				"status": voucher.get("status") or "draft",
			})
		return _report(report_id, "سجل السندات والقيود", date_from, date_to,
		               [_col("number", "الرقم"), _col("date", "التاريخ", "date"), _col("type", "النوع"),
		                _col("description", "البيان"), _col("party", "الطرف"),
		                _col("debit", "مدين", "money"), _col("credit", "دائن", "money"),
		                _col("status", "الحالة")],
		               rows, {"debit": round2(sum(r["debit"] for r in rows)),
		                      "credit": round2(sum(r["credit"] for r in rows))})

	raise ValueError("التقرير غير موجود")


def _natural_balance(state, account, date_to, before="") -> float:
	"""رصيد الحساب قبل تاريخ معيّن (أو حتى تاريخ)."""
	totals = totals_map(state, "", before) if before else totals_map(state, "", date_to)
	return aggregate(state, account, totals)["balance"]


def month_range_safe(filters, date_from, date_to):
	if not date_from and not date_to:
		today = today_iso()
		return today[:8] + "01", today
	return date_from, date_to


def _days_between(start, end) -> int:
	try:
		a = datetime.strptime(date_only(start), "%Y-%m-%d")
		b = datetime.strptime(date_only(end), "%Y-%m-%d")
		return (b - a).days
	except Exception:
		return 0


def report_catalog() -> list[dict]:
	return [dict(item) for item in REPORTS]


def export_payload(report: dict) -> tuple[list[dict], list[dict]]:
	columns = [{"key": c["key"], "label": c["label"]} for c in report.get("columns") or []]
	return columns, report.get("rows") or []


def dump(value) -> str:
	return json.dumps(value, ensure_ascii=False)
