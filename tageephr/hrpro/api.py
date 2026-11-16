"""واجهة نظام Tageep HRMS داخل الفرابي — ترجمة لمسارات hrpro/src/api.js."""
from __future__ import annotations

import json
import re
import time
import urllib.parse
from datetime import datetime

import frappe
from frappe import _

from . import engine, reports, store
from .defaults import LEVELS, MODULES, ROLE_PRESETS
from .utils import (
	date_only, hash_password, is_legacy_plain, month_range, num, round2, sign_token,
	today_iso, uid, verify_password, verify_token,
)

MAX_ATTEMPTS = 6
LOCK_WINDOW = 15 * 60
PROTECTED_COLLECTIONS = {"auditLog", "notifications"}
SERVER_ONLY = {"auditLog"}

COLLECTION_MODULE = {
	"employees": "employees", "employeeDocuments": "employees", "contracts": "employees",
	"branches": "organization", "departments": "organization", "jobGrades": "organization",
	"workShifts": "organization", "holidays": "organization", "documentTypes": "organization",
	"attendanceRecords": "attendance", "attendanceDaily": "attendance", "attendanceCorrections": "attendance",
	"fingerprintDevices": "attendance", "lateConversions": "attendance", "dailyFollowUps": "attendance",
	"absences": "attendance", "archivedReports": "attendance", "sentReports": "attendance", "dailyExtras": "attendance",
	"dailyAdvances": "attendance", "approvalRequests": "attendance",
	"leaveTypes": "leaves", "leaveRequests": "leaves", "leaveBalances": "leaves", "leaveLedger": "leaves", "leavePolicy": "leaves",
	"tasks": "tasks", "taskComments": "tasks", "selfRequests": "tasks",
	"payrollPeriods": "payroll", "payslips": "payroll", "payrollSettings": "payroll", "salaryPayments": "payroll",
	"journalEntries": "payroll", "eosSettlements": "payroll",
	"allowanceTypes": "compensation", "deductionTypes": "compensation", "employeeAllowances": "compensation",
	"employeeDeductions": "compensation", "incentives": "compensation", "advances": "compensation",
	"advancePayments": "compensation", "loans": "compensation", "loanPayments": "compensation",
	"insuranceRecords": "compensation",
	"reportTemplates": "reports", "notifications": "notifications", "users": "users",
	"settings": "settings", "auditLog": "audit",
}


class ApiError(Exception):
	def __init__(self, message, status=400):
		super().__init__(message)
		self.message = message
		self.status = status


# ───────────────────────── الصلاحيات ─────────────────────────
def user_permissions(user):
	if not user:
		return {}
	if user.get("role") == "admin":
		return {key: "all" for key in MODULES}
	preset = ROLE_PRESETS.get(user.get("role")) or {}
	base = {}
	if preset.get("modules") == "all":
		base = {key: "all" for key in MODULES}
	elif preset.get("modules"):
		base = dict(preset["modules"])
	perms = dict(base)
	perms.update(user.get("permissions") or {})
	return perms


def has_permission(user, module, action="view"):
	if not user:
		return False
	if user.get("role") == "admin":
		return True
	level = user_permissions(user).get(module, "none")
	return LEVELS.get(level, 0) >= LEVELS.get(action, 0)


def can_access_branch(user, branch_id):
	if not user:
		return False
	if user.get("role") == "admin":
		return True
	preset = ROLE_PRESETS.get(user.get("role")) or {}
	if not preset.get("branchScoped"):
		return True
	if not user.get("branchId") or not branch_id:
		return True
	return str(user["branchId"]) == str(branch_id)


def sanitize_user(user):
	if not user:
		return None
	copy = {k: v for k, v in user.items() if k not in ("password", "passwordHash", "twoFactorSecret")}
	copy["permissions"] = user_permissions(user)
	copy["roleLabel"] = (ROLE_PRESETS.get(user.get("role")) or {}).get("label") or user.get("role")
	return copy


def password_issues(password, username=""):
	issues = []
	text = str(password or "")
	if len(text) < 8:
		issues.append("كلمة المرور يجب أن تكون 8 أحرف على الأقل")
	if username and text.lower() == str(username).lower():
		issues.append("يجب ألا تكون كلمة المرور مطابقة لاسم المستخدم")
	if not re.search(r"[A-Za-z\u0600-\u06FF]", text):
		issues.append("يجب أن تحتوي على حرف واحد على الأقل")
	if not re.search(r"[0-9]", text):
		issues.append("يفضل أن تحتوي على رقم واحد على الأقل")
	return issues


def _attempt_key(username):
	return "hrpro_login:%s:%s" % (frappe.local.request.remote_addr if hasattr(frappe.local, "request") else "", str(username).lower())


def _register_failure(key):
	cache = frappe.cache()
	count = (cache.get_value(key) or 0) + 1
	cache.set_value(key, count, expires_in_sec=LOCK_WINDOW)
	return count


def _is_locked(key):
	return (frappe.cache().get_value(key) or 0) >= MAX_ATTEMPTS


# ───────────────────────── السياق ─────────────────────────
class Ctx:
	def __init__(self, method, path, body, query, state):
		self.method = method
		self.path = path
		self.body = body or {}
		self.query = query or {}
		self.state = state
		self.user = None
		self.token = ""

	def audit(self, action, module, collection, record_id, details):
		engine.add_audit(self.state, {
			"userId": self.user.get("id") if self.user else "",
			"userName": self.user.get("name") if self.user else "غير معروف",
			"action": action, "module": module, "collection": collection,
			"recordId": record_id, "details": details,
			"ip": getattr(frappe.local, "request", None) and frappe.local.request.remote_addr or "",
		})

	def require_permission(self, module, action="view"):
		if not has_permission(self.user, module, action):
			raise ApiError("لا تملك صلاحية لهذا الإجراء", 403)

	def scope_branch(self, branch_id):
		if not can_access_branch(self.user, branch_id):
			raise ApiError("لا تملك صلاحية لهذا الفرع", 403)


def _current_user(ctx):
	token = frappe.get_request_header("X-Hrpro-Token") or ""
	if not token:
		header = frappe.get_request_header("Authorization") or ""
		if header.lower().startswith("bearer "):
			candidate = header[7:].strip()
			if candidate.count(".") == 2:
				token = candidate
	payload = verify_token(store.get_secret(), token)
	if not payload:
		raise ApiError("يجب تسجيل الدخول مرة أخرى", 401)
	revoked = frappe.cache().get_value("hrpro_revoked") or []
	if payload.get("jti") in revoked:
		raise ApiError("يجب تسجيل الدخول مرة أخرى", 401)
	user = next((u for u in ctx.state.get("users") or [] if u.get("id") == payload.get("uid")), None)
	if not user or user.get("disabled"):
		raise ApiError("الحساب غير متاح", 401)
	ctx.user = user
	ctx.token = token
	return user


def _token_for(user):
	return sign_token(store.get_secret(), {"uid": user["id"], "role": user.get("role")}, 12 * 3600)


def _commit(ctx):
	store.save(ctx.state)


# ───────────────────────── المسارات ─────────────────────────
ROUTES = []


def route(method, pattern, auth=True, permission=None):
	def decorator(fn):
		ROUTES.append((method, re.compile("^%s$" % pattern), fn, auth, permission))
		return fn
	return decorator


# ═════════ المصادقة ═════════
@route("GET", r"/auth/setup-status", auth=False)
def auth_setup_status(ctx):
	users = ctx.state.get("users") or []
	has_admin = any(u.get("role") == "admin" and (u.get("passwordHash") or u.get("password")) for u in users)
	return {"setupRequired": not has_admin, "companyName": (ctx.state.get("settings") or {}).get("companyName") or ""}


@route("POST", r"/auth/setup", auth=False)
def auth_setup(ctx):
	users = ctx.state.setdefault("users", [])
	if any(u.get("role") == "admin" and (u.get("passwordHash") or u.get("password")) for u in users):
		raise ApiError("تم إعداد النظام مسبقًا", 409)
	body = ctx.body
	name, username, password = body.get("name"), body.get("username"), body.get("password")
	if not name or not username:
		raise ApiError("الاسم واسم الدخول مطلوبان")
	issues = password_issues(password, username)
	if issues:
		raise ApiError(" — ".join(issues))
	admin = {
		"id": uid("u_"), "name": name, "username": username, "role": "admin", "permissions": {},
		"branchId": ((ctx.state.get("branches") or [{}])[0]).get("id") or "",
		"passwordHash": hash_password(password), "mustChangePassword": False,
		"createdAt": engine._now(), "active": True,
	}
	users.append(admin)
	if body.get("companyName"):
		ctx.state["settings"]["companyName"] = body["companyName"]
	engine.add_audit(ctx.state, {"userId": admin["id"], "userName": admin["name"], "action": "setup",
	                             "module": "users", "collection": "users", "recordId": admin["id"],
	                             "details": "إنشاء حساب المدير الأول"})
	_commit(ctx)
	return {"token": _token_for(admin), "user": sanitize_user(admin), "setupComplete": True}


@route("POST", r"/auth/login", auth=False)
def auth_login(ctx):
	body = ctx.body
	username, password = body.get("username"), body.get("password")
	if not username or not password:
		raise ApiError("اسم المستخدم وكلمة المرور مطلوبان")
	key = _attempt_key(username)
	if _is_locked(key):
		raise ApiError("تم إيقاف المحاولات مؤقتًا. أعد المحاولة بعد 15 دقيقة", 429)
	user = next((u for u in ctx.state.get("users") or []
	             if str(u.get("username") or "").lower() == str(username).lower()
	             or str(u.get("name") or "").lower() == str(username).lower()
	             or str(u.get("email") or "").lower() == str(username).lower()), None)
	if not user or user.get("disabled"):
		_register_failure(key)
		raise ApiError("اسم المستخدم أو كلمة المرور غير صحيحة", 401)
	stored = user.get("passwordHash") or user.get("password")
	if not verify_password(password, stored):
		_register_failure(key)
		engine.add_audit(ctx.state, {"userId": user.get("id"), "userName": user.get("name"),
		                             "action": "login_failed", "module": "users", "collection": "users",
		                             "recordId": user.get("id"), "details": "محاولة دخول فاشلة"})
		_commit(ctx)
		raise ApiError("اسم المستخدم أو كلمة المرور غير صحيحة", 401)
	frappe.cache().delete_value(key)
	if is_legacy_plain(stored):
		user["passwordHash"] = hash_password(password)
		user.pop("password", None)
	user["lastLoginAt"] = engine._now()
	user["lastLoginIp"] = frappe.local.request.remote_addr if getattr(frappe.local, "request", None) else ""
	engine.add_audit(ctx.state, {"userId": user.get("id"), "userName": user.get("name"), "action": "login",
	                             "module": "users", "collection": "users", "recordId": user.get("id"),
	                             "details": "تسجيل دخول ناجح"})
	_commit(ctx)
	return {"token": _token_for(user), "user": sanitize_user(user), "mustChangePassword": bool(user.get("mustChangePassword"))}


@route("POST", r"/auth/logout")
def auth_logout(ctx):
	payload = verify_token(store.get_secret(), ctx.token)
	if payload and payload.get("jti"):
		revoked = frappe.cache().get_value("hrpro_revoked") or []
		revoked.append(payload["jti"])
		frappe.cache().set_value("hrpro_revoked", revoked[-5000:])
	ctx.audit("logout", "users", "users", ctx.user.get("id"), "تسجيل خروج")
	_commit(ctx)
	return {"ok": True}


@route("GET", r"/auth/me")
def auth_me(ctx):
	return {"user": sanitize_user(ctx.user), "modules": MODULES, "roles": ROLE_PRESETS}


@route("POST", r"/auth/change-password")
def auth_change_password(ctx):
	user = ctx.user
	if not verify_password(ctx.body.get("currentPassword") or "", user.get("passwordHash") or user.get("password")):
		raise ApiError("كلمة المرور الحالية غير صحيحة")
	issues = password_issues(ctx.body.get("newPassword"), user.get("username"))
	if issues:
		raise ApiError(" — ".join(issues))
	user["passwordHash"] = hash_password(ctx.body["newPassword"])
	user.pop("password", None)
	user["mustChangePassword"] = False
	user["passwordChangedAt"] = engine._now()
	ctx.audit("change_password", "users", "users", user["id"], "تغيير كلمة المرور")
	_commit(ctx)
	return {"ok": True, "message": "تم تحديث كلمة المرور، سجّل الدخول مرة أخرى"}


# ═════════ التهيئة العامة ═════════
@route("GET", r"/bootstrap")
def bootstrap(ctx):
	s = ctx.state
	user = ctx.user
	can_view_employees = has_permission(user, "employees", "view") or has_permission(user, "self", "view")
	preset = ROLE_PRESETS.get(user.get("role")) or {}
	branch_id = None if user.get("role") == "admin" else ((user.get("branchId") if preset.get("branchScoped") else None) or None)
	employees = [e for e in s.get("employees") or [] if can_view_employees and (not branch_id or e.get("branchId") == branch_id)]
	self_emps = [e for e in s.get("employees") or [] if has_permission(user, "self", "view") and user.get("employeeId") and e.get("id") == user["employeeId"]]
	merged = employees if employees else self_emps
	visible_notifications = [n for n in s.get("notifications") or [] if not n.get("dismissed")]
	today = today_iso()
	active = [e for e in s.get("employees") or [] if e.get("status") != "terminated"]
	return {
		"user": sanitize_user(user), "modules": MODULES, "roles": ROLE_PRESETS,
		"permissions": user_permissions(user), "branchScope": branch_id,
		"settings": s.get("settings"), "branches": s.get("branches"), "departments": s.get("departments"),
		"jobGrades": s.get("jobGrades"), "workShifts": s.get("workShifts"), "holidays": s.get("holidays"),
		"leaveTypes": s.get("leaveTypes"), "leavePolicy": s.get("leavePolicy"),
		"payrollSettings": s.get("payrollSettings"), "documentTypes": s.get("documentTypes"),
		"allowanceTypes": s.get("allowanceTypes"), "deductionTypes": s.get("deductionTypes"),
		"employees": merged,
		"tasks": [t for t in s.get("tasks") or [] if (has_permission(user, "tasks", "view") and (not branch_id or not t.get("branchId") or t.get("branchId") == branch_id))
		          or (user.get("employeeId") and t.get("employeeId") == user.get("employeeId"))],
		"selfRequests": list(reversed((s.get("selfRequests") or [])[-200:])) if has_permission(user, "tasks", "view")
		else list(reversed([r for r in s.get("selfRequests") or [] if r.get("employeeId") == user.get("employeeId")][-50:])),
		"users": [sanitize_user(u) for u in s.get("users") or []] if has_permission(user, "users", "view") else [],
		"notifications": list(reversed(visible_notifications[-50:])),
		"counts": {
			"employees": len(s.get("employees") or []),
			"activeEmployees": len(active),
			"pendingLeaves": len([r for r in s.get("leaveRequests") or [] if r.get("status") == "pending"]),
			"openTasks": len([t for t in s.get("tasks") or [] if t.get("status") not in ("completed", "cancelled")]),
			"overdueTasks": len([t for t in s.get("tasks") or [] if t.get("status") not in ("completed", "cancelled")
			                     and t.get("dueDate") and date_only(t["dueDate"]) < today]),
			"pendingRequests": len([r for r in s.get("selfRequests") or [] if r.get("status") == "pending"]),
			"unreadNotifications": len([n for n in visible_notifications if not n.get("read")]),
		},
		"db": {"type": "frappe", "encryptAtRest": True, "lastSavedAt": engine._now()},
	}


@route("GET", r"/dashboard", permission=("dashboard", "view"))
def dashboard(ctx):
	s = ctx.state
	today = today_iso()
	now = datetime.now()
	range_ = month_range(now.year, now.month)
	engine.process_attendance(s, {"from": today, "to": today})
	_commit(ctx)
	today_rows = [r for r in s.get("attendanceDaily") or [] if r.get("date") == today]
	active = [e for e in s.get("employees") or [] if e.get("status") != "terminated"]
	month_att = [r for r in s.get("attendanceDaily") or [] if range_["from"] <= r.get("date", "") <= range_["to"]]
	month_slips = [p for p in s.get("payslips") or [] if num(p.get("month")) == now.month and num(p.get("year")) == now.year]

	present_statuses = ("present", "late", "missing_punch")
	charts = {"attendance": [], "payroll": [], "departments": [], "leaves": []}
	from datetime import timedelta

	for i in range(13, -1, -1):
		day = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
		rows = [r for r in s.get("attendanceDaily") or [] if r.get("date") == day]
		charts["attendance"].append({
			"label": day[5:],
			"present": len([r for r in rows if r.get("status") in present_statuses]),
			"absent": len([r for r in rows if r.get("status") == "absent"]),
			"leave": len([r for r in rows if r.get("status") == "leave"]),
		})
	for i in range(5, -1, -1):
		d = datetime(now.year, now.month, 1) - timedelta(days=1) if i else now
		m, y = (now.month - i - 1) % 12 + 1, now.year - ((now.month - i - 1) // 12)
		slips = [p for p in s.get("payslips") or [] if num(p.get("month")) == m and num(p.get("year")) == y]
		charts["payroll"].append({"label": "%s/%s" % (m, y), "total": round2(sum(num(p.get("netSalary")) for p in slips))})

	charts["departments"] = [
		{"label": d.get("name"), "value": len([e for e in active if e.get("departmentId") == d.get("id")])}
		for d in s.get("departments") or []
	]
	charts["departments"] = [c for c in charts["departments"] if c["value"] > 0]
	leave_usage = {}
	for req in s.get("leaveRequests") or []:
		if req.get("status") != "approved":
			continue
		leave_type = next((t for t in s.get("leaveTypes") or [] if t.get("id") == req.get("leaveTypeId")), None)
		name = (leave_type or {}).get("name", "أخرى")
		leave_usage[name] = round2(leave_usage.get(name, 0) + num(req.get("days")))
	charts["leaves"] = [{"label": k, "value": v} for k, v in leave_usage.items()]

	workable = [r for r in month_att if r.get("status") not in ("weekend", "holiday", "future")]
	rate = round2(len([r for r in workable if r.get("status") in present_statuses]) / float(len(workable)) * 100) if workable else 0
	return {
		"kpi": {
			"headcount": len(active),
			"presentToday": len([r for r in today_rows if r.get("status") in present_statuses]),
			"absentToday": len([r for r in today_rows if r.get("status") == "absent"]),
			"lateToday": len([r for r in today_rows if num(r.get("lateMinutes")) > 0]),
			"onLeaveToday": len([r for r in today_rows if r.get("status") == "leave"]),
			"missingPunchToday": len([r for r in today_rows if r.get("status") == "missing_punch"]),
			"pendingLeaves": len([r for r in s.get("leaveRequests") or [] if r.get("status") == "pending"]),
			"monthPayroll": round2(sum(num(p.get("netSalary")) for p in month_slips)),
			"monthOvertimeMinutes": sum(num(r.get("overtimeMinutes")) for r in month_att),
			"monthLateMinutes": sum(num(r.get("lateMinutes")) for r in month_att),
			"openAdvances": round2(sum(num(a.get("remainingAmount")) for a in s.get("advances") or [] if a.get("status") != "closed")),
			"unreadNotifications": len([n for n in s.get("notifications") or [] if not n.get("read") and not n.get("dismissed")]),
			"attendanceRate": rate,
			"payrollCostYtd": round2(sum(num(p.get("netSalary")) for p in s.get("payslips") or [] if num(p.get("year")) == now.year)),
		},
		"charts": charts,
		"today": [{"employeeName": r.get("employeeName"), "status": r.get("status"), "checkIn": r.get("checkIn"),
		           "checkOut": r.get("checkOut"), "lateMinutes": r.get("lateMinutes"), "departmentId": r.get("departmentId")}
		          for r in today_rows[:12]],
		"notifications": list(reversed([n for n in s.get("notifications") or [] if not n.get("read") and not n.get("dismissed")][-6:])),
		"expiring": {
			"contracts": len([c for c in s.get("contracts") or [] if c.get("endDate") and today <= date_only(c["endDate"]) <= (datetime.now() + timedelta(days=60)).strftime("%Y-%m-%d")]),
			"documents": len([d for d in s.get("employeeDocuments") or [] if d.get("expiryDate") and today <= date_only(d["expiryDate"]) <= (datetime.now() + timedelta(days=60)).strftime("%Y-%m-%d")]),
		},
		"openPeriod": next((p for p in s.get("payrollPeriods") or [] if p.get("status") in ("open", "draft")), None),
	}


# ═════════ الموظفون ═════════
@route("GET", r"/employees/(?P<emp_id>[^/]+)/profile")
def employee_profile(ctx, emp_id):
	s = ctx.state
	emp = engine.find_employee(s, emp_id)
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	is_self = ctx.user.get("employeeId") == emp.get("id")
	if not is_self and not has_permission(ctx.user, "employees", "view"):
		raise ApiError("لا تملك صلاحية عرض ملفات الموظفين", 403)
	if not is_self and not can_access_branch(ctx.user, emp.get("branchId")):
		raise ApiError("لا تملك صلاحية لعرض موظفي هذا الفرع", 403)
	now = datetime.now()
	range_ = month_range(now.year, now.month)
	engine.process_attendance(s, {"from": range_["from"], "to": range_["to"], "employeeId": emp["id"]})
	_commit(ctx)
	return {
		"employee": emp,
		"attendance": engine.attendance_summary_for_employee(s, emp["id"], range_["from"], range_["to"]),
		"today": next((d for d in s.get("attendanceDaily") or [] if d.get("empId") == emp["id"] and d.get("date") == today_iso()), None),
		"payslips": sorted([p for p in s.get("payslips") or [] if p.get("employeeId") == emp["id"]],
		                  key=lambda p: (num(p.get("year")), num(p.get("month"))), reverse=True)[:12],
		"leaves": sorted([l for l in s.get("leaveRequests") or [] if l.get("employeeId") == emp["id"]],
		                key=lambda l: l.get("createdAt") or "", reverse=True)[:12],
		"balances": [b for b in s.get("leaveBalances") or [] if b.get("employeeId") == emp["id"]],
		"documents": [d for d in s.get("employeeDocuments") or [] if d.get("employeeId") == emp["id"]],
		"contracts": [c for c in s.get("contracts") or [] if c.get("employeeId") == emp["id"]],
		"advances": [a for a in s.get("advances") or [] if a.get("employeeId") == emp["id"]],
		"loans": [l for l in s.get("loans") or [] if l.get("employeeId") == emp["id"]],
		"allowances": [a for a in s.get("employeeAllowances") or [] if a.get("employeeId") == emp["id"]],
		"deductions": [d for d in s.get("employeeDeductions") or [] if d.get("employeeId") == emp["id"]],
		"incentives": [i for i in s.get("incentives") or [] if i.get("employeeId") == emp["id"]],
	}


@route("GET", r"/employees/next-number", permission=("employees", "add"))
def employee_next_number(ctx):
	numbers = [int(e["employeeNumber"]) for e in ctx.state.get("employees") or []
	           if str(e.get("employeeNumber") or "").isdigit()]
	return {"next": str((max(numbers) + 1) if numbers else 1).zfill(4)}


# ═════════ الحضور ═════════
@route("POST", r"/attendance/process", permission=("attendance", "edit"))
def attendance_process(ctx):
	body = ctx.body
	if body.get("from") and body.get("to"):
		range_ = {"from": body["from"], "to": body["to"]}
	else:
		range_ = month_range(body.get("year") or datetime.now().year, body.get("month") or datetime.now().month)
	summary = engine.process_attendance(ctx.state, {"from": range_["from"], "to": range_["to"],
	                                                "employeeId": body.get("employeeId"),
	                                                "branchId": body.get("branchId"),
	                                                "departmentId": body.get("departmentId")})
	ctx.audit("process_attendance", "attendance", "attendanceDaily", "", "معالجة الحضور %s → %s" % (range_["from"], range_["to"]))
	_commit(ctx)
	return {"summary": summary, "message": "تمت معالجة الحضور بنجاح"}


@route("GET", r"/attendance/daily", permission=("attendance", "view"))
def attendance_daily(ctx):
	q = ctx.query
	frm = date_only(q.get("from")) or today_iso()
	to = date_only(q.get("to")) or frm
	rows = engine.attendance_for(ctx.state, frm, to, {
		"employeeId": q.get("employeeId"), "branchId": q.get("branchId"),
		"departmentId": q.get("departmentId"), "status": q.get("status")})
	preset = ROLE_PRESETS.get(ctx.user.get("role")) or {}
	if preset.get("branchScoped") and ctx.user.get("branchId"):
		rows = [r for r in rows if can_access_branch(ctx.user, r.get("branchId"))]
	rows.sort(key=lambda r: (r.get("date", ""), r.get("employeeName", "")))
	return {"data": rows, "from": frm, "to": to}


@route("POST", r"/attendance/corrections", permission=("attendance", "add"))
def attendance_create_correction(ctx):
	s = ctx.state
	body = ctx.body
	emp = engine.find_employee(s, body.get("empId"))
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	ctx.scope_branch(emp.get("branchId"))
	if not body.get("date"):
		raise ApiError("التاريخ مطلوب")
	allowed = ["present", "late", "half_day", "absent", "leave", "remote"]
	if body.get("status") not in allowed:
		raise ApiError("نوع المعالجة غير صالح")
	if body.get("status") == "leave" and not body.get("leaveTypeId"):
		raise ApiError("اختر نوع الإجازة")
	auto_approve = has_permission(ctx.user, "attendance", "edit")
	correction = {
		"id": uid("ac_"), "empId": emp["id"], "employeeName": emp.get("name"),
		"branchId": emp.get("branchId") or "", "date": date_only(body.get("date")),
		"status": body.get("status"), "checkIn": body.get("checkIn") or "", "checkOut": body.get("checkOut") or "",
		"leaveTypeId": body.get("leaveTypeId") or "",
		"dayPortion": (num(body.get("dayPortion"), 0.5) or 0.5) if body.get("status") == "half_day" else (num(body.get("dayPortion"), 1) or 1),
		"excuseLate": body.get("excuseLate") is not False and body.get("status") == "present",
		"treatAsPresent": body.get("status") == "present",
		"reason": body.get("reason") or "", "requestedBy": ctx.user.get("name"), "requestedById": ctx.user.get("id"),
		"statusApproval": "approved" if auto_approve else "pending", "createdAt": engine._now(),
	}
	correction["approvalStatus"] = correction["statusApproval"]
	s.setdefault("attendanceCorrections", []).append(correction)
	ctx.audit("create", "attendance", "attendanceCorrections", correction["id"],
	          "معالجة بصمة %s %s → %s" % (emp.get("name"), correction["date"], body.get("status")))
	if auto_approve:
		engine.process_attendance(s, {"from": correction["date"], "to": correction["date"], "employeeId": emp["id"]})
	engine.notify(s, {"key": "correction:%s" % correction["id"], "type": "attendance_correction",
	                  "severity": "success" if auto_approve else "info", "title": "معالجة بصمة",
	                  "message": "%s عالج بصمة %s بتاريخ %s" % (ctx.user.get("name"), emp.get("name"), correction["date"]),
	                  "link": "#/attendance"})
	_commit(ctx)
	return {"data": correction, "message": "تم حفظ معالجة البصمة بنجاح"}


@route("GET", r"/attendance/corrections", permission=("attendance", "view"))
def attendance_corrections(ctx):
	rows = list(ctx.state.get("attendanceCorrections") or [])
	if ctx.query.get("employeeId"):
		rows = [c for c in rows if c.get("empId") == ctx.query["employeeId"]]
	if ctx.query.get("from"):
		rows = [c for c in rows if c.get("date", "") >= date_only(ctx.query["from"])]
	if ctx.query.get("to"):
		rows = [c for c in rows if c.get("date", "") <= date_only(ctx.query["to"])]
	rows.sort(key=lambda c: c.get("createdAt") or "", reverse=True)
	return {"data": rows}


@route("PUT", r"/attendance/corrections/(?P<corr_id>[^/]+)/approve", permission=("attendance", "edit"))
def attendance_approve_correction(ctx, corr_id):
	s = ctx.state
	correction = next((c for c in s.get("attendanceCorrections") or [] if c.get("id") == corr_id), None)
	if not correction:
		raise ApiError("المعالجة غير موجودة", 404)
	correction.update({"approvalStatus": "approved", "approvedBy": ctx.user.get("name"), "approvedAt": engine._now()})
	engine.process_attendance(s, {"from": correction["date"], "to": correction["date"], "employeeId": correction["empId"]})
	ctx.audit("approve", "attendance", "attendanceCorrections", corr_id, "اعتماد معالجة بصمة")
	_commit(ctx)
	return {"data": correction, "message": "تم اعتماد المعالجة وتحديث الحضور"}


@route("PUT", r"/attendance/corrections/(?P<corr_id>[^/]+)/reject", permission=("attendance", "edit"))
def attendance_reject_correction(ctx, corr_id):
	correction = next((c for c in ctx.state.get("attendanceCorrections") or [] if c.get("id") == corr_id), None)
	if not correction:
		raise ApiError("المعالجة غير موجودة", 404)
	correction.update({"approvalStatus": "rejected", "status": "cancelled", "rejectionReason": ctx.body.get("reason") or ""})
	ctx.audit("reject", "attendance", "attendanceCorrections", corr_id, "رفض معالجة بصمة")
	_commit(ctx)
	return {"data": correction, "message": "تم رفض المعالجة"}


@route("DELETE", r"/attendance/corrections/(?P<corr_id>[^/]+)", permission=("attendance", "delete"))
def attendance_delete_correction(ctx, corr_id):
	s = ctx.state
	correction = next((c for c in s.get("attendanceCorrections") or [] if c.get("id") == corr_id), None)
	if not correction:
		raise ApiError("المعالجة غير موجودة", 404)
	s["attendanceCorrections"] = [c for c in s.get("attendanceCorrections") or [] if c.get("id") != corr_id]
	engine.process_attendance(s, {"from": correction["date"], "to": correction["date"], "employeeId": correction["empId"]})
	ctx.audit("delete", "attendance", "attendanceCorrections", corr_id, "حذف معالجة بصمة")
	_commit(ctx)
	return {"ok": True}


@route("POST", r"/attendance/late-conversion/run", permission=("leaves", "edit"))
def attendance_late_conversion(ctx):
	result = engine.run_late_conversion(ctx.state, {**ctx.body, "userName": ctx.user.get("name")})
	ctx.audit("late_conversion", "leaves", "lateConversions", "",
	          "تحويل التأخير إلى إجازات %s/%s" % (result.get("year"), result.get("month")))
	_commit(ctx)
	message = result.get("message") if result.get("skipped") else "تم تحويل التأخير لعدد %s موظف" % len(result.get("conversions") or [])
	return {"data": result, "message": message}


# ═════════ البصمة ═════════
def _device_key_ok(ctx):
	configured = ((ctx.state.get("settings") or {}).get("fingerprintDevice") or {}).get("apiKey")
	if not configured:
		return True
	provided = frappe.get_request_header("X-Device-Key") or ctx.body.get("apiKey") or ctx.query.get("key")
	return bool(provided) and str(provided) == str(configured)


@route("POST", r"/fingerprint/devices/(?P<device_id>[^/]+)/test", permission=("attendance", "edit"))
def fingerprint_test_device(ctx, device_id):
	device = next((d for d in ctx.state.get("fingerprintDevices") or [] if d.get("id") == device_id), None)
	if not device:
		raise ApiError("الجهاز غير موجود", 404)
	device["lastTestAt"] = engine._now()
	_commit(ctx)
	return {"data": {"connected": True, "message": "تم حفظ اختبار الاتصال. التكامل المباشر يحتاج وسيط ADMS/Push"}}


@route("POST", r"/fingerprint/punches", auth=False)
def fingerprint_punches(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح جهاز البصمة غير صالح", 401)
	s = ctx.state
	body = ctx.body
	punches = body.get("punches") or body.get("records") or []
	if not isinstance(punches, list) or not punches:
		raise ApiError("لا توجد بصمات")
	branch_id = body.get("branchId") or ""
	device_id = body.get("deviceId") or body.get("deviceSn") or body.get("sn") or ""
	added = skipped = 0
	unknown = []
	dates = set()
	for p in punches:
		number = str(p.get("employeeNumber") or p.get("employeeId") or p.get("empId") or p.get("pin") or p.get("userId") or "").strip()
		if not number:
			skipped += 1
			continue
		emp = engine.find_employee(s, number) or next((e for e in s.get("employees") or [] if str(e.get("fingerprintId") or "") == number), None)
		if not emp:
			unknown.append(number)
			skipped += 1
			continue
		raw_time = p.get("time") or p.get("punchTime") or p.get("timestamp") or p.get("dateTime") or ""
		day = date_only(p.get("date") or raw_time)
		time_text = p.get("timeOnly") or ""
		if not time_text and raw_time:
			m = re.search(r"(\d{1,2}):(\d{2})", str(raw_time))
			if m:
				time_text = "%02d:%s" % (int(m.group(1)), m.group(2))
		if not day or not time_text:
			skipped += 1
			continue
		exists = any((a.get("empId") == emp["id"] or a.get("employeeId") == emp["id"]) and date_only(a.get("date")) == day
		             and (a.get("punchTime") == time_text or a.get("checkIn") == time_text or a.get("checkOut") == time_text)
		             for a in s.get("attendanceRecords") or [])
		if exists:
			skipped += 1
			continue
		punch_type = p.get("punchType")
		s.setdefault("attendanceRecords", []).append({
			"id": uid("att_"), "empId": emp["id"], "employeeId": emp["id"],
			"employeeName": emp.get("name") or "", "employeeNumber": emp.get("employeeNumber") or "",
			"date": day, "punchTime": time_text, "punchType": "" if punch_type is None else punch_type,
			"checkIn": None if punch_type == 1 else time_text, "checkOut": time_text if punch_type == 1 else None,
			"branchId": branch_id or emp.get("branchId") or "", "deviceId": device_id,
			"source": "fingerprint", "createdAt": engine._now(),
		})
		dates.add(day)
		added += 1
	if dates:
		sorted_dates = sorted(dates)
		engine.process_attendance(s, {"from": sorted_dates[0], "to": sorted_dates[-1]})
	if added:
		_commit(ctx)
	return {"message": "تم استلام %s بصمة" % added if added else "لا توجد بصمات جديدة",
	        "added": added, "skipped": skipped, "unknown": unknown, "dates": sorted(dates)}


@route("POST", r"/fingerprint/heartbeat", auth=False)
def fingerprint_heartbeat(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح جهاز البصمة غير صالح", 401)
	body = ctx.body
	s = ctx.state
	device = next((d for d in s.get("fingerprintDevices") or []
	               if (body.get("branchId") and d.get("branchId") == body["branchId"]) or (body.get("deviceIp") and d.get("deviceIp") == body["deviceIp"])), None)
	if device:
		device["lastSeen"] = engine._now()
		device["status"] = body.get("status") or "online"
		if body.get("employeeCount") is not None:
			device["deviceEmployeeCount"] = num(body["employeeCount"])
		if body.get("logCount") is not None:
			device["deviceLogCount"] = num(body["logCount"])
		_commit(ctx)
	return {"ok": True}


@route("POST", r"/fingerprint/receive", auth=False)
def fingerprint_receive(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح جهاز البصمة غير صالح", 401)
	s = ctx.state
	records = ctx.body.get("records") or ctx.body.get("attendance") or []
	if not isinstance(records, list) or not records:
		raise ApiError("لا توجد سجلات")
	added = 0
	dates = set()
	for rec in records:
		emp_ref = rec.get("empId") or rec.get("employeeId") or rec.get("userId")
		emp = engine.find_employee(s, emp_ref) or next((e for e in s.get("employees") or [] if str(e.get("fingerprintId") or "") == str(emp_ref)), None)
		emp_id = emp["id"] if emp else emp_ref
		day = date_only(rec.get("date") or rec.get("checkIn") or rec.get("punchTime"))
		if not emp_id or not day:
			continue
		push_time = rec.get("punchTime") or rec.get("checkIn") or ""
		if any((a.get("empId") == emp_id or a.get("employeeId") == emp_id) and date_only(a.get("date")) == day
		       and a.get("punchTime") in (push_time, None) and a.get("checkIn") == push_time for a in s.get("attendanceRecords") or []):
			continue
		s.setdefault("attendanceRecords", []).append({
			"id": uid("att_"), "empId": emp_id, "employeeId": emp_id,
			"employeeName": (emp or {}).get("name") or "", "branchId": (emp or {}).get("branchId") or rec.get("branchId") or "",
			"date": day, "checkIn": rec.get("checkIn") or rec.get("punchTime"), "checkOut": rec.get("checkOut"),
			"punchTime": rec.get("punchTime") or rec.get("checkIn"), "punchType": rec.get("punchType"),
			"source": rec.get("source") or "fingerprint", "deviceId": rec.get("deviceId") or ctx.body.get("deviceId") or "",
			"createdAt": engine._now(),
		})
		added += 1
		dates.add(day)
	for day in dates:
		engine.process_attendance(s, {"from": day, "to": day})
	device_id = ctx.body.get("deviceId")
	if device_id:
		device = next((d for d in s.get("fingerprintDevices") or [] if d.get("id") == device_id or d.get("deviceIp") == device_id), None)
		if device:
			device.update({"lastSyncAt": engine._now(), "lastSeen": engine._now(), "status": "online"})
			device["totalRecords"] = num(device.get("totalRecords")) + added
	_commit(ctx)
	return {"ok": True, "added": added, "total": len(records), "message": "تم استلام %s بصمة جديدة" % added}


@route("GET", r"/fingerprint/ping", auth=False)
def fingerprint_ping(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح الجهاز غير صالح", 401)
	s = ctx.state
	return {"ok": True, "company": (s.get("settings") or {}).get("companyName") or "Tageep HRMS",
	        "version": "3.1.0", "serverTime": engine._now(),
	        "branches": len([b for b in s.get("branches") or [] if b.get("active") is not False]),
	        "employees": len([e for e in s.get("employees") or [] if e.get("status") != "terminated"]),
	        "apiKeyRequired": bool(((s.get("settings") or {}).get("fingerprintDevice") or {}).get("apiKey"))}


@route("GET", r"/fingerprint/branches", auth=False)
def fingerprint_branches(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح الجهاز غير صالح", 401)
	s = ctx.state
	return {"data": [{"id": b.get("id"), "name": b.get("name"), "code": b.get("code") or "",
	                  "phone": b.get("phone") or "", "address": b.get("address") or "",
	                  "employees": len([e for e in s.get("employees") or [] if e.get("branchId") == b.get("id") and e.get("status") != "terminated"])}
	                 for b in s.get("branches") or [] if b.get("active") is not False]}


@route("GET", r"/fingerprint/employees", auth=False)
def fingerprint_employees(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح الجهاز غير صالح", 401)
	s = ctx.state
	branch_id = ctx.query.get("branchId") or ""
	department_id = ctx.query.get("departmentId") or ""
	search = str(ctx.query.get("q") or "").strip()
	rows = [e for e in s.get("employees") or [] if e.get("status") != "terminated"]
	if branch_id:
		rows = [e for e in rows if e.get("branchId") == branch_id]
	if department_id:
		rows = [e for e in rows if e.get("departmentId") == department_id]
	if search:
		rows = [e for e in rows if search in str(e.get("name") or "") or search in str(e.get("employeeNumber") or "")]
	departments = {d.get("id"): d for d in s.get("departments") or []}
	return {"data": [{"id": e.get("id"), "employeeNumber": e.get("employeeNumber") or "", "name": e.get("name") or "",
	                   "branchId": e.get("branchId") or "", "departmentId": e.get("departmentId") or "",
	                   "departmentName": (departments.get(e.get("departmentId")) or {}).get("name") or "",
	                   "jobTitle": e.get("jobTitle") or "", "fingerprintId": e.get("fingerprintId") or "",
	                   "status": e.get("status") or "active"} for e in rows], "branchId": branch_id}


@route("POST", r"/fingerprint/device-info", auth=False)
def fingerprint_device_info(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح الجهاز غير صالح", 401)
	s = ctx.state
	body = ctx.body
	sn = str(body.get("sn") or body.get("deviceSn") or body.get("ip") or "").strip()
	if not sn:
		raise ApiError("لا توجد بيانات جهاز")
	device = next((d for d in s.get("fingerprintDevices") or []
	               if (d.get("sn") and d["sn"] == sn) or (body.get("ip") and d.get("deviceIp") == body["ip"])), None)
	if not device:
		device = {"id": uid("fd_"), "sn": sn, "branchId": body.get("branchId") or "", "createdAt": engine._now()}
		s.setdefault("fingerprintDevices", []).append(device)
	device["name"] = body.get("name") or device.get("name") or "جهاز %s" % sn
	device["deviceIp"] = body.get("ip") or device.get("deviceIp") or ""
	device["port"] = num(body.get("port")) or device.get("port") or 4370
	device["status"] = "online"
	device["lastSeen"] = engine._now()
	device.setdefault("lastSyncAt", "")
	if body.get("branchId"):
		device["branchId"] = body["branchId"]
	if body.get("userCount") is not None:
		device["deviceEmployeeCount"] = num(body["userCount"])
	if body.get("logCount") is not None:
		device["deviceLogCount"] = num(body["logCount"])
	if body.get("logCapacity") is not None:
		device["deviceLogCapacity"] = num(body["logCapacity"])
	if body.get("users"):
		device["deviceUsers"] = [{"userId": str(u.get("userId") or ""), "name": u.get("name") or "",
		                          "cardno": u.get("cardno") or 0} for u in (body["users"] or [])[:500]]
	_commit(ctx)
	return {"ok": True, "deviceId": device["id"]}


@route("POST", r"/fingerprint/assign", auth=False)
def fingerprint_assign(ctx):
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح الجهاز غير صالح", 401)
	s = ctx.state
	body = ctx.body
	emp = next((e for e in s.get("employees") or [] if e.get("id") == body.get("employeeId")), None) or engine.find_employee(s, body.get("employeeId"))
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	fingerprint_id = str(body.get("fingerprintId") or "").strip()
	if fingerprint_id:
		other = next((e for e in s.get("employees") or [] if e.get("id") != emp["id"] and str(e.get("fingerprintId") or "") == fingerprint_id), None)
		if other:
			raise ApiError("رقم البصمة %s مسند بالفعل للموظف: %s" % (fingerprint_id, other.get("name")), 409)
	emp["fingerprintId"] = fingerprint_id
	emp["fingerprintLinkedAt"] = engine._now() if fingerprint_id else ""
	engine.add_audit(s, {"userName": "وسيط البصمة", "action": "link_fingerprint" if fingerprint_id else "unlink_fingerprint",
	                    "module": "attendance", "collection": "employees", "recordId": emp["id"],
	                    "details": ("إسناد رقم البصمة %s إلى %s" % (fingerprint_id, emp.get("name"))) if fingerprint_id else ("إلغاء ربط بصمة %s" % emp.get("name"))})
	_commit(ctx)
	return {"ok": True, "message": "تم إسناد رقم البصمة للموظف" if fingerprint_id else "تم إلغاء ربط البصمة",
	        "employee": {"id": emp["id"], "name": emp.get("name"), "employeeNumber": emp.get("employeeNumber") or "",
	                     "fingerprintId": emp.get("fingerprintId")}}


@route("POST", r"/fingerprint/push", auth=False)
def fingerprint_push(ctx):
	return fingerprint_receive(ctx)


# ═════════ الإجازات ═════════
@route("POST", r"/leaves/requests", auth=True)
def leave_create(ctx):
	s = ctx.state
	body = ctx.body
	is_self = ctx.user.get("employeeId") and str(body.get("employeeId")) == str(ctx.user.get("employeeId"))
	if not has_permission(ctx.user, "leaves", "add") and not (is_self and has_permission(ctx.user, "self", "view")):
		raise ApiError("لا تملك صلاحية تقديم طلب إجازة", 403)
	emp = engine.find_employee(s, body.get("employeeId"))
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	ctx.scope_branch(emp.get("branchId"))
	leave_type = next((t for t in s.get("leaveTypes") or [] if t.get("id") == body.get("leaveTypeId")), None)
	if not leave_type:
		raise ApiError("نوع الإجازة غير موجود")
	frm = date_only(body.get("fromDate"))
	to = date_only(body.get("toDate") or body.get("fromDate"))
	if not frm or not to or to < frm:
		raise ApiError("فترة الإجازة غير صحيحة")
	policy = s.get("leavePolicy") or {}
	overlap = next((r for r in s.get("leaveRequests") or [] if r.get("employeeId") == emp["id"]
	                and r.get("status") in ("approved", "pending")
	                and not (date_only(r.get("toDate") or r.get("fromDate")) < frm) and not (date_only(r.get("fromDate")) > to)), None)
	if overlap:
		raise ApiError("يوجد طلب متداخل من %s إلى %s" % (overlap.get("fromDate"), overlap.get("toDate")))
	portion = num(body.get("dayPortion"), 1) or 1
	days = engine.count_leave_days(s, frm, to, leave_type)
	if frm == to and portion < 1:
		days = portion
	elif portion < 1:
		days = round2(days * portion)
	if days <= 0:
		raise ApiError("الفترة المحددة لا تحتوي أيام عمل (عطلة أسبوعية أو رسمية)")
	if policy.get("maxRequestDays") and days > num(policy["maxRequestDays"]):
		raise ApiError("الحد الأقصى للطلب الواحد %s يوم" % policy["maxRequestDays"])
	available = engine.ensure_balance(s, emp["id"], leave_type["id"], engine.leave_year(frm))["balance"]
	allow_negative = policy.get("allowNegativeBalance") is True or leave_type.get("allowNegative") is True
	if num(leave_type.get("daysPerYear")) > 0 and not allow_negative and days > available + 0.0001:
		raise ApiError("الرصيد المتاح %s يوم فقط، المطلوب %s يوم" % (round2(available), round2(days)))
	request = {
		"id": uid("lr_"), "employeeId": emp["id"], "employeeName": emp.get("name"),
		"leaveTypeId": leave_type["id"], "fromDate": frm, "toDate": to, "days": days, "dayPortion": portion,
		"reason": body.get("reason") or "", "status": "approved" if policy.get("requireApproval") is False else "pending",
		"requestedBy": ctx.user.get("name"), "requestedById": ctx.user.get("id"), "createdAt": engine._now(),
		"attachment": body.get("attachment") or "",
	}
	s.setdefault("leaveRequests", []).append(request)
	if request["status"] == "approved":
		engine.approve_leave_request(s, request["id"], ctx.user)
	else:
		engine.notify(s, {"key": "leave-new:%s" % request["id"], "type": "leave_request", "severity": "info",
		                  "title": "طلب إجازة جديد",
		                  "message": "%s طلب %s من %s إلى %s (%s يوم)" % (emp.get("name"), leave_type.get("name"), frm, to, days),
		                  "link": "#/leaves"})
	ctx.audit("create", "leaves", "leaveRequests", request["id"], "طلب إجازة %s %s يوم" % (leave_type.get("name"), days))
	_commit(ctx)
	return {"data": request, "message": "تم اعتماد الإجازة مباشرة" if policy.get("requireApproval") is False else "تم إرسال طلب الإجازة للاعتماد"}


@route("PUT", r"/leaves/requests/(?P<req_id>[^/]+)/approve", permission=("leaves", "edit"))
def leave_approve(ctx, req_id):
	request = engine.approve_leave_request(ctx.state, req_id, ctx.user)
	engine.notify(ctx.state, {"key": "leave-approved:%s" % request["id"], "type": "leave_approved", "severity": "success",
	                          "title": "اعتماد إجازة",
	                          "message": "تم اعتماد إجازة %s (%s يوم)" % (request.get("employeeName") or "", request.get("days")),
	                          "link": "#/leaves"})
	ctx.audit("approve", "leaves", "leaveRequests", request["id"], "اعتماد طلب إجازة")
	_commit(ctx)
	return {"data": request, "message": "تم اعتماد الإجازة وخصمها من الرصيد"}


@route("PUT", r"/leaves/requests/(?P<req_id>[^/]+)/reject", permission=("leaves", "edit"))
def leave_reject(ctx, req_id):
	request = next((r for r in ctx.state.get("leaveRequests") or [] if r.get("id") == req_id), None)
	if not request:
		raise ApiError("الطلب غير موجود", 404)
	request.update({"status": "rejected", "rejectionReason": ctx.body.get("reason") or "",
	                "approvedBy": ctx.user.get("name"), "approvedAt": engine._now()})
	ctx.audit("reject", "leaves", "leaveRequests", req_id, "رفض طلب إجازة")
	_commit(ctx)
	return {"data": request, "message": "تم رفض الطلب"}


@route("PUT", r"/leaves/requests/(?P<req_id>[^/]+)/cancel", permission=("leaves", "edit"))
def leave_cancel(ctx, req_id):
	request = engine.cancel_leave_request(ctx.state, req_id, ctx.user)
	ctx.audit("cancel", "leaves", "leaveRequests", req_id, "إلغاء طلب إجازة")
	_commit(ctx)
	return {"data": request, "message": "تم إلغاء الطلب وإرجاع الرصيد"}


@route("GET", r"/leaves/balances", permission=("leaves", "view"))
def leave_balances(ctx):
	s = ctx.state
	year = int(num(ctx.query.get("year")) or datetime.now().year)
	rows = [b for b in s.get("leaveBalances") or [] if num(b.get("year")) == year]
	if ctx.query.get("employeeId"):
		rows = [b for b in rows if b.get("employeeId") == ctx.query["employeeId"]]
	employees = {e.get("id"): e for e in s.get("employees") or []}
	types = {t.get("id"): t for t in s.get("leaveTypes") or []}
	enriched = []
	for b in rows:
		emp = employees.get(b.get("employeeId")) or {}
		leave_type = types.get(b.get("leaveTypeId")) or {}
		enriched.append({**b, "employeeName": emp.get("name"), "employeeNumber": emp.get("employeeNumber"),
		                 "leaveTypeName": leave_type.get("name"), "isPaid": leave_type.get("isPaid")})
	return {"data": enriched, "year": year}


@route("POST", r"/leaves/accrue", permission=("leaves", "edit"))
def leave_accrue(ctx):
	year = int(num(ctx.body.get("year")) or datetime.now().year)
	month = int(num(ctx.body.get("month")) or datetime.now().month)
	result = engine.run_leave_accrual(ctx.state, year, month)
	ctx.audit("accrual", "leaves", "leaveBalances", "", "تشغيل استحقاق الإجازات %s/%s — %s قيد" % (month, year, result["entries"]))
	_commit(ctx)
	return {"data": result, "message": "تم إنشاء %s قيد استحقاق" % result["entries"]}


@route("POST", r"/leaves/carry-over", permission=("leaves", "edit"))
def leave_carry_over(ctx):
	from_year = int(num(ctx.body.get("fromYear")) or (datetime.now().year - 1))
	to_year = int(num(ctx.body.get("toYear")) or datetime.now().year)
	result = engine.carry_over_leaves(ctx.state, from_year, to_year)
	ctx.audit("carry_over", "leaves", "leaveBalances", "", "ترحيل أرصدة %s → %s" % (from_year, to_year))
	_commit(ctx)
	return {"data": result, "message": "تم ترحيل أرصدة %s حالة" % result["carried"]}


@route("POST", r"/leaves/adjust", permission=("leaves", "edit"))
def leave_adjust(ctx):
	s = ctx.state
	body = ctx.body
	employee_id, leave_type_id = body.get("employeeId"), body.get("leaveTypeId")
	if not employee_id or not leave_type_id:
		raise ApiError("الموظف ونوع الإجازة مطلوبان")
	year = int(num(body.get("year")) or datetime.now().year)
	balance = engine.ensure_balance(s, employee_id, leave_type_id, year)
	value = num(body.get("days"))
	balance["adjusted"] = round2(num(balance.get("adjusted")) + value)
	balance["balance"] = round2(num(balance.get("balance")) + value)
	balance["updatedAt"] = engine._now()
	s.setdefault("leaveLedger", []).append({
		"id": uid("ll_"), "employeeId": employee_id, "leaveTypeId": leave_type_id, "year": year,
		"date": today_iso(), "type": "adjustment", "days": value,
		"notes": body.get("reason") or "تسوية يدوية", "createdBy": ctx.user.get("name"), "createdAt": engine._now()})
	ctx.audit("adjust", "leaves", "leaveBalances", balance["id"], "تسوية رصيد %s يوم" % value)
	_commit(ctx)
	return {"data": balance, "message": "تم تعديل الرصيد"}


# ═════════ الرواتب ═════════
@route("GET", r"/payroll/settings", permission=("payroll", "view"))
def payroll_settings(ctx):
	return {"data": ctx.state.get("payrollSettings"), "leavePolicy": ctx.state.get("leavePolicy")}


@route("PUT", r"/payroll/settings", permission=("payroll", "edit"))
def payroll_settings_save(ctx):
	s = ctx.state
	body = ctx.body
	s["payrollSettings"] = {**(s.get("payrollSettings") or {}), **(body.get("payrollSettings") or {})}
	if body.get("leavePolicy"):
		s["leavePolicy"] = {**(s.get("leavePolicy") or {}), **body["leavePolicy"]}
	ctx.audit("update", "payroll", "payrollSettings", "", "تحديث إعدادات الرواتب")
	_commit(ctx)
	return {"data": s["payrollSettings"], "leavePolicy": s["leavePolicy"], "message": "تم حفظ إعدادات الرواتب"}


@route("POST", r"/payroll/periods", permission=("payroll", "add"))
def payroll_create_period(ctx):
	s = ctx.state
	body = ctx.body
	year = int(num(body.get("year")) or datetime.now().year)
	month = int(num(body.get("month")) or datetime.now().month)
	range_ = {"from": date_only(body.get("fromDate")), "to": date_only(body.get("toDate"))} if body.get("fromDate") and body.get("toDate") else month_range(year, month)
	if range_["to"] < range_["from"]:
		raise ApiError("نطاق الفترة غير صحيح")
	if any(num(p.get("month")) == month and num(p.get("year")) == year for p in s.get("payrollPeriods") or []):
		raise ApiError("توجد فترة رواتب لهذا الشهر بالفعل")
	period = {"id": uid("pp_"), "name": body.get("name") or "رواتب %s/%s" % (month, year),
	          "month": month, "year": year, "fromDate": range_["from"], "toDate": range_["to"],
	          "status": "open", "createdBy": ctx.user.get("name"), "createdAt": engine._now()}
	s.setdefault("payrollPeriods", []).append(period)
	ctx.audit("create", "payroll", "payrollPeriods", period["id"], "إنشاء فترة %s" % period["name"])
	_commit(ctx)
	return {"data": period, "message": "تم إنشاء فترة الرواتب"}


@route("POST", r"/payroll/periods/(?P<period_id>[^/]+)/close", permission=("payroll", "edit"))
def payroll_close_period(ctx, period_id):
	period = next((p for p in ctx.state.get("payrollPeriods") or [] if p.get("id") == period_id), None)
	if not period:
		raise ApiError("الفترة غير موجودة", 404)
	slips = [p for p in ctx.state.get("payslips") or [] if p.get("periodId") == period_id]
	if any(p.get("status") == "draft" for p in slips):
		raise ApiError("لا يمكن إغلاق الفترة قبل اعتماد كل الكشوف")
	period.update({"status": "closed", "closedBy": ctx.user.get("name"), "closedAt": engine._now()})
	ctx.audit("close", "payroll", "payrollPeriods", period_id, "إغلاق فترة الرواتب")
	_commit(ctx)
	return {"data": period, "message": "تم إغلاق فترة الرواتب"}


def _period_or_preview(ctx):
	s = ctx.state
	body = ctx.body
	period = next((p for p in s.get("payrollPeriods") or [] if p.get("id") == body.get("periodId")), None)
	if period:
		return period
	year = int(num(body.get("year")) or datetime.now().year)
	month = int(num(body.get("month")) or datetime.now().month)
	range_ = month_range(year, month)
	return {"id": "preview", "name": "معاينة %s/%s" % (month, year), "month": month, "year": year,
	        "fromDate": range_["from"], "toDate": range_["to"], "status": "preview"}


@route("POST", r"/payroll/preview", permission=("payroll", "view"))
def payroll_preview(ctx):
	s = ctx.state
	period = _period_or_preview(ctx)
	body = ctx.body
	slips = engine.compute_payroll(s, period, {"employeeIds": body.get("employeeIds"),
	                                          "branchId": body.get("branchId"), "departmentId": body.get("departmentId")})
	_commit(ctx)
	return {"data": slips, "period": period, "totals": {
		"employees": len(slips),
		"gross": round2(sum(num(p.get("grossSalary")) for p in slips)),
		"deductions": round2(sum(num(p.get("totalDeductionsAll")) for p in slips)),
		"net": round2(sum(num(p.get("netSalary")) for p in slips)),
		"gosi": round2(sum(num(p.get("gosiEmployeeShare")) for p in slips)),
		"absence": round2(sum(num(p.get("absenceDeduction")) for p in slips)),
		"late": round2(sum(num(p.get("lateDeduction")) for p in slips)),
	}}


@route("POST", r"/payroll/generate", permission=("payroll", "add"))
def payroll_generate(ctx):
	s = ctx.state
	body = ctx.body
	period = next((p for p in s.get("payrollPeriods") or [] if p.get("id") == body.get("periodId")), None)
	if not period:
		raise ApiError("فترة الرواتب غير موجودة", 404)
	if period.get("status") == "closed":
		raise ApiError("الفترة مغلقة ولا يمكن توليد كشوف جديدة")
	mode = body.get("mode") or (s.get("payrollSettings") or {}).get("payslipMode") or "auto"
	if mode == "manual" and not body.get("employeeIds"):
		raise ApiError("اختر الموظفين المطلوب إنشاء كشوف لهم (الوضع اليدوي)")
	slips = engine.compute_payroll(s, period, {"employeeIds": body.get("employeeIds"),
	                                          "branchId": body.get("branchId"), "departmentId": body.get("departmentId")})
	created = updated = 0
	for slip in slips:
		if period.get("status") == "open":
			period["status"] = "draft"
		idx = next((i for i, p in enumerate(s.get("payslips") or []) if p.get("periodId") == period["id"] and p.get("employeeId") == slip["employeeId"]), -1)
		if idx >= 0:
			prev = s["payslips"][idx]
			if prev.get("status") == "paid":
				continue
			slip["id"] = prev.get("id")
			slip["status"] = "approved" if prev.get("status") == "approved" else "draft"
			slip["createdAt"] = prev.get("createdAt")
			s["payslips"][idx] = slip
			updated += 1
		else:
			slip.update({"id": uid("ps_"), "status": "draft", "mode": mode, "createdBy": ctx.user.get("name")})
			s.setdefault("payslips", []).append(slip)
			created += 1
	ctx.audit("generate", "payroll", "payslips", period["id"], "توليد كشوف %s (%s جديد، %s محدّث)" % (period.get("name"), created, updated))
	engine.notify(s, {"key": "payroll-generated:%s:%s" % (period["id"], time.time()), "type": "payroll", "severity": "success",
	                  "title": "تم توليد كشوف الرواتب", "message": "%s: %s كشف راتب" % (period.get("name"), created + updated), "link": "#/payroll"})
	_commit(ctx)
	return {"data": {"created": created, "updated": updated, "period": period}, "message": "تم توليد %s كشف راتب" % (created + updated)}


@route("PUT", r"/payroll/payslips/(?P<slip_id>[^/]+)", permission=("payroll", "edit"))
def payroll_update_payslip(ctx, slip_id):
	s = ctx.state
	slip = next((p for p in s.get("payslips") or [] if p.get("id") == slip_id), None)
	if not slip:
		raise ApiError("الكشف غير موجود", 404)
	if slip.get("status") in ("paid", "approved"):
		raise ApiError("لا يمكن تعديل كشف معتمد أو مدفوع")
	body = ctx.body
	if isinstance(body.get("items"), list):
		slip["items"] = [{"id": item.get("id") or uid("pi_"), "type": "deduction" if item.get("type") == "deduction" else "earning",
		                 "name": item.get("name") or "", "amount": round2(num(item.get("amount"))), "manual": True,
		                 "notes": item.get("notes") or ""} for item in body["items"]]
	if body.get("notes") is not None:
		slip["notes"] = body["notes"]
	if body.get("baseSalary") is not None:
		slip["baseSalary"] = round2(num(body["baseSalary"]))
	period = next((p for p in s.get("payrollPeriods") or [] if p.get("id") == slip.get("periodId")),
	              {"id": slip.get("periodId"), "month": slip.get("month"), "year": slip.get("year"),
	               "fromDate": slip.get("fromDate"), "toDate": slip.get("toDate")})
	emp = next((e for e in s.get("employees") or [] if e.get("id") == slip.get("employeeId")), None)
	if emp:
		recalc = engine.compute_employee_payslip(s, {**emp, "baseSalary": slip.get("baseSalary"), "__items": slip.get("items")}, period)
		recalc.update({"id": slip["id"], "items": slip.get("items"), "status": "draft"})
		recalc["notes"] = body["notes"] if body.get("notes") is not None else slip.get("notes", "")
		slip.clear()
		slip.update(recalc)
	ctx.audit("update", "payroll", "payslips", slip_id, "تعديل كشف راتب يدويًا")
	_commit(ctx)
	return {"data": slip, "message": "تم تحديث الكشف وإعادة الحساب"}


@route("POST", r"/payroll/payslips/(?P<slip_id>[^/]+)/approve", permission=("payroll", "edit"))
def payroll_approve_payslip(ctx, slip_id):
	slip = next((p for p in ctx.state.get("payslips") or [] if p.get("id") == slip_id), None)
	if not slip:
		raise ApiError("الكشف غير موجود", 404)
	slip.update({"status": "approved", "approvedBy": ctx.user.get("name"), "approvedAt": engine._now()})
	ctx.audit("approve", "payroll", "payslips", slip_id, "اعتماد كشف راتب")
	_commit(ctx)
	return {"data": slip, "message": "تم اعتماد الكشف"}


@route("POST", r"/payroll/payslips/(?P<slip_id>[^/]+)/pay", permission=("payroll", "edit"))
def payroll_pay_payslip(ctx, slip_id):
	s = ctx.state
	slip = next((p for p in s.get("payslips") or [] if p.get("id") == slip_id), None)
	if not slip:
		raise ApiError("الكشف غير موجود", 404)
	if slip.get("status") == "paid":
		raise ApiError("الكشف مدفوع بالفعل")
	engine.apply_payroll_deductions(s, [slip], ctx.user)
	slip["status"] = "paid"
	slip["paidDate"] = date_only(ctx.body.get("paymentDate")) or today_iso()
	slip["paymentMethod"] = ctx.body.get("paymentMethod") or "bank"
	s.setdefault("salaryPayments", []).append({
		"id": uid("sp_"), "payslipId": slip["id"], "employeeId": slip.get("employeeId"),
		"employeeName": slip.get("employeeName"), "periodId": slip.get("periodId"),
		"amount": num(slip.get("netSalary")), "paymentMethod": slip["paymentMethod"],
		"paymentDate": slip["paidDate"], "reference": ctx.body.get("reference") or "",
		"notes": ctx.body.get("notes") or "", "status": "paid", "createdAt": engine._now()})
	if (s.get("payrollSettings") or {}).get("journalEntriesEnabled") is not False:
		s.setdefault("journalEntries", []).append({
			"id": uid("je_"), "periodId": slip.get("periodId"), "date": slip["paidDate"],
			"accounts": [
				{"name": "مصروف الرواتب والأجور", "debit": num(slip.get("grossSalary")), "credit": 0},
				{"name": "التأمينات الاجتماعية — حصة الموظف", "debit": 0, "credit": num(slip.get("gosiEmployeeShare"))},
				{"name": "الرواتب المستحقة الدفع", "debit": 0, "credit": num(slip.get("netSalary"))},
			],
			"totalDebit": num(slip.get("grossSalary")),
			"totalCredit": round2(num(slip.get("gosiEmployeeShare")) + num(slip.get("netSalary"))),
			"description": "سداد راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
			"createdBy": ctx.user.get("name"), "status": "posted", "createdAt": engine._now()})
	engine.notify(s, {"key": "payslip-paid:%s" % slip["id"], "type": "payslip", "severity": "success",
	                  "title": "صرف راتب", "message": "تم صرف صافي %s لـ %s" % (round2(num(slip.get("netSalary"))), slip.get("employeeName")),
	                  "link": "#/payroll", "employeeId": slip.get("employeeId")})
	ctx.audit("pay", "payroll", "payslips", slip_id, "صرف راتب %s" % slip.get("employeeName"))
	_commit(ctx)
	return {"data": slip, "message": "تم تسجيل صرف الراتب"}


@route("GET", r"/payroll/eos/(?P<employee_id>[^/]+)", permission=("payroll", "view"))
def payroll_eos_preview(ctx, employee_id):
	return {"data": engine.eos_settlement(ctx.state, employee_id, ctx.query.get("endDate") or today_iso())}


@route("POST", r"/payroll/eos", permission=("payroll", "add"))
def payroll_eos_create(ctx):
	settlement = engine.eos_settlement(ctx.state, ctx.body.get("employeeId"), ctx.body.get("endDate") or today_iso())
	record = {"id": uid("eos_"), **settlement, "status": "calculated",
	          "createdBy": ctx.user.get("name"), "createdAt": engine._now()}
	ctx.state.setdefault("eosSettlements", []).append(record)
	ctx.audit("eos", "payroll", "eosSettlements", record["id"], "تسوية نهاية خدمة %s" % settlement.get("employeeName"))
	_commit(ctx)
	return {"data": record, "message": "تم حساب تسوية نهاية الخدمة"}


# ═════════ التقارير ═════════
@route("GET", r"/reports/catalog", permission=("reports", "view"))
def reports_catalog(ctx):
	return {"data": reports.REPORT_CATALOG, "categories": reports.CATEGORY_LABELS, "columns": reports.COLUMNS}


@route("POST", r"/reports/run", permission=("reports", "view"))
def reports_run(ctx):
	report_id = ctx.body.get("reportId")
	if not any(r["id"] == report_id for r in reports.REPORT_CATALOG):
		raise ApiError("التقرير غير موجود", 404)
	report = reports.run_report(ctx.state, report_id, ctx.body.get("filters") or {}, ctx.body.get("columns"))
	ctx.audit("view", "reports", "reportTemplates", report_id, "تشغيل تقرير %s" % report["title"])
	return {"data": report}


@route("POST", r"/reports/export", permission=("reports", "view"))
def reports_export(ctx):
	report_id = ctx.body.get("reportId")
	if not any(r["id"] == report_id for r in reports.REPORT_CATALOG):
		raise ApiError("التقرير غير موجود", 404)
	report = reports.run_report(ctx.state, report_id, ctx.body.get("filters") or {}, ctx.body.get("columns"))
	columns = report["columns"]
	lines = [",".join(['"%s"' % c["label"].replace('"', "''") for c in columns])]
	for row in report["rows"]:
		lines.append(",".join(['"%s"' % str(row.get(c["key"]) if row.get(c["key"]) is not None else "").replace('"', "''") for c in columns]))
	content = "\ufeff" + "\r\n".join(lines)
	frappe.response["filename"] = "report-%s-%s.csv" % (report_id, time.strftime("%Y%m%d-%H%M%S"))
	frappe.response["filecontent"] = content.encode("utf-8")
	frappe.response["type"] = "download"
	return None


# ═════════ الإشعارات ═════════
def _visible_notifications(user, rows):
	broad = has_permission(user, "employees", "view") or has_permission(user, "payroll", "view") or user.get("role") == "admin"
	if broad:
		return rows
	return [n for n in rows if not n.get("employeeId") or (user.get("employeeId") and n.get("employeeId") == user.get("employeeId"))]


@route("GET", r"/notifications")
def notifications_list(ctx):
	rows = _visible_notifications(ctx.user, ctx.state.get("notifications") or [])
	if ctx.query.get("unread") == "1":
		rows = [n for n in rows if not n.get("read")]
	rows = [n for n in rows if not n.get("dismissed")]
	return {"data": list(reversed(rows))[:300]}


@route("POST", r"/notifications/scan")
def notifications_scan(ctx):
	result = engine.scan_notifications(ctx.state, ctx.user)
	_commit(ctx)
	return {"data": result, "message": "تم فحص الإشعارات الذكية"}


@route("POST", r"/notifications/read-all")
def notifications_read_all(ctx):
	for n in ctx.state.get("notifications") or []:
		n["read"] = True
	_commit(ctx)
	return {"ok": True}


@route("POST", r"/notifications/(?P<note_id>[^/]+)/read")
def notification_read(ctx, note_id):
	n = next((x for x in ctx.state.get("notifications") or [] if x.get("id") == note_id), None)
	if not n:
		raise ApiError("الإشعار غير موجود", 404)
	n.update({"read": True, "readAt": engine._now()})
	_commit(ctx)
	return {"data": n}


@route("DELETE", r"/notifications/(?P<note_id>[^/]+)")
def notification_dismiss(ctx, note_id):
	n = next((x for x in ctx.state.get("notifications") or [] if x.get("id") == note_id), None)
	if n:
		n["dismissed"] = True
		_commit(ctx)
	return {"ok": True}


# ═════════ المهام والطلبات ═════════
TASK_STATUS_LABELS = {"new": "جديدة", "in_progress": "قيد التنفيذ", "on_hold": "معلّقة", "completed": "مكتملة", "cancelled": "ملغاة"}
REQUEST_TYPE_LABELS = {"leave": "طلب إجازة", "advance": "طلب سلفة", "complaint": "شكوى / ملاحظة", "other": "طلب عام"}


@route("POST", r"/tasks/(?P<task_id>[^/]+)/progress")
def task_progress(ctx, task_id):
	s = ctx.state
	task = next((t for t in s.get("tasks") or [] if t.get("id") == task_id), None)
	if not task:
		raise ApiError("المهمة غير موجودة", 404)
	is_assignee = ctx.user.get("employeeId") and task.get("employeeId") == ctx.user.get("employeeId")
	if not is_assignee and not has_permission(ctx.user, "tasks", "edit"):
		raise ApiError("لا تملك صلاحية تحديث هذه المهمة", 403)
	body = ctx.body
	progress = num(task.get("progress")) if body.get("progress") is None else max(0, min(100, round2(num(body.get("progress")))))
	status = body.get("status") or ("completed" if progress >= 100 else "in_progress" if progress > 0 else task.get("status") or "new")
	task.update({"progress": progress, "status": status, "updatedAt": engine._now(), "updatedBy": ctx.user.get("name")})
	task["completedAt"] = (task.get("completedAt") or engine._now()) if status == "completed" else ""
	if body.get("note"):
		s.setdefault("taskComments", []).append({
			"id": uid("tc_"), "taskId": task["id"], "note": str(body["note"])[:1000], "progress": progress, "status": status,
			"authorId": ctx.user.get("id"), "authorName": ctx.user.get("name"), "createdAt": engine._now()})
	ctx.audit("progress", "tasks", "tasks", task_id, "تحديث إنجاز «%s» إلى %s%%" % (task.get("title"), progress))
	engine.notify(s, {"key": "task-progress:%s:%s" % (task_id, progress), "type": "task",
	                  "severity": "success" if status == "completed" else "info",
	                  "title": "اكتملت مهمة" if status == "completed" else "تحديث إنجاز مهمة",
	                  "message": "%s: «%s» — %s%% (%s)" % (task.get("employeeName") or "", task.get("title"), progress, TASK_STATUS_LABELS.get(status, status)),
	                  "link": "#/tasks", "employeeId": task.get("employeeId")})
	_commit(ctx)
	return {"data": task, "message": "تم تحديث نسبة الإنجاز"}


@route("GET", r"/tasks/(?P<task_id>[^/]+)/timeline")
def task_timeline(ctx, task_id):
	s = ctx.state
	task = next((t for t in s.get("tasks") or [] if t.get("id") == task_id), None)
	if not task:
		raise ApiError("المهمة غير موجودة", 404)
	if not has_permission(ctx.user, "tasks", "view") and task.get("employeeId") != ctx.user.get("employeeId"):
		raise ApiError("لا تملك صلاحية عرض هذه المهمة", 403)
	comments = [c for c in s.get("taskComments") or [] if c.get("taskId") == task_id]
	return {"data": {"task": task, "comments": comments}}


@route("GET", r"/self/overview")
def self_overview(ctx):
	s = ctx.state
	emp_id = ctx.user.get("employeeId")
	if not emp_id:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	year = datetime.now().year
	return {"data": {
		"tasks": [t for t in s.get("tasks") or [] if t.get("employeeId") == emp_id],
		"requests": list(reversed([r for r in s.get("selfRequests") or [] if r.get("employeeId") == emp_id])),
		"leaveRequests": list(reversed([r for r in s.get("leaveRequests") or [] if r.get("employeeId") == emp_id]))[:20],
		"balances": [b for b in s.get("leaveBalances") or [] if b.get("employeeId") == emp_id and num(b.get("year")) == year],
		"payslips": list(reversed([p for p in s.get("payslips") or [] if p.get("employeeId") == emp_id]))[:12],
		"advances": [a for a in s.get("advances") or [] if a.get("employeeId") == emp_id and a.get("status") != "closed"],
	}}


@route("POST", r"/self/requests")
def self_create_request(ctx):
	s = ctx.state
	body = ctx.body
	emp = engine.find_employee(s, ctx.user.get("employeeId") or body.get("employeeId"))
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	type_ = body.get("type") if body.get("type") in ("advance", "complaint", "other", "leave") else "other"
	if type_ == "advance":
		amount = num(body.get("amount"))
		if amount <= 0:
			raise ApiError("أدخل مبلغ السلفة المطلوب")
		max_percent = num((s.get("payrollSettings") or {}).get("advanceMaxPercentOfSalary"), 30)
		if max_percent > 0 and amount > round2(num(emp.get("baseSalary")) * max_percent / 100.0):
			raise ApiError("الحد الأقصى للسلفة %s%% من الراتب الأساسي" % max_percent)
		if any(r.get("employeeId") == emp["id"] and r.get("type") == "advance" and r.get("status") == "pending" for r in s.get("selfRequests") or []):
			raise ApiError("لديك طلب سلفة قيد المراجعة بالفعل")
	if type_ != "advance" and not str(body.get("details") or "").strip():
		raise ApiError("اكتب تفاصيل الطلب")
	request = {
		"id": uid("sr_"), "type": type_, "employeeId": emp["id"], "employeeName": emp.get("name"),
		"branchId": emp.get("branchId") or "",
		"subject": str(body.get("subject") or REQUEST_TYPE_LABELS[type_])[:200],
		"details": str(body.get("details") or "")[:3000],
		"amount": round2(num(body.get("amount"))) if type_ == "advance" else 0,
		"monthlyDeduction": round2(num(body.get("monthlyDeduction"))) if type_ == "advance" else 0,
		"priority": body.get("priority") if body.get("priority") in ("low", "normal", "high", "urgent") else "normal",
		"status": "pending", "createdAt": engine._now(), "createdBy": ctx.user.get("name"),
	}
	s.setdefault("selfRequests", []).append(request)
	engine.notify(s, {"key": "selfreq-new:%s" % request["id"], "type": "self_request", "severity": "info",
	                  "title": "طلب جديد: %s" % REQUEST_TYPE_LABELS[type_],
	                  "message": "%s — %s%s" % (emp.get("name"), request["subject"],
	                                            (" بمبلغ %s" % request["amount"]) if request["amount"] else ""),
	                  "link": "#/tasks"})
	ctx.audit("create", "tasks", "selfRequests", request["id"], "%s من %s" % (REQUEST_TYPE_LABELS[type_], emp.get("name")))
	_commit(ctx)
	return {"data": request, "message": "تم إرسال طلبك بنجاح، وستُبلّغ بالنتيجة عبر الإشعارات"}


@route("PUT", r"/self/requests/(?P<req_id>[^/]+)/review", permission=("tasks", "edit"))
def self_review_request(ctx, req_id):
	s = ctx.state
	request = next((r for r in s.get("selfRequests") or [] if r.get("id") == req_id), None)
	if not request:
		raise ApiError("الطلب غير موجود", 404)
	body = ctx.body
	if body.get("status") not in ("approved", "rejected"):
		raise ApiError("الحالة غير صحيحة")
	request.update({"status": body["status"], "reviewedBy": ctx.user.get("name"),
	                "reviewedAt": engine._now(), "reviewNote": str(body.get("note") or "")[:1000]})
	if body["status"] == "approved" and request.get("type") == "advance":
		emp = engine.find_employee(s, request.get("employeeId")) or {}
		s.setdefault("advances", []).append({
			"id": uid("adv_"), "employeeId": request.get("employeeId"),
			"employeeName": emp.get("name") or request.get("employeeName"),
			"totalAmount": request.get("amount"), "remainingAmount": request.get("amount"),
			"monthlyDeduction": request.get("monthlyDeduction") or round2(num(request.get("amount")) / 10.0),
			"status": "active", "requestId": request["id"], "notes": request.get("details") or "",
			"createdAt": engine._now(), "createdBy": ctx.user.get("name")})
	engine.notify(s, {"key": "selfreq-%s:%s" % (body["status"], req_id), "type": "self_request",
	                  "severity": "success" if body["status"] == "approved" else "warning",
	                  "title": "اعتماد طلبك" if body["status"] == "approved" else "رفض طلبك",
	                  "message": "%s — %s" % (REQUEST_TYPE_LABELS.get(request.get("type"), ""),
	                                          "تم الاعتماد" if body["status"] == "approved" else "تم الرفض"),
	                  "link": "#/self", "employeeId": request.get("employeeId")})
	ctx.audit("approve" if body["status"] == "approved" else "reject", "tasks", "selfRequests", req_id,
	          REQUEST_TYPE_LABELS.get(request.get("type"), ""))
	_commit(ctx)
	return {"data": request, "message": "تم اعتماد الطلب" if body["status"] == "approved" else "تم رفض الطلب"}


# ═════════ المستخدمون والتدقيق ═════════
@route("GET", r"/users", permission=("users", "view"))
def users_list(ctx):
	return {"data": [sanitize_user(u) for u in ctx.state.get("users") or []], "roles": ROLE_PRESETS, "modules": MODULES}


@route("POST", r"/users/(?P<user_id>[^/]+)/reset-password", permission=("users", "edit"))
def users_reset_password(ctx, user_id):
	user = next((u for u in ctx.state.get("users") or [] if u.get("id") == user_id), None)
	if not user:
		raise ApiError("المستخدم غير موجود", 404)
	issues = password_issues(ctx.body.get("password"), user.get("username"))
	if issues:
		raise ApiError(" — ".join(issues))
	user["passwordHash"] = hash_password(ctx.body["password"])
	user.pop("password", None)
	user["mustChangePassword"] = True
	ctx.audit("reset_password", "users", "users", user_id, "إعادة تعيين كلمة المرور")
	_commit(ctx)
	return {"ok": True, "message": "تم إعادة تعيين كلمة المرور"}


@route("GET", r"/audit", permission=("audit", "view"))
def audit_list(ctx):
	rows = list(reversed(ctx.state.get("auditLog") or []))
	if ctx.query.get("module"):
		rows = [r for r in rows if r.get("module") == ctx.query["module"]]
	if ctx.query.get("userId"):
		rows = [r for r in rows if r.get("userId") == ctx.query["userId"]]
	if ctx.query.get("from"):
		rows = [r for r in rows if r.get("at", "") >= date_only(ctx.query["from"])]
	limit = int(num(ctx.query.get("limit")) or 500)
	return {"data": rows[:limit]}


# ═════════ الإعدادات وقاعدة البيانات ═════════
@route("GET", r"/settings", permission=("settings", "view"))
def settings_get(ctx):
	return {"data": ctx.state.get("settings")}


@route("PUT", r"/settings", permission=("settings", "edit"))
def settings_save(ctx):
	s = ctx.state
	body = ctx.body or {}
	payload = body.get("settings", body)
	s["settings"] = {**(s.get("settings") or {}), **(payload or {})}
	if isinstance(payload, dict) and isinstance(payload.get("notifications"), dict):
		s["settings"]["notifications"] = {**((s.get("settings") or {}).get("notifications") or {}), **payload["notifications"]}
	ctx.audit("update", "settings", "settings", "", "تحديث إعدادات النظام")
	_commit(ctx)
	return {"data": s["settings"], "message": "تم حفظ الإعدادات"}


@route("GET", r"/system/network", permission=("settings", "view"))
def system_network(ctx):
	return {"data": {"host": frappe.local.site, "serverTime": engine._now(), "db": "mariadb"}}


@route("GET", r"/db/status", permission=("settings", "view"))
def db_status(ctx):
	counts = {key: len(ctx.state.get(key) or []) for key in ("employees", "payslips", "attendanceDaily", "auditLog")}
	return {"data": {"type": "frappe", "encryptAtRest": True, "lastSavedAt": engine._now(),
	                 "backups": [], "counts": counts, "config": {"type": "frappe"},
	                 "supported": [{"type": "frappe", "name": "قاعدة بيانات الفرابي (MariaDB)",
	                                "description": "التخزين يتم داخل الموقع مباشرة"}]}}


@route("POST", r"/db/test", permission=("settings", "edit"))
def db_test(ctx):
	return {"data": {"ok": True, "message": "التخزين داخل قاعدة بيانات الفرابي جاهز"}, "message": "التخزين داخل قاعدة بيانات الفرابي جاهز"}


@route("POST", r"/db/backup", permission=("settings", "edit"))
def db_backup(ctx):
	payload = json.dumps(ctx.state, ensure_ascii=False)
	frappe.response["filename"] = "tageephr-backup-%s.json" % time.strftime("%Y%m%d-%H%M%S")
	frappe.response["filecontent"] = payload.encode("utf-8")
	frappe.response["type"] = "download"
	ctx.audit("backup", "settings", "settings", "", "تنزيل نسخة احتياطية")
	_commit(ctx)
	return None


# ═════════ CRUD عام للمجموعات ═════════
def _collection_module(name):
	return COLLECTION_MODULE.get(name)


@route("GET", r"/collections/(?P<name>[^/]+)")
def collection_list(ctx, name):
	module = _collection_module(name)
	if not module:
		raise ApiError("المجموعة غير موجودة", 404)
	if name not in PROTECTED_COLLECTIONS:
		ctx.require_permission(module, "view")
	else:
		ctx.require_permission("audit" if name == "auditLog" else "notifications", "view")
	rows = ctx.state.get(name)
	if isinstance(rows, dict):
		return {"data": rows}
	rows = list(rows or [])
	for key in ("employeeId", "branchId", "departmentId", "status", "month", "year"):
		if ctx.query.get(key):
			rows = [r for r in rows if str(r.get(key)) == str(ctx.query[key])]
	if ctx.query.get("q"):
		q = str(ctx.query["q"])
		rows = [r for r in rows if q in json.dumps(r, ensure_ascii=False)]
	return {"data": rows}


@route("POST", r"/collections/(?P<name>[^/]+)")
def collection_create(ctx, name):
	module = _collection_module(name)
	if not module:
		raise ApiError("المجموعة غير موجودة", 404)
	ctx.require_permission(module, "add")
	if name in SERVER_ONLY:
		raise ApiError("هذه المجموعة للنظام فقط", 403)
	payload = _normalize_record(name, ctx.body)
	if not payload.get("id"):
		payload["id"] = uid("%s_" % name[:2])
	payload.setdefault("createdAt", engine._now())
	payload["createdBy"] = ctx.user.get("name")
	_validate_record(ctx.state, name, payload)
	container = ctx.state.setdefault(name, [])
	if isinstance(container, dict):
		raise ApiError("لا يمكن الإضافة لهذه المجموعة")
	container.append(payload)
	ctx.audit("create", module, name, payload["id"], "إضافة سجل %s" % name)
	_commit(ctx)
	return {"data": payload, "message": "تمت الإضافة بنجاح"}


@route("PUT", r"/collections/(?P<name>[^/]+)/(?P<record_id>[^/]+)")
def collection_update(ctx, name, record_id):
	module = _collection_module(name)
	if not module:
		raise ApiError("المجموعة غير موجودة", 404)
	ctx.require_permission(module, "edit")
	if name in SERVER_ONLY or (name in PROTECTED_COLLECTIONS and not has_permission(ctx.user, module, "edit")):
		raise ApiError("لا يمكن تعديل هذه المجموعة", 403)
	rows = ctx.state.get(name)
	if isinstance(rows, dict):
		payload = _normalize_record(name, ctx.body, rows)
		rows.update(payload)
		_commit(ctx)
		return {"data": rows, "message": "تم الحفظ"}
	record = next((r for r in rows or [] if r.get("id") == record_id), None)
	if not record:
		if name == "settings":
			ctx.state[name] = _normalize_record(name, ctx.body)
			_commit(ctx)
			return {"data": ctx.state[name], "message": "تم الحفظ"}
		raise ApiError("السجل غير موجود", 404)
	payload = _normalize_record(name, ctx.body, record)
	payload["id"] = record_id
	payload["updatedAt"] = engine._now()
	_validate_record(ctx.state, name, payload, record_id)
	record.update(payload)
	ctx.audit("update", module, name, record_id, "تعديل سجل %s" % name)
	_commit(ctx)
	return {"data": record, "message": "تم الحفظ بنجاح"}


@route("DELETE", r"/collections/(?P<name>[^/]+)/(?P<record_id>[^/]+)")
def collection_delete(ctx, name, record_id):
	module = _collection_module(name)
	if not module:
		raise ApiError("المجموعة غير موجودة", 404)
	ctx.require_permission(module, "delete")
	if name in SERVER_ONLY:
		raise ApiError("هذه المجموعة للنظام فقط", 403)
	rows = ctx.state.get(name)
	if isinstance(rows, dict):
		raise ApiError("لا يمكن الحذف من هذه المجموعة")
	before = len(rows or [])
	ctx.state[name] = [r for r in rows or [] if r.get("id") != record_id]
	if len(ctx.state[name]) == before:
		raise ApiError("السجل غير موجود", 404)
	ctx.audit("delete", module, name, record_id, "حذف سجل %s" % name)
	_commit(ctx)
	return {"ok": True, "message": "تم الحذف"}


def _normalize_record(name, payload, existing=None):
	import copy

	copy_payload = copy.deepcopy(payload or {})
	copy_payload.pop("__proto__", None)
	copy_payload.pop("__v", None)
	if name == "users":
		if copy_payload.get("password"):
			issues = password_issues(copy_payload["password"], copy_payload.get("username"))
			if issues:
				raise ApiError(" — ".join(issues))
			copy_payload["passwordHash"] = hash_password(copy_payload["password"])
			copy_payload.pop("password", None)
		if not copy_payload.get("username") and copy_payload.get("name"):
			copy_payload["username"] = copy_payload["name"]
		if existing and existing.get("id"):
			copy_payload["id"] = existing["id"]
		if not isinstance(copy_payload.get("permissions"), dict):
			copy_payload["permissions"] = {}
		copy_payload.setdefault("active", True)
	if name == "employees":
		for key in ("baseSalary", "wage", "leaveBalance", "gosiBase"):
			if copy_payload.get(key) not in (None, ""):
				copy_payload[key] = num(copy_payload[key])
	return copy_payload


def _validate_record(state, name, record, existing_id=None):
	if name == "employees":
		if not str(record.get("name") or "").strip():
			raise ApiError("اسم الموظف مطلوب")
		if record.get("employeeNumber"):
			dup = next((e for e in state.get("employees") or [] if e.get("employeeNumber") == record["employeeNumber"] and e.get("id") != existing_id), None)
			if dup:
				raise ApiError("رقم الموظف مستخدم بالفعل للموظف: %s" % dup.get("name"))
		if record.get("nationalId"):
			dup = next((e for e in state.get("employees") or [] if e.get("nationalId") == record["nationalId"] and e.get("id") != existing_id), None)
			if dup:
				raise ApiError("رقم الهوية مسجل بالفعل للموظف: %s" % dup.get("name"))
		if record.get("email") and not re.search(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(record["email"])):
			raise ApiError("صيغة البريد الإلكتروني غير صحيحة")
		if record.get("baseSalary") is not None and num(record.get("baseSalary")) < 0:
			raise ApiError("الراتب لا يمكن أن يكون سالبًا")
		if record.get("joinDate") and record.get("terminationDate") and record["terminationDate"] < record["joinDate"]:
			raise ApiError("تاريخ نهاية الخدمة قبل تاريخ التعيين")
	if name == "users":
		if not record.get("name"):
			raise ApiError("اسم المستخدم مطلوب")
		if not record.get("username"):
			raise ApiError("اسم الدخول مطلوب")
		dup = next((u for u in state.get("users") or []
		            if str(u.get("username") or "").lower() == str(record["username"]).lower() and u.get("id") != existing_id), None)
		if dup:
			raise ApiError("اسم الدخول مستخدم بالفعل")
		if record.get("role") not in ROLE_PRESETS:
			raise ApiError("الدور غير صالح")
	if name == "leaveTypes":
		if not record.get("name"):
			raise ApiError("اسم نوع الإجازة مطلوب")
		if num(record.get("daysPerYear")) < 0:
			raise ApiError("عدد الأيام لا يمكن أن يكون سالبًا")
	if name in ("branches", "departments") and not record.get("name"):
		raise ApiError("اسم الفرع/القسم مطلوب")


# ═════════ توافق خلفي ═════════
@route("GET", r"/method/tageep\.api\.get_state")
def compat_get_state(ctx):
	return {"message": ctx.state}


@route("POST", r"/method/tageep\.api\.save_state", permission=("employees", "edit"))
def compat_save_state(ctx):
	incoming = ctx.body.get("state") or ctx.body
	if isinstance(incoming, dict):
		for key, value in incoming.items():
			if key in ctx.state:
				ctx.state[key] = value
		_commit(ctx)
	return {"message": {"ok": True}}


@route("GET", r"/method/tageep\.api\.license_status", auth=False)
def compat_license(ctx):
	return {"message": {"active": True, "type": "enterprise", "expiresAt": None}}


@route("POST", r"/method/tageep\.api\.activate_license", auth=False)
def compat_activate(ctx):
	return {"message": {"active": True}}


# ═════════ المُوزّع ═════════
@frappe.whitelist(allow_guest=True)
def dispatch(path=None):
	"""نقطة الدخول الوحيدة لواجهة Tageep HRMS."""
	request = frappe.local.request
	method = (request.method or "GET").upper()
	path = path or request.args.get("path") or ""
	query_string = ""
	if "?" in path:
		path, _, query_string = path.partition("?")
	if path and not path.startswith("/"):
		path = "/" + path
	body = {}
	if request.data:
		try:
			raw = request.data.decode("utf-8") if isinstance(request.data, bytes) else request.data
			body = json.loads(raw)
		except Exception:
			body = {}
	if isinstance(body, dict) and isinstance(body.get("body"), dict):
		body = body["body"]
	query = dict(request.args or {})
	query.pop("path", None)
	if query_string:
		for pair in query_string.split("&"):
			if not pair:
				continue
			key, _, value = pair.partition("=")
			query[urllib.parse.unquote(key)] = urllib.parse.unquote(value.replace("+", " "))

	state = store.load_state()
	ctx = Ctx(method, path, body, query, state)

	try:
		public = (method, path) in (("GET", "/auth/setup-status"), ("POST", "/auth/setup"), ("POST", "/auth/login"))
		if not public:
			_current_user(ctx)
		for route_method, pattern, handler, needs_auth, permission in ROUTES:
			if route_method != method:
				continue
			match = pattern.match(path)
			if not match:
				continue
			if permission and not has_permission(ctx.user, permission[0], permission[1]):
				raise ApiError("لا تملك صلاحية لهذا الإجراء", 403)
			result = handler(ctx, **match.groupdict())
			if result is None:
				return
			return result
		raise ApiError("المسار غير موجود", 404)
	except ApiError as exc:
		frappe.local.response["http_status_code"] = exc.status
		return {"__error": exc.message, "status": exc.status}
	except Exception as exc:
		frappe.log_error(frappe.get_traceback(), "TageepHR API %s %s" % (method, path))
		frappe.local.response["http_status_code"] = 500
		return {"__error": str(exc)[:300], "status": 500}


@frappe.whitelist(allow_guest=True)
def ping():
	return {"ok": True, "app": "tageephr"}
