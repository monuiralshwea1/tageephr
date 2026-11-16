"""محرك الموارد البشرية — منقول من hrpro/src/hr-engine.js."""
from __future__ import annotations

import time
from datetime import datetime

from .utils import (
	add_days, date_only, days_between, each_date, is_workday, js_day_of_week, month_range,
	num, parse_time_to_minutes, round2, today_iso, uid, working_dates,
)

LEAVE_STATUS_LABELS = {
	"present": "حاضر", "late": "متأخر", "half_day": "نصف يوم", "absent": "غائب",
	"leave": "إجازة", "holiday": "عطلة رسمية", "weekend": "عطلة أسبوعية",
	"missing_punch": "بصمة ناقصة", "remote": "عمل عن بعد", "future": "لم يحن بعد",
}

CORRECTION_TYPES = ["present", "late", "half_day", "absent", "leave", "remote"]


def _now() -> str:
	return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ───────────────────────── أدوات مساعدة ─────────────────────────
def find_employee(state, emp_id):
	for emp in state.get("employees") or []:
		if emp.get("id") == emp_id or emp.get("employeeNumber") == emp_id or emp.get("username") == emp_id:
			return emp
	return None


def find_shift(state, employee):
	if not employee or not employee.get("shiftId"):
		return None
	for shift in state.get("workShifts") or []:
		if shift.get("id") == employee["shiftId"]:
			return shift
	return None


def shift_info(shift):
	if not shift or not isinstance(shift.get("periods"), list) or not shift["periods"]:
		return None
	periods = []
	for p in shift["periods"]:
		start = parse_time_to_minutes(p.get("startTime"))
		end = parse_time_to_minutes(p.get("endTime"))
		if start is None or end is None:
			continue
		periods.append({
			"start": start,
			"end": end + 1440 if end <= start else end,
			"name": p.get("name") or "",
			"graceMinutes": None if p.get("graceMinutes") in (None, "") else num(p.get("graceMinutes")),
			"earlyGraceMinutes": None if p.get("earlyGraceMinutes") in (None, "") else num(p.get("earlyGraceMinutes")),
			"absenceAfterMinutes": None if p.get("absenceAfterMinutes") in (None, "") else num(p.get("absenceAfterMinutes")),
		})
	if not periods:
		return None
	periods.sort(key=lambda x: x["start"])
	return {
		"start": min(p["start"] for p in periods),
		"end": max(p["end"] for p in periods),
		"required": sum(p["end"] - p["start"] for p in periods),
		"periods": periods,
		"first": periods[0],
		"last": periods[-1],
	}


def holiday_set(state):
	return {date_only(h.get("date") if isinstance(h, dict) else h) for h in (state.get("holidays") or [])}


def settings_grace(state):
	s = state.get("settings") or {}
	ps = state.get("payrollSettings") or {}
	return {
		"grace": num(s.get("gracePeriodMinutes"), 15),
		"earlyGrace": num(s.get("earlyDepartureGraceMinutes"), 15),
		"lateAbsence": num(s.get("lateAbsenceMinutes"), 0),
		"workMinutes": num(ps.get("workMinutesPerDay"), 480),
		"overtimeMin": num(ps.get("overtimeMinMinutes"), 15),
		"overtimeEarly": bool(ps.get("overtimeCountEarlyArrival")),
		"overtimeLate": True if ps.get("overtimeCountLateDeparture") is None else bool(ps.get("overtimeCountLateDeparture")),
	}


def collect_punch_times(record):
	times = []

	def push(value):
		minutes = parse_time_to_minutes(value)
		if minutes is not None:
			times.append(int(round(minutes)))

	if record.get("punchTime"):
		push(record["punchTime"])
	if record.get("checkIn"):
		push(record["checkIn"])
	if record.get("checkOut"):
		push(record["checkOut"])
	for p in record.get("punches") or []:
		push(p.get("time") if isinstance(p, dict) else p)
	return times


def records_by_employee_date(state, frm, to):
	mapping = {}
	for rec in state.get("attendanceRecords") or []:
		emp_id = rec.get("empId") or rec.get("employeeId")
		if not emp_id:
			continue
		day = date_only(rec.get("date")) or date_only(rec.get("checkIn") or rec.get("punchTime") or rec.get("createdAt"))
		if not day or day < frm or day > to:
			continue
		mapping.setdefault("%s|%s" % (emp_id, day), []).append(rec)
	return mapping


def approved_leave_for_date(state, emp_id, day):
	for req in state.get("leaveRequests") or []:
		if req.get("employeeId") != emp_id or req.get("status") != "approved":
			continue
		start = date_only(req.get("fromDate"))
		end = date_only(req.get("toDate") or req.get("fromDate"))
		if start and start <= day <= end:
			return req
	return None


def approved_correction_for_date(state, emp_id, day):
	for c in state.get("attendanceCorrections") or []:
		if c.get("empId") != emp_id or date_only(c.get("date")) != day:
			continue
		if c.get("approvalStatus"):
			if c["approvalStatus"] == "approved":
				return c
			continue
		if c.get("status") in ("approved", "applied"):
			return c
	return None


def correction_type(correction):
	for key in ("type", "correctionType", "status"):
		value = correction.get(key)
		if value in CORRECTION_TYPES:
			return value
	return "present"


def follow_up_for_date(state, emp_id, day):
	for f in state.get("dailyFollowUps") or []:
		if f.get("empId") == emp_id and date_only(f.get("date") or f.get("day")) == day:
			return f
	return None


def map_follow_up_status(follow_up, state):
	if not follow_up:
		return None
	status = str(follow_up.get("statusType") or follow_up.get("status") or "").lower()
	if "absent" in status or "غياب" in status:
		return {"status": "absent", "source": "followup"}
	if "annual" in status or "سنوي" in status:
		annual = next((t for t in state.get("leaveTypes") or [] if t.get("name") and "سنوي" in t["name"]), None)
		return {"status": "leave", "leaveTypeId": annual["id"] if annual else "", "source": "followup"}
	if "occasion" in status or "مناسب" in status:
		return {"status": "holiday", "source": "followup"}
	if "leave" in status or "إجاز" in status:
		return {"status": "leave", "leaveTypeId": follow_up.get("leaveTypeId") or "", "source": "followup"}
	return {"status": "present", "source": "followup"}


def leave_type_map(state):
	return {t.get("id"): t for t in state.get("leaveTypes") or []}


def _hhmm(minutes, wrap=False):
	value = int(minutes)
	hours = (value // 60) % 24 if wrap else value // 60
	return "%02d:%02d" % (hours, value % 60)


# ───────────────────────── محرك الحضور ─────────────────────────
def compute_day(state, employee, day, punch_records, options=None):
	options = options or {}
	g = settings_grace(state)
	holidays = options.get("holidaySet") or holiday_set(state)
	info = shift_info(find_shift(state, employee))
	grace_min = info["first"]["graceMinutes"] if info and info["first"]["graceMinutes"] is not None else g["grace"]
	early_grace = info["last"]["earlyGraceMinutes"] if info and info["last"]["earlyGraceMinutes"] is not None else g["earlyGrace"]
	absence_after = g["lateAbsence"]
	if info and info["first"]["absenceAfterMinutes"] and info["first"]["absenceAfterMinutes"] > 0:
		absence_after = info["first"]["absenceAfterMinutes"]

	correction = approved_correction_for_date(state, employee["id"], day)
	leave_request = approved_leave_for_date(state, employee["id"], day)

	punch_set = set()
	for rec in punch_records or []:
		punch_set.update(collect_punch_times(rec))
	punches = sorted(punch_set)
	check_in = punches[0] if punches else None
	check_out = punches[-1] if len(punches) > 1 else None
	if punch_records and len(punch_records) == 1 and punch_records[0].get("checkIn") and punch_records[0].get("checkOut"):
		a = parse_time_to_minutes(punch_records[0]["checkIn"])
		b = parse_time_to_minutes(punch_records[0]["checkOut"])
		check_in = int(round(a)) if a is not None else check_in
		check_out = int(round(b)) if b is not None else check_out

	is_weekend = not is_workday(day, state.get("settings") or {})
	is_holiday = day in holidays

	base = {
		"id": "ad_%s_%s" % (employee["id"], day),
		"empId": employee["id"], "employeeId": employee["id"],
		"employeeName": employee.get("name") or "",
		"employeeNumber": employee.get("employeeNumber") or "",
		"branchId": employee.get("branchId") or "",
		"departmentId": employee.get("departmentId") or "",
		"date": day, "shiftId": employee.get("shiftId") or "",
		"checkIn": _hhmm(check_in) if check_in is not None else "",
		"checkOut": _hhmm(check_out, wrap=True) if check_out is not None else "",
		"workedMinutes": 0, "lateMinutes": 0, "earlyMinutes": 0, "overtimeMinutes": 0,
		"status": "absent", "leaveTypeId": "", "dayPortion": 1, "paid": True,
		"source": "system", "correctionId": "", "notes": "", "processedAt": _now(),
	}

	if leave_request:
		types = leave_type_map(state)
		leave_type = types.get(leave_request.get("leaveTypeId")) or {}
		return {**base, "status": "leave", "leaveTypeId": leave_request.get("leaveTypeId") or "",
		        "dayPortion": num(leave_request.get("dayPortion"), 1) or 1,
		        "paid": leave_type.get("isPaid") is not False,
		        "leaveRequestId": leave_request.get("id"), "source": "leave",
		        "notes": leave_type.get("name") or ""}

	if correction:
		c_in = parse_time_to_minutes(correction["checkIn"]) if correction.get("checkIn") else check_in
		c_out = parse_time_to_minutes(correction["checkOut"]) if correction.get("checkOut") else check_out
		status = correction_type(correction)
		late_minutes = early_minutes = worked = 0
		if c_in is not None and c_out is not None:
			worked = max(0, c_out - c_in)
			if info and c_in > info["start"] + grace_min and not correction.get("excuseLate"):
				late_minutes = int(round(c_in - info["start"] - grace_min))
			if info and c_out < info["end"] - early_grace and not correction.get("excuseEarly"):
				early_minutes = int(round(info["end"] - early_grace - c_out))
		if status == "present" and (correction.get("excuseLate") or correction.get("treatAsPresent")):
			late_minutes = 0
		if status == "present" and late_minutes > 0:
			status = "late"

		result = {**base, "source": "correction", "correctionId": correction.get("id") or "",
		          "notes": correction.get("reason") or "", "workedMinutes": worked,
		          "lateMinutes": late_minutes, "earlyMinutes": early_minutes,
		          "checkIn": _hhmm(c_in) if c_in is not None else "",
		          "checkOut": _hhmm(c_out, wrap=True) if c_out is not None else ""}

		if status == "half_day":
			result.update({"status": "half_day", "overtimeMinutes": 0,
			               "dayPortion": num(correction.get("dayPortion"), 0.5) or 0.5})
			return result
		if status == "leave":
			leave_type = leave_type_map(state).get(correction.get("leaveTypeId")) or {}
			result.update({"status": "leave", "leaveTypeId": correction.get("leaveTypeId") or "",
			               "dayPortion": num(correction.get("dayPortion"), 1) or 1,
			               "paid": leave_type.get("isPaid") is not False})
			return result
		if status == "absent":
			result.update({"status": "absent", "paid": False,
			               "leaveTypeId": correction.get("leaveTypeId") or ""})
			return result
		result.update({"status": status, "dayPortion": 1})
		return result

	if is_weekend or is_holiday:
		if check_in is not None and check_out is not None:
			worked = max(0, check_out - check_in)
			return {**base, "status": "holiday" if is_holiday else "weekend",
			        "workedMinutes": worked,
			        "overtimeMinutes": worked if worked >= g["overtimeMin"] else 0,
			        "source": "fingerprint", "notes": "عمل في عطلة"}
		return {**base, "status": "holiday" if is_holiday else "weekend"}

	follow_up = follow_up_for_date(state, employee["id"], day)
	mapped = map_follow_up_status(follow_up, state)
	if check_in is None and check_out is None and mapped:
		leave_type = leave_type_map(state).get(mapped.get("leaveTypeId")) or {}
		return {**base, "status": mapped["status"], "leaveTypeId": mapped.get("leaveTypeId") or "",
		        "paid": (leave_type.get("isPaid") is not False) if mapped["status"] == "leave" else mapped["status"] != "absent",
		        "dayPortion": num((follow_up or {}).get("value"), 1) or 1,
		        "source": "followup", "notes": (follow_up or {}).get("notes") or ""}

	if check_in is None:
		tracking_start = date_only((state.get("settings") or {}).get("attendanceStartDate"))
		if day > today_iso():
			return {**base, "status": "future"}
		if tracking_start and day < tracking_start:
			return {**base, "status": "not_tracked"}
		return {**base, "status": "absent", "paid": False}

	if check_out is None:
		return {**base, "status": "missing_punch", "source": "fingerprint", "notes": "لا توجد بصمة انصراف"}

	worked = max(0, check_out - check_in)
	if info and len(info["periods"]) > 1:
		break_minutes = 0
		for i in range(1, len(info["periods"])):
			break_minutes += max(0, info["periods"][i]["start"] - info["periods"][i - 1]["end"])
		worked = max(0, worked - break_minutes)

	late_minutes = early_minutes = 0
	if info:
		if check_in > info["start"] + grace_min:
			late_minutes = int(round(check_in - info["start"] - grace_min))
		if check_out < info["end"] - early_grace:
			early_minutes = int(round(info["end"] - early_grace - check_out))

	overtime_minutes = 0
	if num((state.get("payrollSettings") or {}).get("overtimeEnabled"), 1):
		extra = 0
		if info:
			if g["overtimeEarly"]:
				extra += max(0, info["start"] - check_in)
			if g["overtimeLate"]:
				extra += max(0, check_out - info["end"])
		else:
			extra = worked - g["workMinutes"]
		if extra >= g["overtimeMin"]:
			overtime_minutes = int(round(extra))

	if absence_after > 0 and late_minutes >= absence_after:
		return {**base, "status": "absent", "workedMinutes": worked, "lateMinutes": late_minutes,
		        "earlyMinutes": early_minutes, "overtimeMinutes": overtime_minutes, "paid": False,
		        "source": "fingerprint",
		        "notes": "تجاوز حد الغياب (%s دقيقة تأخير)" % int(absence_after)}

	status = "present"
	if info and worked < info["required"] * 0.5:
		status = "half_day"
	if late_minutes > 0:
		status = "late"
	return {**base, "status": status, "workedMinutes": worked, "lateMinutes": late_minutes,
	        "earlyMinutes": early_minutes, "overtimeMinutes": overtime_minutes,
	        "dayPortion": 0.5 if status == "half_day" else 1, "paid": True,
	        "source": "fingerprint"}


def process_attendance(state, options=None):
	options = options or {}
	frm = date_only(options.get("from")) or month_range(datetime.now().year, datetime.now().month)["from"]
	to = date_only(options.get("to")) or today_iso()
	employee_ids = options.get("employeeIds") or []
	employees = []
	for emp in state.get("employees") or []:
		if employee_ids:
			if emp.get("id") not in employee_ids:
				continue
		elif options.get("employeeId") and emp.get("id") != options["employeeId"]:
			continue
		if options.get("branchId") and emp.get("branchId") != options["branchId"]:
			continue
		if options.get("departmentId") and emp.get("departmentId") != options["departmentId"]:
			continue
		if emp.get("status") == "terminated" and emp.get("terminationDate") and date_only(emp["terminationDate"]) < frm:
			continue
		employees.append(emp)

	punch_map = records_by_employee_date(state, frm, to)
	holidays = holiday_set(state)
	existing = {"%s|%s" % (d.get("empId"), d.get("date")): d for d in state.get("attendanceDaily") or []}
	records = []
	for emp in employees:
		start = date_only(emp.get("joinDate")) if emp.get("joinDate") and date_only(emp["joinDate"]) > frm else frm
		end = date_only(emp.get("terminationDate")) if emp.get("terminationDate") and date_only(emp["terminationDate"]) < to else to
		for day in each_date(start, end):
			punches = punch_map.get("%s|%s" % (emp["id"], day), [])
			row = compute_day(state, emp, day, punches, {"holidaySet": holidays})
			prev = existing.get("%s|%s" % (emp["id"], day))
			records.append(prev if prev and prev.get("locked") else row)

	new_keys = {"%s|%s" % (r.get("empId"), r.get("date")) for r in records}
	kept = [r for r in state.get("attendanceDaily") or [] if "%s|%s" % (r.get("empId"), r.get("date")) not in new_keys]
	state["attendanceDaily"] = kept + records

	def count(status):
		return len([r for r in records if r.get("status") == status])

	return {
		"from": frm, "to": to, "employees": len(employees), "days": len(records),
		"present": len([r for r in records if r.get("status") in ("present", "late")]),
		"late": count("late"), "absent": count("absent"), "leave": count("leave"),
		"missingPunch": count("missing_punch"),
		"overtimeMinutes": sum(num(r.get("overtimeMinutes")) for r in records),
		"lateMinutes": sum(num(r.get("lateMinutes")) for r in records),
	}


def attendance_for(state, frm, to, filters=None):
	filters = filters or {}
	from_d, to_d = date_only(frm), date_only(to)
	rows = []
	for r in state.get("attendanceDaily") or []:
		if r.get("date", "") < from_d or r.get("date", "") > to_d:
			continue
		if filters.get("employeeId") and r.get("empId") != filters["employeeId"]:
			continue
		if filters.get("branchId") and r.get("branchId") != filters["branchId"]:
			continue
		if filters.get("departmentId") and r.get("departmentId") != filters["departmentId"]:
			continue
		if filters.get("status") and r.get("status") != filters["status"]:
			continue
		rows.append(r)
	return rows


SUMMARY_KEYS = ("totalDays", "presentDays", "lateDays", "absentDays", "leaveDays", "unpaidLeaveDays",
                "halfDays", "missingPunchDays", "lateMinutes", "earlyMinutes", "overtimeMinutes",
                "workingDays", "paidLeaveDays", "convertedLateMinutes", "holidayOrWeekend")


def attendance_summary_for_employee(state, employee_id, frm, to):
	rows = attendance_for(state, frm, to, {"employeeId": employee_id})
	summary = {k: 0 for k in SUMMARY_KEYS}
	types = leave_type_map(state)
	for r in rows:
		status = r.get("status")
		if status in ("weekend", "holiday", "future", "not_tracked"):
			if status in ("weekend", "holiday"):
				summary["holidayOrWeekend"] += 1
				summary["overtimeMinutes"] += num(r.get("overtimeMinutes"))
			continue
		summary["workingDays"] += 1
		portion = num(r.get("dayPortion"), 1) or 1
		if status == "present":
			summary["presentDays"] += 1
		elif status == "late":
			summary["presentDays"] += 1
			summary["lateDays"] += 1
		elif status == "missing_punch":
			summary["presentDays"] += 1
			summary["missingPunchDays"] += 1
		elif status == "half_day":
			summary["halfDays"] += 1
		elif status == "absent":
			summary["absentDays"] += 1
		elif status == "leave":
			summary["leaveDays"] += portion
			leave_type = types.get(r.get("leaveTypeId")) or {}
			if leave_type.get("isPaid") is False:
				summary["unpaidLeaveDays"] += portion
			else:
				summary["paidLeaveDays"] += portion
		summary["lateMinutes"] += num(r.get("lateMinutes"))
		summary["earlyMinutes"] += num(r.get("earlyMinutes"))
		summary["overtimeMinutes"] += num(r.get("overtimeMinutes"))
		if r.get("convertedToLeave"):
			summary["convertedLateMinutes"] += num(r.get("lateMinutes")) + num(r.get("earlyMinutes"))
	return summary


# ───────────────────────── الإجازات والأرصدة ─────────────────────────
def leave_year(value):
	text = date_only(value) or today_iso()
	return int(text[:4])


def ensure_balance(state, employee_id, leave_type_id, year):
	balances = state.setdefault("leaveBalances", [])
	for rec in balances:
		if rec.get("employeeId") == employee_id and rec.get("leaveTypeId") == leave_type_id and num(rec.get("year")) == num(year):
			rec["balance"] = round2(num(rec.get("entitlement")) + num(rec.get("accrued")) + num(rec.get("carried")) + num(rec.get("adjusted")) - num(rec.get("used")) - num(rec.get("converted")))
			return rec
	leave_type = next((t for t in state.get("leaveTypes") or [] if t.get("id") == leave_type_id), {})
	rec = {
		"id": uid("lb_"), "employeeId": employee_id, "leaveTypeId": leave_type_id, "year": year,
		"entitlement": num(leave_type.get("daysPerYear"), 0), "accrued": 0, "used": 0,
		"converted": 0, "adjusted": 0, "carried": 0,
		"balance": num(leave_type.get("daysPerYear"), 0), "updatedAt": _now(),
	}
	balances.append(rec)
	return rec


def add_leave_ledger(state, entry):
	state.setdefault("leaveLedger", [])
	rec = {"id": uid("ll_"), "createdAt": _now(), **entry}
	state["leaveLedger"].append(rec)
	return rec


def available_leave(state, employee_id, leave_type_id, day):
	return ensure_balance(state, employee_id, leave_type_id, leave_year(day))["balance"]


def count_leave_days(state, frm, to, leave_type):
	policy = state.get("leavePolicy") or {}
	holidays = list(holiday_set(state))
	dates = each_date(frm, to)
	if leave_type and leave_type.get("countWeekends"):
		return len(dates)
	if policy.get("workingDaysOnly") is False:
		return len(dates)
	return len(working_dates(frm, to, holidays, state.get("settings") or {}))


def approve_leave_request(state, request_id, approver=None):
	approver = approver or {}
	request = next((r for r in state.get("leaveRequests") or [] if r.get("id") == request_id), None)
	if not request:
		raise ValueError("طلب الإجازة غير موجود")
	if request.get("status") == "approved":
		raise ValueError("الطلب معتمد بالفعل")
	leave_type = next((t for t in state.get("leaveTypes") or [] if t.get("id") == request.get("leaveTypeId")), None)
	if not leave_type:
		raise ValueError("نوع الإجازة غير موجود")
	policy = state.get("leavePolicy") or {}
	available = available_leave(state, request["employeeId"], request["leaveTypeId"], request.get("fromDate"))
	days = num(request.get("days"), 0) or count_leave_days(state, request.get("fromDate"), request.get("toDate"), leave_type)
	allow_negative = policy.get("allowNegativeBalance") is True or leave_type.get("allowNegative") is True
	if num(leave_type.get("daysPerYear")) > 0 and not allow_negative and days > available + 0.0001:
		raise ValueError("الرصيد المتاح %s يوم فقط، والمطلوب %s يوم" % (round2(available), round2(days)))

	year = leave_year(request.get("fromDate"))
	balance = ensure_balance(state, request["employeeId"], request["leaveTypeId"], year)
	balance["used"] = round2(num(balance.get("used")) + days)
	balance["balance"] = round2(num(balance.get("balance")) - days)
	balance["updatedAt"] = _now()

	request.update({
		"status": "approved",
		"approvedBy": approver.get("name") or approver.get("id") or "النظام",
		"approvedById": approver.get("id") or "",
		"approvedAt": _now(),
		"days": days,
	})
	add_leave_ledger(state, {
		"employeeId": request["employeeId"], "leaveTypeId": request["leaveTypeId"], "year": year,
		"date": date_only(request.get("fromDate")), "type": "used", "days": -days,
		"reference": request["id"],
		"notes": "اعتماد إجازة من %s إلى %s" % (request.get("fromDate"), request.get("toDate")),
	})

	holidays = holiday_set(state)
	portion = num(request.get("dayPortion"), 1) or 1
	for day in each_date(request.get("fromDate"), request.get("toDate")):
		if policy.get("workingDaysOnly") is not False and (not is_workday(day, state.get("settings") or {}) or day in holidays):
			continue
		existing = next((d for d in state.get("attendanceDaily") or [] if d.get("empId") == request["employeeId"] and d.get("date") == day), None)
		employee = find_employee(state, request["employeeId"]) or {}
		rec = {
			"id": existing["id"] if existing else "ad_%s_%s" % (request["employeeId"], day),
			"empId": request["employeeId"], "employeeId": request["employeeId"],
			"employeeName": employee.get("name") or "", "employeeNumber": employee.get("employeeNumber") or "",
			"branchId": employee.get("branchId") or "", "departmentId": employee.get("departmentId") or "",
			"date": day, "shiftId": employee.get("shiftId") or "",
			"checkIn": "", "checkOut": "", "workedMinutes": 0, "lateMinutes": 0,
			"earlyMinutes": 0, "overtimeMinutes": 0, "status": "leave",
			"leaveTypeId": request["leaveTypeId"], "leaveRequestId": request["id"],
			"dayPortion": portion, "paid": leave_type.get("isPaid") is not False,
			"source": "leave", "correctionId": "", "locked": True,
			"notes": leave_type.get("name") or "", "processedAt": _now(),
		}
		if existing:
			existing.update(rec)
		else:
			state.setdefault("attendanceDaily", []).append(rec)
	return request


def cancel_leave_request(state, request_id, user=None):
	user = user or {}
	request = next((r for r in state.get("leaveRequests") or [] if r.get("id") == request_id), None)
	if not request:
		raise ValueError("طلب الإجازة غير موجود")
	was_approved = request.get("status") == "approved"
	request.update({"status": "cancelled", "cancelledBy": user.get("name") or user.get("id") or "", "cancelledAt": _now()})
	if was_approved:
		days = num(request.get("days"), 0)
		balance = ensure_balance(state, request["employeeId"], request["leaveTypeId"], leave_year(request.get("fromDate")))
		balance["used"] = round2(max(0, num(balance.get("used")) - days))
		balance["balance"] = round2(num(balance.get("balance")) + days)
		add_leave_ledger(state, {
			"employeeId": request["employeeId"], "leaveTypeId": request["leaveTypeId"],
			"year": leave_year(request.get("fromDate")), "date": today_iso(), "type": "cancel",
			"days": days, "reference": request["id"], "notes": "إلغاء إجازة معتمدة",
		})
		state["attendanceDaily"] = [d for d in state.get("attendanceDaily") or [] if d.get("leaveRequestId") != request["id"]]
	return request


def run_leave_accrual(state, year, month):
	results = []
	policy = state.get("leavePolicy") or {}
	for employee in [e for e in state.get("employees") or [] if e.get("status") != "terminated"]:
		for leave_type in state.get("leaveTypes") or []:
			mode = leave_type.get("accrual") or ("monthly" if policy.get("accrualMode") == "monthly" else "annual")
			if mode not in ("monthly", "annual") or num(leave_type.get("daysPerYear")) <= 0:
				continue
			balance = ensure_balance(state, employee["id"], leave_type["id"], year)
			if mode == "monthly":
				per_month = num(leave_type.get("daysPerYear")) / 12.0
				key = "accrual:%s:%s" % (year, month)
			else:
				per_month = num(leave_type.get("daysPerYear"))
				key = "annual:%s" % year
			exists = any(l.get("employeeId") == employee["id"] and l.get("leaveTypeId") == leave_type["id"] and l.get("key") == key
			             for l in state.get("leaveLedger") or [])
			if exists:
				continue
			if mode == "monthly":
				balance["accrued"] = round2(num(balance.get("accrued")) + per_month)
				balance["balance"] = round2(num(balance.get("balance")) + per_month)
				ledger_type, ledger_date = "accrual", "%04d-%02d-01" % (year, month)
				notes = "استحقاق شهر %s/%s" % (month, year)
			else:
				balance["adjusted"] = round2(num(balance.get("adjusted")) + per_month)
				balance["balance"] = round2(num(balance.get("balance")) + per_month)
				ledger_type, ledger_date = "entitlement", "%04d-01-01" % year
				notes = "استحقاق سنوي %s" % year
			balance["updatedAt"] = _now()
			add_leave_ledger(state, {
				"employeeId": employee["id"], "leaveTypeId": leave_type["id"], "year": year,
				"date": ledger_date, "type": ledger_type, "days": round2(per_month), "key": key, "notes": notes,
			})
			results.append({"employeeId": employee["id"], "leaveTypeId": leave_type["id"], "days": round2(per_month)})
	return {"entries": len(results), "details": results}


def carry_over_leaves(state, from_year, to_year):
	policy = state.get("leavePolicy") or {}
	if policy.get("carryOverEnabled") is False:
		return {"carried": 0}
	count = 0
	for leave_type in state.get("leaveTypes") or []:
		if leave_type.get("isCarryOver") is False:
			continue
		max_carry = num(leave_type.get("maxCarryOver"), num(policy.get("maxCarryOverDays"), 0))
		for employee in [e for e in state.get("employees") or [] if e.get("status") != "terminated"]:
			prev = ensure_balance(state, employee["id"], leave_type["id"], from_year)
			carry = max(0, min(num(prev.get("balance")), max_carry))
			if carry <= 0:
				continue
			nxt = ensure_balance(state, employee["id"], leave_type["id"], to_year)
			nxt["carried"] = round2(carry)
			nxt["balance"] = round2(num(nxt.get("entitlement")) + num(nxt.get("accrued")) + carry + num(nxt.get("adjusted")) - num(nxt.get("used")) - num(nxt.get("converted")))
			add_leave_ledger(state, {
				"employeeId": employee["id"], "leaveTypeId": leave_type["id"], "year": to_year,
				"date": "%04d-01-01" % to_year, "type": "carry", "days": round2(carry),
				"key": "carry:%s:%s" % (from_year, to_year), "notes": "ترحيل رصيد من %s" % from_year,
			})
			count += 1
	return {"carried": count}


def run_late_conversion(state, options=None):
	options = options or {}
	now = datetime.now()
	year = int(options.get("year") or now.year)
	month = int(options.get("month") or now.month)
	range_ = month_range(year, month)
	policy = state.get("leavePolicy") or {}
	conv = policy.get("lateConversion") or {}
	ps = state.get("payrollSettings") or {}
	if conv.get("enabled") is False:
		return {"skipped": True, "message": "تحويل التأخير إلى إجازات غير مفعّل في الإعدادات", "conversions": []}

	process_attendance(state, {"from": range_["from"], "to": range_["to"]})

	threshold = num(conv.get("thresholdMinutes"), 120)
	max_hours = num(conv.get("maxHoursPerMonth"), 0)
	work_minutes = num(ps.get("workMinutesPerDay"), 480)
	count_early = bool(conv.get("countEarlyDeparture"))
	conversions = []
	leave_types = state.get("leaveTypes") or []
	default_type = conv.get("leaveTypeId")
	if not default_type:
		candidate = next((t for t in leave_types if t.get("id") == "lt_annual"), None) \
			or next((t for t in leave_types if t.get("name") and "سنوي" in t["name"]), None) \
			or next((t for t in leave_types if t.get("isPaid")), None) \
			or (leave_types[0] if leave_types else {})
		default_type = candidate.get("id", "") if candidate else ""

	for prev in [c for c in state.get("lateConversions") or [] if num(c.get("year")) == year and num(c.get("month")) == month]:
		balance = ensure_balance(state, prev.get("empId") or prev.get("employeeId"), prev.get("leaveTypeId"), year)
		balance["converted"] = round2(max(0, num(balance.get("converted")) - num(prev.get("days"))))
		balance["balance"] = round2(num(balance.get("balance")) + num(prev.get("days")))
		state["leaveLedger"] = [l for l in state.get("leaveLedger") or [] if l.get("conversionId") != prev.get("id")]
		for d in state.get("attendanceDaily") or []:
			if d.get("convertedConversionId") == prev.get("id"):
				d.update({"convertedToLeave": False, "convertedConversionId": "", "convertedDays": 0})
	state["lateConversions"] = [c for c in state.get("lateConversions") or []
	                            if not (num(c.get("year")) == year and num(c.get("month")) == month)]

	def day_minutes(row):
		return num(row.get("lateMinutes")) + (num(row.get("earlyMinutes")) if count_early else 0)

	min_daily = num(conv.get("minDailyLateMinutes"), 0)
	for emp in [e for e in state.get("employees") or [] if e.get("status") != "terminated"]:
		rows = [d for d in state.get("attendanceDaily") or [] if d.get("empId") == emp["id"] and d.get("date", "") >= range_["from"] and d.get("date", "") <= range_["to"]]
		eligible = [d for d in rows if not d.get("convertedToLeave") and day_minutes(d) > 0 and day_minutes(d) >= min_daily]
		late_minutes = sum(day_minutes(d) for d in eligible)
		if late_minutes < threshold:
			continue
		convertible = late_minutes if conv.get("mode") == "all" else late_minutes - threshold
		if max_hours > 0:
			convertible = min(convertible, max_hours * 60)
		convertible = int(convertible)
		if convertible <= 0:
			continue
		days = round2(convertible / work_minutes)
		if days <= 0:
			continue
		leave_type_id = (emp.get("lateConversionLeaveTypeId") if conv.get("employeeOverride") is not False else "") or default_type
		leave_type = next((t for t in leave_types if t.get("id") == leave_type_id), {})
		balance = ensure_balance(state, emp["id"], leave_type_id, year)
		record = {
			"id": uid("lc_"), "empId": emp["id"], "employeeId": emp["id"],
			"employeeName": emp.get("name") or "", "year": year, "month": month,
			"lateMinutes": late_minutes, "convertedMinutes": convertible, "days": days,
			"leaveTypeId": leave_type_id, "leaveTypeName": leave_type.get("name") or "",
			"thresholdMinutes": threshold, "mode": conv.get("mode"),
			"skipMoneyDeduction": conv.get("skipMoneyDeduction") is not False,
			"createdAt": _now(), "createdBy": options.get("userName") or "النظام",
		}
		state.setdefault("lateConversions", []).append(record)
		balance["converted"] = round2(num(balance.get("converted")) + days)
		balance["balance"] = round2(num(balance.get("balance")) - days)
		balance["updatedAt"] = _now()
		add_leave_ledger(state, {
			"employeeId": emp["id"], "leaveTypeId": leave_type_id, "year": year, "date": range_["to"],
			"type": "late_conversion", "days": -days, "conversionId": record["id"],
			"notes": "تحويل %s دقيقة تأخير إلى %s يوم إجازة (%s/%s)" % (convertible, days, month, year),
		})
		remaining = convertible
		for d in eligible:
			mins = day_minutes(d)
			if mins > 0 and remaining > 0:
				d["convertedToLeave"] = True
				d["convertedConversionId"] = record["id"]
				remaining -= mins
		conversions.append(record)
	return {"year": year, "month": month, "thresholdMinutes": threshold, "conversions": conversions}


# ───────────────────────── محرك الرواتب ─────────────────────────
def active_allowances(state, employee_id, day):
	return [a for a in state.get("employeeAllowances") or []
	        if a.get("employeeId") == employee_id and a.get("status") != "inactive"
	        and (not a.get("effectiveDate") or date_only(a["effectiveDate"]) <= day)
	        and (not a.get("endDate") or date_only(a["endDate"]) >= day)]


def active_deductions(state, employee_id, day):
	return [d for d in state.get("employeeDeductions") or []
	        if d.get("employeeId") == employee_id and d.get("status") != "inactive"
	        and (not d.get("effectiveDate") or date_only(d["effectiveDate"]) <= day)
	        and (not d.get("endDate") or date_only(d["endDate"]) >= day)]


def _component_amount(state, row, base_salary, type_key, collection):
	type_row = next((t for t in state.get(collection) or [] if t.get("id") == row.get(type_key)), {})
	calc = row.get("calculationType") or type_row.get("calculationType") or "fixed"
	value = num(row.get("amount")) if row.get("amount") not in (None, "") else num(type_row.get("value"))
	if calc in ("percentage", "percent"):
		return round2(base_salary * value / 100.0)
	return round2(value)


def allowance_amount(state, row, base_salary):
	return _component_amount(state, row, base_salary, "allowanceTypeId", "allowanceTypes")


def deduction_amount(state, row, base_salary):
	return _component_amount(state, row, base_salary, "deductionTypeId", "deductionTypes")


def tax_for(state, gross):
	ps = state.get("payrollSettings") or {}
	if not ps.get("taxEnabled"):
		return 0
	exempt = num(ps.get("taxExemptLimit"), 0)
	taxable = max(0, gross - exempt)
	brackets = ps.get("taxBrackets") or []
	if ps.get("taxMode") == "brackets" and brackets:
		tax = 0.0
		last = 0.0
		for bracket in brackets:
			up_to = num(bracket.get("upTo"), 0)
			rate = num(bracket.get("rate"), 0) / 100.0
			amount = max(0, min(taxable, up_to) - last) if up_to > 0 else max(0, taxable - last)
			tax += amount * rate
			last = up_to if up_to > 0 else last
			if up_to > 0 and taxable <= up_to:
				break
		return round2(tax)
	rate = ps.get("taxRate")
	if rate is None:
		rate = (state.get("settings") or {}).get("taxRate", 0)
	return round2(taxable * num(rate) / 100.0)


def employee_in_period(employee, period):
	if employee.get("status") == "terminated" and (not employee.get("terminationDate") or date_only(employee["terminationDate"]) < period["fromDate"]):
		return False
	if employee.get("joinDate") and date_only(employee["joinDate"]) > period["toDate"]:
		return False
	if employee.get("payrollExcluded") is True:
		return False
	return True


def compute_employee_payslip(state, employee, period):
	ps = state.get("payrollSettings") or {}
	settings = state.get("settings") or {}
	holidays = list(holiday_set(state))
	work_days = len(working_dates(period["fromDate"], period["toDate"], holidays, settings))
	base_salary = num(employee.get("baseSalary"))
	daily_wage = base_salary / work_days if ps.get("dailyWageBasis") == "working_days" and work_days > 0 else base_salary / 30.0
	work_minutes = num(ps.get("workMinutesPerDay"), 480)
	minute_rate = daily_wage / work_minutes if work_minutes else 0
	hourly_rate = daily_wage / (work_minutes / 60.0) if work_minutes else 0

	eligible_days = work_days
	if employee.get("joinDate") and date_only(employee["joinDate"]) > period["fromDate"]:
		eligible_days = len(working_dates(employee["joinDate"], period["toDate"], holidays, settings))
	if employee.get("terminationDate") and date_only(employee["terminationDate"]) < period["toDate"]:
		start = employee["joinDate"] if employee.get("joinDate") and date_only(employee["joinDate"]) > period["fromDate"] else period["fromDate"]
		eligible_days = len(working_dates(start, employee["terminationDate"], holidays, settings))
	proration = max(0.0, min(1.0, eligible_days / float(work_days))) if work_days else 1.0
	basic_earning = round2(base_salary * proration)

	att = attendance_summary_for_employee(state, employee["id"], period["fromDate"], period["toDate"])
	absent_days = att["absentDays"]
	half_days = att["halfDays"]
	unpaid_leave_days = att["unpaidLeaveDays"]
	skip_converted = ps.get("skipLateDeductionForConvertedLeave") is not False
	late_minutes = max(0, att["lateMinutes"] - num(att["convertedLateMinutes"])) if skip_converted else att["lateMinutes"]
	early_minutes = max(0, att["earlyMinutes"] - num(att["convertedLateMinutes"])) if skip_converted else att["earlyMinutes"]
	overtime_minutes = att["overtimeMinutes"]

	allowances = []
	total_allowances = 0.0
	insurance_allowances = 0.0
	for row in active_allowances(state, employee["id"], period["toDate"]):
		type_row = next((t for t in state.get("allowanceTypes") or [] if t.get("id") == row.get("allowanceTypeId")), {})
		amount = allowance_amount(state, row, base_salary)
		if not amount:
			continue
		allowances.append({"id": row.get("id"), "name": type_row.get("name") or row.get("name") or "بدل",
		                   "amount": amount, "insuranceBased": type_row.get("isInsuranceBased") is True,
		                   "taxable": type_row.get("isTaxable") is not False})
		total_allowances += amount
		if type_row.get("isInsuranceBased") is True:
			insurance_allowances += amount

	total_allowances = round2(total_allowances)
	incentives_total = 0.0
	incentives_list = []
	for inc in state.get("incentives") or []:
		if inc.get("employeeId") != employee["id"] or inc.get("status") != "approved" or inc.get("paidInPayslip"):
			continue
		inc_month = num(inc.get("month")) or (int(str(inc.get("date"))[5:7]) if inc.get("date") else 0)
		inc_year = num(inc.get("year")) or (int(str(inc.get("date"))[:4]) if inc.get("date") else 0)
		if (inc_month and inc_month != num(period["month"])) or (inc_year and inc_year != num(period["year"])):
			continue
		incentives_total += num(inc.get("amount"))
		incentives_list.append(inc)
	incentives_total = round2(incentives_total)

	overtime_amount = 0.0
	if ps.get("overtimeEnabled") is not False and overtime_minutes > 0 and not (ps.get("overtimeRequiresApproval") and employee.get("overtimeApproved") is not True):
		overtime_amount = round2((overtime_minutes / 60.0) * hourly_rate * num(ps.get("overtimeMultiplier"), 1.5))

	items = employee.get("__items") or []
	manual_additions = sum(num(i.get("amount")) for i in items if i.get("type") == "earning")
	manual_deductions = sum(num(i.get("amount")) for i in items if i.get("type") != "earning")

	absence_deduction = round2(absent_days * daily_wage * num(ps.get("absenceDeductionDays"), num(settings.get("absentDeductionDays"), 1)))
	unpaid_leave_deduction = round2(unpaid_leave_days * daily_wage) if ps.get("unpaidLeaveDeduction") is not False else 0
	half_day_deduction = round2(half_days * daily_wage * num(ps.get("halfDayDeductionFactor"), 0.5))
	late_deduction = 0.0
	if ps.get("lateDeductionMode") != "none" and late_minutes >= num(ps.get("lateDeductionMinimumMinutes"), 1):
		multiplier = num(ps.get("lateDeductionMultiplier"), 1)
		if ps.get("lateDeductionMode") == "per_hour_block":
			late_deduction = round2(__import__("math").ceil(late_minutes / 60.0) * hourly_rate * multiplier)
		else:
			late_deduction = round2(late_minutes * minute_rate * multiplier)
	early_deduction = round2(early_minutes * minute_rate * num(ps.get("lateDeductionMultiplier"), 1)) if ps.get("earlyDeductionEnabled") is not False else 0

	gosi_base = num(employee.get("gosiBase")) if num(employee.get("gosiBase")) > 0 else base_salary
	if num(employee.get("gosiBase")) > 0:
		gosi_base += total_allowances if ps.get("gosiBaseIncludesAllowances") else 0
	elif ps.get("gosiBaseIncludesAllowances"):
		gosi_base += insurance_allowances + total_allowances
	cap = num(settings.get("socialInsuranceSalaryCap"), 45000)
	floor = num(settings.get("socialInsuranceSalaryFloor"), 0)
	if cap > 0:
		gosi_base = min(gosi_base, cap)
	if floor > 0:
		gosi_base = max(gosi_base, floor)
	gosi_enabled = ps.get("gosiEnabled") is not False and employee.get("insuranceEligible") is not False
	gosi_employee = round2(gosi_base * num(settings.get("gosiEmployeeRate"), 11) / 100.0) if gosi_enabled else 0
	gosi_employer = round2(gosi_base * num(settings.get("gosiEmployerRate"), 11.75) / 100.0) if gosi_enabled else 0
	tax = tax_for(state, basic_earning + total_allowances + incentives_total + overtime_amount + manual_additions)

	advance_deduction = 0.0
	advance_ids = []
	for adv in state.get("advances") or []:
		if adv.get("employeeId") != employee["id"] or adv.get("status") in ("closed", "paid"):
			continue
		remaining = num(adv.get("remainingAmount"), num(adv.get("totalAmount")) - num(adv.get("paidAmount")))
		if remaining <= 0:
			continue
		if adv.get("startDate") and date_only(adv["startDate"]) > period["toDate"]:
			continue
		amount = min(remaining, num(adv.get("monthlyDeduction"), num(adv.get("totalAmount"))))
		if amount > 0:
			advance_deduction += amount
			advance_ids.append({"id": adv["id"], "amount": amount})
	advance_deduction = round2(advance_deduction)

	loan_deduction = 0.0
	loan_ids = []
	for loan in state.get("loans") or []:
		if loan.get("employeeId") != employee["id"] or loan.get("status") in ("closed", "paid"):
			continue
		remaining = num(loan.get("remainingAmount"), num(loan.get("totalAmount")) - num(loan.get("paidAmount")))
		if remaining <= 0:
			continue
		requested = num(loan.get("monthlyPayment"), 0)
		amount = min(remaining, requested) if ps.get("loanRespectRemaining") is not False else requested
		if amount > 0:
			loan_deduction += amount
			loan_ids.append({"id": loan["id"], "amount": amount})
	loan_deduction = round2(loan_deduction)

	other_list = []
	other_deductions = 0.0
	for row in active_deductions(state, employee["id"], period["toDate"]):
		type_row = next((t for t in state.get("deductionTypes") or [] if t.get("id") == row.get("deductionTypeId")), {})
		amount = deduction_amount(state, row, base_salary)
		if not amount:
			continue
		other_list.append({"id": row.get("id"), "name": type_row.get("name") or row.get("name") or "خصم", "amount": amount})
		other_deductions += amount
	other_deductions = round2(other_deductions)

	gross = round2(basic_earning + total_allowances + incentives_total + overtime_amount + manual_additions)
	total_deductions = round2(absence_deduction + unpaid_leave_deduction + half_day_deduction + late_deduction + early_deduction
	                          + gosi_employee + tax + advance_deduction + loan_deduction + other_deductions + manual_deductions)
	cap_percent = num(ps.get("maxDeductionPercentOfGross"), 0)
	if cap_percent > 0 and gross > 0 and total_deductions > gross * cap_percent / 100.0:
		total_deductions = round2(gross * cap_percent / 100.0)

	return {
		"employeeId": employee["id"], "employeeName": employee.get("name") or "",
		"employeeNumber": employee.get("employeeNumber") or "",
		"branchId": employee.get("branchId") or "", "departmentId": employee.get("departmentId") or "",
		"periodId": period["id"], "month": period["month"], "year": period["year"],
		"fromDate": period["fromDate"], "toDate": period["toDate"],
		"baseSalary": base_salary, "dailyWage": round2(daily_wage), "totalWorkingDays": work_days,
		"eligibleDays": eligible_days,
		"actualWorkDays": round2(att["presentDays"] + att["halfDays"] * 0.5 + att["paidLeaveDays"]),
		"presentDays": att["presentDays"], "absentDays": absent_days, "halfDays": half_days,
		"leaveDays": att["leaveDays"], "paidLeaveDays": att["paidLeaveDays"], "unpaidLeaveDays": unpaid_leave_days,
		"lateMinutes": late_minutes, "earlyMinutes": early_minutes, "overtimeMinutes": overtime_minutes,
		"missingPunchDays": att["missingPunchDays"], "basicEarning": basic_earning,
		"allowances": allowances, "totalAllowances": total_allowances,
		"incentivesTotal": incentives_total,
		"incentives": [{"id": i["id"], "type": i.get("type"), "amount": num(i.get("amount"))} for i in incentives_list],
		"overtimeAmount": overtime_amount, "manualAdditions": round2(manual_additions),
		"grossSalary": gross, "gosiBase": round2(gosi_base), "gosiEmployeeShare": gosi_employee,
		"gosiEmployerShare": gosi_employer, "tax": tax, "absenceDeduction": absence_deduction,
		"unpaidLeaveDeduction": unpaid_leave_deduction, "halfDayDeduction": half_day_deduction,
		"lateDeduction": late_deduction, "earlyDeduction": early_deduction,
		"advanceDeduction": advance_deduction, "advanceIds": advance_ids,
		"loanDeduction": loan_deduction, "loanIds": loan_ids,
		"otherDeductions": other_deductions, "otherDeductionsList": other_list,
		"manualDeductions": round2(manual_deductions),
		"totalDeductionsAll": total_deductions, "netSalary": round2(gross - total_deductions),
		"items": items, "status": "draft", "notes": "", "createdAt": _now(),
	}


def compute_payroll(state, period, options=None):
	options = options or {}
	process_attendance(state, {"from": period["fromDate"], "to": period["toDate"]})
	employees = [e for e in state.get("employees") or [] if employee_in_period(e, period)]
	if options.get("employeeIds"):
		employees = [e for e in employees if e["id"] in options["employeeIds"]]
	if options.get("branchId"):
		employees = [e for e in employees if e.get("branchId") == options["branchId"]]
	if options.get("departmentId"):
		employees = [e for e in employees if e.get("departmentId") == options["departmentId"]]
	existing = {p.get("employeeId"): p for p in state.get("payslips") or [] if p.get("periodId") == period["id"]}
	slips = []
	for emp in employees:
		prev = existing.get(emp["id"])
		emp_items = dict(emp)
		if prev and isinstance(prev.get("items"), list):
			emp_items["__items"] = [i for i in prev["items"] if i.get("manual") is not False]
		slip = compute_employee_payslip(state, emp_items, period)
		if prev:
			slip["id"] = prev.get("id")
			slip["status"] = prev.get("status") or "draft"
			slip["notes"] = prev.get("notes") or ""
			slip["createdAt"] = prev.get("createdAt") or slip["createdAt"]
		slips.append(slip)
	return slips


def apply_payroll_deductions(state, payslips, user=None):
	for slip in payslips:
		for adv in slip.get("advanceIds") or []:
			record = next((a for a in state.get("advances") or [] if a.get("id") == adv["id"]), None)
			if not record:
				continue
			record["remainingAmount"] = round2(max(0, num(record.get("remainingAmount"), num(record.get("totalAmount"))) - adv["amount"]))
			if record["remainingAmount"] <= 0:
				record["status"] = "closed"
			state.setdefault("advancePayments", []).append({
				"id": uid("ap_"), "advanceId": adv["id"], "employeeId": slip["employeeId"],
				"amount": adv["amount"], "month": slip["month"], "year": slip["year"],
				"date": today_iso(),
				"notes": "خصم من كشف راتب %s/%s" % (slip["month"], slip["year"]),
				"payslipId": slip.get("id"), "createdAt": _now(),
			})
		for ln in slip.get("loanIds") or []:
			record = next((l for l in state.get("loans") or [] if l.get("id") == ln["id"]), None)
			if not record:
				continue
			record["remainingAmount"] = round2(max(0, num(record.get("remainingAmount"), num(record.get("totalAmount"))) - ln["amount"]))
			record["paidPayments"] = num(record.get("paidPayments")) + 1
			if record["remainingAmount"] <= 0:
				record["status"] = "closed"
			state.setdefault("loanPayments", []).append({
				"id": uid("lp_"), "loanId": ln["id"], "employeeId": slip["employeeId"],
				"amount": ln["amount"], "dueDate": today_iso(), "paidDate": today_iso(),
				"month": slip["month"], "year": slip["year"], "status": "paid",
				"notes": "خصم من كشف راتب %s/%s" % (slip["month"], slip["year"]),
				"payslipId": slip.get("id"), "createdAt": _now(),
			})
		for inc_ref in slip.get("incentives") or []:
			inc = next((i for i in state.get("incentives") or [] if i.get("id") == inc_ref.get("id")), None)
			if inc:
				inc["paidInPayslip"] = True
				inc["payslipId"] = slip.get("id")
	return {"ok": True}


def eos_settlement(state, employee_id, end_date):
	emp = find_employee(state, employee_id)
	if not emp:
		raise ValueError("الموظف غير موجود")
	start = date_only(emp.get("joinDate") or emp.get("contractStartDate") or end_date)
	end = date_only(end_date) or today_iso()
	if not start or start > end:
		raise ValueError("تاريخ بداية الخدمة غير صحيح")
	total_days = days_between(start, end)
	years = total_days / 365.25
	wage = num(emp.get("baseSalary"))
	first_five = min(years, 5)
	after_five = max(0, years - 5)
	gratuity = round2((first_five * 0.5 * wage) + (after_five * wage))
	unused_leave = sum(max(0, num(b.get("balance"))) for b in state.get("leaveBalances") or []
	                   if b.get("employeeId") == employee_id and num(b.get("year")) == leave_year(end))
	leave_pay = round2(unused_leave * (wage / 30.0))
	return {
		"employeeId": employee_id, "employeeName": emp.get("name"), "startDate": start, "endDate": end,
		"serviceYears": round2(years), "totalDays": total_days, "lastSalary": wage,
		"gratuity": gratuity, "unusedLeaveDays": round2(unused_leave), "leavePay": leave_pay,
		"total": round2(gratuity + leave_pay),
		"breakdown": {"firstFiveYears": round2(first_five * 0.5 * wage), "afterFiveYears": round2(after_five * wage)},
	}


# ───────────────────────── سجل التدقيق والإشعارات ─────────────────────────
def add_audit(state, entry):
	state.setdefault("auditLog", []).append({
		"id": uid("au_"), "at": _now(),
		"userId": entry.get("userId") or "", "userName": entry.get("userName") or "النظام",
		"action": entry.get("action") or "", "module": entry.get("module") or "",
		"collection": entry.get("collection") or "", "recordId": entry.get("recordId") or "",
		"details": entry.get("details") or "", "ip": entry.get("ip") or "",
	})
	if len(state["auditLog"]) > 20000:
		state["auditLog"] = state["auditLog"][-15000:]


def notify(state, payload):
	state.setdefault("notifications", [])
	key = payload.get("key") or ""
	if key:
		for existing in state["notifications"]:
			if existing.get("key") == key and not existing.get("dismissed"):
				return existing
	rec = {"id": uid("nt_"), "createdAt": _now(), "read": False, "dismissed": False, "severity": "info", **payload, "key": key}
	state["notifications"].append(rec)
	if len(state["notifications"]) > 3000:
		state["notifications"] = state["notifications"][-2000:]
	return rec


def _diff_days(a, b):
	try:
		from datetime import date as _date

		return (datetime.strptime(date_only(a), "%Y-%m-%d").date() - datetime.strptime(date_only(b), "%Y-%m-%d").date()).days
	except Exception:
		return 0


def _employee_name(state, emp_id):
	emp = next((e for e in state.get("employees") or [] if e.get("id") == emp_id), None)
	return emp.get("name") if emp else "موظف"


def scan_notifications(state, user=None):
	settings = state.get("settings") or {}
	cfg = settings.get("notifications") or {}
	if cfg.get("enabled") is False:
		return {"created": 0}
	today = today_iso()
	started = datetime.utcnow()

	if cfg.get("pendingLeaveDays"):
		for req in state.get("leaveRequests") or []:
			if req.get("status") != "pending":
				continue
			days = _diff_days(today, date_only(req.get("createdAt") or today))
			if days >= num(cfg.get("pendingLeaveDays"), 2):
				notify(state, {
					"key": "leave-pending:%s" % req.get("id"), "type": "leave_pending", "severity": "warning",
					"title": "طلب إجازة بانتظار الاعتماد",
					"message": "طلب %s من %s إلى %s معلق منذ %s يوم" % (_employee_name(state, req.get("employeeId")), req.get("fromDate"), req.get("toDate"), days),
					"link": "#/leaves", "employeeId": req.get("employeeId"),
				})

	if cfg.get("missingPunch") is not False:
		for day in state.get("attendanceDaily") or []:
			if day.get("status") != "missing_punch":
				continue
			if day.get("date", "") < add_days(today, -2) or day.get("date", "") > today:
				continue
			notify(state, {
				"key": "missing-punch:%s:%s" % (day.get("empId"), day.get("date")),
				"type": "missing_punch", "severity": "warning", "title": "بصمة انصراف ناقصة",
				"message": "%s — %s بدون بصمة انصراف" % (day.get("employeeName") or _employee_name(state, day.get("empId")), day.get("date")),
				"link": "#/attendance", "employeeId": day.get("empId"), "date": day.get("date"),
			})
		for day in state.get("attendanceDaily") or []:
			if day.get("date") != add_days(today, -1) or day.get("status") != "absent":
				continue
			notify(state, {
				"key": "absent:%s:%s" % (day.get("empId"), day.get("date")),
				"type": "absence", "severity": "danger", "title": "غياب بدون إجازة",
				"message": "%s تغيَّب يوم %s دون تسجيل إجازة" % (day.get("employeeName") or _employee_name(state, day.get("empId")), day.get("date")),
				"link": "#/attendance", "employeeId": day.get("empId"), "date": day.get("date"),
			})

	horizon = num(cfg.get("contractExpiryDays"), 60)
	for contract in state.get("contracts") or []:
		if not contract.get("endDate") or contract.get("status") == "terminated":
			continue
		left = _diff_days(date_only(contract["endDate"]), today)
		if 0 <= left <= horizon:
			notify(state, {
				"key": "contract-expiry:%s:%s" % (contract.get("id"), contract.get("endDate")),
				"type": "contract_expiry", "severity": "danger" if left <= 14 else "warning",
				"title": "عقد على وشك الانتهاء",
				"message": "عقد %s ينتهي %s (%s يوم)" % (_employee_name(state, contract.get("employeeId")), contract["endDate"], left),
				"link": "#/employees", "employeeId": contract.get("employeeId"),
			})

	doc_horizon = num(cfg.get("documentExpiryDays"), 60)
	for doc in state.get("employeeDocuments") or []:
		if not doc.get("expiryDate"):
			continue
		left = _diff_days(date_only(doc["expiryDate"]), today)
		if 0 <= left <= doc_horizon:
			notify(state, {
				"key": "doc-expiry:%s:%s" % (doc.get("id"), doc.get("expiryDate")),
				"type": "document_expiry", "severity": "danger" if left <= 14 else "warning",
				"title": "مستند على وشك الانتهاء",
				"message": "%s — %s ينتهي %s" % (doc.get("name") or "مستند", _employee_name(state, doc.get("employeeId")), doc["expiryDate"]),
				"link": "#/employees", "employeeId": doc.get("employeeId"),
			})

	for emp in state.get("employees") or []:
		exp = emp.get("idExpiryDate") or emp.get("iqamaExpiryDate")
		if not exp:
			continue
		left = _diff_days(date_only(exp), today)
		if 0 <= left <= doc_horizon:
			notify(state, {
				"key": "id-expiry:%s:%s" % (emp.get("id"), exp),
				"type": "id_expiry", "severity": "danger" if left <= 14 else "warning",
				"title": "انتهاء الهوية/الإقامة",
				"message": "%s — تنتهي في %s (%s يوم)" % (emp.get("name"), exp, left),
				"link": "#/employees", "employeeId": emp.get("id"),
			})

	if cfg.get("lowLeaveBalanceDays"):
		for bal in state.get("leaveBalances") or []:
			leave_type = next((t for t in state.get("leaveTypes") or [] if t.get("id") == bal.get("leaveTypeId")), None)
			if not leave_type or not leave_type.get("isPaid"):
				continue
			if 0 <= num(bal.get("balance")) <= num(cfg.get("lowLeaveBalanceDays"), 3):
				notify(state, {
					"key": "low-balance:%s:%s:%s" % (bal.get("employeeId"), bal.get("leaveTypeId"), bal.get("year")),
					"type": "low_leave_balance", "severity": "info", "title": "رصيد إجازات منخفض",
					"message": "رصيد %s من %s أصبح %s يوم" % (_employee_name(state, bal.get("employeeId")), leave_type.get("name"), round2(bal.get("balance"))),
					"link": "#/leaves", "employeeId": bal.get("employeeId"),
				})

	if cfg.get("deviceOfflineHours"):
		for device in state.get("fingerprintDevices") or []:
			if not device.get("lastSeen"):
				continue
			try:
				seen = datetime.strptime(device["lastSeen"][:19], "%Y-%m-%dT%H:%M:%S")
				hours = (datetime.utcnow() - seen).total_seconds() / 3600.0
			except Exception:
				hours = 0
			if hours >= num(cfg.get("deviceOfflineHours"), 24):
				notify(state, {
					"key": "device-offline:%s:%s" % (device.get("id"), today[:13]),
					"type": "device_offline", "severity": "danger", "title": "جهاز بصمة غير متصل",
					"message": "%s في %s آخر اتصال قبل %s ساعة" % (device.get("name") or device.get("deviceIp"), device.get("branchName") or "", round(hours)),
					"link": "#/attendance",
				})

	now = datetime.now()
	prev_month = (now.month - 2) % 12 + 1
	prev_year = now.year if now.month > 1 else now.year - 1
	if not any(num(p.get("month")) == prev_month and num(p.get("year")) == prev_year for p in state.get("payrollPeriods") or []):
		notify(state, {
			"key": "payroll-due:%s-%s" % (prev_year, prev_month), "type": "payroll_due", "severity": "info",
			"title": "مسير رواتب الشهر السابق غير منشأ",
			"message": "لم يتم إنشاء فترة رواتب لشهر %s/%s" % (prev_month, prev_year), "link": "#/payroll",
		})

	for emp in state.get("employees") or []:
		late = [d for d in state.get("attendanceDaily") or []
		        if d.get("empId") == emp.get("id") and d.get("date", "") >= add_days(today, -30) and num(d.get("lateMinutes")) > 0]
		if len(late) >= 5:
			notify(state, {
				"key": "repeat-late:%s:%s" % (emp.get("id"), today[:7]), "type": "repeat_late", "severity": "warning",
				"title": "تأخير متكرر",
				"message": "%s تأخر %s مرة خلال 30 يومًا (%s دقيقة)" % (emp.get("name"), len(late), sum(num(d.get("lateMinutes")) for d in late)),
				"link": "#/attendance", "employeeId": emp.get("id"),
			})

	created = len([n for n in state.get("notifications") or [] if n.get("createdAt", "") >= started.strftime("%Y-%m-%dT%H:%M:%S")])
	return {"created": created}
