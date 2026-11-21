"""واجهة نظام Tageep HRMS داخل الفرابي — ترجمة لمسارات hrpro/src/api.js."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import urllib.parse
from datetime import datetime

import frappe
from frappe import _

from . import accounting, engine, files, reports, store
from .defaults import DEFAULT_SETTINGS, LEVELS, MODULES, ROLE_PRESETS
from .utils import (
	date_only, hash_password, is_legacy_plain, month_range, num, pad2, round2, sign_token,
	today_iso, uid, verify_password, verify_token,
)

MAX_ATTEMPTS = 6
LOCK_WINDOW = 15 * 60
PROTECTED_COLLECTIONS = {"auditLog", "notifications"}
SERVER_ONLY = {"auditLog"}

COLLECTION_MODULE = {
	"employees": "employees", "employeeDocuments": "employees", "contracts": "employees",
	"employeeTransfers": "employees", "employeePromotions": "employees",
	"fingerprintCommands": "attendance",
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
	"accounts": "accounts", "vouchers": "accounts",
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
@route("GET", r"/license/status", auth=False)
def license_status(ctx):
	return {"data": {"active": True, "type": "enterprise", "expiresAt": None}, "active": True,
	        "message": {"active": True, "type": "enterprise", "expiresAt": None}}


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
	preset = ROLE_PRESETS.get(user.get("role")) or {}
	self_only = bool(preset.get("selfOnly"))
	# دور الخدمة الذاتية (employee) يرى ملفه هو فقط، وليس كل موظفي فرعه
	can_view_employees = has_permission(user, "employees", "view") or (has_permission(user, "self", "view") and not self_only)
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
		"settings": ({k: v for k, v in (s.get("settings") or {}).items() if k != "fingerprintDevice"}
		             if not has_permission(user, "attendance", "view") else s.get("settings")),
		"branches": s.get("branches"), "departments": s.get("departments"),
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
		"transfers": sorted([t for t in s.get("employeeTransfers") or [] if t.get("employeeId") == emp["id"]],
		                    key=lambda t: t.get("createdAt") or "", reverse=True)[:20],
		"promotions": sorted([p for p in s.get("employeePromotions") or [] if p.get("employeeId") == emp["id"]],
		                     key=lambda p: p.get("createdAt") or "", reverse=True)[:20],
	}


@route("GET", r"/employees/next-number", permission=("employees", "add"))
def employee_next_number(ctx):
	numbers = [int(e["employeeNumber"]) for e in ctx.state.get("employees") or []
	           if str(e.get("employeeNumber") or "").isdigit()]
	return {"next": str((max(numbers) + 1) if numbers else 1).zfill(4)}


# ═════════ نقل الموظفين والترقيات ═════════
TRANSFER_FIELDS = ("branchId", "departmentId", "jobTitle")
PROMOTION_TYPES = {
	"promotion": "ترقية", "salary": "زيادة راتب", "allowance": "زيادة بدل",
	"grade": "تغيير رتبة", "position": "تغيير مسمى وظيفي", "mixed": "ترقية وزيادة",
}


def _branch_label(state, branch_id):
	return next((b.get("name") for b in state.get("branches") or [] if b.get("id") == branch_id), "") or ""


def _dept_label(state, dept_id):
	return next((d.get("name") for d in state.get("departments") or [] if d.get("id") == dept_id), "") or ""


def _active_branch(state, branch_id):
	return next((b for b in state.get("branches") or []
	             if b.get("id") == branch_id and b.get("active") is not False), None)


def _flag(value, default=True):
	if value is None:
		return default
	if isinstance(value, str):
		return value.strip().lower() not in ("", "0", "false", "no", "off")
	return bool(value)


def _queue_fingerprint_enroll(state, emp, branch_id, transfer_id=""):
	"""يضع أمر إضافة رقم بصمة الموظف في طابور أوامر جهاز الفرع الجديد.

	وسيط البصمة في الفرع يسحب الأوامر تلقائيًا من /fingerprint/commands ثم ينفذها
	على جهاز ذلك الفرع ويؤكدها عبر /fingerprint/commands/<id>/ack.
	"""
	pin = str(emp.get("fingerprintId") or emp.get("employeeNumber") or "").strip()
	if not pin:
		return {"status": "no_pin", "message": "لا يوجد رقم بصمة أو رقم وظيفي للموظف"}
	devices = [d for d in state.get("fingerprintDevices") or [] if d.get("branchId") == branch_id]
	device = devices[0] if devices else {}
	command = {
		"id": uid("fc_"), "action": "enroll_fingerprint", "branchId": branch_id,
		"deviceId": device.get("sn") or device.get("deviceIp") or device.get("id") or "",
		"pin": pin, "name": emp.get("name") or "", "employeeId": emp.get("id") or "",
		"employeeName": emp.get("name") or "", "employeeNumber": emp.get("employeeNumber") or "",
		"fingerprintId": emp.get("fingerprintId") or "", "transferId": transfer_id,
		"status": "pending", "attempts": 0, "message": "", "createdAt": engine._now(),
	}
	state.setdefault("fingerprintCommands", []).append(command)
	return {"status": "queued", "commandId": command["id"], "pin": pin, "deviceId": command["deviceId"],
	        "message": "تمت جدولة إضافة رقم البصمة %s إلى جهاز فرع %s" % (pin, _branch_label(state, branch_id))}


@route("POST", r"/employees/(?P<emp_id>[^/]+)/transfer", permission=("employees", "edit"))
def employee_transfer(ctx, emp_id):
	s = ctx.state
	emp = engine.find_employee(s, emp_id)
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	ctx.scope_branch(emp.get("branchId"))
	if emp.get("status") == "terminated":
		raise ApiError("لا يمكن نقل موظف منتهي الخدمة")
	body = ctx.body
	target = str(body.get("branchId") or "").strip()
	if not target:
		raise ApiError("الفرع الجديد مطلوب")
	if not _active_branch(s, target):
		raise ApiError("الفرع الجديد غير موجود أو غير نشط")
	if target == emp.get("branchId"):
		raise ApiError("الموظف موجود بالفعل في هذا الفرع")
	ctx.scope_branch(target)

	before = {key: emp.get(key) or "" for key in TRANSFER_FIELDS}
	emp["branchId"] = target
	for key in TRANSFER_FIELDS[1:]:
		value = body.get(key)
		if value not in (None, ""):
			emp[key] = value
	emp["branchChangedAt"] = engine._now()

	effective = date_only(body.get("effectiveDate") or today_iso())
	transfer = {
		"id": uid("tr_"), "employeeId": emp["id"], "employeeName": emp.get("name") or "",
		"employeeNumber": emp.get("employeeNumber") or "",
		"branchId": target,
		"fromBranchId": before["branchId"], "fromBranchName": _branch_label(s, before["branchId"]),
		"toBranchId": target, "toBranchName": _branch_label(s, target),
		"fromDepartmentId": before["departmentId"], "fromDepartmentName": _dept_label(s, before["departmentId"]),
		"toDepartmentId": emp.get("departmentId") or "", "toDepartmentName": _dept_label(s, emp.get("departmentId")),
		"fromJobTitle": before["jobTitle"], "toJobTitle": emp.get("jobTitle") or "",
		"effectiveDate": effective, "reason": body.get("reason") or "", "notes": body.get("notes") or "",
		"status": "applied", "fingerprint": {"status": "disabled", "message": "لم تُطلب مزامنة البصمة"},
		"createdAt": engine._now(), "createdBy": ctx.user.get("name") or "",
	}
	s.setdefault("employeeTransfers", []).append(transfer)

	if _flag(body.get("syncFingerprint"), True):
		transfer["fingerprint"] = _queue_fingerprint_enroll(s, emp, target, transfer["id"])

	engine.add_audit(s, {
		"userId": ctx.user.get("id"), "userName": ctx.user.get("name"), "action": "employee_transfer",
		"module": "employees", "collection": "employees", "recordId": emp["id"],
		"details": "نقل %s من %s إلى %s" % (emp.get("name"), transfer["fromBranchName"], transfer["toBranchName"]),
		"ip": getattr(frappe.local, "request", None) and frappe.local.request.remote_addr or "",
	})
	engine.notify(s, {
		"key": "transfer:%s" % transfer["id"], "type": "employee_transfer", "severity": "info",
		"title": "نقل موظف",
		"message": "%s نُقل من %s إلى %s" % (emp.get("name"), transfer["fromBranchName"] or "—", transfer["toBranchName"]),
		"link": "/employees/%s" % emp["id"],
	})
	_commit(ctx)
	fp = transfer.get("fingerprint") or {}
	message = "تم نقل %s إلى %s" % (emp.get("name"), transfer["toBranchName"])
	if fp.get("status") == "queued":
		message += " — %s" % fp.get("message")
	elif fp.get("status") == "no_pin":
		message += " — %s" % fp.get("message")
	return {"data": transfer, "message": message}


@route("GET", r"/employees/(?P<emp_id>[^/]+)/transfers", permission=("employees", "view"))
def employee_transfers(ctx, emp_id):
	rows = [t for t in ctx.state.get("employeeTransfers") or [] if t.get("employeeId") == emp_id]
	rows.sort(key=lambda t: t.get("createdAt") or "", reverse=True)
	return {"data": rows}


@route("POST", r"/employees/(?P<emp_id>[^/]+)/promotion", permission=("employees", "edit"))
def employee_promotion(ctx, emp_id):
	s = ctx.state
	emp = engine.find_employee(s, emp_id)
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	ctx.scope_branch(emp.get("branchId"))
	if emp.get("status") == "terminated":
		raise ApiError("لا يمكن ترقية موظف منتهي الخدمة")
	body = ctx.body
	kind = str(body.get("type") or "promotion")
	if kind not in PROMOTION_TYPES:
		raise ApiError("نوع الترقية غير معروف")
	old = {
		"jobTitle": emp.get("jobTitle") or "", "jobGradeId": emp.get("jobGradeId") or "",
		"baseSalary": num(emp.get("baseSalary")), "shiftId": emp.get("shiftId") or "",
		"departmentId": emp.get("departmentId") or "",
	}
	changes = {}
	if body.get("newJobTitle"):
		changes["jobTitle"] = str(body["newJobTitle"]).strip()
	if body.get("newJobGradeId"):
		changes["jobGradeId"] = body["newJobGradeId"]
	if body.get("newShiftId"):
		changes["shiftId"] = body["newShiftId"]
	if body.get("newDepartmentId"):
		changes["departmentId"] = body["newDepartmentId"]
	new_salary = None
	if body.get("newBaseSalary") not in (None, ""):
		new_salary = round2(num(body["newBaseSalary"]))
		if new_salary <= 0:
			raise ApiError("الراتب الجديد يجب أن يكون أكبر من صفر")
		if new_salary == num(emp.get("baseSalary")):
			raise ApiError("الراتب الجديد مطابق للراتب الحالي")
		changes["baseSalary"] = new_salary
		# تحديث أجر التأمينات إن كان مربوطًا بالراتب الأساسي
		if emp.get("gosiBase") not in (None, ""):
			changes["gosiBase"] = new_salary
	if not changes:
		raise ApiError("حدّد تغييرًا واحدًا على الأقل: مسمى وظيفي أو رتبة أو راتب أو دوام أو قسم")

	for key, value in changes.items():
		emp[key] = value
	effective = date_only(body.get("effectiveDate") or today_iso())
	record = {
		"id": uid("pr_"), "employeeId": emp["id"], "employeeName": emp.get("name") or "",
		"employeeNumber": emp.get("employeeNumber") or "", "branchId": emp.get("branchId") or "",
		"type": kind, "typeLabel": PROMOTION_TYPES.get(kind, kind),
		"oldJobTitle": old["jobTitle"], "newJobTitle": emp.get("jobTitle") or "",
		"oldJobGradeId": old["jobGradeId"], "newJobGradeId": emp.get("jobGradeId") or "",
		"oldBaseSalary": old["baseSalary"], "newBaseSalary": num(emp.get("baseSalary")),
		"salaryIncrease": round2(num(emp.get("baseSalary")) - old["baseSalary"]),
		"oldShiftId": old["shiftId"], "newShiftId": emp.get("shiftId") or "",
		"oldDepartmentId": old["departmentId"], "newDepartmentId": emp.get("departmentId") or "",
		"effectiveDate": effective, "reason": body.get("reason") or "", "notes": body.get("notes") or "",
		"status": "applied", "createdAt": engine._now(), "createdBy": ctx.user.get("name") or "",
	}
	s.setdefault("employeePromotions", []).append(record)
	engine.add_audit(s, {
		"userId": ctx.user.get("id"), "userName": ctx.user.get("name"), "action": "employee_promotion",
		"module": "employees", "collection": "employees", "recordId": emp["id"],
		"details": "%s: %s" % (PROMOTION_TYPES.get(kind, kind), emp.get("name")),
		"ip": getattr(frappe.local, "request", None) and frappe.local.request.remote_addr or "",
	})
	engine.notify(s, {
		"key": "promotion:%s" % record["id"], "type": "employee_promotion", "severity": "info",
		"title": PROMOTION_TYPES.get(kind, "ترقية"),
		"message": "%s — %s" % (emp.get("name"),
		                        "الراتب من %s إلى %s" % (num(old["baseSalary"]), num(emp.get("baseSalary")))
		                        if record["salaryIncrease"] else (emp.get("jobTitle") or PROMOTION_TYPES.get(kind, ""))),
		"link": "/employees/%s" % emp["id"],
	})
	_commit(ctx)
	return {"data": record, "message": "تم تسجيل %s لـ %s" % (PROMOTION_TYPES.get(kind, "التغيير"), emp.get("name"))}


@route("GET", r"/employees/(?P<emp_id>[^/]+)/promotions", permission=("employees", "view"))
def employee_promotions(ctx, emp_id):
	rows = [p for p in ctx.state.get("employeePromotions") or [] if p.get("employeeId") == emp_id]
	rows.sort(key=lambda p: p.get("createdAt") or "", reverse=True)
	return {"data": rows}


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
	if q.get("shiftId"):
		# خريطة واحدة بدل البحث في كل الموظفين لكل صف (أسرع مع الجداول الكبيرة)
		shift_by_emp = {e.get("id"): e.get("shiftId") for e in ctx.state.get("employees") or []}
		rows = [r for r in rows if r.get("shiftId") == q.get("shiftId")
		        or shift_by_emp.get(r.get("empId")) == q.get("shiftId")]
	rows.sort(key=lambda r: (r.get("date", ""), r.get("employeeName", "")))
	rows = engine.attach_shift_periods(ctx.state, rows, frm, to)
	return {"data": rows, "from": frm, "to": to}


ATTENDANCE_STATUS_LABELS = {
	"present": "حاضر", "late": "متأخر", "absent": "غائب", "leave": "إجازة",
	"half_day": "نصف يوم", "missing_punch": "بصمة ناقصة", "weekend": "عطلة أسبوعية",
	"holiday": "عطلة رسمية", "remote": "عمل عن بعد", "future": "لم يحن", "not_tracked": "غير متتبع",
}
ATTENDANCE_SOURCE_LABELS = {"fingerprint": "جهاز بصمة", "mobile": "جوال", "correction": "تصحيح", "leave": "إجازة"}


@route("POST", r"/attendance/export", permission=("attendance", "view"))
def attendance_export(ctx):
	"""تصدير جداول الحضور والبصمات إلى Excel/CSV بنفس أعمدة الشاشة."""
	state = ctx.state
	body = ctx.body or {}
	filters = body.get("filters") or {}
	kind = "punches" if body.get("kind") == "punches" else "daily"
	frm = date_only(filters.get("from")) or today_iso()
	to = date_only(filters.get("to")) or frm
	branches = {b.get("id"): b.get("name") for b in state.get("branches") or []}
	departments = {d.get("id"): d.get("name") for d in state.get("departments") or []}
	employee_names = {e.get("id"): e.get("name") for e in state.get("employees") or []}
	shift_by_emp = {e.get("id"): e.get("shiftId") for e in state.get("employees") or []}
	preset = ROLE_PRESETS.get(ctx.user.get("role")) or {}
	scoped = preset.get("branchScoped") and ctx.user.get("branchId")

	if kind == "punches":
		rows = []
		for rec in state.get("attendanceRecords") or []:
			day = date_only(rec.get("date"))
			if not day or day < frm or day > to:
				continue
			if filters.get("employeeId") and rec.get("empId") != filters["employeeId"]:
				continue
			if filters.get("branchId") and rec.get("branchId") != filters["branchId"]:
				continue
			if scoped and rec.get("branchId") and rec.get("branchId") != ctx.user.get("branchId"):
				continue
			location = ""
			if rec.get("latitude") is not None and rec.get("longitude") is not None:
				location = "%s, %s" % (rec.get("latitude"), rec.get("longitude"))
			rows.append({
				"date": day, "employee": rec.get("employeeName") or employee_names.get(rec.get("empId")) or "",
				"branch": branches.get(rec.get("branchId"), ""), "checkIn": rec.get("checkIn") or rec.get("punchTime") or "",
				"checkOut": rec.get("checkOut") or "",
				"type": "خروج" if str(rec.get("punchType")) == "1" else "دخول",
				"source": ATTENDANCE_SOURCE_LABELS.get(rec.get("source"), rec.get("source") or "يدوي"),
				"device": rec.get("deviceId") or "", "location": location,
			})
		rows.sort(key=lambda r: (r["date"], r["employee"], r["checkIn"]))
		title = "سجل البصمات الخام"
		columns = [{"key": "date", "label": "التاريخ"}, {"key": "employee", "label": "الموظف"},
		           {"key": "branch", "label": "الفرع"}, {"key": "checkIn", "label": "وقت البصمة"},
		           {"key": "checkOut", "label": "الانصراف"}, {"key": "type", "label": "النوع"},
		           {"key": "source", "label": "المصدر"}, {"key": "device", "label": "الجهاز"},
		           {"key": "location", "label": "الموقع"}]
	else:
		rows = engine.attendance_for(state, frm, to, {
			"employeeId": filters.get("employeeId"), "branchId": filters.get("branchId"),
			"departmentId": filters.get("departmentId"), "status": filters.get("status")})
		if scoped:
			rows = [r for r in rows if can_access_branch(ctx.user, r.get("branchId"))]
		if filters.get("shiftId"):
			rows = [r for r in rows if r.get("shiftId") == filters["shiftId"]
			        or shift_by_emp.get(r.get("empId")) == filters["shiftId"]]
		rows = engine.attach_shift_periods(state, rows, frm, to)
		rows.sort(key=lambda r: (r.get("date", ""), r.get("employeeName", "")))
		rows = [{
			"date": r.get("date"), "employee": r.get("employeeName") or "",
			"department": departments.get(r.get("departmentId"), ""), "branch": branches.get(r.get("branchId"), ""),
			"shift": r.get("shiftName") or "", "checkIn": r.get("checkIn") or "", "checkOut": r.get("checkOut") or "",
			"late": num(r.get("lateMinutes")), "early": num(r.get("earlyMinutes")), "overtime": num(r.get("overtimeMinutes")),
			"status": ATTENDANCE_STATUS_LABELS.get(r.get("status"), r.get("status") or ""),
			"source": ATTENDANCE_SOURCE_LABELS.get(r.get("source"), r.get("source") or ""),
		} for r in rows]
		title = "سجل الحضور"
		columns = [{"key": "date", "label": "التاريخ"}, {"key": "employee", "label": "الموظف"},
		           {"key": "department", "label": "القسم"}, {"key": "branch", "label": "الفرع"},
		           {"key": "shift", "label": "الدوام"}, {"key": "checkIn", "label": "الحضور"},
		           {"key": "checkOut", "label": "الانصراف"}, {"key": "late", "label": "تأخير (د)"},
		           {"key": "early", "label": "انصراف مبكر (د)"}, {"key": "overtime", "label": "إضافي (د)"},
		           {"key": "status", "label": "الحالة"}, {"key": "source", "label": "المصدر"}]

	if not rows:
		raise ApiError("لا توجد بيانات للتصدير في الفترة المحددة")
	stamp = time.strftime("%Y%m%d-%H%M%S")
	if str(body.get("format") or "xlsx").lower() in ("xlsx", "excel"):
		return _download(files.build_xlsx(columns, rows, title), "attendance-%s-%s.xlsx" % (kind, stamp))
	return _download(files.build_csv(columns, rows), "attendance-%s-%s.csv" % (kind, stamp))


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

	# فهارس جاهزة مرة واحدة بدل مسح كل الموظفين وكل السجلات لكل بصمة
	# (هذا المسح كان سبب بطء/تعليق رفع أرشيف آلاف البصمات)
	emp_by_key = {}
	employees = s.get("employees") or []
	for emp in employees:
		for key in (emp.get("id"), emp.get("employeeNumber"), emp.get("username")):
			key = str(key or "").strip()
			if key and key not in emp_by_key:
				emp_by_key[key] = emp
	for emp in employees:
		for key in (emp.get("fingerprintId"), emp.get("nationalId")):
			key = str(key or "").strip()
			if key and key not in emp_by_key:
				emp_by_key[key] = emp

	existing = set()
	for a in s.get("attendanceRecords") or []:
		emp_id = a.get("empId") or a.get("employeeId")
		day = date_only(a.get("date"))
		if not emp_id or not day:
			continue
		for field in ("punchTime", "checkIn", "checkOut"):
			value = a.get(field)
			if value:
				existing.add("%s|%s|%s" % (emp_id, day, str(value)[:5]))

	# أوقات بصمات الجوال: تُتجاهل بصمة الجهاز المكررة قربها حتى لا تُحسب مرتين
	mobile_times = {}
	for a in s.get("attendanceRecords") or []:
		if a.get("source") != "mobile":
			continue
		emp_id = a.get("empId") or a.get("employeeId")
		day = date_only(a.get("date"))
		minute = _minute_of(a.get("punchTime") or a.get("checkIn") or a.get("checkOut"))
		if emp_id and day and minute is not None:
			mobile_times.setdefault((emp_id, day), []).append(minute)

	records = s.setdefault("attendanceRecords", [])
	for p in punches:
		number = str(p.get("employeeNumber") or p.get("employeeId") or p.get("empId") or p.get("pin") or p.get("userId") or "").strip()
		if not number:
			skipped += 1
			continue
		emp = emp_by_key.get(number)
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
		key = "%s|%s|%s" % (emp["id"], day, str(time_text)[:5])
		if key in existing:
			skipped += 1
			continue
		minute = _minute_of(time_text)
		if minute is not None and any(abs(minute - m) <= 10 for m in mobile_times.get((emp["id"], day), ())):
			skipped += 1
			continue
		punch_type = p.get("punchType")
		records.append({
			"id": uid("att_"), "empId": emp["id"], "employeeId": emp["id"],
			"employeeName": emp.get("name") or "", "employeeNumber": emp.get("employeeNumber") or "",
			"date": day, "punchTime": time_text, "punchType": "" if punch_type is None else punch_type,
			"checkIn": None if punch_type == 1 else time_text, "checkOut": time_text if punch_type == 1 else None,
			"branchId": branch_id or emp.get("branchId") or "", "deviceId": device_id,
			"source": "fingerprint", "createdAt": engine._now(),
		})
		existing.add(key)
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


@route("POST", r"/fingerprint/commands", auth=False)
def fingerprint_commands(ctx):
	"""يسحب وسيط البصمة أوامر الأجهزة (مثل إضافة رقم بصمة موظف منقول)."""
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح جهاز البصمة غير صالح", 401)
	s = ctx.state
	body = ctx.body if isinstance(ctx.body, dict) else {}
	branch_id = str(body.get("branchId") or ctx.query.get("branchId") or "").strip()
	device_id = str(body.get("deviceId") or ctx.query.get("deviceId") or "").strip()
	pending = []
	for cmd in s.setdefault("fingerprintCommands", []):
		if cmd.get("status") != "pending":
			continue
		if branch_id and cmd.get("branchId") != branch_id:
			continue
		if not branch_id and device_id and cmd.get("deviceId") != device_id:
			continue
		pending.append(cmd)
	pending = pending[:20]
	for cmd in pending:
		cmd["status"] = "sent"
		cmd["sentAt"] = engine._now()
		cmd["attempts"] = num(cmd.get("attempts")) + 1
	if pending:
		_commit(ctx)
	return {"ok": True, "data": [{
		"id": c.get("id"), "action": c.get("action"), "pin": c.get("pin"),
		"name": c.get("name") or "", "employeeNumber": c.get("employeeNumber") or "",
		"employeeId": c.get("employeeId") or "", "branchId": c.get("branchId") or "",
		"deviceId": c.get("deviceId") or "",
	} for c in pending]}


@route("POST", r"/fingerprint/commands/(?P<command_id>[^/]+)/ack", auth=False)
def fingerprint_command_ack(ctx, command_id):
	"""يؤكد وسيط البصمة نتيجة تنفيذ الأمر على الجهاز."""
	if not _device_key_ok(ctx):
		raise ApiError("مفتاح جهاز البصمة غير صالح", 401)
	s = ctx.state
	command = next((c for c in s.get("fingerprintCommands") or [] if c.get("id") == command_id), None)
	if not command:
		raise ApiError("الأمر غير موجود", 404)
	ok = _flag(ctx.body.get("ok"), False)
	message = str(ctx.body.get("message") or "")[:300]
	command["message"] = message
	command["attempts"] = num(command.get("attempts"))
	if ok:
		command["status"] = "done"
		command["finishedAt"] = engine._now()
	elif command["attempts"] >= 5:
		command["status"] = "failed"
		command["finishedAt"] = engine._now()
	else:
		command["status"] = "pending"
	if command.get("transferId"):
		transfer = next((t for t in s.get("employeeTransfers") or [] if t.get("id") == command["transferId"]), None)
		if transfer:
			fp = transfer.setdefault("fingerprint", {})
			fp["status"] = "synced" if ok else ("failed" if command["status"] == "failed" else "queued")
			fp["message"] = message or ("تمت إضافة رقم البصمة إلى جهاز الفرع" if ok else "في انتظار تنفيذ الوسيط")
			fp["syncedAt"] = command.get("finishedAt") or ""
	_commit(ctx)
	return {"ok": True, "status": command["status"], "message": command["message"]}


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
def _auto_post(ctx, event, ref_id, date, entries, description, ref_type="", ref_number="", branch_id=""):
	"""ترحيل قيد محاسبي تلقائي دون إيقاف العملية المالية إذا فشل الترحيل."""
	try:
		return accounting.post_entry(ctx.state, event, ref_id, date, entries, description=description,
		                             ref_type=ref_type, ref_number=ref_number,
		                             user=ctx.user.get("name"), branch_id=branch_id,
		                             currency=(ctx.state.get("settings") or {}).get("currency"))
	except ValueError as exc:
		engine.notify(ctx.state, {"key": "accounting-post:%s:%s" % (event, ref_id), "type": "accounts",
		                          "severity": "warning", "title": "تعذّر الترحيل المحاسبي",
		                          "message": str(exc)[:200], "link": "#/accounts"})
		return None


def _financial_collection_hook(ctx, name, payload):
	"""ترحيل محاسبي للعمليات المالية التي تُسجَّل عبر واجهة المجموعات العامة."""
	if name == "advancePayments":
		amount = num(payload.get("amount"))
		_auto_post(ctx, "advance_payment", payload.get("id"), payload.get("date") or today_iso(), [
			("cash", amount, 0, "تحصيل سداد سلفة"),
			("advances", 0, amount, "تخفيض رصيد سلفة موظف"),
		], "سداد سلفة موظف", "advancePayments", "")
	elif name == "loanPayments":
		amount = num(payload.get("amount"))
		_auto_post(ctx, "loan_payment", payload.get("id"), payload.get("paidDate") or payload.get("dueDate") or today_iso(), [
			("cash", amount, 0, "تحصيل قسط قرض"),
			("advances", 0, amount, "تخفيض رصيد قرض موظف"),
		], "سداد قرض موظف", "loanPayments", "")


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
	_auto_post(ctx, "payslip_accrual", slip.get("id"), slip.get("toDate") or today_iso(),
	           accounting.payslip_entries(slip),
	           "استحقاق راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
	           "payslips", "%s/%s" % (slip.get("month"), slip.get("year")), slip.get("branchId") or "")
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
	_auto_post(ctx, "payslip_accrual", slip.get("id"), slip.get("toDate") or slip["paidDate"],
	           accounting.payslip_entries(slip),
	           "استحقاق راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
	           "payslips", "%s/%s" % (slip.get("month"), slip.get("year")), slip.get("branchId") or "")
	_auto_post(ctx, "payslip_payment", slip.get("id"), slip["paidDate"],
	           accounting.payslip_payment_entries(slip, slip["paymentMethod"]),
	           "صرف راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
	           "payslips", "%s/%s" % (slip.get("month"), slip.get("year")), slip.get("branchId") or "")
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
	_auto_post(ctx, "eos_accrual", record["id"], record.get("endDate") or today_iso(), [
		("eosExpense", num(record.get("total")), 0, "مكافأة نهاية خدمة — %s" % record.get("employeeName")),
		("eosPayable", 0, num(record.get("total")), "مستحق نهاية خدمة — %s" % record.get("employeeName")),
	], "استحقاق نهاية خدمة %s" % record.get("employeeName"), "eosSettlements", "",
		(engine.find_employee(ctx.state, record.get("employeeId")) or {}).get("branchId") or "")
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


def _download(content, filename):
	frappe.response["filename"] = filename
	frappe.response["filecontent"] = content
	frappe.response["type"] = "download"
	return None


@route("POST", r"/reports/export", permission=("reports", "view"))
def reports_export(ctx):
	report_id = ctx.body.get("reportId")
	if not any(r["id"] == report_id for r in reports.REPORT_CATALOG):
		raise ApiError("التقرير غير موجود", 404)
	report = reports.run_report(ctx.state, report_id, ctx.body.get("filters") or {}, ctx.body.get("columns"))
	columns = report["columns"]
	fmt = str(ctx.body.get("format") or "csv").lower()
	stamp = time.strftime("%Y%m%d-%H%M%S")
	if fmt in ("xlsx", "excel"):
		content = files.build_xlsx(columns, report["rows"], report.get("title") or "تقرير")
		return _download(content, "report-%s-%s.xlsx" % (report_id, stamp))
	content = files.build_csv(columns, report["rows"])
	return _download(content, "report-%s-%s.csv" % (report_id, stamp))


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


# ═════════ بصمة الجوال بنطاق الفرع (الخدمة الذاتية) ═════════
def _haversine_meters(lat1, lon1, lat2, lon2):
	from math import asin, cos, radians, sin, sqrt
	lat1, lon1, lat2, lon2 = map(radians, (float(lat1), float(lon1), float(lat2), float(lon2)))
	dlat, dlon = lat2 - lat1, lon2 - lon1
	a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
	return 6371000.0 * 2 * asin(sqrt(a))


def _branch_geo(state, branch_id):
	branch = next((b for b in state.get("branches") or [] if b.get("id") == branch_id), None)
	if not branch:
		return None, {"enabled": False, "reason": "لم يُحدَّد فرع للموظف"}
	try:
		lat = float(branch.get("latitude"))
	except (TypeError, ValueError):
		lat = None
	try:
		lng = float(branch.get("longitude"))
	except (TypeError, ValueError):
		lng = None
	radius = max(30.0, min(5000.0, num(branch.get("geofenceRadius"), 150) or 150))
	enabled = branch.get("mobilePunchEnabled") is not False and lat is not None and lng is not None
	reason = ""
	if lat is None or lng is None:
		reason = "لم تُحدَّد إحداثيات موقع الفرع — اطلب من الموارد البشرية ضبط خط الطول والعرض"
	elif branch.get("mobilePunchEnabled") is False:
		reason = "البصمة من الجوال معطّلة لهذا الفرع"
	return branch, {"latitude": lat, "longitude": lng, "radius": radius, "enabled": enabled, "reason": reason}


def _self_punch_records(state, emp_id, day):
	return sorted([r for r in state.get("attendanceRecords") or []
	               if (r.get("empId") or r.get("employeeId")) == emp_id and date_only(r.get("date")) == day],
	              key=lambda r: str(r.get("punchTime") or r.get("checkIn") or ""))


def _self_next_punch(state, emp, records, day=None):
	"""نوع البصمة التالية من أوقات الدخول والخروج الفعلية، لا من عدد السجلات."""
	day = day or today_iso()
	daily = next((d for d in state.get("attendanceDaily") or []
	              if d.get("empId") == emp.get("id") and d.get("date") == day), None) or {}
	last = records[-1] if records else None
	if last:
		punch_type = str(last.get("punchType") if last.get("punchType") is not None else "")
		last_in = last.get("checkIn") or ""
		last_out = last.get("checkOut") or ""
		if not last_in and not last_out:
			last_in = last.get("punchTime") or ""
		# بصمة صنّفها الجهاز أو النظام صراحةً كخروج
		if punch_type == "1" or (last_out and not last_in):
			return "in"
		# آخر بصمة دخول بلا انصراف ⇒ التالية انصراف
		if last_in and not last_out:
			return "out"
		if last_in and last_out:
			return "out" if str(last_out) <= str(last_in) else "in"
	# لا سجلات خام: اعتمد على سجل الحضور اليومي إن وُجد
	if daily.get("checkIn") and not daily.get("checkOut"):
		return "out"
	if daily.get("checkOut") and not daily.get("checkIn"):
		return "in"
	return "in"


def _self_credential(state, emp_id):
	return next((c for c in state.get("selfCredentials") or []
	             if c.get("employeeId") == emp_id and c.get("credentialId")), None)


def _biometric_required(state, emp=None):
	"""إلزام بصمة الجوال — يُعطّل عامًّا من الإعدادات أو لموظف جواله لا يدعم البصمة."""
	if (state.get("settings") or {}).get("mobilePunchBiometric") is False:
		return False
	return not (emp or {}).get("mobileBiometricExempt")


def _minute_of(value):
	m = re.search(r"(\d{1,2}):(\d{2})", str(value or ""))
	return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _device_punch_near(records, minute, minutes=10):
	"""بصمة جهاز البصمة القريبة زمنيًا — لمنع تسجيل البصمة مرتين."""
	if minute is None:
		return None
	for r in records:
		if (r.get("source") or "") == "mobile":
			continue
		near = _minute_of(r.get("punchTime") or r.get("checkIn") or r.get("checkOut"))
		if near is not None and abs(near - minute) <= minutes:
			return r
	return None


# ── التحقق من بصمة جهاز الموظف (WebAuthn / Passkey) ──
def _b64url_decode(value):
	text = str(value or "").strip()
	if not text:
		return b""
	if len(text) % 4:
		text += "=" * (4 - len(text) % 4)
	return base64.urlsafe_b64decode(text.encode("ascii"))


def _b64url_encode(data):
	return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _cbor_decode(data, offset=0):
	"""مفكّك CBOR مصغّر يكفي لقراءة مفتاح COSE من رد تسجيل WebAuthn."""
	head = data[offset]
	offset += 1
	major, info = head >> 5, head & 0x1F
	if info < 24:
		value = info
	elif info == 24:
		value = data[offset]
		offset += 1
	elif info == 25:
		value = int.from_bytes(data[offset:offset + 2], "big")
		offset += 2
	elif info == 26:
		value = int.from_bytes(data[offset:offset + 4], "big")
		offset += 4
	elif info == 27:
		value = int.from_bytes(data[offset:offset + 8], "big")
		offset += 8
	else:
		raise ApiError("بيانات البصمة غير مفهومة")
	if major == 0:
		return value, offset
	if major == 1:
		return -1 - value, offset
	if major == 2:
		return data[offset:offset + value], offset + value
	if major == 3:
		return data[offset:offset + value].decode("utf-8", "replace"), offset + value
	if major == 4:
		items = []
		for _ in range(value):
			item, offset = _cbor_decode(data, offset)
			items.append(item)
		return items, offset
	if major == 5:
		out = {}
		for _ in range(value):
			key, offset = _cbor_decode(data, offset)
			val, offset = _cbor_decode(data, offset)
			out[key] = val
		return out, offset
	if major == 6:
		return _cbor_decode(data, offset)
	if major == 7:
		if info == 20:
			return False, offset
		if info == 21:
			return True, offset
		return None, offset
	raise ApiError("بيانات البصمة غير مفهومة")


def _cose_public_key(cose):
	from cryptography.hazmat.primitives.asymmetric import ec, rsa
	if not isinstance(cose, dict):
		raise ApiError("مفتاح بصمة الجوال غير صالح")
	kty = cose.get(1)
	if kty == 2:
		if cose.get(-1) != 1:
			raise ApiError("منحنى مفتاح البصمة غير مدعوم")
		x, y = cose.get(-2), cose.get(-3)
		if not isinstance(x, bytes) or not isinstance(y, bytes):
			raise ApiError("مفتاح بصمة الجوال غير صالح")
		return ec.EllipticCurvePublicNumbers(int.from_bytes(x, "big"), int.from_bytes(y, "big"),
		                                     ec.SECP256R1()).public_key()
	if kty == 3:
		n, e = cose.get(-1), cose.get(-2)
		if not isinstance(n, bytes) or not isinstance(e, bytes):
			raise ApiError("مفتاح بصمة الجوال غير صالح")
		return rsa.RSAPublicNumbers(int.from_bytes(e, "big"), int.from_bytes(n, "big")).public_key()
	raise ApiError("نوع مفتاح بصمة الجوال غير مدعوم")


def _verify_signature(public_key, signature, signed):
	from cryptography.exceptions import InvalidSignature
	from cryptography.hazmat.primitives import hashes
	from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
	try:
		if isinstance(public_key, ec.EllipticCurvePublicKey):
			public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
		elif isinstance(public_key, rsa.RSAPublicKey):
			public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
		else:
			raise ApiError("نوع مفتاح بصمة الجوال غير مدعوم")
	except InvalidSignature:
		raise ApiError("تعذّر التحقق من بصمة جوالك — أعد المحاولة", 403)


def _webauthn_context():
	"""يعيد Origin وRP ID كما يراها المتصفح (مع مراعاة الوسيط HTTPS)."""
	req = getattr(frappe.local, "request", None)
	proto, host = "https", ""
	if req is not None:
		hdrs = req.headers or {}
		proto = (hdrs.get("X-Forwarded-Proto") or getattr(req, "scheme", "") or "https").split(",")[0].strip() or "https"
		host = (hdrs.get("X-Forwarded-Host") or hdrs.get("Host") or getattr(req, "host", "") or "").split(",")[0].strip()
	rp_id = host.split(":")[0].strip()
	return {"origin": "%s://%s" % (proto, host), "rp_id": rp_id, "host": host}


def _challenge_key(user_id):
	return "hrpro_webauthn:%s" % user_id


def _store_challenge(user_id, mode, info):
	challenge = _b64url_encode(os.urandom(32))
	frappe.cache().set_value(_challenge_key(user_id),
	                         {"challenge": challenge, "mode": mode, "origin": info["origin"], "rp_id": info["rp_id"]},
	                         expires_in_sec=180)
	return challenge


def _read_challenge(user_id, mode):
	stored = frappe.cache().get_value(_challenge_key(user_id)) or {}
	if not isinstance(stored, dict) or stored.get("mode") != mode or not stored.get("challenge"):
		raise ApiError("انتهت صلاحية طلب بصمة الجوال — أعد المحاولة من الزر نفسه")
	return stored


def _client_data(payload, expected_type, stored):
	try:
		raw = _b64url_decode(payload.get("clientDataJSON"))
		data = json.loads(raw.decode("utf-8"))
	except Exception:
		raise ApiError("لم تُقرأ بصمة الجهاز — أعد المحاولة")
	if data.get("type") != expected_type:
		raise ApiError("نوع طلب بصمة الجهاز غير صحيح")
	if data.get("challenge") != stored.get("challenge"):
		raise ApiError("انتهت صلاحية طلب بصمة الجوال — أعد المحاولة")
	if str(data.get("origin") or "") != stored.get("origin"):
		raise ApiError("طلب بصمة الجهاز لم يصدر من هذا الموقع", 403)
	return raw


def _check_auth_data(auth_data, stored):
	if not isinstance(auth_data, bytes) or len(auth_data) < 37:
		raise ApiError("بيانات بصمة الجهاز غير صالحة")
	if auth_data[:32] != hashlib.sha256(str(stored["rp_id"]).encode()).digest():
		raise ApiError("بصمة الجهاز غير مرتبطة بهذا النظام", 403)
	flags = auth_data[32]
	if not flags & 0x01:
		raise ApiError("لم يتأكد وجودك على الجهاز — أعد المحاولة")
	if not flags & 0x04:
		raise ApiError("يجب تأكيد هويتك ببصمة الإصبع أو التعرف على الوجه على جوالك")
	return int.from_bytes(auth_data[33:37], "big")


def _verify_self_assertion(state, user_id, emp, payload):
	"""يتحقق من توقيع بصمة جهاز الموظف قبل قبول بصمة الحضور."""
	cred = _self_credential(state, emp.get("id"))
	if not cred:
		raise ApiError("فعّل بصمة جوالك أولاً من الخدمة الذاتية حتى تُقبل بصمتك", 428)
	stored = _read_challenge(user_id, "assert")
	raw_id = payload.get("rawId") or payload.get("id") or ""
	if raw_id and _b64url_encode(_b64url_decode(raw_id)) != cred.get("credentialId"):
		raise ApiError("بصمة هذا الجوال غير مسجلة لحسابك", 403)
	try:
		client_data = _client_data(payload, "webauthn.get", stored)
		auth_data = _b64url_decode(payload.get("authenticatorData"))
		signature = _b64url_decode(payload.get("signature"))
	except ApiError:
		raise
	except Exception:
		raise ApiError("لم تُقرأ بصمة الجوال — أعد المحاولة")
	sign_count = _check_auth_data(auth_data, stored)
	try:
		cose, _ = _cbor_decode(_b64url_decode(cred.get("publicKey")))
		public_key = _cose_public_key(cose)
	except ApiError:
		raise
	except Exception:
		raise ApiError("مفتاح بصمة الجوال غير صالح — أعد تفعيلها")
	_verify_signature(public_key, signature, auth_data + hashlib.sha256(client_data).digest())
	if sign_count and sign_count <= int(cred.get("signCount") or 0):
		raise ApiError("أُعيد استخدام بصمة قديمة — أعد المحاولة", 403)
	cred["signCount"] = sign_count or int(cred.get("signCount") or 0)
	cred["lastUsedAt"] = engine._now()
	frappe.cache().delete_value(_challenge_key(user_id))
	return cred


@route("GET", r"/self/attendance/context")
def self_attendance_context(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	today = today_iso()
	branch, geo = _branch_geo(s, emp.get("branchId"))
	records = _self_punch_records(s, emp["id"], today)
	day = next((d for d in s.get("attendanceDaily") or [] if d.get("empId") == emp["id"] and d.get("date") == today), None)
	return {"data": {
		"employee": {"id": emp.get("id"), "name": emp.get("name"), "employeeNumber": emp.get("employeeNumber")},
		"branch": {"id": (branch or {}).get("id"), "name": (branch or {}).get("name")},
		"geo": geo,
		"today": day,
		"punches": [{"time": r.get("punchTime") or r.get("checkIn") or "",
		             "type": "خروج" if str(r.get("punchType")) == "1" else "دخول",
		             "source": ATTENDANCE_SOURCE_LABELS.get(r.get("source"), r.get("source") or "يدوي")} for r in records],
		"nextPunch": _self_next_punch(s, emp, records, today),
		"canPunch": bool(geo.get("enabled")),
		"reason": geo.get("reason") or "",
		"biometric": {"required": _biometric_required(s, emp),
		              "enrolled": bool(_self_credential(s, emp["id"])),
		              "enrolledAt": (_self_credential(s, emp["id"]) or {}).get("createdAt") or ""},
		"serverTime": engine._now(),
	}}


@route("POST", r"/self/attendance/punch")
def self_attendance_punch(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	if emp.get("status") == "terminated":
		raise ApiError("لا يمكن تسجيل البصمة لموظف منتهي الخدمة", 403)
	branch, geo = _branch_geo(s, emp.get("branchId"))
	if not geo.get("enabled"):
		raise ApiError(geo.get("reason") or "البصمة من الجوال غير متاحة", 403)
	try:
		lat = float(ctx.body.get("latitude"))
		lng = float(ctx.body.get("longitude"))
	except (TypeError, ValueError):
		raise ApiError("تعذر قراءة موقعك — اسمح للتطبيق بالوصول إلى الموقع وأعد المحاولة")
	if not (-90 <= lat <= 90 and -180 <= lng <= 180):
		raise ApiError("إحداثيات الموقع غير صحيحة")
	accuracy = max(0.0, num(ctx.body.get("accuracy"), 0))
	distance = _haversine_meters(lat, lng, geo["latitude"], geo["longitude"])
	# تسامح بسيط مع دقة GPS (بحد أقصى 50 مترًا) حتى لا تُرفض البصمة داخل الفرع
	allowed = geo["radius"] + min(accuracy, 50.0)
	if distance > allowed:
		raise ApiError("أنت خارج نطاق الفرع — المسافة الحالية %.0f م والحد المسموح %.0f م" % (distance, geo["radius"]), 403)
	today = today_iso()
	now_text = datetime.now().strftime("%H:%M")
	records = _self_punch_records(s, emp["id"], today)
	if records:
		last = str(records[-1].get("punchTime") or records[-1].get("checkIn") or "")
		if len(last) >= 5 and last[:5] == now_text:
			raise ApiError("سُجلت بصمتك للتو — انتظر دقيقة قبل البصمة التالية")
		# البصمة من الجوال بديل عند تعطل جهاز البصمة: لا نكرر بصمة سجلها الجهاز
		device_hit = _device_punch_near(records, _minute_of(now_text))
		if device_hit:
			raise ApiError("بصمتك مسجّلة من جهاز البصمة الساعة %s — بصمة الجوال بديل عند تعطل الجهاز"
			               % (device_hit.get("punchTime") or device_hit.get("checkIn") or ""))
	# بصمة جهاز الموظف: لا تُقبل البصمة إلا بتأكيد بصمة الإصبع/الوجه على جواله
	if _biometric_required(s, emp):
		_verify_self_assertion(s, ctx.user.get("id"), emp, ctx.body.get("biometric") or {})
	punch_type = 0 if _self_next_punch(s, emp, records, today) == "in" else 1
	record = {
		"id": uid("att_"), "empId": emp["id"], "employeeId": emp["id"],
		"employeeName": emp.get("name") or "", "employeeNumber": emp.get("employeeNumber") or "",
		"date": today, "punchTime": now_text, "punchType": punch_type,
		"checkIn": now_text if punch_type == 0 else None, "checkOut": now_text if punch_type == 1 else None,
		"branchId": emp.get("branchId") or "", "deviceId": "self-mobile", "source": "mobile",
		"latitude": round(lat, 6), "longitude": round(lng, 6),
		"distance": round(distance, 1), "accuracy": round(accuracy, 1), "createdAt": engine._now(),
	}
	s.setdefault("attendanceRecords", []).append(record)
	engine.process_attendance(s, {"from": today, "to": today, "employeeId": emp["id"]})
	day = next((d for d in s.get("attendanceDaily") or [] if d.get("empId") == emp["id"] and d.get("date") == today), None)
	label = "دخول" if punch_type == 0 else "خروج"
	ctx.audit("punch", "attendance", "attendanceRecords", record["id"],
	          "بصمة جوال %s — %s الساعة %s (على %.0f م من الفرع)" % (emp.get("name"), label, now_text, distance))
	_commit(ctx)
	return {"data": {"record": record, "today": day, "distance": round(distance, 1),
	                  "nextPunch": "out" if punch_type == 0 else "in"},
	        "message": "تم تسجيل بصمة %s الساعة %s بعد تأكيد بصمة جوالك" % (label, now_text)}


# ── تفعيل بصمة جوال الموظف والتحقق منها قبل كل بصمة حضور ──
@route("POST", r"/self/biometric/register/options")
def self_biometric_register_options(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	info = _webauthn_context()
	if not info["rp_id"]:
		raise ApiError("تعذر تحديد نطاق النظام لتفعيل بصمة الجوال")
	challenge = _store_challenge(ctx.user.get("id"), "register", info)
	return {"data": {"publicKey": {
		"challenge": challenge,
		"rp": {"id": info["rp_id"], "name": "Tageep HRMS"},
		"user": {"id": _b64url_encode(str(emp["id"]).encode()), 
		         "name": emp.get("employeeNumber") or emp["id"],
		         "displayName": emp.get("name") or ""},
		"pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
		"timeout": 120000, "attestation": "none",
		"authenticatorSelection": {"authenticatorAttachment": "platform", "userVerification": "required",
		                           "residentKey": "preferred", "requireResidentKey": False},
	}}}


@route("POST", r"/self/biometric/register")
def self_biometric_register(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	stored = _read_challenge(ctx.user.get("id"), "register")
	body = ctx.body or {}
	try:
		client_data = _client_data(body, "webauthn.create", stored)
		attestation = _b64url_decode(body.get("attestationObject"))
	except ApiError:
		raise
	except Exception:
		raise ApiError("لم تُقرأ بصمة الجوال — أعد المحاولة")
	try:
		att, _ = _cbor_decode(attestation)
	except Exception:
		raise ApiError("بيانات تسجيل بصمة الجوال غير صالحة")
	auth_data = att.get("authData") if isinstance(att, dict) else None
	if not isinstance(auth_data, bytes) or len(auth_data) < 55:
		raise ApiError("بيانات تسجيل بصمة الجوال غير صالحة")
	_check_auth_data(auth_data, stored)
	offset = 53
	cred_len = int.from_bytes(auth_data[offset:offset + 2], "big")
	offset += 2
	cred_id = auth_data[offset:offset + cred_len]
	offset += cred_len
	try:
		cose, cose_end = _cbor_decode(auth_data, offset)
		cose_bytes = auth_data[offset:cose_end]
		_cose_public_key(cose)
	except Exception:
		raise ApiError("مفتاح بصمة الجوال غير صالح")
	if not cred_id:
		raise ApiError("لم يُرسل الجهاز معرّفًا للبصمة")
	credential_id = _b64url_encode(cred_id)
	creds = s.setdefault("selfCredentials", [])
	# بصمة واحدة لكل موظف: استبدل أي تسجيل سابق له أو لنفس الجهاز
	creds[:] = [c for c in creds if c.get("employeeId") != emp["id"] and c.get("credentialId") != credential_id]
	creds.append({
		"id": uid("wc_"), "employeeId": emp["id"], "employeeName": emp.get("name") or "",
		"userId": ctx.user.get("id"), "credentialId": credential_id,
		"publicKey": _b64url_encode(cose_bytes), "signCount": 0,
		"deviceLabel": str(body.get("deviceLabel") or "")[:160],
		"transports": body.get("transports") or ["internal"],
		"createdAt": engine._now(), "lastUsedAt": "", "ip": getattr(frappe.local, "request", None) and frappe.local.request.remote_addr or "",
	})
	frappe.cache().delete_value(_challenge_key(ctx.user.get("id")))
	ctx.audit("biometric_register", "attendance", "selfCredentials", credential_id,
	          "تفعيل بصمة جوال %s" % (emp.get("name") or ""))
	_commit(ctx)
	return {"data": {"enrolled": True, "credentialId": credential_id},
	        "message": "تم تفعيل بصمة جوالك — من الآن لا تُقبل بصمة الحضور إلا ببصمة إصبعك أو وجهك"}


@route("POST", r"/self/biometric/assert/options")
def self_biometric_assert_options(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	cred = _self_credential(s, emp["id"])
	if not cred:
		raise ApiError("فعّل بصمة جوالك أولاً من الخدمة الذاتية حتى تُقبل بصمتك", 428)
	info = _webauthn_context()
	if not info["rp_id"]:
		raise ApiError("تعذر تحديد نطاق النظام لقراءة بصمة الجوال")
	challenge = _store_challenge(ctx.user.get("id"), "assert", info)
	return {"data": {"publicKey": {
		"challenge": challenge, "rpId": info["rp_id"], "timeout": 120000,
		"userVerification": "required",
		"allowCredentials": [{"type": "public-key", "id": cred["credentialId"],
		                      "transports": cred.get("transports") or ["internal"]}],
	}}}


@route("POST", r"/self/biometric/reset")
@route("DELETE", r"/self/biometric")
def self_biometric_reset(ctx):
	s = ctx.state
	emp = engine.find_employee(s, ctx.user.get("employeeId") or "")
	if not emp:
		raise ApiError("حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية")
	before = len(s.get("selfCredentials") or [])
	s["selfCredentials"] = [c for c in s.get("selfCredentials") or [] if c.get("employeeId") != emp["id"]]
	ctx.audit("biometric_reset", "attendance", "selfCredentials", emp["id"],
	          "إلغاء بصمة جوال %s" % (emp.get("name") or ""))
	_commit(ctx)
	return {"data": {"enrolled": False, "removed": before - len(s["selfCredentials"])},
	        "message": "أُلغيت بصمة الجوال — اضغط «تفعيل بصمة الجوال» لتسجيل جوالك الحالي"}


@route("POST", r"/employees/(?P<emp_id>[^/]+)/biometric/reset")
def employee_biometric_reset(ctx, emp_id):
	"""إعادة تعيين بصمة جوال موظف من شاشة الموظفين (مدير/موارد بشرية)."""
	ctx.require_permission("employees", "edit")
	s = ctx.state
	emp = engine.find_employee(s, emp_id)
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	ctx.scope_branch(emp.get("branchId"))
	before = len(s.get("selfCredentials") or [])
	s["selfCredentials"] = [c for c in s.get("selfCredentials") or [] if c.get("employeeId") != emp["id"]]
	ctx.audit("biometric_reset", "employees", "selfCredentials", emp["id"],
	          "إعادة تعيين بصمة جوال %s من شاشة الموظفين" % (emp.get("name") or ""))
	_commit(ctx)
	return {"data": {"enrolled": False, "removed": before - len(s["selfCredentials"])},
	        "message": "أُعيد تعيين بصمة جوال %s — يسجّل جواله من جديد من الخدمة الذاتية" % (emp.get("name") or "")}


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
		advance = {
			"id": uid("adv_"), "employeeId": request.get("employeeId"),
			"employeeName": emp.get("name") or request.get("employeeName"),
			"totalAmount": request.get("amount"), "remainingAmount": request.get("amount"),
			"monthlyDeduction": request.get("monthlyDeduction") or round2(num(request.get("amount")) / 10.0),
			"status": "active", "requestId": request["id"], "notes": request.get("details") or "",
			"startDate": today_iso(),
			"createdAt": engine._now(), "createdBy": ctx.user.get("name")}
		s.setdefault("advances", []).append(advance)
		_auto_post(ctx, "advance_disbursement", advance["id"], advance["startDate"], [
			("advances", num(advance.get("totalAmount")), 0, "سلفة موظف — %s" % advance.get("employeeName")),
			("bank", 0, num(advance.get("totalAmount")), "صرف سلفة — %s" % advance.get("employeeName")),
		], "صرف سلفة %s" % advance.get("employeeName"), "advances", "", emp.get("branchId") or "")
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


# ═════════ حسابات الخدمة الذاتية للموظفين ═════════
def _self_username(state, emp):
	taken = {str(u.get("username") or "").lower() for u in state.get("users") or []}
	base = re.sub(r"[^A-Za-z0-9_.-]", "", str(emp.get("employeeNumber") or emp.get("id") or "")).strip() or "emp"
	candidate, index = base, 1
	while candidate.lower() in taken:
		index += 1
		candidate = "%s%s" % (base, index)
	return candidate


def _generate_password(emp):
	import secrets
	digits = re.sub(r"\D", "", str(emp.get("nationalId") or ""))[-4:] or re.sub(r"\D", "", str(emp.get("employeeNumber") or ""))[-4:] or "1234"
	return "Emp@%s%04d" % (digits, secrets.randbelow(10000))


def _new_self_user(state, emp, password="", username=""):
	username = username or _self_username(state, emp)
	if any(str(u.get("username") or "").lower() == username.lower() for u in state.get("users") or []):
		raise ApiError("اسم الدخول مستخدم بالفعل")
	password = password or _generate_password(emp)
	user = {
		"id": uid("u_"), "name": emp.get("name") or username, "username": username,
		"role": "employee", "permissions": {}, "branchId": emp.get("branchId") or "",
		"employeeId": emp["id"], "passwordHash": hash_password(password),
		"mustChangePassword": False, "createdAt": engine._now(), "active": True,
	}
	state.setdefault("users", []).append(user)
	return user, password


@route("POST", r"/employees/(?P<emp_id>[^/]+)/self-account", permission=("users", "add"))
def employee_self_account(ctx, emp_id):
	"""إنشاء أو تحديث حساب خدمة ذاتية للموظف مع ربطه بملفه الوظيفي."""
	s = ctx.state
	emp = engine.find_employee(s, emp_id)
	if not emp:
		raise ApiError("الموظف غير موجود", 404)
	if emp.get("status") == "terminated":
		raise ApiError("لا يمكن إنشاء حساب لموظف منتهي الخدمة")
	users = s.setdefault("users", [])
	existing = next((u for u in users if u.get("employeeId") == emp["id"]), None)
	password = str(ctx.body.get("password") or "")
	if password:
		issues = password_issues(password, (existing or {}).get("username") or emp.get("employeeNumber"))
		if issues:
			raise ApiError(" — ".join(issues))
	if existing:
		if existing.get("role") != "employee":
			return {"data": {"id": existing.get("id"), "username": existing.get("username"), "password": "", "existing": True},
			        "message": "لدى الموظف حساب بدور مختلف — لم يُنشأ حساب خدمة ذاتية جديد"}
		existing.update({"name": emp.get("name") or existing.get("name"), "branchId": emp.get("branchId") or "",
		                 "disabled": False, "active": True})
		if password:
			existing["passwordHash"] = hash_password(password)
			existing.pop("password", None)
		ctx.audit("update", "users", "users", existing["id"], "تحديث حساب خدمة ذاتية لـ %s" % emp.get("name"))
		_commit(ctx)
		return {"data": {"id": existing["id"], "username": existing.get("username"), "password": password, "existing": True},
		        "message": "تم تحديث حساب الخدمة الذاتية" + (" وإعادة تعيين كلمة المرور" if password else "")}
	user, password = _new_self_user(s, emp, password, str(ctx.body.get("username") or "").strip())
	ctx.audit("create", "users", "users", user["id"], "إنشاء حساب خدمة ذاتية لـ %s" % emp.get("name"))
	_commit(ctx)
	return {"data": {"id": user["id"], "name": user["name"], "username": user["username"],
	                  "password": password, "employeeId": emp["id"]},
	        "message": "تم إنشاء حساب الخدمة الذاتية"}


@route("POST", r"/users/self-accounts", permission=("users", "add"))
def users_self_accounts_bulk(ctx):
	"""إنشاء حساب خدمة ذاتية لكل الموظفين النشطين الذين ليس لديهم حساب بعد."""
	s = ctx.state
	users = s.setdefault("users", [])
	created, skipped = [], 0
	for emp in s.get("employees") or []:
		if emp.get("status") == "terminated":
			continue
		if any(u.get("employeeId") == emp.get("id") for u in users):
			skipped += 1
			continue
		user, password = _new_self_user(s, emp)
		created.append({"employeeId": emp["id"], "name": emp.get("name"), "username": user["username"],
		                "password": password, "branchName": _branch_label(s, emp.get("branchId"))})
	if created:
		ctx.audit("create", "users", "users", "", "إنشاء %s حساب خدمة ذاتية" % len(created))
		_commit(ctx)
	return {"data": {"created": created, "skipped": skipped},
	        "message": "تم إنشاء %s حساب خدمة ذاتية" % len(created)}


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
	return {"data": ctx.state.get("settings"), "payrollSettings": ctx.state.get("payrollSettings"),
	        "leavePolicy": ctx.state.get("leavePolicy"), "db": _db_status_payload(ctx)}


@route("PUT", r"/settings", permission=("settings", "edit"))
def settings_save(ctx):
	s = ctx.state
	body = ctx.body or {}
	payload = body.get("settings", body)
	s["settings"] = {**(s.get("settings") or {}), **(payload or {})}
	if isinstance(payload, dict) and isinstance(payload.get("notifications"), dict):
		s["settings"]["notifications"] = {**((s.get("settings") or {}).get("notifications") or {}), **payload["notifications"]}
	if isinstance(body.get("payrollSettings"), dict):
		s["payrollSettings"] = {**(s.get("payrollSettings") or {}), **body["payrollSettings"]}
	if isinstance(body.get("leavePolicy"), dict):
		s["leavePolicy"] = {**(s.get("leavePolicy") or {}), **body["leavePolicy"]}
		if isinstance(body["leavePolicy"].get("lateConversion"), dict):
			s["leavePolicy"]["lateConversion"] = {**(s["leavePolicy"].get("lateConversion") or {}),
			                                             **body["leavePolicy"]["lateConversion"]}
	ctx.audit("update", "settings", "settings", "", "تحديث إعدادات النظام")
	_commit(ctx)
	return {"data": s["settings"], "payrollSettings": s.get("payrollSettings"),
	        "leavePolicy": s.get("leavePolicy"), "message": "تم حفظ الإعدادات"}


@route("GET", r"/system/network", permission=("settings", "view"))
def system_network(ctx):
	return {"data": {"host": frappe.local.site, "serverTime": engine._now(), "db": "mariadb"}}


def _db_status_payload(ctx):
	counts = {key: len(ctx.state.get(key) or []) for key in ("employees", "payslips", "attendanceDaily", "auditLog")}
	try:
		backups = files.list_backups()
	except Exception:
		backups = []
	return {"type": "frappe", "encryptAtRest": bool((ctx.state.get("settings") or {}).get("encryptAtRest", True)),
	        "lastSavedAt": engine._now(), "backups": backups, "counts": counts,
	        "config": {"type": "frappe", "site": frappe.local.site},
	        "supported": [{"type": "frappe", "name": "قاعدة بيانات الفرابي (MariaDB)",
	                       "description": "الحفظ يتم كوثائق JSON داخل جدول tabTageephr State في قاعدة الموقع"}]}


@route("GET", r"/db/status", permission=("settings", "view"))
def db_status(ctx):
	return {"data": _db_status_payload(ctx)}


@route("POST", r"/db/test", permission=("settings", "edit"))
def db_test(ctx):
	result = {"ok": True, "type": "frappe", "site": frappe.local.site,
	          "message": "التخزين داخل قاعدة بيانات الفرابي جاهز"}
	return {"data": result, "message": result["message"]}


@route("POST", r"/db/switch", permission=("settings", "edit"))
def db_switch(ctx):
	raise ApiError("التخزين مُدار من قاعدة بيانات الفرابي — لا يمكن التبديل إلى قاعدة خارجية", 400)


@route("GET", r"/db/backups", permission=("settings", "view"))
def db_backups(ctx):
	return {"data": files.list_backups()}


@route("POST", r"/db/backup", permission=("settings", "edit"))
def db_backup(ctx):
	result = files.create_backup(ctx.state, ctx.body.get("passphrase"), ctx.body.get("encrypt") is not False)
	ctx.audit("backup", "settings", "settings", "", "إنشاء نسخة احتياطية %s" % result["name"])
	_commit(ctx)
	return {"data": {key: result[key] for key in ("name", "size", "createdAt", "encrypted")},
	        "message": "تم إنشاء النسخة الاحتياطية"}


@route("GET", r"/db/backups/(?P<name>[^/]+)/download", permission=("settings", "view"))
def db_backup_file(ctx, name):
	try:
		content = files.read_backup_file(name)
	except FileNotFoundError:
		raise ApiError("النسخة غير موجودة", 404)
	ctx.audit("download_backup", "settings", "settings", "", "تنزيل النسخة %s" % name)
	return _download(content, name)


@route("POST", r"/db/backup/download", permission=("settings", "view"))
def db_backup_download(ctx):
	result = files.create_backup(ctx.state, ctx.body.get("passphrase"), ctx.body.get("encrypt") is not False)
	ctx.audit("backup", "settings", "settings", "", "تنزيل نسخة احتياطية %s" % result["name"])
	_commit(ctx)
	return _download(result["buffer"], result["name"])


@route("POST", r"/db/restore", permission=("settings", "delete"))
def db_restore(ctx):
	upload = ctx.body.get("__file")
	if not upload:
		raise ApiError("لم يتم رفع ملف")
	passphrase = ctx.body.get("passphrase") or frappe.get_request_header("X-Backup-Password") or ""
	try:
		restored = files.restore_from_buffer(upload["content"], passphrase)
	except ValueError as exc:
		raise ApiError(str(exc))
	files.create_backup(ctx.state, auto=True)
	for key in list(ctx.state.keys()):
		if key not in restored:
			ctx.state.pop(key, None)
	ctx.state.update(restored)
	settings = ctx.state.get("settings") or {}
	ctx.state["settings"] = {**DEFAULT_SETTINGS, **settings,
	                        "notifications": {**DEFAULT_SETTINGS["notifications"], **(settings.get("notifications") or {})}}
	ctx.audit("restore", "settings", "settings", "", "استعادة نسخة احتياطية")
	_commit(ctx)
	return {"ok": True, "message": "تمت استعادة البيانات بنجاح"}


@route("POST", r"/db/encryption", permission=("settings", "delete"))
def db_encryption(ctx):
	enabled = ctx.body.get("encryptAtRest") is not False
	ctx.state.setdefault("settings", {})["encryptAtRest"] = enabled
	ctx.audit("update_encryption", "settings", "settings", "", "تشفير النسخ: %s" % enabled)
	_commit(ctx)
	return {"data": {"encryptAtRest": enabled}, "message": "تم تحديث إعداد تشفير النسخ"}


# ═════════ استيراد وتصدير الموظفين ═════════
def _date_cell(row, *keys):
	value = _cell_raw(row, *keys)
	if value in (None, ""):
		return ""
	parsed = date_only(value)
	if parsed:
		return parsed
	text = str(value)
	match = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", text)
	if match:
		return "%s-%s-%s" % (match.group(3), pad2(match.group(2)), pad2(match.group(1)))
	if isinstance(value, (int, float)) or re.match(r"^\d{5}$", text):
		try:
			from datetime import timedelta

			base = datetime(1899, 12, 30)
			return today_iso(base + timedelta(days=float(value)))
		except Exception:
			return ""
	return ""


def _cell_raw(row, *keys):
	for key in keys:
		if row.get(key) not in (None, ""):
			return row[key]
	return ""


def _next_number(employees):
	used = {str(e.get("employeeNumber")) for e in employees}
	number = 1001
	while str(number) in used:
		number += 1
	return str(number)


def _cell(row, *keys):
	for key in keys:
		value = row.get(key)
		if value not in (None, ""):
			if isinstance(value, float) and value.is_integer():
				return str(int(value))
			return str(value).strip() if not isinstance(value, (int, float)) else value
	return ""


@route("POST", r"/import/employees", permission=("employees", "add"))
def import_employees(ctx):
	upload = ctx.body.get("__file")
	if not upload:
		raise ApiError("لم يتم رفع ملف")
	try:
		rows = files.read_table(upload["content"], upload.get("filename") or "")
	except Exception as exc:
		raise ApiError("تعذر قراءة الملف: %s" % str(exc)[:120])
	state = ctx.state
	employees = state.setdefault("employees", [])
	branches = state.get("branches") or []
	departments = state.get("departments") or []
	year = int(today_iso()[:4])
	imported = 0
	errors = []
	for index, row in enumerate(rows):
		row = {str(k).strip(): v for k, v in row.items() if k is not None}
		name = _cell(row, "اسم الموظف", "الاسم", "name")
		if not name:
			errors.append("صف %s: الاسم مفقود" % (index + 2))
			continue
		number = _cell(row, "رقم الموظف", "الرقم", "employeeNumber")
		if number and any(str(e.get("employeeNumber")) == str(number) for e in employees):
			errors.append("صف %s: رقم الموظف %s مكرر" % (index + 2, number))
			continue
		national_id = _cell(row, "الهوية", "رقم الهوية", "nationalId")
		if national_id and any(str(e.get("nationalId")) == str(national_id) for e in employees):
			errors.append("صف %s: رقم الهوية مكرر" % (index + 2))
			continue
		branch_name = _cell(row, "الفرع", "branch")
		department_name = _cell(row, "القسم", "department")
		emp = {
			"id": uid("em_"),
			"name": name,
			"employeeNumber": str(number) if number else _next_number(employees),
			"nationalId": str(national_id),
			"baseSalary": num(_cell(row, "الراتب الأساسي", "الراتب", "baseSalary")),
			"branchId": next((b.get("id") for b in branches if b.get("name") == branch_name), ""),
			"departmentId": next((d.get("id") for d in departments if d.get("name") == department_name), ""),
			"jobTitle": _cell(row, "المسمى الوظيفي", "الوظيفة", "jobTitle"),
			"joinDate": _date_cell(row, "تاريخ التعيين", "joinDate") or today_iso(),
			"phone": _cell(row, "الهاتف", "phone"),
			"email": _cell(row, "البريد", "البريد الإلكتروني", "email"),
			"status": "active",
			"createdAt": engine._now(),
			"createdBy": ctx.user.get("name"),
		}
		employees.append(emp)
		for leave_type in state.get("leaveTypes") or []:
			if num(leave_type.get("daysPerYear")) > 0:
				engine.ensure_balance(state, emp["id"], leave_type["id"], year)
		imported += 1
	ctx.audit("import", "employees", "employees", "", "استيراد %s موظف" % imported)
	_commit(ctx)
	return {"data": {"imported": imported, "errors": errors}, "message": "تم استيراد %s موظف" % imported}


@route("GET", r"/export/employees", permission=("employees", "view"))
def export_employees(ctx):
	state = ctx.state
	branches = {b.get("id"): b.get("name") for b in (state.get("branches") or [])}
	departments = {d.get("id"): d.get("name") for d in (state.get("departments") or [])}
	columns = [{"key": "employeeNumber", "label": "رقم الموظف"}, {"key": "name", "label": "اسم الموظف"},
	           {"key": "nationalId", "label": "الهوية"}, {"key": "branch", "label": "الفرع"},
	           {"key": "department", "label": "القسم"}, {"key": "jobTitle", "label": "المسمى الوظيفي"},
	           {"key": "baseSalary", "label": "الراتب الأساسي"}, {"key": "joinDate", "label": "تاريخ التعيين"},
	           {"key": "phone", "label": "الهاتف"}, {"key": "email", "label": "البريد"},
	           {"key": "status", "label": "الحالة"}]
	rows = []
	for emp in state.get("employees") or []:
		rows.append({"employeeNumber": emp.get("employeeNumber") or "", "name": emp.get("name") or "",
		             "nationalId": emp.get("nationalId") or "", "branch": branches.get(emp.get("branchId"), ""),
		             "department": departments.get(emp.get("departmentId"), ""),
		             "jobTitle": emp.get("jobTitle") or "", "baseSalary": num(emp.get("baseSalary")),
		             "joinDate": emp.get("joinDate") or "", "phone": emp.get("phone") or "",
		             "email": emp.get("email") or "",
		             "status": "منتهي" if emp.get("status") == "terminated" else "نشط"})
	content = files.build_xlsx(columns, rows, "الموظفون")
	ctx.audit("export", "employees", "employees", "", "تصدير %s موظف إلى Excel" % len(rows))
	return _download(content, "employees-%s.xlsx" % time.strftime("%Y%m%d-%H%M%S"))


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
	if name == "payslips" and ctx.user.get("employeeId") and not has_permission(ctx.user, module, "view"):
		rows = [r for r in rows if r.get("employeeId") == ctx.user.get("employeeId")]
	preset = ROLE_PRESETS.get(ctx.user.get("role")) or {}
	if name == "employees" and preset.get("branchScoped") and ctx.user.get("branchId"):
		rows = [r for r in rows if r.get("branchId") == ctx.user.get("branchId")]
	if name in ("employeeTransfers", "employeePromotions") and preset.get("branchScoped") and ctx.user.get("branchId"):
		rows = [r for r in rows if ctx.user.get("branchId") in (r.get("branchId"), r.get("toBranchId"))]
	for key, value in ctx.query.items():
		if key in ("search", "q", "limit", "sort", "order", "path"):
			continue
		rows = [r for r in rows if str(r.get(key)) == str(value)]
	search = ctx.query.get("search") or ctx.query.get("q")
	if search:
		needle = str(search).lower()
		rows = [r for r in rows if needle in json.dumps(r, ensure_ascii=False).lower()]
	sort_key = ctx.query.get("sort")
	if sort_key:
		rows.sort(key=lambda r: (r.get(sort_key) is None, str(r.get(sort_key))),
		          reverse=str(ctx.query.get("order") or "asc").lower() == "desc")
	limit = int(num(ctx.query.get("limit")) or 0)
	if limit > 0:
		rows = rows[:limit]
	if name == "users":
		rows = [sanitize_user(r) for r in rows]
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
	_financial_collection_hook(ctx, name, payload)
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
	record = next((r for r in rows or [] if r.get("id") == record_id), None)
	if record:
		if name == "users":
			if record_id == ctx.user.get("id"):
				raise ApiError("لا يمكنك حذف حسابك الحالي")
			admins = [u for u in (ctx.state.get("users") or []) if u.get("role") == "admin" and not u.get("disabled")]
			if record.get("role") == "admin" and len(admins) <= 1:
				raise ApiError("لا يمكن حذف آخر مدير نظام")
		if name == "workShifts" and any(e.get("shiftId") == record_id for e in (ctx.state.get("employees") or [])):
			raise ApiError("لا يمكن حذف دوام مرتبط بموظفين")
		if name == "leaveTypes" and any(l.get("leaveTypeId") == record_id and l.get("status") == "pending"
		                                for l in (ctx.state.get("leaveRequests") or [])):
			raise ApiError("لا يمكن حذف نوع إجازة له طلبات معلقة")
		if name == "branches" and any(e.get("branchId") == record_id for e in (ctx.state.get("employees") or [])):
			raise ApiError("لا يمكن حذف فرع مرتبط بموظفين")
		if name == "departments" and any(e.get("departmentId") == record_id for e in (ctx.state.get("employees") or [])):
			raise ApiError("لا يمكن حذف قسم مرتبط بموظفين")
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


@route("POST", r"/license/activate", auth=False)
def license_activate(ctx):
	return {"data": {"active": True, "licensed": True, "required": False},
	        "message": "الترخيص مُدار تلقائيًا داخل الفرابي — لا حاجة لمفتاح تنشيط"}


@route("POST", r"/method/tageep\.api\.sync_fingerprint", auth=False)
def compat_sync_fingerprint(ctx):
	result = fingerprint_punches(ctx)
	records = ctx.body.get("records") or ctx.body.get("punches") or []
	return {"message": "ok", "added": result.get("added", 0), "skipped": result.get("skipped", 0),
	        "unknown": result.get("unknown") or [],
	        "data": {"added": result.get("added", 0), "total": len(records), "skipped": result.get("skipped", 0)}}


# ═════════ إدارة الحسابات ═════════
def _accounts_collection(ctx):
	rows = ctx.state.get("accounts")
	if not isinstance(rows, list) or not rows:
		rows = accounting.default_accounts()
		ctx.state["accounts"] = rows
	return accounting.ensure_default_accounts(ctx.state)


def _vouchers_collection(ctx):
	rows = ctx.state.get("vouchers")
	if not isinstance(rows, list):
		rows = []
		ctx.state["vouchers"] = rows
	return rows


@route("GET", r"/accounts/summary", permission=("accounts", "view"))
def accounts_summary(ctx):
	_accounts_collection(ctx)
	return {"data": accounting.summary(ctx.state)}


@route("GET", r"/accounts/tree", permission=("accounts", "view"))
def accounts_tree(ctx):
	_accounts_collection(ctx)
	return {"data": accounting.tree(ctx.state, ctx.query.get("from") or "", ctx.query.get("to") or "")}


@route("GET", r"/accounts/next-code", permission=("accounts", "view"))
def accounts_next_code(ctx):
	_accounts_collection(ctx)
	try:
		code = accounting.next_code(ctx.state, ctx.query.get("parentId") or "")
	except ValueError as exc:
		raise ApiError(str(exc))
	return {"data": {"code": code}}


@route("GET", r"/accounts/mapping", permission=("accounts", "view"))
def accounts_mapping(ctx):
	_accounts_collection(ctx)
	current = accounting.mapping(ctx.state)
	rows = [{"key": key, "label": label, "code": current.get(key), "typeLabel": ""}
	        for key, label in accounting.MAPPING_LABELS.items()]
	return {"data": {"mapping": current, "rows": rows, "events": accounting.EVENT_LABELS}}


@route("PUT", r"/accounts/mapping", permission=("accounts", "edit"))
def accounts_mapping_save(ctx):
	_accounts_collection(ctx)
	body = ctx.body if isinstance(ctx.body, dict) else {}
	payload = body.get("mapping") if isinstance(body.get("mapping"), dict) else body
	index = {str(a.get("code")): a for a in accounting.accounts(ctx.state)}
	for key in accounting.DEFAULT_MAPPING:
		code = str(payload.get(key) or "").strip()
		if not code:
			continue
		account = index.get(code)
		if not account:
			raise ApiError("كود الحساب غير موجود: %s" % code)
		if account.get("isGroup"):
			raise ApiError("اختر حسابًا فرعيًا لا رئيسيًا: %s" % account.get("name"))
	saved = accounting.save_mapping(ctx.state, payload)
	ctx.audit("update", "accounts", "settings", "accountingMapping", "تحديث الربط المحاسبي التلقائي")
	_commit(ctx)
	return {"data": saved, "message": "تم حفظ الربط المحاسبي"}


@route("POST", r"/accounts/postings/sync", permission=("accounts", "add"))
def accounts_postings_sync(ctx):
	"""ترحيل القيود الناقصة لكل العمليات المالية السابقة (رواتب، نهاية خدمة، سلف)."""
	s = ctx.state
	_accounts_collection(ctx)
	if not accounting.mapping(s).get("enabled", True):
		raise ApiError("الترحيل التلقائي معطّل — فعّله من تبويب الربط المحاسبي أولًا")
	created, skipped, failed = 0, 0, []
	currency = (s.get("settings") or {}).get("currency") or ""

	def attempt(event, ref_id, date, entries, description, ref_type="", ref_number="", branch_id=""):
		nonlocal created, skipped
		if not ref_id or accounting.has_posting(s, event, ref_id):
			skipped += 1
			return
		try:
			voucher = accounting.post_entry(s, event, ref_id, date, entries, description=description,
			                                ref_type=ref_type, ref_number=ref_number,
			                                user=ctx.user.get("name"), branch_id=branch_id, currency=currency)
		except ValueError as exc:
			failed.append(str(exc))
			return
		if voucher:
			created += 1

	for slip in s.get("payslips") or []:
		if slip.get("status") not in ("approved", "paid"):
			continue
		attempt("payslip_accrual", slip.get("id"), slip.get("toDate") or slip.get("paidDate"),
		        accounting.payslip_entries(slip),
		        "استحقاق راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
		        "payslips", "%s/%s" % (slip.get("month"), slip.get("year")), slip.get("branchId") or "")
		if slip.get("status") == "paid":
			attempt("payslip_payment", slip.get("id"), slip.get("paidDate"),
			        accounting.payslip_payment_entries(slip),
			        "صرف راتب %s — %s/%s" % (slip.get("employeeName"), slip.get("month"), slip.get("year")),
			        "payslips", "%s/%s" % (slip.get("month"), slip.get("year")), slip.get("branchId") or "")
	for record in s.get("eosSettlements") or []:
		total = num(record.get("total"))
		attempt("eos_accrual", record.get("id"), record.get("endDate") or today_iso(), [
			("eosExpense", total, 0, "مكافأة نهاية خدمة — %s" % record.get("employeeName")),
			("eosPayable", 0, total, "مستحق نهاية خدمة — %s" % record.get("employeeName")),
		], "استحقاق نهاية خدمة %s" % record.get("employeeName"), "eosSettlements", "")
	for advance in s.get("advances") or []:
		total = num(advance.get("totalAmount"))
		attempt("advance_disbursement", advance.get("id"), advance.get("startDate") or today_iso(), [
			("advances", total, 0, "سلفة موظف — %s" % advance.get("employeeName")),
			("bank", 0, total, "صرف سلفة — %s" % advance.get("employeeName")),
		], "صرف سلفة %s" % advance.get("employeeName"), "advances", "")
	if created:
		ctx.audit("post", "accounts", "vouchers", "sync", "ترحيل %s قيدًا تلقائيًا ناقصًا" % created)
	_commit(ctx)
	return {"data": {"created": created, "skipped": skipped, "failed": failed[:10]},
	        "message": "تم ترحيل %s قيدًا (تم تجاهل %s قيد موجود)%s" % (created, skipped,
	                                                         (" — تعذّر ترحيل %s" % len(failed)) if failed else "")}


@route("POST", r"/accounts", permission=("accounts", "add"))
def accounts_create(ctx):
	rows = _accounts_collection(ctx)
	body = ctx.body
	name = str(body.get("name") or "").strip()
	if not name:
		raise ApiError("اسم الحساب مطلوب")
	parent = next((a for a in rows if a.get("id") == body.get("parentId")), None)
	if body.get("parentId") and not parent:
		raise ApiError("الحساب الأب غير موجود")
	acct_type = (parent or {}).get("type") or body.get("type") or "asset"
	if acct_type not in accounting.ACCOUNT_TYPES:
		raise ApiError("نوع الحساب غير صالح")
	code = str(body.get("code") or "").strip()
	if not code:
		try:
			code = accounting.next_code(ctx.state, parent.get("id") if parent else "")
		except ValueError as exc:
			raise ApiError(str(exc))
	if any(str(a.get("code")) == code for a in rows):
		raise ApiError("كود الحساب مستخدم بالفعل: %s" % code)
	is_group = bool(body.get("isGroup"))
	record = {
		"id": uid("acc_"), "code": code, "name": name,
		"nameEn": str(body.get("nameEn") or "").strip(),
		"type": acct_type, "parentId": (parent or {}).get("id") or "",
		"isGroup": is_group, "nature": body.get("nature") or ("debit" if acct_type in accounting.DEBIT_TYPES else "credit"),
		"partyType": body.get("partyType") or "", "description": str(body.get("description") or "").strip(),
		"active": body.get("active", True) is not False, "createdAt": engine._now(),
		"createdBy": ctx.user.get("name"),
	}
	rows.append(record)
	ctx.audit("create", "accounts", "accounts", record["id"], "إضافة حساب %s" % name)
	_commit(ctx)
	return {"data": record, "message": "تمت إضافة الحساب بنجاح"}


def _ensure_no_cycle(state, account, parent_id):
	current = parent_id
	guard = 0
	while current and guard < 30:
		if current == account.get("id"):
			raise ApiError("لا يمكن جعل الحساب تابعًا لنفسه أو لأحد فروعه")
		row = next((a for a in accounting.accounts(state) if a.get("id") == current), None)
		current = (row or {}).get("parentId") or ""
		guard += 1


@route("PUT", r"/accounts/(?P<account_id>[^/]+)", permission=("accounts", "edit"))
def accounts_update(ctx, account_id):
	rows = _accounts_collection(ctx)
	record = next((a for a in rows if a.get("id") == account_id), None)
	if not record:
		raise ApiError("الحساب غير موجود", 404)
	body = ctx.body
	if body.get("parentId") is not None:
		parent_id = body.get("parentId") or ""
		if parent_id and not any(a.get("id") == parent_id for a in rows):
			raise ApiError("الحساب الأب غير موجود")
		_ensure_no_cycle(ctx.state, record, parent_id)
		record["parentId"] = parent_id
	if str(body.get("code") or "").strip():
		code = str(body.get("code")).strip()
		if any(str(a.get("code")) == code and a.get("id") != account_id for a in rows):
			raise ApiError("كود الحساب مستخدم بالفعل: %s" % code)
		record["code"] = code
	if str(body.get("name") or "").strip():
		record["name"] = str(body.get("name")).strip()
	for key in ("nameEn", "description", "partyType"):
		if key in body:
			record[key] = str(body.get(key) or "").strip()
	if "nature" in body and body.get("nature"):
		record["nature"] = body.get("nature")
	if "active" in body:
		record["active"] = body.get("active") is not False
	if "isGroup" in body:
		has_moves = any(line.get("accountId") == account_id
		                for v in ctx.state.get("vouchers") or [] for line in v.get("lines") or [])
		if record.get("isGroup") and not body.get("isGroup") and has_moves:
			raise ApiError("لا يمكن تحويل حساب رئيسي عليه حركة إلى حساب فرعي")
		record["isGroup"] = bool(body.get("isGroup"))
	record["updatedAt"] = engine._now()
	ctx.audit("update", "accounts", "accounts", account_id, "تعديل حساب %s" % record.get("name"))
	_commit(ctx)
	return {"data": record, "message": "تم حفظ الحساب"}


@route("DELETE", r"/accounts/(?P<account_id>[^/]+)", permission=("accounts", "delete"))
def accounts_delete(ctx, account_id):
	rows = _accounts_collection(ctx)
	record = next((a for a in rows if a.get("id") == account_id), None)
	if not record:
		raise ApiError("الحساب غير موجود", 404)
	if any((a.get("parentId") or "") == account_id for a in rows):
		raise ApiError("لا يمكن حذف حساب له حسابات فرعية — احذف الفروع أولًا")
	if any(line.get("accountId") == account_id for v in ctx.state.get("vouchers") or [] for line in v.get("lines") or []):
		raise ApiError("لا يمكن حذف حساب عليه حركة في السندات")
	ctx.state["accounts"] = [a for a in rows if a.get("id") != account_id]
	ctx.audit("delete", "accounts", "accounts", account_id, "حذف حساب %s" % record.get("name"))
	_commit(ctx)
	return {"ok": True, "message": "تم حذف الحساب"}


@route("GET", r"/vouchers", permission=("accounts", "view"))
def vouchers_list(ctx):
	rows = _vouchers_collection(ctx)
	vtype = ctx.query.get("type") or ""
	status = ctx.query.get("status") or ""
	date_from = date_only(ctx.query.get("from"))
	date_to = date_only(ctx.query.get("to"))
	search = str(ctx.query.get("search") or "").lower()
	out = []
	for voucher in rows:
		day = date_only(voucher.get("date"))
		if vtype and voucher.get("type") != vtype:
			continue
		if status and (voucher.get("status") or "draft") != status:
			continue
		if date_from and day < date_from:
			continue
		if date_to and day > date_to:
			continue
		if search and search not in json.dumps(voucher, ensure_ascii=False).lower():
			continue
		out.append(voucher)
	out.sort(key=lambda v: (date_only(v.get("date")), str(v.get("number"))), reverse=True)
	limit = int(num(ctx.query.get("limit")) or 500)
	return {"data": out[:limit], "total": len(out)}


@route("GET", r"/vouchers/next-number", permission=("accounts", "view"))
def vouchers_next_number(ctx):
	_vouchers_collection(ctx)
	vtype = ctx.query.get("type") or "journal"
	if vtype not in accounting.VOUCHER_TYPES:
		raise ApiError("نوع السند غير صالح")
	return {"data": {"number": accounting.next_voucher_number(ctx.state, vtype, ctx.query.get("date") or "")}}


@route("GET", r"/vouchers/(?P<voucher_id>[^/]+)", permission=("accounts", "view"))
def vouchers_get(ctx, voucher_id):
	rows = _vouchers_collection(ctx)
	record = next((v for v in rows if v.get("id") == voucher_id), None)
	if not record:
		raise ApiError("السند غير موجود", 404)
	return {"data": record}


def _prepare_voucher(ctx, payload, existing=None):
	record = dict(existing or {})
	record.update({
		"type": payload.get("type") or record.get("type") or "journal",
		"date": date_only(payload.get("date")) or record.get("date") or today_iso(),
		"description": str(payload.get("description") or "").strip(),
		"reference": str(payload.get("reference") or "").strip(),
		"branchId": payload.get("branchId") or record.get("branchId") or "",
		"partyType": payload.get("partyType") or "",
		"party": str(payload.get("party") or "").strip(),
		"currency": payload.get("currency") or ((ctx.state.get("settings") or {}).get("currency") or ""),
		"notes": str(payload.get("notes") or "").strip(),
		"lines": payload.get("lines") or record.get("lines") or [],
	})
	if payload.get("number") is not None:
		record["number"] = str(payload.get("number") or "").strip()
	record["isOpening"] = record.get("type") == "opening"
	return record


@route("POST", r"/vouchers", permission=("accounts", "add"))
def vouchers_create(ctx):
	_vouchers_collection(ctx)
	record = _prepare_voucher(ctx, ctx.body)
	record["id"] = uid("vc_")
	record["status"] = "posted" if ctx.body.get("post") else "draft"
	record["createdAt"] = engine._now()
	record["createdBy"] = ctx.user.get("name")
	try:
		accounting.validate_voucher(ctx.state, record, None, require_balance=record["status"] == "posted")
	except ValueError as exc:
		raise ApiError(str(exc))
	if record["status"] == "posted":
		record["postedAt"] = engine._now()
	ctx.state["vouchers"].append(record)
	ctx.audit("create", "accounts", "vouchers", record["id"], "إنشاء %s %s" % (record["type"], record["number"]))
	_commit(ctx)
	return {"data": record, "message": "تم حفظ السند"}


@route("PUT", r"/vouchers/(?P<voucher_id>[^/]+)", permission=("accounts", "edit"))
def vouchers_update(ctx, voucher_id):
	rows = _vouchers_collection(ctx)
	record = next((v for v in rows if v.get("id") == voucher_id), None)
	if not record:
		raise ApiError("السند غير موجود", 404)
	if record.get("status") == "cancelled":
		raise ApiError("السند ملغي — لا يمكن تعديله")
	updated = _prepare_voucher(ctx, ctx.body, record)
	try:
		accounting.validate_voucher(ctx.state, updated, voucher_id, require_balance=updated.get("status") == "posted"
		                            or bool(ctx.body.get("post")))
	except ValueError as exc:
		raise ApiError(str(exc))
	if ctx.body.get("post"):
		updated["status"] = "posted"
		updated["postedAt"] = engine._now()
	updated["updatedAt"] = engine._now()
	record.clear()
	record.update(updated)
	ctx.audit("update", "accounts", "vouchers", voucher_id, "تعديل السند %s" % record.get("number"))
	_commit(ctx)
	return {"data": record, "message": "تم حفظ السند"}


@route("POST", r"/vouchers/(?P<voucher_id>[^/]+)/post", permission=("accounts", "edit"))
def vouchers_post(ctx, voucher_id):
	rows = _vouchers_collection(ctx)
	record = next((v for v in rows if v.get("id") == voucher_id), None)
	if not record:
		raise ApiError("السند غير موجود", 404)
	if record.get("status") == "cancelled":
		raise ApiError("السند ملغي — لا يمكن ترحيله")
	try:
		accounting.post_voucher(ctx.state, record)
	except ValueError as exc:
		raise ApiError(str(exc))
	ctx.audit("post", "accounts", "vouchers", voucher_id, "ترحيل السند %s" % record.get("number"))
	_commit(ctx)
	return {"data": record, "message": "تم ترحيل السند"}


@route("POST", r"/vouchers/(?P<voucher_id>[^/]+)/cancel", permission=("accounts", "edit"))
def vouchers_cancel(ctx, voucher_id):
	rows = _vouchers_collection(ctx)
	record = next((v for v in rows if v.get("id") == voucher_id), None)
	if not record:
		raise ApiError("السند غير موجود", 404)
	record["status"] = "cancelled"
	record["cancelledAt"] = engine._now()
	ctx.audit("cancel", "accounts", "vouchers", voucher_id, "إلغاء السند %s" % record.get("number"))
	_commit(ctx)
	return {"data": record, "message": "تم إلغاء السند"}


@route("DELETE", r"/vouchers/(?P<voucher_id>[^/]+)", permission=("accounts", "delete"))
def vouchers_delete(ctx, voucher_id):
	rows = _vouchers_collection(ctx)
	record = next((v for v in rows if v.get("id") == voucher_id), None)
	if not record:
		raise ApiError("السند غير موجود", 404)
	if (record.get("status") or "draft") == "posted":
		raise ApiError("لا يمكن حذف سند مُرحّل — ألغِه أولًا")
	ctx.state["vouchers"] = [v for v in rows if v.get("id") != voucher_id]
	ctx.audit("delete", "accounts", "vouchers", voucher_id, "حذف السند %s" % record.get("number"))
	_commit(ctx)
	return {"ok": True, "message": "تم حذف السند"}


@route("GET", r"/accounts/statement", permission=("accounts", "view"))
def accounts_statement(ctx):
	_accounts_collection(ctx)
	account_id = ctx.query.get("accountId") or ""
	if not account_id:
		raise ApiError("اختر الحساب أولًا")
	try:
		data = accounting.statement(ctx.state, account_id, ctx.query.get("from") or "", ctx.query.get("to") or "")
	except ValueError as exc:
		raise ApiError(str(exc))
	return {"data": data}


@route("GET", r"/accounting/reports/catalog", permission=("accounts", "view"))
def accounting_reports_catalog(ctx):
	return {"data": accounting.report_catalog()}


@route("POST", r"/accounting/reports/run", permission=("accounts", "view"))
def accounting_reports_run(ctx):
	_accounts_collection(ctx)
	report_id = ctx.body.get("reportId") or "trial_balance"
	try:
		result = accounting.run_report(ctx.state, report_id, ctx.body.get("filters") or {})
	except ValueError as exc:
		raise ApiError(str(exc))
	return {"data": result}


@route("POST", r"/accounting/reports/export", permission=("accounts", "view"))
def accounting_reports_export(ctx):
	_accounts_collection(ctx)
	report_id = ctx.body.get("reportId") or "trial_balance"
	try:
		result = accounting.run_report(ctx.state, report_id, ctx.body.get("filters") or {})
	except ValueError as exc:
		raise ApiError(str(exc))
	columns = [{"key": c["key"], "label": c["label"]} for c in result["columns"]]
	stamp = time.strftime("%Y%m%d-%H%M%S")
	if str(ctx.body.get("format") or "xlsx") in ("xlsx", "excel"):
		return _download(files.build_xlsx(columns, result["rows"], result["title"]), "%s-%s.xlsx" % (report_id, stamp))
	return _download(files.build_csv(columns, result["rows"]), "%s-%s.csv" % (report_id, stamp))


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
	content_type = str(request.headers.get("Content-Type") or "").lower()
	if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
		try:
			for key, value in (request.form or {}).items():
				body[key] = value
			for key in (request.files or {}):
				uploaded = request.files[key]
				body["__file"] = {"filename": uploaded.filename or "", "content": uploaded.read()}
		except Exception:
			frappe.log_error(frappe.get_traceback(), "TageepHR multipart")
		try:
			if request.files:
				frappe.local.uploaded_file = None
		except Exception:
			pass
	elif request.data:
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
		for route_method, pattern, handler, needs_auth, permission in ROUTES:
			if route_method != method:
				continue
			match = pattern.match(path)
			if not match:
				continue
			if needs_auth:
				_current_user(ctx)
			if permission and not has_permission(ctx.user, permission[0], permission[1]):
				raise ApiError("لا تملك صلاحية لهذا الإجراء", 403)
			result = handler(ctx, **match.groupdict())
			if result is None:
				return
			return result
		_current_user(ctx)
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
