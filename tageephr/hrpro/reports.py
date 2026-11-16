"""تقارير نظام Tageep HRMS — منقولة من hrpro/src/reports.js."""
from __future__ import annotations

from datetime import datetime

from .engine import LEAVE_STATUS_LABELS, attendance_for, attendance_summary_for_employee
from .utils import date_only, month_range, num, round2, today_iso, working_dates

REPORT_CATALOG = [
	{"id": "daily_attendance", "name": "تقرير الحضور اليومي", "category": "daily", "icon": "calendar", "description": "حضور وانصراف الموظفين في يوم محدد مع التأخير والإضافي"},
	{"id": "monthly_attendance", "name": "ملخص الحضور الشهري", "category": "monthly", "icon": "chart", "description": "أيام الحضور والغياب والتأخير والإجازات لكل موظف خلال الشهر"},
	{"id": "late_report", "name": "تقرير التأخيرات", "category": "monthly", "icon": "clock", "description": "دقائق التأخير والانصراف المبكر مع الخصم المالي المحسوب"},
	{"id": "absence_report", "name": "تقرير الغياب", "category": "monthly", "icon": "user-x", "description": "أيام الغياب بدون إجازة حسب الموظف والقسم"},
	{"id": "missing_punches", "name": "البصمات الناقصة", "category": "fingerprint", "icon": "alert", "description": "السجلات التي تنقصها بصمة دخول أو خروج"},
	{"id": "raw_punches", "name": "سجلات البصمة الخام", "category": "fingerprint", "icon": "fingerprint", "description": "كل بصمة كما وردت من الأجهزة مع مصدرها وجهازها"},
	{"id": "device_status", "name": "حالة أجهزة البصمة", "category": "fingerprint", "icon": "router", "description": "الأجهزة المسجلة وآخر مزامنة وعدد السجلات"},
	{"id": "attendance_compliance", "name": "الالتزام بالدوام", "category": "monthly", "icon": "check", "description": "نسبة الحضور والالتزام لكل موظف"},
	{"id": "overtime_report", "name": "تقرير العمل الإضافي", "category": "monthly", "icon": "plus", "description": "دقائق الإضافي وقيمتها المالية"},
	{"id": "leave_balances", "name": "أرصدة الإجازات", "category": "leaves", "icon": "palmtree", "description": "الأرصدة المستحقة والمستخدمة والمتبقية لكل نوع إجازة"},
	{"id": "leave_requests", "name": "سجل طلبات الإجازات", "category": "leaves", "icon": "list", "description": "الطلبات وحالتها وفترتها وعدد أيامها"},
	{"id": "leave_liability", "name": "التزام الإجازات المالي", "category": "leaves", "icon": "money", "description": "قيمة الأرصدة غير المستخدمة المستحقة ماليًا"},
	{"id": "late_conversions", "name": "تحويل التأخير إلى إجازات", "category": "leaves", "icon": "exchange", "description": "ساعات التأخير التي تم تحويلها إلى إجازات شهريًا"},
	{"id": "payroll_summary", "name": "ملخص الرواتب", "category": "payroll", "icon": "wallet", "description": "إجمالي الرواتب والخصومات والصافي حسب الفترة والفرع"},
	{"id": "payslip_register", "name": "كشف الرواتب التفصيلي", "category": "payroll", "icon": "receipt", "description": "تفصيل كل كشف راتب ببنوده"},
	{"id": "department_report", "name": "تقرير الأقسام", "category": "organization", "icon": "building", "description": "عدد الموظفين وتكلفة الرواتب لكل قسم"},
	{"id": "employee_list", "name": "كشف الموظفين", "category": "organization", "icon": "users", "description": "بيانات الموظفين الكاملة مع الفرع والقسم والراتب"},
	{"id": "contract_expiry", "name": "العقود والمستندات المنتهية", "category": "organization", "icon": "file", "description": "العقود والمستندات القريبة من الانتهاء"},
	{"id": "advances_loans", "name": "السلف والقروض", "category": "payroll", "icon": "credit", "description": "الأرصدة المتبقية والأقساط الشهرية"},
	{"id": "audit_log", "name": "سجل التدقيق", "category": "security", "icon": "shield", "description": "من قام بأي تعديل ومتى ومن أي جهاز"},
	{"id": "tasks_report", "name": "تقرير المهام والإنجاز", "category": "tasks", "icon": "check", "description": "المهام المسندة للموظفين مع نسب الإنجاز والاستحقاق والمتأخرات"},
	{"id": "self_requests", "name": "تقرير طلبات الموظفين", "category": "tasks", "icon": "list", "description": "طلبات السلف والشكاوى والمقترحات المقدمة من الخدمة الذاتية وحالتها"},
]

CATEGORY_LABELS = {
	"daily": "التقارير اليومية", "monthly": "التقارير الشهرية", "fingerprint": "تقارير البصمة",
	"leaves": "تقارير الإجازات", "payroll": "تقارير الرواتب", "organization": "تقارير المؤسسة",
	"security": "تقارير الأمان", "tasks": "تقارير المهام والطلبات",
}

STATUS_LABELS = dict(LEAVE_STATUS_LABELS)
STATUS_LABELS.update({"not_tracked": "غير متابع"})
SOURCE_LABELS = {"system": "النظام", "fingerprint": "بصمة", "correction": "معالجة", "leave": "إجازة", "followup": "تعقيب"}
LEAVE_REQUEST_STATUS = {"pending": "معلّق", "approved": "معتمد", "rejected": "مرفوض", "cancelled": "ملغي"}
TASK_STATUS_LABELS = {"new": "جديدة", "in_progress": "قيد التنفيذ", "on_hold": "معلّقة", "completed": "مكتملة", "cancelled": "ملغاة"}
REQUEST_TYPE_LABELS = {"leave": "طلب إجازة", "advance": "طلب سلفة", "complaint": "شكوى / ملاحظة", "other": "طلب عام"}


def column(key, label, type="text"):
	return {"key": key, "label": label, "type": type}


COLUMNS = {
	"daily_attendance": [column("date", "التاريخ", "date"), column("employeeNumber", "الرقم"), column("employeeName", "الموظف"),
	                     column("branchName", "الفرع"), column("departmentName", "القسم"), column("checkIn", "الحضور"),
	                     column("checkOut", "الانصراف"), column("workedMinutes", "دقائق العمل", "number"),
	                     column("lateMinutes", "التأخير (دقيقة)", "number"), column("earlyMinutes", "انصراف مبكر", "number"),
	                     column("overtimeMinutes", "الإضافي", "number"), column("statusLabel", "الحالة"),
	                     column("sourceLabel", "المصدر"), column("notes", "ملاحظات")],
	"monthly_attendance": [column("employeeNumber", "الرقم"), column("employeeName", "الموظف"), column("branchName", "الفرع"),
	                       column("departmentName", "القسم"), column("workingDays", "أيام العمل", "number"),
	                       column("presentDays", "حضور", "number"), column("absentDays", "غياب", "number"),
	                       column("halfDays", "نصف يوم", "number"), column("paidLeaveDays", "إجازة مدفوعة", "number"),
	                       column("unpaidLeaveDays", "إجازة غير مدفوعة", "number"), column("lateDays", "مرات التأخير", "number"),
	                       column("lateMinutes", "دقائق التأخير", "number"), column("overtimeMinutes", "دقائق الإضافي", "number"),
	                       column("compliance", "نسبة الالتزام %", "number")],
	"late_report": [column("date", "التاريخ", "date"), column("employeeNumber", "الرقم"), column("employeeName", "الموظف"),
	                column("departmentName", "القسم"), column("checkIn", "وقت الحضور"), column("shiftStart", "بداية الدوام"),
	                column("lateMinutes", "دقائق التأخير", "number"), column("earlyMinutes", "انصراف مبكر", "number"),
	                column("lateDeduction", "الخصم المالي", "money"), column("convertedToLeave", "محوّل إلى إجازة")],
	"absence_report": [column("date", "التاريخ", "date"), column("employeeNumber", "الرقم"), column("employeeName", "الموظف"),
	                   column("branchName", "الفرع"), column("departmentName", "القسم"), column("dayPortion", "الأيام", "number"),
	                   column("deduction", "قيمة الخصم", "money"), column("notes", "ملاحظات")],
	"missing_punches": [column("date", "التاريخ", "date"), column("employeeNumber", "الرقم"), column("employeeName", "الموظف"),
	                    column("checkIn", "الحضور"), column("checkOut", "الانصراف"), column("branchName", "الفرع"), column("notes", "الملاحظة")],
	"raw_punches": [column("date", "التاريخ", "date"), column("time", "الوقت"), column("employeeId", "معرّف البصمة"),
	                column("employeeName", "الموظف"), column("punchTypeLabel", "النوع"), column("source", "المصدر"),
	                column("deviceId", "الجهاز / IP"), column("branchName", "الفرع")],
	"device_status": [column("name", "الجهاز"), column("branchName", "الفرع"), column("deviceIp", "IP"),
	                  column("devicePort", "المنفذ"), column("deviceType", "النوع"), column("status", "الحالة"),
	                  column("lastSeen", "آخر اتصال", "datetime"), column("lastSyncAt", "آخر مزامنة", "datetime"),
	                  column("totalRecords", "عدد السجلات", "number")],
	"attendance_compliance": [column("employeeNumber", "الرقم"), column("employeeName", "الموظف"), column("departmentName", "القسم"),
	                          column("workingDays", "أيام العمل", "number"), column("presentDays", "حضور", "number"),
	                          column("absentDays", "غياب", "number"), column("lateDays", "تأخير", "number"),
	                          column("compliance", "نسبة الالتزام %", "number")],
	"overtime_report": [column("date", "التاريخ", "date"), column("employeeName", "الموظف"), column("departmentName", "القسم"),
	                    column("overtimeMinutes", "دقائق الإضافي", "number"), column("statusLabel", "نوع اليوم"),
	                    column("amount", "القيمة التقديرية", "money")],
	"leave_balances": [column("employeeNumber", "الرقم"), column("employeeName", "الموظف"), column("departmentName", "القسم"),
	                   column("leaveType", "نوع الإجازة"), column("entitlement", "الاستحقاق", "number"),
	                   column("accrued", "المستحق المتراكم", "number"), column("carried", "المرحّل", "number"),
	                   column("used", "المستخدم", "number"), column("converted", "محوّل من التأخير", "number"),
	                   column("balance", "الرصيد المتبقي", "number")],
	"leave_requests": [column("employeeNumber", "الرقم"), column("employeeName", "الموظف"), column("leaveType", "نوع الإجازة"),
	                   column("fromDate", "من", "date"), column("toDate", "إلى", "date"), column("days", "الأيام", "number"),
	                   column("statusLabel", "الحالة"), column("approvedBy", "اعتُمد بواسطة"), column("reason", "السبب")],
	"leave_liability": [column("employeeName", "الموظف"), column("leaveType", "نوع الإجازة"),
	                    column("balance", "الرصيد المتبقي", "number"), column("dailyWage", "الأجر اليومي", "money"),
	                    column("liability", "الالتزام المالي", "money")],
	"late_conversions": [column("year", "السنة"), column("monthName", "الشهر"), column("employeeName", "الموظف"),
	                     column("lateMinutes", "دقائق التأخير", "number"), column("convertedMinutes", "الدقائق المحوّلة", "number"),
	                     column("days", "أيام الإجازة", "number"), column("leaveTypeName", "نوع الإجازة")],
	"payroll_summary": [column("period", "الفترة"), column("branchName", "الفرع"), column("employeeNumber", "الرقم"),
	                    column("employeeName", "الموظف"), column("grossSalary", "الإجمالي", "money"),
	                    column("totalDeductionsAll", "الخصومات", "money"), column("netSalary", "الصافي", "money"),
	                    column("statusLabel", "الحالة")],
	"payslip_register": [column("month", "الشهر"), column("year", "السنة"), column("employeeNumber", "الرقم"),
	                     column("employeeName", "الموظف"), column("baseSalary", "الراتب الأساسي", "money"),
	                     column("totalAllowances", "البدلات", "money"), column("overtimeAmount", "الإضافي", "money"),
	                     column("absenceDeduction", "خصم الغياب", "money"), column("lateDeduction", "خصم التأخير", "money"),
	                     column("gosiEmployeeShare", "التأمينات", "money"), column("netSalary", "الصافي", "money")],
	"department_report": [column("departmentName", "القسم"), column("branchName", "الفرع"),
	                      column("employees", "عدد الموظفين", "number"), column("totalSalaries", "إجمالي الرواتب", "money"),
	                      column("averageSalary", "متوسط الراتب", "money")],
	"employee_list": [column("employeeNumber", "الرقم"), column("employeeName", "الموظف"), column("branchName", "الفرع"),
	                  column("departmentName", "القسم"), column("jobTitle", "المسمى الوظيفي"),
	                  column("joinDate", "تاريخ التعيين", "date"), column("baseSalary", "الراتب الأساسي", "money"),
	                  column("statusLabel", "الحالة"), column("phone", "الهاتف")],
	"contract_expiry": [column("type", "النوع"), column("employeeName", "الموظف"), column("title", "العنوان"),
	                    column("endDate", "تاريخ الانتهاء", "date"), column("daysLeft", "الأيام المتبقية", "number")],
	"advances_loans": [column("kind", "النوع"), column("employeeName", "الموظف"), column("totalAmount", "الإجمالي", "money"),
	                   column("remainingAmount", "المتبقي", "money"), column("monthly", "القسط الشهري", "money"),
	                   column("statusLabel", "الحالة")],
	"audit_log": [column("at", "التاريخ", "datetime"), column("userName", "المستخدم"), column("action", "الإجراء"),
	              column("module", "الوحدة"), column("details", "التفاصيل"), column("ip", "IP")],
	"tasks_report": [column("title", "المهمة"), column("employeeName", "الموظف"), column("assignedTo", "المسند إليه"),
	                 column("dueDate", "تاريخ الاستحقاق", "date"), column("progress", "الإنجاز %", "number"),
	                 column("statusLabel", "الحالة"), column("overdue", "متأخرة")],
	"self_requests": [column("createdAt", "التاريخ", "datetime"), column("employeeName", "الموظف"), column("typeLabel", "النوع"),
	                  column("subject", "الموضوع"), column("amount", "المبلغ", "money"), column("statusLabel", "الحالة")],
}

PS_STATUS = {"draft": "مسودّة", "approved": "معتمد", "paid": "مدفوع"}
EMP_STATUS = {"active": "على رأس العمل", "terminated": "منتهي الخدمة", "on_leave": "إجازة"}
MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]


def _filters(filters, default_days=30):
	frm = date_only((filters or {}).get("from") or (filters or {}).get("fromDate"))
	to = date_only((filters or {}).get("to") or (filters or {}).get("toDate"))
	if not frm or not to:
		now = datetime.now()
		range_ = month_range(now.year, now.month)
		frm, to = frm or range_["from"], to or range_["to"]
	return frm, to


def run_report(state, report_id, filters=None, columns=None):
	filters = filters or {}
	frm, to = _filters(filters)
	employees = {e.get("id"): e for e in state.get("employees") or []}
	branches = {b.get("id"): b for b in state.get("branches") or []}
	departments = {d.get("id"): d for d in state.get("departments") or []}
	leave_types = {t.get("id"): t for t in state.get("leaveTypes") or []}

	def emp_name(emp_id):
		emp = employees.get(emp_id) or {}
		return emp.get("name") or ""

	rows = []
	branch_id = (filters.get("branchId") or "").strip()
	department_id = (filters.get("departmentId") or "").strip()
	employee_id = (filters.get("employeeId") or "").strip()

	def keep(emp_id):
		emp = employees.get(emp_id) or {}
		if branch_id and emp.get("branchId") != branch_id:
			return False
		if department_id and emp.get("departmentId") != department_id:
			return False
		if employee_id and emp_id != employee_id:
			return False
		return True

	if report_id in ("daily_attendance", "late_report", "absence_report", "missing_punches", "overtime_report"):
		status_filter = {"daily_attendance": None, "late_report": "late", "absence_report": "absent",
		                 "missing_punches": "missing_punch", "overtime_report": None}[report_id]
		for r in attendance_for(state, frm, to, {"status": status_filter}):
			if not keep(r.get("empId")):
				continue
			emp = employees.get(r.get("empId")) or {}
			branch = branches.get(r.get("branchId")) or {}
			dept = departments.get(r.get("departmentId")) or {}
			base = {
				"date": r.get("date"), "employeeNumber": r.get("employeeNumber") or emp.get("employeeNumber") or "",
				"employeeName": r.get("employeeName") or emp.get("name") or "",
				"branchName": branch.get("name") or "", "departmentName": dept.get("name") or "",
				"checkIn": r.get("checkIn") or "", "checkOut": r.get("checkOut") or "",
				"statusLabel": STATUS_LABELS.get(r.get("status"), r.get("status") or ""),
				"sourceLabel": SOURCE_LABELS.get(r.get("source"), r.get("source") or ""),
				"notes": r.get("notes") or "",
			}
			if report_id == "daily_attendance":
				base.update({"workedMinutes": round2(r.get("workedMinutes")), "lateMinutes": round2(r.get("lateMinutes")),
				             "earlyMinutes": round2(r.get("earlyMinutes")), "overtimeMinutes": round2(r.get("overtimeMinutes"))})
				rows.append(base)
			elif report_id == "late_report":
				wage = num(emp.get("baseSalary"))
				minute_rate = wage / 30.0 / 480.0
				base.update({"shiftStart": "", "lateMinutes": round2(r.get("lateMinutes")),
				             "earlyMinutes": round2(r.get("earlyMinutes")),
				             "lateDeduction": round2((num(r.get("lateMinutes")) + num(r.get("earlyMinutes"))) * minute_rate),
				             "convertedToLeave": "نعم" if r.get("convertedToLeave") else "لا"})
				rows.append(base)
			elif report_id == "absence_report":
				wage = num(emp.get("baseSalary"))
				base.update({"dayPortion": num(r.get("dayPortion"), 1) or 1,
				             "deduction": round2(num(r.get("dayPortion"), 1) * (wage / 30.0))})
				rows.append(base)
			elif report_id == "missing_punches":
				if r.get("status") == "missing_punch":
					rows.append(base)
			else:
				if num(r.get("overtimeMinutes")) > 0:
					hourly = num(emp.get("baseSalary")) / 30.0 / 8.0
					base.update({"overtimeMinutes": round2(r.get("overtimeMinutes")),
					             "statusLabel": STATUS_LABELS.get(r.get("status"), r.get("status") or ""),
					             "amount": round2(num(r.get("overtimeMinutes")) / 60.0 * hourly * 1.5)})
					rows.append(base)

	elif report_id in ("monthly_attendance", "attendance_compliance"):
		for emp_id, emp in employees.items():
			if not keep(emp_id) or emp.get("status") == "terminated":
				continue
			summary = attendance_summary_for_employee(state, emp_id, frm, to)
			if not summary["workingDays"]:
				continue
			compliance = round2(summary["presentDays"] / float(summary["workingDays"]) * 100) if summary["workingDays"] else 0
			rows.append({
				"employeeNumber": emp.get("employeeNumber") or "", "employeeName": emp.get("name") or "",
				"branchName": (branches.get(emp.get("branchId")) or {}).get("name") or "",
				"departmentName": (departments.get(emp.get("departmentId")) or {}).get("name") or "",
				"workingDays": summary["workingDays"], "presentDays": summary["presentDays"],
				"absentDays": summary["absentDays"], "halfDays": summary["halfDays"],
				"paidLeaveDays": round2(summary["paidLeaveDays"]), "unpaidLeaveDays": round2(summary["unpaidLeaveDays"]),
				"lateDays": summary["lateDays"], "lateMinutes": round2(summary["lateMinutes"]),
				"overtimeMinutes": round2(summary["overtimeMinutes"]), "compliance": compliance,
			})

	elif report_id == "raw_punches":
		for rec in state.get("attendanceRecords") or []:
			day = date_only(rec.get("date") or rec.get("checkIn") or rec.get("punchTime"))
			if not day or day < frm or day > to:
				continue
			if not keep(rec.get("empId")):
				continue
			rows.append({
				"date": day, "time": rec.get("punchTime") or rec.get("checkIn") or rec.get("checkOut") or "",
				"employeeId": rec.get("empId") or "", "employeeName": rec.get("employeeName") or emp_name(rec.get("empId")),
				"punchTypeLabel": "دخول" if rec.get("checkIn") else "خروج" if rec.get("checkOut") else "",
				"source": rec.get("source") or "", "deviceId": rec.get("deviceId") or "",
				"branchName": (branches.get(rec.get("branchId")) or {}).get("name") or "",
			})

	elif report_id == "device_status":
		for device in state.get("fingerprintDevices") or []:
			rows.append({
				"name": device.get("name") or "", "branchName": (branches.get(device.get("branchId")) or {}).get("name") or "",
				"deviceIp": device.get("deviceIp") or "", "devicePort": device.get("port") or device.get("devicePort") or "",
				"deviceType": device.get("type") or "", "status": device.get("status") or "",
				"lastSeen": device.get("lastSeen") or "", "lastSyncAt": device.get("lastSyncAt") or "",
				"totalRecords": num(device.get("totalRecords")),
			})

	elif report_id == "leave_balances":
		year = int(num(filters.get("year")) or datetime.now().year)
		for bal in state.get("leaveBalances") or []:
			if num(bal.get("year")) != year or not keep(bal.get("employeeId")):
				continue
			emp = employees.get(bal.get("employeeId")) or {}
			rows.append({
				"employeeNumber": emp.get("employeeNumber") or "", "employeeName": emp.get("name") or "",
				"departmentName": (departments.get(emp.get("departmentId")) or {}).get("name") or "",
				"leaveType": (leave_types.get(bal.get("leaveTypeId")) or {}).get("name") or "",
				"entitlement": round2(bal.get("entitlement")), "accrued": round2(bal.get("accrued")),
				"carried": round2(bal.get("carried")), "used": round2(bal.get("used")),
				"converted": round2(bal.get("converted")), "balance": round2(bal.get("balance")),
			})

	elif report_id == "leave_requests":
		for req in state.get("leaveRequests") or []:
			day = date_only(req.get("fromDate"))
			if day and (day < frm or day > to):
				continue
			if not keep(req.get("employeeId")):
				continue
			emp = employees.get(req.get("employeeId")) or {}
			rows.append({
				"employeeNumber": emp.get("employeeNumber") or "", "employeeName": req.get("employeeName") or emp.get("name") or "",
				"leaveType": (leave_types.get(req.get("leaveTypeId")) or {}).get("name") or "",
				"fromDate": req.get("fromDate"), "toDate": req.get("toDate"), "days": round2(req.get("days")),
				"statusLabel": LEAVE_REQUEST_STATUS.get(req.get("status"), req.get("status") or ""),
				"approvedBy": req.get("approvedBy") or "", "reason": req.get("reason") or "",
			})

	elif report_id == "leave_liability":
		for bal in state.get("leaveBalances") or []:
			if num(bal.get("balance")) <= 0 or not keep(bal.get("employeeId")):
				continue
			emp = employees.get(bal.get("employeeId")) or {}
			wage = num(emp.get("baseSalary"))
			rows.append({
				"employeeName": emp.get("name") or "", "leaveType": (leave_types.get(bal.get("leaveTypeId")) or {}).get("name") or "",
				"balance": round2(bal.get("balance")), "dailyWage": round2(wage / 30.0),
				"liability": round2(num(bal.get("balance")) * wage / 30.0),
			})

	elif report_id == "late_conversions":
		for conv in state.get("lateConversions") or []:
			if not keep(conv.get("empId")):
				continue
			rows.append({
				"year": conv.get("year"), "monthName": MONTHS_AR[(num(conv.get("month"), 1) - 1) % 12],
				"employeeName": conv.get("employeeName") or emp_name(conv.get("empId")),
				"lateMinutes": round2(conv.get("lateMinutes")), "convertedMinutes": round2(conv.get("convertedMinutes")),
				"days": round2(conv.get("days")), "leaveTypeName": conv.get("leaveTypeName") or "",
			})

	elif report_id in ("payroll_summary", "payslip_register"):
		month = int(num(filters.get("month"))) if filters.get("month") else None
		year = int(num(filters.get("year"))) if filters.get("year") else None
		for slip in state.get("payslips") or []:
			if month and num(slip.get("month")) != month:
				continue
			if year and num(slip.get("year")) != year:
				continue
			if not keep(slip.get("employeeId")):
				continue
			base = {
				"period": "%s/%s" % (slip.get("month"), slip.get("year")),
				"branchName": (branches.get(slip.get("branchId")) or {}).get("name") or "",
				"employeeNumber": slip.get("employeeNumber") or "", "employeeName": slip.get("employeeName") or "",
				"grossSalary": round2(slip.get("grossSalary")), "totalDeductionsAll": round2(slip.get("totalDeductionsAll")),
				"netSalary": round2(slip.get("netSalary")), "statusLabel": PS_STATUS.get(slip.get("status"), slip.get("status") or ""),
			}
			if report_id == "payslip_register":
				base.update({
					"month": slip.get("month"), "year": slip.get("year"),
					"baseSalary": round2(slip.get("baseSalary")), "totalAllowances": round2(slip.get("totalAllowances")),
					"overtimeAmount": round2(slip.get("overtimeAmount")), "absenceDeduction": round2(slip.get("absenceDeduction")),
					"lateDeduction": round2(slip.get("lateDeduction")), "gosiEmployeeShare": round2(slip.get("gosiEmployeeShare")),
				})
			rows.append(base)

	elif report_id == "department_report":
		agg = {}
		for emp_id, emp in employees.items():
			if emp.get("status") == "terminated":
				continue
			key = emp.get("departmentId") or ""
			item = agg.setdefault(key, {"employees": 0, "total": 0.0,
			                            "departmentName": (departments.get(key) or {}).get("name") or "بدون قسم",
			                            "branchName": (branches.get(emp.get("branchId")) or {}).get("name") or ""})
			item["employees"] += 1
			item["total"] += num(emp.get("baseSalary"))
		for item in agg.values():
			rows.append({"departmentName": item["departmentName"], "branchName": item["branchName"],
			             "employees": item["employees"], "totalSalaries": round2(item["total"]),
			             "averageSalary": round2(item["total"] / item["employees"]) if item["employees"] else 0})

	elif report_id == "employee_list":
		for emp_id, emp in employees.items():
			if not keep(emp_id):
				continue
			rows.append({
				"employeeNumber": emp.get("employeeNumber") or "", "employeeName": emp.get("name") or "",
				"branchName": (branches.get(emp.get("branchId")) or {}).get("name") or "",
				"departmentName": (departments.get(emp.get("departmentId")) or {}).get("name") or "",
				"jobTitle": emp.get("jobTitle") or "", "joinDate": emp.get("joinDate") or "",
				"baseSalary": round2(emp.get("baseSalary")), "statusLabel": EMP_STATUS.get(emp.get("status"), emp.get("status") or ""),
				"phone": emp.get("phone") or "",
			})

	elif report_id == "contract_expiry":
		today = today_iso()
		for contract in state.get("contracts") or []:
			if not contract.get("endDate"):
				continue
			left = (datetime.strptime(date_only(contract["endDate"]), "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
			if left > 90:
				continue
			rows.append({"type": "عقد", "employeeName": emp_name(contract.get("employeeId")),
			             "title": contract.get("contractType") or "عقد عمل", "endDate": contract.get("endDate"), "daysLeft": left})
		for doc in state.get("employeeDocuments") or []:
			if not doc.get("expiryDate"):
				continue
			left = (datetime.strptime(date_only(doc["expiryDate"]), "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
			if left > 90:
				continue
			rows.append({"type": "مستند", "employeeName": emp_name(doc.get("employeeId")),
			             "title": doc.get("name") or "", "endDate": doc.get("expiryDate"), "daysLeft": left})

	elif report_id == "advances_loans":
		for adv in state.get("advances") or []:
			rows.append({"kind": "سلفة", "employeeName": adv.get("employeeName") or emp_name(adv.get("employeeId")),
			             "totalAmount": round2(adv.get("totalAmount")), "remainingAmount": round2(adv.get("remainingAmount")),
			             "monthly": round2(adv.get("monthlyDeduction")), "statusLabel": adv.get("status") or ""})
		for loan in state.get("loans") or []:
			rows.append({"kind": "قرض", "employeeName": emp_name(loan.get("employeeId")),
			             "totalAmount": round2(loan.get("totalAmount")), "remainingAmount": round2(loan.get("remainingAmount")),
			             "monthly": round2(loan.get("monthlyPayment")), "statusLabel": loan.get("status") or ""})

	elif report_id == "audit_log":
		for entry in reversed(state.get("auditLog") or []):
			if entry.get("at", "") < frm:
				continue
			rows.append({"at": entry.get("at"), "userName": entry.get("userName"), "action": entry.get("action"),
			             "module": entry.get("module"), "details": entry.get("details"), "ip": entry.get("ip")})

	elif report_id == "tasks_report":
		today = today_iso()
		for task in state.get("tasks") or []:
			if not keep(task.get("employeeId")):
				continue
			overdue = bool(task.get("dueDate")) and date_only(task["dueDate"]) < today and task.get("status") not in ("completed", "cancelled")
			rows.append({"title": task.get("title") or "", "employeeName": task.get("employeeName") or "",
			             "assignedTo": task.get("assignedTo") or "", "dueDate": task.get("dueDate") or "",
			             "progress": round2(task.get("progress")), "statusLabel": TASK_STATUS_LABELS.get(task.get("status"), task.get("status") or ""),
			             "overdue": "نعم" if overdue else "لا"})

	elif report_id == "self_requests":
		for req in state.get("selfRequests") or []:
			rows.append({"createdAt": req.get("createdAt"), "employeeName": req.get("employeeName") or "",
			             "typeLabel": REQUEST_TYPE_LABELS.get(req.get("type"), req.get("type") or ""),
			             "subject": req.get("subject") or "", "amount": round2(req.get("amount")),
			             "statusLabel": LEAVE_REQUEST_STATUS.get(req.get("status"), req.get("status") or "")})

	report_columns = COLUMNS.get(report_id, [])
	if columns and isinstance(columns, list) and columns:
		wanted = [c for c in columns if isinstance(c, str)]
		if wanted:
			report_columns = [c for c in report_columns if c["key"] in wanted]
	catalog = next((r for r in REPORT_CATALOG if r["id"] == report_id), {})
	return {
		"id": report_id, "title": catalog.get("name", report_id), "category": catalog.get("category", ""),
		"columns": report_columns, "rows": rows, "from": frm, "to": to, "count": len(rows),
		"generatedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
	}
