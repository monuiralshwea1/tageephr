"""وحدة إدارة الحسابات لنظام Tageep HRMS.

شجرة حسابات مرقّمة تلقائيًا/يدويًا + سندات قبض وصرف وقيود يومية وقيود
افتتاحية + كشف حساب + ميزان مراجعة ودفتر أستاذ وميزانية عمومية وقائمة
دخل وأرصدة العملاء (مدينة) والموردين (دائنة) وأعمار الديون وسجل القيود.

البيانات تُخزَّن داخل مجموعتَي ``accounts`` و``vouchers`` في نفس حالة النظام
المحفوظة في قاعدة بيانات الفرابي، ولا تحتاج أي إعداد إضافي.
"""
from __future__ import annotations

import calendar
import json
import re
from datetime import datetime
from uuid import uuid4

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
	"closing": {"label": "قيد إقفال سنوي", "prefix": "CL"},
}

PARTY_TYPES = {"": "بدون", "customer": "عميل", "supplier": "مورد", "employee": "موظف", "other": "أخرى"}

# عملات جاهزة تُقترح عند إضافة عملة جديدة (الرمز والاسم فقط، والسعر يُدخله المستخدم)
CURRENCY_PRESETS = {
	"YER": {"symbol": "ر.ي", "name": "ريال يمني"},
	"SAR": {"symbol": "ر.س", "name": "ريال سعودي"},
	"USD": {"symbol": "$", "name": "دولار أمريكي"},
	"EUR": {"symbol": "€", "name": "يورو"},
	"AED": {"symbol": "د.إ", "name": "درهم إماراتي"},
	"GBP": {"symbol": "£", "name": "جنيه إسترليني"},
	"KWD": {"symbol": "د.ك", "name": "دينار كويتي"},
	"QAR": {"symbol": "ر.ق", "name": "ريال قطري"},
	"OMR": {"symbol": "ر.ع", "name": "ريال عماني"},
	"BHD": {"symbol": "د.ب", "name": "دينار بحريني"},
	"JOD": {"symbol": "د.أ", "name": "دينار أردني"},
	"EGP": {"symbol": "ج.م", "name": "جنيه مصري"},
	"TRY": {"symbol": "₺", "name": "ليرة تركية"},
	"CNY": {"symbol": "¥", "name": "يوان صيني"},
	"INR": {"symbol": "₹", "name": "روبية هندية"},
	"DJF": {"symbol": "ف.ج", "name": "فرنك جيبوتي"},
}


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
	{"id": "acc_2107", "code": "2107", "name": "مكافآت نهاية الخدمة المستحقة", "type": "liability", "parentId": "acc_21", "isGroup": False, "nature": "credit"},
	{"id": "acc_5106", "code": "5106", "name": "البدلات والحوافز والإضافي", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5108", "code": "5108", "name": "خصومات الرواتب المستردة (غياب/جزاءات)", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "credit"},
	{"id": "acc_5109", "code": "5109", "name": "مصروف مكافأة نهاية الخدمة", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
	{"id": "acc_5110", "code": "5110", "name": "حصة المنشأة في التأمينات الاجتماعية", "type": "expense", "parentId": "acc_5", "isGroup": False, "nature": "debit"},
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


# ───────────────────────── العملات وأسعار الصرف ─────────────────────────
# قاعدة العملات: كل المبالغ في النظام (الأرصدة والسندات والتقارير) تُحفظ
# بالعملة الأساسية المختارة في الإعدادات. سعر الصرف لأي عملة = كم وحدة من
# العملة الأساسية تساوي وحدة واحدة من هذه العملة، لذا التحويل إلى العملة
# الأخرى للعرض يكون بقسمة المبلغ على السعر.

def base_code(state) -> str:
	return str(((state.get("settings") or {}).get("currencyCode")) or "YER").strip().upper()


def _preset(code) -> dict:
	return CURRENCY_PRESETS.get(code) or {"symbol": code, "name": code}


def ensure_currencies(state) -> list[dict]:
	rows = state.get("currencies")
	if not isinstance(rows, list):
		rows = []
	code = base_code(state)
	settings = state.get("settings") or {}
	base = next((r for r in rows if str(r.get("code") or "").upper() == code), None)
	if not base:
		preset = _preset(code)
		base = {"id": "cur_%s" % code.lower(), "code": code,
		        "symbol": str(settings.get("currency") or preset["symbol"]), "name": preset["name"],
		        "rate": 1.0, "active": True,
		        "createdAt": datetime.now().isoformat(timespec="seconds")}
		rows.insert(0, base)
	if not str(base.get("symbol") or ""):
		base["symbol"] = str(settings.get("currency") or _preset(code)["symbol"])
	if not str(base.get("name") or ""):
		base["name"] = _preset(code)["name"]
	base["rate"] = 1.0
	for row in rows:
		row["isBase"] = str(row.get("code") or "").upper() == code
		if not str(row.get("symbol") or ""):
			row["symbol"] = _preset(str(row.get("code") or "").upper())["symbol"]
	state["currencies"] = rows
	return rows


def currencies_index(state) -> dict:
	return {str(row.get("code") or "").upper(): row for row in ensure_currencies(state)}


def base_currency(state) -> dict:
	code = base_code(state)
	rows = ensure_currencies(state)
	return next((r for r in rows if str(r.get("code") or "").upper() == code), rows[0])


def rate_of(state, code="") -> float:
	code = str(code or "").strip().upper() or base_code(state)
	if code == base_code(state):
		return 1.0
	row = currencies_index(state).get(code)
	if not row:
		raise ValueError("العملة غير معروفة: %s" % code)
	rate = num(row.get("rate"))
	if rate <= 0:
		raise ValueError("سعر صرف العملة %s غير محدد" % code)
	return rate


def display_currency(state, code="") -> dict:
	code = str(code or "").strip().upper()
	if not code or code == base_code(state):
		return base_currency(state)
	row = currencies_index(state).get(code)
	if not row:
		raise ValueError("العملة غير معروفة: %s" % code)
	return row


def display_factor(state, code="") -> float:
	"""معامل تحويل مبلغ محفوظ بالعملة الأساسية إلى عملة العرض."""
	row = display_currency(state, code)
	return 1.0 / rate_of(state, row.get("code"))


def convert(state, amount, from_code="", to_code="") -> float:
	f = rate_of(state, from_code or base_code(state))
	t = rate_of(state, to_code or base_code(state))
	return round2(num(amount) * f / t)


def currency_meta(state, code="") -> dict:
	row = display_currency(state, code)
	return {"code": row.get("code"), "symbol": row.get("symbol") or "",
	        "name": row.get("name") or "", "rate": round(num(row.get("rate")), 6),
	        "isBase": str(row.get("code")).upper() == base_code(state)}


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


def tree(state, date_from="", date_to="", currency="") -> list[dict]:
	totals = totals_map(state, date_from, date_to)
	show = display_currency(state, currency)
	factor = 1.0 / rate_of(state, show.get("code"))
	index = currencies_index(state)
	out = []
	for account in sorted(accounts(state), key=lambda a: str(a.get("code"))):
		agg = aggregate(state, account, totals)
		account_code = str(account.get("currency") or "").upper()
		out.append({
			"id": account.get("id"), "code": account.get("code"), "name": account.get("name"),
			"nameEn": account.get("nameEn") or "", "type": account.get("type"),
			"typeLabel": ACCOUNT_TYPES.get(account.get("type") or "", ""),
			"parentId": account.get("parentId") or "", "isGroup": bool(account.get("isGroup")),
			"nature": account.get("nature") or ("debit" if account.get("type") in DEBIT_TYPES else "credit"),
			"partyType": account.get("partyType") or "", "active": account.get("active", True),
			"description": account.get("description") or "", "level": account_level(state, account),
			"currency": account_code,
			"currencySymbol": (index.get(account_code) or {}).get("symbol") or "",
			"displayCurrency": show.get("code"), "displaySymbol": show.get("symbol") or "",
			"debit": round2(agg["debit"] * factor), "credit": round2(agg["credit"] * factor),
			"balance": round2(agg["balance"] * factor),
			"naturalBalance": round2(_natural(account, agg["balance"]) * factor),
		})
	return out


def summary(state, currency="") -> dict:
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
	show = display_currency(state, currency)
	factor = 1.0 / rate_of(state, show.get("code"))
	conv = lambda value: round2(num(value) * factor)  # noqa: E731
	return {
		"assets": conv(buckets["asset"]), "liabilities": conv(buckets["liability"]),
		"equity": conv(buckets["equity"]), "revenue": conv(buckets["revenue"]),
		"expense": conv(buckets["expense"]), "profit": conv(profit), "cash": conv(cash),
		"currency": currency_meta(state, show.get("code")),
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
			"partyId": str(line.get("partyId") or "").strip(),
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
		# نوع الطرف يتبع الحساب: حسابات العملاء/الموردين/الموظفين تفرض نوعها تلقائيًا
		account_party = account.get("partyType") or ""
		if account_party:
			line["partyType"] = account_party
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
def statement(state, account_id, date_from="", date_to="", currency="") -> dict:
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
	total_debit = round2(sum(r["debit"] for r in rows))
	total_credit = round2(sum(r["credit"] for r in rows))
	show = display_currency(state, currency)
	factor = 1.0 / rate_of(state, show.get("code"))
	for row in rows:
		for field in ("debit", "credit", "amount", "balance"):
			row[field] = round2(num(row.get(field)) * factor)
	return {
		"account": {"id": account.get("id"), "code": account.get("code"), "name": account.get("name"),
		            "type": account.get("type"), "isGroup": bool(account.get("isGroup")),
		            "currency": str(account.get("currency") or "").upper()},
		"from": date_only(date_from), "to": date_only(date_to),
		"opening": round2(opening * factor), "closing": round2(running * factor),
		"totalDebit": round2(total_debit * factor),
		"totalCredit": round2(total_credit * factor),
		"currency": currency_meta(state, show.get("code")),
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
	"""تشغيل تقرير ثم تحويل كل مبالغه إلى عملة العرض المطلوبة."""
	filters = filters or {}
	result = _run_report_base(state, report_id, filters)
	show = display_currency(state, filters.get("currency"))
	factor = 1.0 / rate_of(state, show.get("code"))
	money_keys = {c.get("key") for c in result.get("columns") or [] if c.get("type") == "money"}
	if abs(factor - 1.0) > 1e-12:
		for row in result.get("rows") or []:
			for key in money_keys:
				if key in row and row[key] not in ("", None):
					row[key] = round2(num(row[key]) * factor)
		for key in list((result.get("totals") or {}).keys()):
			result["totals"][key] = round2(num(result["totals"].get(key)) * factor)
	result["currency"] = currency_meta(state, show.get("code"))
	result["moneyColumns"] = sorted(money_keys)
	return result


def _run_report_base(state, report_id, filters=None) -> dict:
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


# ═════════════════════ الربط المحاسبي التلقائي ═════════════════════
# كل عملية مالية في النظام (رواتب، خصومات، بدلات، تأمينات، سلف، قروض،
# نهاية خدمة) تُرحَّل تلقائيًا كسند قيد يومية على بند حسابد محدد.
# الربط يُخزَّن داخل settings.accountingMapping ويمكن تعديله من الواجهة.

MAPPING_LABELS = {
	"salaryExpense": "مصروف الرواتب الأساسية",
	"allowanceExpense": "مصروف البدلات والحوافز والإضافي",
	"employerGosiExpense": "مصروف حصة المنشأة في التأمينات",
	"deductionRecovery": "استرداد خصومات الغياب والجزاءات (دائن)",
	"eosExpense": "مصروف مكافأة نهاية الخدمة",
	"gosiPayable": "التأمينات الاجتماعية المستحقة",
	"taxPayable": "الضرائب المستحقة",
	"salariesPayable": "الرواتب المستحقة الدفع",
	"eosPayable": "مكافآت نهاية الخدمة المستحقة",
	"advances": "سلف وقروض الموظفين (أصل)",
	"cash": "النقدية بالصندوق",
	"bank": "النقدية بالبنك",
	"receivable": "العملاء (مدينون)",
	"payable": "الموردون (دائنون)",
	"generalExpense": "مصروفات عامة وأخرى",
}

DEFAULT_MAPPING = {
	"salaryExpense": "5101",
	"allowanceExpense": "5106",
	"employerGosiExpense": "5110",
	"deductionRecovery": "5108",
	"eosExpense": "5109",
	"gosiPayable": "2104",
	"taxPayable": "2103",
	"salariesPayable": "2102",
	"eosPayable": "2107",
	"advances": "1105",
	"cash": "1101",
	"bank": "1102",
	"receivable": "1103",
	"payable": "2101",
	"generalExpense": "5103",
}

EVENT_LABELS = {
	"payslip_accrual": "استحقاق راتب",
	"payslip_payment": "صرف راتب",
	"eos_accrual": "استحقاق نهاية خدمة",
	"eos_payment": "صرف نهاية خدمة",
	"advance_disbursement": "صرف سلفة موظف",
	"advance_payment": "سداد سلفة موظف",
	"loan_payment": "سداد قرض موظف",
	"expense": "مصروف عام",
	"manual": "قيد يدوي",
}


def ensure_default_accounts(state) -> list[dict]:
	"""إضافة أي حسابات افتراضية جديدة إلى شجرة حسابات قائمة (ترحيل تلقائي)."""
	rows = state.get("accounts")
	if not isinstance(rows, list) or not rows:
		rows = default_accounts()
		state["accounts"] = rows
		return rows
	used_codes = {str(a.get("code")) for a in rows}
	used_ids = {a.get("id") for a in rows}
	changed = False
	for account in default_accounts():
		if str(account["code"]) in used_codes:
			continue
		row = dict(account)
		if row["id"] in used_ids:
			row["id"] = "acc_%s" % row["code"]
		rows.append(row)
		used_codes.add(str(row["code"]))
		used_ids.add(row["id"])
		changed = True
	if changed:
		state["accounts"] = rows
	return rows


def mapping(state) -> dict:
	saved = ((state.get("settings") or {}).get("accountingMapping") or {})
	out = {key: (str(saved.get(key)) if saved.get(key) else code) for key, code in DEFAULT_MAPPING.items()}
	out["enabled"] = saved.get("enabled", True) is not False
	return out


def save_mapping(state, payload) -> dict:
	current = mapping(state)
	updated = dict(current)
	for key in DEFAULT_MAPPING:
		if key in (payload or {}):
			value = str(payload.get(key) or "").strip()
			if value:
				updated[key] = value
	if "enabled" in (payload or {}):
		updated["enabled"] = payload.get("enabled") is not False
	state.setdefault("settings", {})["accountingMapping"] = updated
	return updated


def account_for_code(state, code):
	return next((a for a in accounts(state) if str(a.get("code")) == str(code)), None)


def has_posting(state, event, ref_id) -> bool:
	source = "%s:%s" % (event, ref_id)
	return any(v.get("source") == source and (v.get("status") or "draft") != "cancelled"
	           for v in state.get("vouchers") or [])


def build_lines(state, entries) -> list[dict]:
	"""entries: [(مفتاح ربط، مدين، دائن، بيان)] → سطور قيد جاهزة."""
	index = {str(a.get("code")): a for a in accounts(state)}
	lines = []
	for key, debit, credit, note in entries:
		debit, credit = round2(num(debit)), round2(num(credit))
		if not debit and not credit:
			continue
		target = key if key in index else DEFAULT_MAPPING.get(key)
		account = index.get(str(target))
		if not account:
			raise ValueError("لا يوجد حساب مربوط للمفتاح %s (الكود %s)" % (MAPPING_LABELS.get(key, key), target))
		if account.get("isGroup"):
			raise ValueError("الحساب المربوط حساب رئيسي ولا يقبل الترحيل: %s" % account.get("name"))
		lines.append({"accountId": account.get("id"),
		              "description": str(note or "").strip() or MAPPING_LABELS.get(key, ""),
		              "debit": debit, "credit": credit, "partyType": "", "party": "", "dueDate": ""})
	return lines


def post_entry(state, event, ref_id, date, entries, description="", ref_type="", ref_number="",
	           user="", branch_id="", currency="", notes="", allow_repeat=False):
	"""ترحيل قيد تلقائي متوازن مرتبط بعملية مالية، مع منع التكرار."""
	if not mapping(state).get("enabled", True):
		return None
	source = "%s:%s" % (event, ref_id)
	if not allow_repeat:
		existing = next((v for v in state.get("vouchers") or []
		                 if v.get("source") == source and (v.get("status") or "draft") != "cancelled"), None)
		if existing:
			return existing
	day = date_only(date) or today_iso()
	lines = build_lines(state, entries)
	if not lines:
		return None
	debit = round2(sum(num(l.get("debit")) for l in lines))
	credit = round2(sum(num(l.get("credit")) for l in lines))
	if abs(debit - credit) > 0.009:
		raise ValueError("القيد التلقائي غير متوازن: مدين %s / دائن %s" % (debit, credit))
	record = {
		"id": "vc_auto_%s" % uuid4().hex[:16],
		"type": "journal",
		"number": next_voucher_number(state, "journal", day),
		"date": day,
		"description": str(description or EVENT_LABELS.get(event, "قيد تلقائي")).strip(),
		"reference": str(ref_number or ""),
		"branchId": branch_id or "",
		"currency": currency or "",
		"notes": str(notes or ""),
		"lines": lines, "debit": debit, "credit": credit,
		"status": "posted", "isOpening": False,
		"auto": True, "event": event, "eventLabel": EVENT_LABELS.get(event, event),
		"source": source, "sourceType": ref_type, "sourceId": ref_id,
		"createdAt": datetime.now().isoformat(timespec="seconds"),
		"postedAt": datetime.now().isoformat(timespec="seconds"),
		"createdBy": user or "system",
	}
	state.setdefault("vouchers", []).append(record)
	return record


def payslip_entries(slip):
	"""سطور استحقاق كشف الراتب: مصروفات مقابل التزامات وخصومات."""
	gross = num(slip.get("grossSalary"))
	basic = num(slip.get("basicEarning"))
	if basic <= 0:
		basic = gross
	extra = round2(gross - basic)
	gosi_employee = num(slip.get("gosiEmployeeShare"))
	gosi_employer = num(slip.get("gosiEmployerShare"))
	tax = num(slip.get("tax"))
	advances = round2(num(slip.get("advanceDeduction")) + num(slip.get("loanDeduction")))
	net = num(slip.get("netSalary"))
	recovery = round2(num(slip.get("totalDeductionsAll")) - gosi_employee - tax - advances)
	name = slip.get("employeeName") or ""
	recovery_debit = recovery < 0
	entries = [
		("salaryExpense", basic, 0, "راتب أساسي — %s" % name),
		("allowanceExpense", extra, 0, "بدلات ومكافآت — %s" % name),
		("employerGosiExpense", gosi_employer, 0, "حصة المنشأة في التأمينات — %s" % name),
		("gosiPayable", 0, round2(gosi_employee + gosi_employer), "تأمينات مستحقة — %s" % name),
		("taxPayable", 0, tax, "ضرائب مستحقة — %s" % name),
		("advances", 0, advances, "استقطاع سلف وقروض — %s" % name),
		("deductionRecovery", abs(recovery) if recovery_debit else 0, 0 if recovery_debit else recovery,
		 "استرداد خصومات الغياب والجزاءات — %s" % name),
		("salariesPayable", 0, net, "صافي الراتب المستحق — %s" % name),
	]
	return entries


def payslip_payment_entries(slip, method=""):
	"""سطور صرف كشف الراتب: إقفال الالتزام مقابل الصندوق/البنك."""
	name = slip.get("employeeName") or ""
	account_key = "bank" if str(method or slip.get("paymentMethod") or "").lower() in ("bank", "transfer", "cheque", "check") else "cash"
	return [
		("salariesPayable", num(slip.get("netSalary")), 0, "سداد صافي راتب — %s" % name),
		(account_key, 0, num(slip.get("netSalary")), "صرف من %s — %s" % ("البنك" if account_key == "bank" else "الصندوق", name)),
	]


# ═════════════════════ تقسيم الحساب حسب العملات ═════════════════════
def split_account_by_currency(state, account_id, codes) -> list[dict]:
	"""تحويل حساب فرعي بلا حركة إلى حسابات فرعية بعملات مختلفة."""
	rows = accounts(state)
	account = next((a for a in rows if a.get("id") == account_id), None)
	if not account:
		raise ValueError("الحساب غير موجود")
	if account.get("isGroup"):
		raise ValueError("اختر حسابًا فرعيًا غير تجميعي")
	has_moves = any(line.get("accountId") == account_id
	                for v in state.get("vouchers") or [] for line in v.get("lines") or [])
	if has_moves:
		raise ValueError("الحساب عليه حركة محاسبية — أنشئ الحسابات الفرعية يدويًا أو رحّل الأرصدة أولًا")
	if any((a.get("parentId") or "") == account_id for a in rows):
		raise ValueError("الحساب لديه حسابات فرعية بالفعل")
	index = currencies_index(state)
	wanted = []
	for code in codes or []:
		code = str(code or "").strip().upper()
		if not code or code in wanted:
			continue
		if code not in index:
			raise ValueError("العملة غير معروفة: %s" % code)
		wanted.append(code)
	if not wanted:
		raise ValueError("اختر عملة واحدة على الأقل")
	created = []
	for code in wanted:
		currency = index[code]
		child_code = next_code(state, account_id)
		child = {
			"id": "acc_%s" % child_code, "code": child_code,
			"name": "%s - %s" % (account.get("name"), currency.get("name") or code),
			"nameEn": "", "type": account.get("type"), "parentId": account_id,
			"isGroup": False, "nature": account.get("nature") or "debit",
			"partyType": account.get("partyType") or "", "description": "",
			"currency": code, "active": True, "createdAt": datetime.now().isoformat(timespec="seconds"),
		}
		rows.append(child)
		created.append(child)
	# الحساب الأصلي يصبح تجميعيًا حتى لا تُسجَّل عليه حركة مزدوجة
	account["isGroup"] = True
	account["splitAt"] = datetime.now().isoformat(timespec="seconds")
	return created


# ═════════════════════ الإقفال السنوي ═════════════════════
def _last_day(year, month) -> int:
	return calendar.monthrange(int(year), int(month))[1]


def fiscal_period(state, year) -> tuple[str, str]:
	"""فترة السنة المالية حسب شهر بداية السنة في الإعدادات."""
	year = int(year)
	settings = state.get("settings") or {}
	month = int(num(settings.get("fiscalYearStartMonth")) or 1)
	month = min(max(month, 1), 12)
	if month == 1:
		return "%04d-01-01" % year, "%04d-12-31" % year
	start = "%04d-%02d-01" % (year, month)
	end_year, end_month = year + 1, month - 1
	return start, "%04d-%02d-%02d" % (end_year, end_month, _last_day(end_year, end_month))


def closed_years(state) -> list[dict]:
	rows = ((state.get("settings") or {}).get("closedYears") or [])
	return [row for row in rows if isinstance(row, dict) and row.get("year")]


def period_locked(state, date) -> bool:
	day = date_only(date)
	if not day:
		return False
	return any(day <= str(row.get("to") or "") for row in closed_years(state))


def locked_through(state) -> str:
	days = [str(row.get("to") or "") for row in closed_years(state) if row.get("to")]
	return max(days) if days else ""


def year_end_preview(state, year, retained_id="") -> dict:
	year = int(year)
	start, end = fiscal_period(state, year)
	entry = next((row for row in closed_years(state) if int(row.get("year") or 0) == year), None)
	index = by_id(state)
	retained = index.get(retained_id) if retained_id else account_for_code(state, "3102")
	sums = totals_map(state, start, end)
	rows, lines = [], []
	revenue = expense = 0.0
	for account in sorted(accounts(state), key=lambda a: str(a.get("code"))):
		if account.get("isGroup") or account.get("type") not in ("revenue", "expense"):
			continue
		balance = _natural(account, aggregate(state, account, sums)["balance"])
		if abs(balance) < 0.005:
			continue
		rows.append({"accountId": account.get("id"), "code": account.get("code"), "name": account.get("name"),
		             "type": account.get("type"), "typeLabel": ACCOUNT_TYPES.get(account.get("type")),
		             "balance": round2(balance),
		             "entrySide": "credit" if account.get("type") == "expense" else "debit"})
		if account.get("type") == "revenue":
			revenue += balance
			lines.append({"accountId": account.get("id"), "description": "إقفال إيراد — %s" % account.get("name"),
			              "debit": round2(balance), "credit": 0.0})
		else:
			expense += balance
			lines.append({"accountId": account.get("id"), "description": "إقفال مصروف — %s" % account.get("name"),
			              "debit": 0.0, "credit": round2(balance)})
	profit = round2(revenue - expense)
	if retained and abs(profit) >= 0.005:
		lines.append({"accountId": retained.get("id"),
		              "description": ("صافي ربح السنة %d" if profit > 0 else "صافي خسارة السنة %d") % year,
		              "debit": round2(-profit) if profit < 0 else 0.0,
		              "credit": round2(profit) if profit > 0 else 0.0})
	drafts = [v for v in state.get("vouchers") or []
	          if (v.get("status") or "draft") == "draft" and start <= date_only(v.get("date")) <= end]
	warnings = []
	if entry:
		warnings.append({"level": "info", "text": "السنة %d مقفلة بالفعل — القيد %s. يمكنك إعادة فتحها للتعديل."
		                                        % (year, entry.get("voucherNumber") or entry.get("voucherId") or "")})
	if drafts:
		warnings.append({"level": "danger", "text": "يوجد %d سند مسودة في الفترة — رحّلها أو احذفها قبل الإقفال." % len(drafts)})
	if not retained:
		warnings.append({"level": "danger", "text": "حساب الأرباح المحتجزة غير موجود — اختر حسابًا صحيحًا."})
	elif retained.get("isGroup"):
		warnings.append({"level": "danger", "text": "حساب الأرباح المحتجزة المختار حساب رئيسي — اختر حسابًا فرعيًا."})
	if not rows:
		warnings.append({"level": "info", "text": "لا توجد أرصدة إيرادات أو مصروفات في هذه السنة — قد تكون مقفلة أو لا توجد حركة."})
	profit_account = retained.get("name") if retained else ""
	return {
		"year": year, "from": start, "to": end, "closed": bool(entry), "closing": entry or None,
		"retained": {"id": (retained or {}).get("id") or "", "code": (retained or {}).get("code") or "",
		             "name": profit_account},
		"revenue": round2(revenue), "expense": round2(expense), "profit": profit,
		"rows": rows, "lines": lines, "warnings": warnings, "drafts": len(drafts),
		"currency": currency_meta(state), "history": sorted(closed_years(state), key=lambda r: str(r.get("year")), reverse=True),
		"lockedThrough": locked_through(state),
	}


def year_end_close(state, year, retained_id="", user="", notes="", force=False) -> dict:
	preview = year_end_preview(state, year, retained_id)
	if preview["closed"]:
		raise ValueError("السنة %d مقفلة بالفعل — أعد فتحها أولًا" % int(year))
	if not preview["retained"].get("id"):
		raise ValueError("اختر حساب الأرباح المحتجزة أولًا")
	if not preview["rows"]:
		raise ValueError("لا توجد أرصدة إيرادات أو مصروفات لإقفالها في هذه السنة")
	if preview["drafts"] and not force:
		raise ValueError("يوجد %d سند مسودة في الفترة — رحّلها أو احذفها قبل الإقفال" % preview["drafts"])
	day = preview["to"]
	debit = round2(sum(num(l.get("debit")) for l in preview["lines"]))
	credit = round2(sum(num(l.get("credit")) for l in preview["lines"]))
	if abs(debit - credit) > 0.009:
		raise ValueError("قيد الإقفال غير متوازن: مدين %s / دائن %s" % (debit, credit))
	record = {
		"id": "vc_close_%s" % uuid4().hex[:16], "type": "closing",
		"number": next_voucher_number(state, "closing", day), "date": day,
		"description": "إقفال السنة المالية %d — ترحيل الإيرادات والمصروفات إلى الأرباح المحتجزة" % int(year),
		"reference": "", "branchId": "", "partyType": "", "party": "",
		"currency": base_code(state), "notes": str(notes or ""),
		"lines": [dict(l, partyType="", party="", dueDate="") for l in preview["lines"]],
		"debit": debit, "credit": credit, "status": "posted", "isOpening": False,
		"auto": True, "event": "year_end", "eventLabel": "إقفال سنوي",
		"source": "year_end:%d" % int(year), "sourceType": "accounts", "sourceId": str(year),
		"createdAt": datetime.now().isoformat(timespec="seconds"),
		"postedAt": datetime.now().isoformat(timespec="seconds"), "createdBy": user or "system",
	}
	state.setdefault("vouchers", []).append(record)
	settings = state.setdefault("settings", {})
	settings["closedYears"] = [row for row in closed_years(state) if int(row.get("year") or 0) != int(year)] + [{
		"year": int(year), "from": preview["from"], "to": preview["to"],
		"voucherId": record["id"], "voucherNumber": record["number"],
		"revenue": preview["revenue"], "expense": preview["expense"], "profit": preview["profit"],
		"retainedAccountId": preview["retained"].get("id"),
		"closedAt": datetime.now().isoformat(timespec="seconds"), "closedBy": user or "",
	}]
	settings["lockedThrough"] = locked_through(state)
	return {"preview": preview, "voucher": record}


def year_end_reopen(state, year, user="", reason="") -> dict:
	row = next((r for r in closed_years(state) if int(r.get("year") or 0) == int(year)), None)
	if not row:
		raise ValueError("السنة %d غير مقفلة" % int(year))
	source = "year_end:%d" % int(year)
	voucher = next((v for v in state.get("vouchers") or [] if v.get("source") == source), None)
	if voucher and (voucher.get("status") or "draft") != "cancelled":
		voucher["status"] = "cancelled"
		voucher["cancelledAt"] = datetime.now().isoformat(timespec="seconds")
		voucher["cancelReason"] = str(reason or "إعادة فتح السنة المالية")
	settings = state.setdefault("settings", {})
	settings["closedYears"] = [r for r in closed_years(state) if int(r.get("year") or 0) != int(year)]
	settings["lockedThrough"] = locked_through(state)
	return {"year": int(year), "voucher": voucher, "lockedThrough": settings["lockedThrough"]}
