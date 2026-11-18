"""نقل بيانات الموارد البشرية من ERPNext/HRMS إلى تطبيق tageephr.

يُشغَّل مرة واحدة بعد التثبيت (أو عند الحاجة لإعادة المزامنة):

    bench --site site1.local execute tageephr.hrpro.erp_import.run

الدالة idempotent: تستبدل مجموعات الموارد البشرية ببيانات ERP الحالية،
وتحتفظ بالمستخدمين والإعدادات وشجرة الحسابات وسجل التدقيق.
"""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta

import frappe

from . import accounting, engine, store
from .utils import date_only, num, round2, today_iso

# المجموعات التي تُعاد بناؤها من ERP
REBUILD = [
	"branches", "departments", "jobGrades", "workShifts", "holidays",
	"leaveTypes", "leaveBalances", "leaveRequests", "leaveLedger",
	"employees", "contracts", "employeeDocuments", "insuranceRecords",
	"attendanceRecords", "attendanceDaily", "attendanceCorrections",
	"payslips", "payrollPeriods", "salaryPayments", "journalEntries",
	"advances", "advancePayments", "loans", "loanPayments",
	"allowanceTypes", "deductionTypes", "employeeAllowances", "employeeDeductions",
	"incentives", "eosSettlements", "absences", "dailyFollowUps",
	"dailyExtras", "dailyAdvances", "approvalsRequests", "approvalRequests",
]

BASIC_HINTS = ("أساس", "اساس", "basic")

LEAVE_COLORS = ["#2563eb", "#dc2626", "#f59e0b", "#16a34a", "#7c3aed", "#0891b2", "#db2777", "#64748b"]

CURRENCY_LABELS = {"YER": "ر.ي", "SAR": "ر.س", "USD": "$", "AED": "د.إ", "EUR": "€"}

WEEKDAY_INDEX = {
	"Monday": "0", "Tuesday": "1", "Wednesday": "2", "Thursday": "3",
	"Friday": "4", "Saturday": "5", "Sunday": "6",
}


# ───────────────────────── أدوات ─────────────────────────
def _sid(prefix, name):
	return "%s%s" % (prefix, hashlib.md5(str(name).encode("utf-8")).hexdigest()[:10])


def _meta_fields(doctype):
	standard = {"name", "docstatus", "owner", "creation", "modified", "modified_by"}
	try:
		return {f.fieldname for f in frappe.get_meta(doctype).fields} | standard
	except Exception:
		return standard


def get_rows(doctype, fields, filters=None, order_by=None, limit=None):
	"""get_all آمن: يتجاهل الحقول غير الموجودة في هذا التركيب."""
	available = _meta_fields(doctype)
	use = [f for f in fields if f in available]
	kwargs = {"fields": use or ["name"]}
	if filters:
		kwargs["filters"] = filters
	if order_by:
		kwargs["order_by"] = order_by
	if limit:
		kwargs["limit"] = limit
	try:
		return frappe.get_all(doctype, **kwargs)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "tageephr import: %s" % doctype)
		return []


def _clock(value):
	"""تحويل time/timedelta/نص إلى HH:MM."""
	if value in (None, ""):
		return ""
	if isinstance(value, timedelta):
		total = int(value.total_seconds())
	elif hasattr(value, "hour"):
		total = value.hour * 3600 + value.minute * 60 + getattr(value, "second", 0)
	else:
		text = str(value).strip()
		parts = text.split(" ")
		text = parts[-1] if len(parts) > 1 else text
		bits = text.split(":")
		try:
			total = int(bits[0]) * 3600 + (int(bits[1]) if len(bits) > 1 else 0) * 60 + (int(bits[2]) if len(bits) > 2 else 0)
		except Exception:
			return ""
	total %= 86400
	return "%02d:%02d" % (total // 3600, (total % 3600) // 60)


def _minutes(value):
	text = _clock(value)
	if not text:
		return None
	hours, minutes = text.split(":")
	return int(hours) * 60 + int(minutes)


def _is_basic(name):
	text = str(name or "").lower()
	return any(hint in text for hint in BASIC_HINTS)


def _norm_status(value):
	text = str(value or "").strip().lower()
	return {
		"present": "present", "absent": "absent", "half day": "half_day",
		"on leave": "leave", "work from home": "remote", "holiday": "holiday",
	}.get(text, "present")


def _employee_status(value):
	return "terminated" if str(value or "").strip().lower() in ("left", "inactive", "terminated", "suspended") else "active"


# ───────────────────────── البناء ─────────────────────────
def build_state():
	state = store.load_state()

	# ── الشركة والعملة ──
	companies = get_rows("Company", ["name", "default_currency"])
	currency_code = next((c.get("default_currency") for c in companies if c.get("default_currency")), "")
	company_rows = get_rows("Employee", ["company"])
	company_names = [r.get("company") for r in company_rows if r.get("company")]
	main_company = max(set(company_names), key=company_names.count) if company_names else (companies[0]["name"] if companies else "")
	if main_company:
		state["settings"]["companyName"] = main_company
	if currency_code:
		state["settings"]["currencyCode"] = currency_code
		state["settings"]["currency"] = CURRENCY_LABELS.get(currency_code, state["settings"].get("currency") or currency_code)

	# ── الفروع ──
	branch_map = {}
	branches = []
	for row in get_rows("Branch", ["name", "branch", "branch_name"]):
		name = row.get("name")
		branch_map[name] = _sid("br_", name)
		branches.append({
			"id": branch_map[name], "name": row.get("branch") or row.get("branch_name") or name,
			"code": name, "address": "", "phone": "", "managerId": "", "active": True,
			"createdAt": engine._now(),
		})
	state["branches"] = branches

	# ── الأقسام ──
	department_map = {}
	departments = []
	for row in get_rows("Department", ["name", "parent_department", "company"]):
		name = row.get("name")
		department_map[name] = _sid("dp_", name)
		departments.append({
			"id": department_map[name], "name": name, "parentId": department_map.get(row.get("parent_department"), ""),
			"branchId": "", "managerId": "", "company": row.get("company") or "", "active": True,
			"createdAt": engine._now(),
		})
	state["departments"] = departments

	# ── الرتب الوظيفية (المسميات) ──
	grade_map = {}
	job_grades = []
	for row in get_rows("Designation", ["name"]):
		name = row.get("name")
		grade_map[name] = _sid("jg_", name)
		job_grades.append({"id": grade_map[name], "name": name, "code": "", "level": 0, "active": True,
		                   "createdAt": engine._now()})
	state["jobGrades"] = job_grades

	# ── فترات الدوام ──
	shift_map = {}
	shift_windows = {}
	work_shifts = []
	for row in get_rows("Shift Type", ["name", "start_time", "end_time", "late_entry_grace_period",
	                                  "early_exit_grace_period", "working_hours_threshold_for_absent"]):
		name = row.get("name")
		shift_map[name] = _sid("sh_", name)
		start, end = _clock(row.get("start_time")), _clock(row.get("end_time"))
		if not start or not end:
			continue
		start_min, end_min = _minutes(start), _minutes(end)
		if end_min is not None and start_min is not None and end_min <= start_min:
			end_min += 1440
		shift_windows[name] = {"start": start_min, "end": end_min,
		                       "grace": num(row.get("late_entry_grace_period")),
		                       "earlyGrace": num(row.get("early_exit_grace_period"))}
		work_shifts.append({
			"id": shift_map[name], "name": name, "active": True, "createdAt": engine._now(),
			"periods": [{
				"name": "الفترة الأولى", "startTime": start, "endTime": end,
				"graceMinutes": num(row.get("late_entry_grace_period")),
				"earlyGraceMinutes": num(row.get("early_exit_grace_period")),
				"absenceAfterMinutes": 0,
			}],
		})
	state["workShifts"] = work_shifts

	# ── العطلات ──
	holidays = []
	seen_days = set()
	for row in get_rows("Holiday", ["holiday_date", "description", "parent"], order_by="holiday_date asc"):
		day = date_only(row.get("holiday_date"))
		if not day or day in seen_days:
			continue
		seen_days.add(day)
		holidays.append({"id": _sid("hd_", day), "date": day, "name": row.get("description") or "عطلة رسمية",
		                 "description": row.get("description") or "", "listName": row.get("parent") or "",
		                 "recurring": False, "createdAt": engine._now()})
	state["holidays"] = holidays

	# أيام العطلة الأسبوعية من قوائم العطلات
	weekly = []
	for row in get_rows("Holiday List", ["weekly_off"]):
		index = WEEKDAY_INDEX.get(str(row.get("weekly_off") or "").strip())
		if index and index not in weekly:
			weekly.append(index)
	if weekly:
		state["settings"]["weeklyOffDays"] = weekly

	# ── أنواع الإجازات ──
	leave_type_map = {}
	leave_types = []
	erp_leaves = get_rows("Leave Type", ["name", "leave_type_name", "max_leaves_allowed", "is_carry_forward",
	                                     "is_lwp", "is_ppl", "include_holiday", "maximum_carry_forwarded_leaves"])
	for idx, row in enumerate(erp_leaves):
		name = row.get("name")
		leave_type_map[name] = _sid("lt_", name)
		paid = not bool(num(row.get("is_lwp")))
		leave_types.append({
			"id": leave_type_map[name], "name": row.get("leave_type_name") or name,
			"daysPerYear": num(row.get("max_leaves_allowed")), "isPaid": paid,
			"isCarryOver": bool(num(row.get("is_carry_forward"))),
			"maxCarryOver": num(row.get("maximum_carry_forwarded_leaves")),
			"accrual": "annual", "color": LEAVE_COLORS[idx % len(LEAVE_COLORS)],
			"requiresApproval": True, "countWeekends": bool(num(row.get("include_holiday"))),
			"halfPaid": bool(num(row.get("is_ppl"))), "description": "من ERPNext — %s" % name,
		})
	state["leaveTypes"] = leave_types

	# ── أرصدة الإجازات ──
	balances = []
	for row in get_rows("Leave Allocation", ["employee", "leave_type", "from_date", "to_date", "total_leaves_allocated"]):
		if row.get("leave_type") not in leave_type_map:
			continue
		year = int(date_only(row.get("from_date"))[:4]) if date_only(row.get("from_date")) else int(today_iso()[:4])
		total = num(row.get("total_leaves_allocated"))
		balances.append({
			"id": _sid("lb_", "%s|%s|%s" % (row.get("employee"), row.get("leave_type"), year)),
			"employeeId": row.get("employee"), "leaveTypeId": leave_type_map[row.get("leave_type")],
			"year": year, "entitlement": total, "accrued": 0, "carried": 0, "adjusted": 0,
			"used": 0, "converted": 0, "balance": total, "updatedAt": engine._now(),
		})
	state["leaveBalances"] = balances
	state["leaveRequests"] = []
	state["leaveLedger"] = []

	# ── كشوف الرواتب وتفاصيلها ──
	slip_rows = get_rows(
		"Salary Slip",
		["name", "employee", "employee_name", "start_date", "end_date", "posting_date", "gross_pay",
		 "total_deduction", "net_pay", "total_working_days", "payment_days", "status", "docstatus",
		 "absent_days", "leave_without_pay", "branch", "department", "designation"],
		order_by="start_date asc, employee asc",
	)
	slip_ids = {row.get("name") for row in slip_rows}
	details = {}
	try:
		for row in frappe.db.sql(
			"SELECT parent, salary_component, amount, parentfield FROM `tabSalary Detail` "
			"WHERE parenttype='Salary Slip'", as_dict=True):
			if row.get("parent") in slip_ids:
				details.setdefault(row["parent"], []).append(row)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "tageephr import: salary details")

	# أحدث كشف لكل موظف (لاشتقاق الراتب الأساسي والبدلات)
	latest_slip = {}
	for row in slip_rows:
		latest_slip[row.get("employee")] = row

	# مكونات هياكل الرواتب — للموظفين الذين لا توجد لهم كشوف بعد
	structure_components = {}
	try:
		for row in frappe.db.sql(
			"SELECT parent, salary_component, amount FROM `tabSalary Detail` "
			"WHERE parenttype='Salary Structure'", as_dict=True):
			structure_components.setdefault(row.get("parent"), []).append(row)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "tageephr import: salary structures")

	ssa_by_employee = {}
	for row in get_rows("Salary Structure Assignment", ["employee", "base", "salary_structure", "from_date"],
	                    order_by="from_date asc"):
		if row.get("employee"):
			ssa_by_employee[row["employee"]] = row

	def structure_basic(emp_id):
		structure = (ssa_by_employee.get(emp_id) or {}).get("salary_structure")
		return sum(num(c.get("amount")) for c in structure_components.get(structure, [])
		           if _is_basic(c.get("salary_component")))

	allowance_types = {}
	def allowance_type_id(component):
		if component not in allowance_types:
			allowance_types[component] = {
				"id": _sid("at_", component), "name": component, "calculationType": "fixed", "value": 0,
				"isInsuranceBased": False, "isTaxable": True, "active": True, "createdAt": engine._now(),
			}
		return allowance_types[component]["id"]

	payslips = []
	period_keys = {}
	for row in slip_rows:
		start = date_only(row.get("start_date")) or date_only(row.get("posting_date"))
		end = date_only(row.get("end_date")) or start
		if not start:
			continue
		year, month = int(start[:4]), int(start[5:7])
		period_id = "pp_%s_%02d" % (year, month)
		period_keys[(year, month)] = {"fromDate": start, "toDate": end}
		gross = num(row.get("gross_pay"))
		net = num(row.get("net_pay"))
		deduction = num(row.get("total_deduction"))
		rows = details.get(row.get("name"), [])
		earnings = [r for r in rows if str(r.get("parentfield")) != "deductions"]
		deductions = [r for r in rows if str(r.get("parentfield")) == "deductions"]
		basic = sum(num(r.get("amount")) for r in earnings if _is_basic(r.get("salary_component")))
		if basic <= 0:
			basic = min([num(r.get("amount")) for r in earnings if num(r.get("amount")) > 0] or [gross])
		items = []
		allowance_list = []
		total_allowances = 0.0
		for r in earnings:
			amount = num(r.get("amount"))
			if not amount:
				continue
			items.append({"id": _sid("pi_", "%s|%s" % (row.get("name"), r.get("salary_component"))),
			              "type": "earning", "name": r.get("salary_component"), "amount": amount, "manual": False})
			if not _is_basic(r.get("salary_component")):
				total_allowances += amount
				allowance_list.append({"id": _sid("pi_", "%s|%s" % (row.get("name"), r.get("salary_component"))),
				                       "name": r.get("salary_component"), "amount": amount,
				                       "insuranceBased": False, "taxable": True})
		for r in deductions:
			amount = num(r.get("amount"))
			if not amount:
				continue
			items.append({"id": _sid("pi_", "%s|%s" % (row.get("name"), r.get("salary_component"))),
			              "type": "deduction", "name": r.get("salary_component"), "amount": amount, "manual": False})
		approved = num(row.get("docstatus")) == 1
		payslips.append({
			"id": _sid("ps_", row.get("name")),
			"erpName": row.get("name"),
			"employeeId": row.get("employee"), "employeeName": row.get("employee_name") or "",
			"employeeNumber": row.get("employee") or "",
			"branchId": branch_map.get(row.get("branch"), ""), "departmentId": department_map.get(row.get("department"), ""),
			"periodId": period_id, "month": month, "year": year, "fromDate": start, "toDate": end,
			"baseSalary": round2(basic or gross), "dailyWage": round2((basic or gross) / 30.0),
			"totalWorkingDays": num(row.get("total_working_days")), "eligibleDays": num(row.get("payment_days")),
			"presentDays": num(row.get("payment_days")), "absentDays": num(row.get("absent_days")),
			"leaveDays": num(row.get("leave_without_pay")), "paidLeaveDays": 0,
			"unpaidLeaveDays": num(row.get("leave_without_pay")), "halfDays": 0,
			"lateMinutes": 0, "earlyMinutes": 0, "overtimeMinutes": 0, "missingPunchDays": 0,
			"basicEarning": round2(basic), "allowances": allowance_list, "totalAllowances": round2(total_allowances),
			"incentivesTotal": 0, "overtimeAmount": 0, "manualAdditions": 0,
			"grossSalary": round2(gross), "gosiBase": 0, "gosiEmployeeShare": 0, "gosiEmployerShare": 0, "tax": 0,
			"absenceDeduction": round2(sum(num(r.get("amount")) for r in deductions if "absence" in str(r.get("salary_component")).lower() or "غياب" in str(r.get("salary_component")))),
			"unpaidLeaveDeduction": 0, "halfDayDeduction": 0,
			"lateDeduction": round2(sum(num(r.get("amount")) for r in deductions if "late" in str(r.get("salary_component")).lower() or "تأخير" in str(r.get("salary_component")))),
			"earlyDeduction": 0, "advanceDeduction": 0, "loanDeduction": 0,
			"otherDeductions": round2(max(0, deduction - sum(num(r.get("amount")) for r in deductions))),
			"totalDeductionsAll": round2(deduction), "netSalary": round2(net),
			"items": items, "status": "approved" if approved else "draft",
			"approvedBy": "ERPNext" if approved else "", "approvedAt": date_only(row.get("posting_date")) if approved else "",
			"notes": "مستورد من ERPNext — %s" % row.get("name"), "createdAt": engine._now(),
			"source": "erpnext",
		})
	state["payslips"] = payslips

	periods = []
	for (year, month), info in sorted(period_keys.items()):
		has_draft = any(p["year"] == year and p["month"] == month and p["status"] == "draft" for p in payslips)
		periods.append({
			"id": "pp_%s_%02d" % (year, month), "name": "رواتب %s/%s" % (month, year),
			"month": month, "year": year, "fromDate": info["fromDate"], "toDate": info["toDate"],
			"status": "draft" if has_draft else "closed", "createdBy": "ERPNext",
			"createdAt": engine._now(), "closedAt": "" if has_draft else engine._now(),
		})
	state["payrollPeriods"] = periods

	# ── الموظفون ──
	employee_rows = get_rows(
		"Employee",
		["name", "employee_name", "first_name", "last_name", "employee_number", "status", "company",
		 "branch", "department", "designation", "grade", "date_of_joining", "date_of_birth", "gender",
		 "cell_number", "company_email", "personal_email", "bank_ac_no", "iban", "bank_name",
		 "default_shift", "employment_type", "contract_end_date", "relieving_date", "marital_status",
		 "health_insurance_no", "fingerprint_id", "biometric_fingerprint_id", "attendance_device_id",
		 "reports_to", "holiday_list", "ctc"],
		order_by="name asc",
	)
	# أحدث تعيين وردية لكل موظف
	shift_assignment = {}
	for row in get_rows("Shift Assignment", ["employee", "shift_type", "start_date"],
	                    filters={"status": "Active"}, order_by="start_date asc"):
		if row.get("employee"):
			shift_assignment[row["employee"]] = row.get("shift_type")

	employees = []
	for row in employee_rows:
		name = row.get("name")
		latest = latest_slip.get(name) or {}
		latest_detail = details.get(latest.get("name"), [])
		basic = sum(num(d.get("amount")) for d in latest_detail
		            if str(d.get("parentfield")) != "deductions" and _is_basic(d.get("salary_component")))
		if basic <= 0:
			basic = structure_basic(name)
		if basic <= 0:
			basic = num((ssa_by_employee.get(name) or {}).get("base")) or num(latest.get("gross_pay")) or num(row.get("ctc"))
		shift_name = shift_assignment.get(name) or row.get("default_shift")
		fingerprint = row.get("biometric_fingerprint_id") or row.get("fingerprint_id") or row.get("attendance_device_id") or ""
		employees.append({
			"id": name,
			"name": row.get("employee_name") or name,
			"nameEn": " ".join([x for x in [row.get("first_name"), row.get("last_name")] if x and not any("\u0600" <= ch <= "\u06ff" for ch in str(x))]),
			"employeeNumber": row.get("employee_number") or name,
			"nationalId": fingerprint,
			"dateOfBirth": date_only(row.get("date_of_birth")),
			"gender": "female" if str(row.get("gender") or "").lower() in ("female", "أنثى") else ("male" if row.get("gender") else ""),
			"maritalStatus": str(row.get("marital_status") or "").lower(),
			"phone": row.get("cell_number") or "",
			"email": row.get("company_email") or row.get("personal_email") or "",
			"branchId": branch_map.get(row.get("branch"), ""),
			"departmentId": department_map.get(row.get("department"), ""),
			"jobGradeId": grade_map.get(row.get("designation"), ""),
			"jobTitle": row.get("designation") or "",
			"shiftId": shift_map.get(shift_name, ""),
			"managerId": row.get("reports_to") or "",
			"joinDate": date_only(row.get("date_of_joining")) or today_iso(),
			"status": _employee_status(row.get("status")),
			"terminationDate": date_only(row.get("relieving_date")),
			"contractType": "fixed" if row.get("contract_end_date") else "permanent",
			"contractStartDate": date_only(row.get("date_of_joining")),
			"contractEndDate": date_only(row.get("contract_end_date")),
			"baseSalary": round2(basic),
			"insuranceEligible": bool(row.get("health_insurance_no")) or True,
			"insuranceNumber": row.get("health_insurance_no") or "",
			"gosiBase": 0,
			"bankName": row.get("bank_name") or "",
			"bankAccount": row.get("iban") or row.get("bank_ac_no") or "",
			"fingerprintId": fingerprint,
			"employmentType": row.get("employment_type") or "",
			"company": row.get("company") or "",
			"payrollExcluded": False,
			"createdAt": engine._now(), "source": "erpnext",
		})
	state["employees"] = employees
	employee_ids = {e["id"] for e in employees}

	# ── بدلات الموظفين الثابتة (من أحدث كشف) ──
	employee_allowances = []
	for emp in employees:
		latest = latest_slip.get(emp["id"]) or {}
		components = [(d.get("salary_component"), num(d.get("amount")))
		              for d in details.get(latest.get("name"), [])
		              if str(d.get("parentfield")) != "deductions"]
		if not any(amount > 0 for _, amount in components):
			structure = (ssa_by_employee.get(emp["id"]) or {}).get("salary_structure")
			components = [(c.get("salary_component"), num(c.get("amount")))
			              for c in structure_components.get(structure, [])]
		for component, amount in components:
			if _is_basic(component) or amount <= 0:
				continue
			employee_allowances.append({
				"id": _sid("ea_", "%s|%s" % (emp["id"], component)),
				"employeeId": emp["id"], "allowanceTypeId": allowance_type_id(component),
				"amount": amount, "calculationType": "fixed", "effectiveDate": emp["joinDate"],
				"endDate": "", "status": "active", "notes": "من ERPNext", "createdAt": engine._now(),
			})
	state["employeeAllowances"] = employee_allowances
	state["allowanceTypes"] = sorted(allowance_types.values(), key=lambda x: x["name"])
	state["deductionTypes"] = []
	state["employeeDeductions"] = []

	# ── الحضور: السجلات اليومية من Attendance ──
	checkin_map = {}
	checkin_rows = get_rows("Employee Checkin", ["employee", "employee_name", "time", "log_type", "device_id"],
	                        order_by="time asc")
	for row in checkin_rows:
		emp_id = row.get("employee")
		if emp_id not in employee_ids:
			continue
		stamp = str(row.get("time") or "")
		day = date_only(stamp)
		clock = _clock(stamp)
		if not day or not clock:
			continue
		checkin_map.setdefault((emp_id, day), []).append((clock, row.get("log_type") or ""))

	daily = []
	attendance_rows = get_rows(
		"Attendance",
		["employee", "employee_name", "employee", "attendance_date", "status", "working_hours",
		 "late_entry", "early_exit", "shift", "department", "leave_type", "total_late_minutes",
		 "total_overtime_hours", "half_day_status"],
		order_by="attendance_date asc",
	)
	for row in attendance_rows:
		emp_id = row.get("employee")
		if emp_id not in employee_ids:
			continue
		day = date_only(row.get("attendance_date"))
		if not day:
			continue
		status = _norm_status(row.get("status"))
		punches = checkin_map.get((emp_id, day), [])
		times = sorted({p[0] for p in punches})
		check_in = _clock(row.get("in_time")) or (times[0] if times else "")
		check_out = _clock(row.get("out_time")) or (times[-1] if len(times) > 1 else "")
		emp = next((e for e in employees if e["id"] == emp_id), {})
		window = shift_windows.get(row.get("shift"))
		late_minutes = num(row.get("total_late_minutes"))
		if not late_minutes and window and check_in and status in ("present", "half_day") and num(row.get("late_entry")):
			late_minutes = max(0, (_minutes(check_in) or 0) - (window["start"] or 0) - window["grace"])
		early_minutes = 0
		if window and check_out and num(row.get("early_exit")):
			early_minutes = max(0, (window["end"] or 0) - window["earlyGrace"] - (_minutes(check_out) or 0))
		if late_minutes > 0 and status == "present":
			status = "late"
		daily.append({
			"id": "ad_%s_%s" % (emp_id, day), "empId": emp_id, "employeeId": emp_id,
			"employeeName": row.get("employee_name") or emp.get("name") or "",
			"employeeNumber": emp.get("employeeNumber") or emp_id,
			"branchId": emp.get("branchId") or "", "departmentId": emp.get("departmentId") or "",
			"date": day, "shiftId": shift_map.get(row.get("shift"), emp.get("shiftId")) or emp.get("shiftId") or "",
			"checkIn": check_in, "checkOut": check_out,
			"workedMinutes": int(round(num(row.get("working_hours")) * 60)),
			"lateMinutes": late_minutes, "earlyMinutes": early_minutes,
			"overtimeMinutes": int(round(num(row.get("total_overtime_hours")) * 60)),
			"status": status, "leaveTypeId": leave_type_map.get(row.get("leave_type"), ""),
			"dayPortion": 0.5 if status == "half_day" else 1, "paid": status not in ("absent",),
			"source": "erpnext", "correctionId": "", "notes": "",
			"processedAt": engine._now(), "locked": True,
		})
	state["attendanceDaily"] = daily
	state["attendanceCorrections"] = []

	# بصمات خام من Employee Checkin
	records = []
	for row in checkin_rows:
		emp_id = row.get("employee")
		if emp_id not in employee_ids:
			continue
		stamp = str(row.get("time") or "")
		day, clock = date_only(stamp), _clock(stamp)
		if not day or not clock:
			continue
		emp = next((e for e in employees if e["id"] == emp_id), {})
		log_type = str(row.get("log_type") or "").upper()
		records.append({
			"id": _sid("att_", "%s|%s|%s|%s" % (emp_id, stamp, log_type, row.get("device_id") or "")),
			"empId": emp_id, "employeeId": emp_id, "employeeName": row.get("employee_name") or emp.get("name") or "",
			"employeeNumber": emp.get("employeeNumber") or emp_id,
			"date": day, "punchTime": clock,
			"punchType": 0 if log_type == "IN" else (1 if log_type == "OUT" else None),
			"checkIn": clock if log_type == "IN" else None,
			"checkOut": clock if log_type == "OUT" else None,
			"branchId": emp.get("branchId") or "", "deviceId": row.get("device_id") or "",
			"source": "fingerprint", "createdAt": engine._now(),
		})
	state["attendanceRecords"] = records

	if daily:
		state["settings"]["attendanceStartDate"] = min(d["date"] for d in daily)

	# ── السلف ──
	advances = []
	for row in get_rows("Employee Advance", ["employee", "employee_name", "advance_amount", "paid_amount",
	                                         "claimed_amount", "return_amount", "posting_date", "status",
	                                         "purpose", "name"]):
		emp_id = row.get("employee")
		if emp_id not in employee_ids:
			continue
		total = num(row.get("advance_amount"))
		claimed = num(row.get("claimed_amount")) + num(row.get("return_amount"))
		remaining = round2(max(0, total - claimed))
		advances.append({
			"id": _sid("adv_", row.get("name")), "erpName": row.get("name"),
			"employeeId": emp_id, "employeeName": row.get("employee_name") or "",
			"branchId": (next((e for e in employees if e["id"] == emp_id), {}) or {}).get("branchId") or "",
			"totalAmount": total, "paidAmount": round2(claimed), "remainingAmount": remaining,
			"monthlyDeduction": remaining, "startDate": date_only(row.get("posting_date")) or today_iso(),
			"reason": row.get("purpose") or "سلفة موظف", "status": "closed" if remaining <= 0 else "active",
			"createdAt": engine._now(), "source": "erpnext",
		})
	state["advances"] = advances
	state["advancePayments"] = []
	state["loans"] = []
	state["loanPayments"] = []
	state["salaryPayments"] = []
	state["journalEntries"] = []
	state["incentives"] = []
	state["eosSettlements"] = []
	state["insuranceRecords"] = []
	state["contracts"] = []
	state["employeeDocuments"] = []
	state["absences"] = []
	state["dailyFollowUps"] = []
	state["dailyExtras"] = []
	state["dailyAdvances"] = []
	state["approvalRequests"] = []
	state["attendanceRecords"] = records

	return state


def post_accounting(state):
	"""ترحيل استحقاق كشف الرواتب المستوردة المعتمدة + صرف السلف (بدون تكرار)."""
	created = 0
	currency = (state.get("settings") or {}).get("currency") or ""
	accounting.ensure_default_accounts(state)
	for slip in state.get("payslips") or []:
		if slip.get("status") != "approved":
			continue
		if accounting.has_posting(state, "payslip_accrual", slip.get("id")):
			continue
		try:
			voucher = accounting.post_entry(
				state, "payslip_accrual", slip.get("id"), slip.get("toDate") or today_iso(),
				accounting.payslip_entries(slip),
				description="استحقاق راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
				ref_type="payslips", ref_number="%s/%s" % (slip.get("month"), slip.get("year")),
				user="ERPNext import", branch_id=slip.get("branchId") or "", currency=currency,
			)
			if voucher:
				created += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), "tageephr import: posting %s" % slip.get("id"))
	for advance in state.get("advances") or []:
		if accounting.has_posting(state, "advance_disbursement", advance.get("id")):
			continue
		try:
			voucher = accounting.post_entry(
				state, "advance_disbursement", advance.get("id"), advance.get("startDate") or today_iso(),
				[("advances", num(advance.get("totalAmount")), 0, "سلفة موظف — %s" % advance.get("employeeName")),
				 ("bank", 0, num(advance.get("totalAmount")), "صرف سلفة — %s" % advance.get("employeeName"))],
				description="صرف سلفة %s" % advance.get("employeeName"), ref_type="advances",
				user="ERPNext import", branch_id=advance.get("branchId") or "", currency=currency,
			)
			if voucher:
				created += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), "tageephr import: advance %s" % advance.get("id"))
	return created


def run(post_vouchers=True):
	"""نقطة الدخول: نقل كل بيانات الموارد البشرية من ERP إلى حالة tageephr."""
	state = build_state()
	vouchers = post_accounting(state) if post_vouchers else 0
	state.setdefault("notifications", []).append({
		"id": "note_erp_import_%s" % today_iso(), "type": "system", "severity": "success",
		"title": "تم استيراد بيانات الموارد البشرية",
		"message": "%s موظف، %s فرع، %s قسم، %s كشف راتب، %s سجل حضور" % (
			len(state.get("employees") or []), len(state.get("branches") or []),
			len(state.get("departments") or []), len(state.get("payslips") or []),
			len(state.get("attendanceDaily") or [])),
		"link": "#/dashboard", "read": False, "dismissed": False,
		"createdAt": engine._now(),
	})
	engine.add_audit(state, {"userName": "ERPNext import", "action": "import", "module": "settings",
	                         "collection": "employees", "recordId": "",
	                         "details": "استيراد بيانات الموارد البشرية من ERPNext"})
	# تأمين التسلسل عبر إصدارات ERP المختلفة (تحويل أي تاريخ إلى نص)
	state = json.loads(json.dumps(state, ensure_ascii=False, default=str))
	store.save(state)
	summary = {
		"branches": len(state.get("branches") or []),
		"departments": len(state.get("departments") or []),
		"jobGrades": len(state.get("jobGrades") or []),
		"workShifts": len(state.get("workShifts") or []),
		"holidays": len(state.get("holidays") or []),
		"leaveTypes": len(state.get("leaveTypes") or []),
		"leaveBalances": len(state.get("leaveBalances") or []),
		"employees": len(state.get("employees") or []),
		"attendanceDaily": len(state.get("attendanceDaily") or []),
		"attendanceRecords": len(state.get("attendanceRecords") or []),
		"payslips": len(state.get("payslips") or []),
		"payrollPeriods": len(state.get("payrollPeriods") or []),
		"advances": len(state.get("advances") or []),
		"allowanceTypes": len(state.get("allowanceTypes") or []),
		"employeeAllowances": len(state.get("employeeAllowances") or []),
		"vouchers": vouchers,
	}
	print("TAGEEEPHR_IMPORT", summary)
	return summary
