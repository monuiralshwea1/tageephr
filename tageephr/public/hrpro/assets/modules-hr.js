'use strict';

/* ═══════════════════════════════════════════════════════════════
   وحدات الموارد البشرية: لوحة المعلومات، الموظفون، المؤسسة،
   الحضور والبصمة، الإجازات
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const h = A.h;

    const kpiCard = ({ label, value, sub, icon, tone = '' }) => `
        <div class="kpi ${tone}">
            <div class="kpi-top"><span>${h(label)}</span>${A.icon(icon)}</div>
            <div class="kpi-value">${value}</div>
            ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
        </div>`;

    const emptyState = message => `<div class="empty">${A.icon('file')}<div>${h(message || 'لا توجد بيانات')}</div></div>`;

    const tabsBar = (tabs, active) => `<div class="tabs">${tabs.map(t => `<button class="tab ${t.id === active ? 'active' : ''}" data-tab="${t.id}">${h(t.label)}</button>`).join('')}</div>`;

    function bindTabs(container, tabs, active, onChange) {
        container.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
            const id = btn.dataset.tab;
            container.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
            const pane = container.querySelector('[data-pane]');
            if (pane) pane.innerHTML = '';
            onChange(id);
        }));
    }

    const ROUTES = [];
    A.registerRoutes([
        { path: 'dashboard', module: 'dashboard', label: 'لوحة المعلومات', subtitle: 'نظرة عامة على أداء الموارد البشرية', icon: 'dashboard', group: 'الرئيسية', permission: 'dashboard' },
        { path: 'employees', module: 'employees', label: 'الموظفون', subtitle: 'إدارة ملفات الموظفين والعقود والمستندات', icon: 'users', group: 'الموارد البشرية', permission: 'employees' },
        { path: 'organization', module: 'organization', label: 'المؤسسة', subtitle: 'الفروع والأقسام والرتب وأوقات الدوام', icon: 'building', group: 'الموارد البشرية', permission: 'organization' },
        { path: 'attendance', module: 'attendance', label: 'الحضور والبصمة', subtitle: 'معالجة البصمات والتأخيرات والانصراف المبكر', icon: 'fingerprint', group: 'الوقت والحضور', permission: 'attendance' },
        { path: 'leaves', module: 'leaves', label: 'الإجازات', subtitle: 'الطلبات والأرصدة والاستحقاق وتحويل التأخير', icon: 'palmtree', group: 'الوقت والحضور', permission: 'leaves' }
    ]);

    // ═══════════════════════════════════════════════════════════
    // لوحة المعلومات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('dashboard', {
        render: async view => {
            const [data, notif] = await Promise.all([A.get('/dashboard'), A.get('/notifications?unread=1').catch(() => ({ data: [] }))]);
            const k = data.kpi;
            const expiring = data.expiring || {};
            view.innerHTML = `
                <div class="grid grid-4">
                    ${kpiCard({ label: 'الموظفون النشطون', value: A.numFmt(k.headcount), sub: `${A.numFmt(k.presentToday)} حاضر اليوم`, icon: 'users' })}
                    ${kpiCard({ label: 'الحضور اليوم', value: A.numFmt(k.presentToday), sub: `${A.numFmt(k.lateToday)} متأخر • ${A.numFmt(k.onLeaveToday)} إجازة`, icon: 'checkCircle' })}
                    ${kpiCard({ label: 'الغياب اليوم', value: A.numFmt(k.absentToday), sub: `${A.numFmt(k.missingPunchToday)} بصمة ناقصة`, icon: 'alert', tone: 'danger' })}
                    ${kpiCard({ label: 'نسبة الالتزام الشهرية', value: A.numFmt(k.attendanceRate, 1) + '%', sub: `${A.numFmt(k.monthLateMinutes)} دقيقة تأخير`, icon: 'chart', tone: 'info' })}
                </div>
                <div class="grid grid-4 mt">
                    ${kpiCard({ label: 'رواتب الشهر الحالي', value: A.money(k.monthPayroll, false), sub: 'صافي الكشوف المسجلة', icon: 'wallet', tone: 'purple' })}
                    ${kpiCard({ label: 'طلبات إجازة معلقة', value: A.numFmt(k.pendingLeaves), sub: 'بحاجة إلى اعتماد', icon: 'palmtree', tone: 'warn' })}
                    ${kpiCard({ label: 'رصيد السلف المفتوحة', value: A.money(k.openAdvances, false), sub: 'إجمالي المتبقي', icon: 'credit' })}
                    ${kpiCard({ label: 'إجمالي رواتب السنة', value: A.money(k.payrollCostYtd, false), sub: 'حتى تاريخ اليوم', icon: 'money', tone: 'info' })}
                </div>

                <div class="split mt">
                    <div class="card">
                        <div class="card-head"><h3>حركة الحضور — آخر 14 يومًا</h3><span class="spacer"></span><span class="badge">${A.numFmt(k.monthOvertimeMinutes)} دقيقة إضافي هذا الشهر</span></div>
                        <div class="card-pad">${A.barChart(data.charts.attendance, [
                            { key: 'present', label: 'حاضر', color: '#0d9488' },
                            { key: 'leave', label: 'إجازة', color: '#0ea5e9' },
                            { key: 'absent', label: 'غائب', color: '#f43f5e' }
                        ])}</div>
                    </div>
                    <div class="card">
                        <div class="card-head"><h3>إشعارات ذكية</h3><span class="spacer"></span><button class="btn btn-sm" id="dashScan">فحص</button></div>
                        <div class="card-pad" id="dashNotifs">
                            ${(notif.data || []).length ? notif.data.slice(0, 6).map(n => `
                                <div class="notif-item" style="padding:9px 0;border-color:var(--line-soft)">
                                    <div class="notif-icon ${h(n.severity || 'info')}">${A.icon(n.severity === 'danger' ? 'alert' : n.severity === 'warning' ? 'clock' : 'bell')}</div>
                                    <div><strong>${h(n.title)}</strong><p>${h(n.message)}</p></div>
                                </div>`).join('') : emptyState('لا توجد إشعارات جديدة')}
                            <button class="btn btn-sm w-full mt" id="dashAllNotifs">عرض كل الإشعارات</button>
                        </div>
                    </div>
                </div>

                <div class="split mt">
                    <div class="card">
                        <div class="card-head"><h3>حضور اليوم</h3><span class="spacer"></span><button class="btn btn-sm" id="dashAttendance">الانتقال للحضور</button></div>
                        ${A.table({
                            columns: [
                                { key: 'employeeName', label: 'الموظف', render: r => `<div class="employee-cell"><div class="avatar">${h(A.initials(r.employeeName))}</div><div><strong>${h(r.employeeName)}</strong><small>${h(A.deptName(r.departmentId))}</small></div></div>` },
                                { key: 'checkIn', label: 'الحضور', render: r => r.checkIn || '—' },
                                { key: 'checkOut', label: 'الانصراف', render: r => r.checkOut || '—' },
                                { key: 'lateMinutes', label: 'التأخير', align: 'left', render: r => r.lateMinutes ? `<span class="badge warning">${r.lateMinutes} د</span>` : '—' },
                                { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                            ],
                            rows: data.today || [],
                            empty: 'لم تُسجل بصمات اليوم بعد'
                        })}
                    </div>
                    <div class="card">
                        <div class="card-head"><h3>تنبيهات المستندات والعقود</h3></div>
                        <div class="card-pad">
                            <div class="stat-line"><span>عقود تنتهي خلال 60 يومًا</span><strong>${A.numFmt(expiring.contracts)}</strong></div>
                            <div class="stat-line"><span>مستندات تنتهي قريبًا</span><strong>${A.numFmt(expiring.documents)}</strong></div>
                            <div class="stat-line"><span>فترة رواتب مفتوحة</span><strong>${data.openPeriod ? h(data.openPeriod.name) : 'لا توجد'}</strong></div>
                            <div class="stat-line"><span>إجمالي الرواتب السنة</span><strong>${A.money(k.payrollCostYtd)}</strong></div>
                            <div class="mt"></div>
                            <h4 class="section-title">توزيع الموظفين على الأقسام</h4>
                            ${A.hBars(data.charts.departments)}
                        </div>
                    </div>
                </div>

                <div class="split mt">
                    <div class="card">
                        <div class="card-head"><h3>اتجاه صافي الرواتب</h3></div>
                        <div class="card-pad">${A.lineChart(data.charts.payroll.map(p => ({ label: p.label, value: p.total })))}</div>
                    </div>
                    <div class="card">
                        <div class="card-head"><h3>استخدام الإجازات (أيام معتمدة)</h3></div>
                        <div class="card-pad">${A.hBars(data.charts.leaves, '#0ea5e9')}</div>
                    </div>
                </div>`;

            document.getElementById('dashScan').onclick = async () => {
                await A.post('/notifications/scan');
                A.toast('تم فحص الإشعارات');
                A.route();
            };
            document.getElementById('dashAllNotifs').onclick = () => A.navigate('/notifications');
            document.getElementById('dashAttendance').onclick = () => A.navigate('/attendance');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // الموظفون
    // ═══════════════════════════════════════════════════════════

    const employeeFields = () => ([
        { type: 'section', label: 'البيانات الأساسية', icon: 'user' },
        { key: 'name', label: 'الاسم الكامل', required: true },
        { key: 'nameEn', label: 'الاسم بالإنجليزية' },
        { key: 'employeeNumber', label: 'الرقم الوظيفي (رقم البصمة)', required: true, help: 'رقم يدوي فريد لا يتكرر، ويجب أن يطابق رقم الموظف في جهاز البصمة ليُربط حضوره تلقائيًا.' },
        { key: 'nationalId', label: 'رقم الهوية / الإقامة' },
        { key: 'idExpiryDate', label: 'انتهاء الهوية', type: 'date' },
        { key: 'dateOfBirth', label: 'تاريخ الميلاد', type: 'date' },
        { key: 'gender', label: 'الجنس', type: 'select', options: [{ value: '', label: '—' }, { value: 'male', label: 'ذكر' }, { value: 'female', label: 'أنثى' }] },
        { key: 'maritalStatus', label: 'الحالة الاجتماعية', type: 'select', options: [{ value: '', label: '—' }, { value: 'single', label: 'أعزب' }, { value: 'married', label: 'متزوج' }, { value: 'divorced', label: 'مطلق' }, { value: 'widowed', label: 'أرمل' }] },
        { key: 'nationality', label: 'الجنسية' },
        { key: 'phone', label: 'الهاتف' },
        { key: 'email', label: 'البريد الإلكتروني', type: 'email' },
        { key: 'address', label: 'العنوان', full: true },
        { type: 'section', label: 'البيانات الوظيفية', icon: 'briefcase' },
        { key: 'branchId', label: 'الفرع', type: 'select', options: A.options.branches(), required: true },
        { key: 'departmentId', label: 'القسم', type: 'select', options: A.options.departments(), placeholder: '—' },
        { key: 'jobGradeId', label: 'الرتبة الوظيفية', type: 'select', options: A.options.grades(), placeholder: '—' },
        { key: 'jobTitle', label: 'المسمى الوظيفي' },
        { key: 'shiftId', label: 'الدوام', type: 'select', options: A.options.shifts(), placeholder: '—' },
        { key: 'managerId', label: 'المدير المباشر', type: 'select', options: A.options.employees(), placeholder: '—' },
        { key: 'joinDate', label: 'تاريخ التعيين', type: 'date', required: true },
        { key: 'status', label: 'الحالة', type: 'select', options: [{ value: 'active', label: 'نشط' }, { value: 'terminated', label: 'منتهي الخدمة' }] },
        { key: 'terminationDate', label: 'تاريخ نهاية الخدمة', type: 'date' },
        { key: 'contractType', label: 'نوع العقد', type: 'select', options: [{ value: 'permanent', label: 'دائم' }, { value: 'fixed', label: 'محدد المدة' }, { value: 'temporary', label: 'مؤقت' }] },
        { key: 'contractStartDate', label: 'بداية العقد', type: 'date' },
        { key: 'contractEndDate', label: 'نهاية العقد', type: 'date' },
        { type: 'section', label: 'الراتب والبيانات المالية', icon: 'wallet' },
        { key: 'baseSalary', label: 'الراتب الأساسي', type: 'number', step: '0.01', required: true },
        { key: 'insuranceEligible', label: 'مشمول بالتأمينات الاجتماعية', type: 'checkbox', default: true },
        { key: 'insuranceNumber', label: 'رقم التأمين' },
        { key: 'gosiBase', label: 'الأجر الخاضع للتأمينات', type: 'number', step: '0.01', help: 'اتركه فارغًا لاستخدام الراتب الأساسي' },
        { key: 'bankName', label: 'البنك' },
        { key: 'bankAccount', label: 'رقم الآيبان / الحساب' },
        { key: 'payrollExcluded', label: 'استبعاد من مسير الرواتب', type: 'checkbox' },
        { type: 'section', label: 'إعدادات الإجازات', icon: 'palmtree' },
        { key: 'lateConversionLeaveTypeId', label: 'نوع الإجازة لتحويل ساعات التأخير', type: 'select', options: A.options.leaves(), placeholder: 'افتراضي النظام' },
        { key: 'leaveBalance', label: 'رصيد الإجازات الافتتاحي', type: 'number', step: '0.5', help: 'يستخدم عند ترحيل بيانات قديمة' },
        { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
    ]);

    function employeeForm(employee) {
        const values = { status: 'active', joinDate: A.today(), insuranceEligible: true, contractType: 'permanent', ...employee };
        A.formModal({
            title: employee ? `تعديل بيانات ${employee.name}` : 'إضافة موظف جديد',
            size: 'lg',
            fields: employeeFields(),
            values,
            submitLabel: employee ? 'حفظ التعديلات' : 'إضافة الموظف',
            onSubmit: async data => {
                if (data.gosiBase === '') delete data.gosiBase;
                if (employee) await A.put(`/collections/employees/${employee.id}`, data);
                else await A.post('/collections/employees', data);
                A.toast(employee ? 'تم حفظ بيانات الموظف' : 'تمت إضافة الموظف بنجاح');
                A.closeModal();
                await A.refresh();
            }
        });
    }

    function debounce(fn, wait) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
    }

    A.registerModule('employees', {
        render: async (view, ctx) => {
            if (ctx.params && ctx.params.length) return renderEmployeeProfile(view, ctx.params[0]);
            const filters = view._filters || (view._filters = makeEmployeeFilterState());
            renderEmployeeList(view, filters);
        }
    });

    function makeEmployeeFilterState() { return { search: '', branchId: '', departmentId: '', status: '' }; }

    function renderEmployeeList(view, state) {
        const employees = (A.state.data.employees || []).filter(e => {
            if (state.branchId && e.branchId !== state.branchId) return false;
            if (state.departmentId && e.departmentId !== state.departmentId) return false;
            if (state.status && (e.status || 'active') !== state.status) return false;
            if (state.search) {
                const q = state.search.toLowerCase();
                if (!`${e.name} ${e.nameEn || ''} ${e.employeeNumber || ''} ${e.nationalId || ''} ${e.phone || ''}`.toLowerCase().includes(q)) return false;
            }
            return true;
        }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));

        view.innerHTML = `
            <div class="card">
                <div class="toolbar">
                    <input class="search" id="empSearch" placeholder="بحث بالاسم أو الرقم أو الهوية" value="${h(state.search)}">
                    <select id="empBranch"><option value="">كل الفروع</option>${A.options.branches().map(o => `<option value="${h(o.value)}" ${state.branchId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                    <select id="empDept"><option value="">كل الأقسام</option>${A.options.departments().map(o => `<option value="${h(o.value)}" ${state.departmentId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                    <select id="empStatus"><option value="">كل الحالات</option><option value="active" ${state.status === 'active' ? 'selected' : ''}>نشط</option><option value="terminated" ${state.status === 'terminated' ? 'selected' : ''}>منتهي</option></select>
                    <span class="grow"></span>
                    ${A.can('employees', 'add') ? `<button class="btn btn-primary" id="empAdd">${A.icon('plus')} موظف جديد</button>` : ''}
                    <button class="btn" id="empExport">${A.icon('download')} Excel</button>
                    <button class="btn" id="empPrint">${A.icon('print')} طباعة</button>
                    ${A.can('employees', 'add') ? `<button class="btn" id="empImport">${A.icon('upload')} استيراد</button><input type="file" id="empImportFile" accept=".xlsx,.xls,.csv" class="hidden">` : ''}
                </div>
                ${A.table({
                    columns: [
                        { key: 'name', label: 'الموظف', render: e => `<div class="employee-cell"><div class="avatar">${h(A.initials(e.name))}</div><div><strong>${h(e.name)}</strong><small>${h(e.employeeNumber || '—')} • ${h(e.jobTitle || 'بدون مسمى')}</small></div></div>` },
                        { key: 'branchId', label: 'الفرع', render: e => h(A.branchName(e.branchId)) },
                        { key: 'departmentId', label: 'القسم', render: e => h(A.deptName(e.departmentId)) },
                        { key: 'baseSalary', label: 'الراتب الأساسي', align: 'left', render: e => A.money(e.baseSalary) },
                        { key: 'joinDate', label: 'التعيين', render: e => A.date(e.joinDate) },
                        { key: 'phone', label: 'الهاتف', render: e => h(e.phone || '—') },
                        { key: 'status', label: 'الحالة', render: e => A.badge(e.status === 'terminated' ? 'terminated' : 'active') }
                    ],
                    rows: employees,
                    actions: e => [
                        { title: 'الملف', icon: 'eye', action: 'view' },
                        ...(A.can('employees', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'edit' }] : []),
                        ...(A.can('employees', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                    ],
                    empty: 'لا يوجد موظفون مطابقون — أضف أول موظف للبدء'
                })}
                <div class="toolbar" style="border-bottom:0;border-top:1px solid var(--line)">
                    <span class="small muted">الإجمالي: ${A.numFmt(employees.length)} موظف • إجمالي الرواتب: ${A.money(employees.reduce((s, e) => s + A.num(e.baseSalary), 0))}</span>
                </div>
            </div>`;

        const refreshList = () => renderEmployeeList(view, state);
        const apply = () => {
            state.search = document.getElementById('empSearch').value;
            state.branchId = document.getElementById('empBranch').value;
            state.departmentId = document.getElementById('empDept').value;
            state.status = document.getElementById('empStatus').value;
            refreshList();
        };
        document.getElementById('empSearch').oninput = debounce(apply, 300);
        ['empBranch', 'empDept', 'empStatus'].forEach(id => { document.getElementById(id).onchange = apply; });
        const addBtn = document.getElementById('empAdd');
        if (addBtn) addBtn.onclick = () => employeeForm(null);
        document.getElementById('empExport').onclick = () => A.downloadGet('/export/employees', 'employees.xlsx').catch(err => A.toast(err.message, 'error'));
        document.getElementById('empPrint').onclick = () => A.printTable({
            title: 'كشف الموظفين',
            columns: [
                { label: 'الرقم', render: e => h(e.employeeNumber) },
                { label: 'الاسم', render: e => h(e.name) },
                { label: 'الفرع', render: e => h(A.branchName(e.branchId)) },
                { label: 'القسم', render: e => h(A.deptName(e.departmentId)) },
                { label: 'الراتب', render: e => A.money(e.baseSalary) },
                { label: 'التعيين', render: e => A.date(e.joinDate) },
                { label: 'الهاتف', render: e => h(e.phone || '') }
            ],
            rows: employees, landscape: true
        });
        const importBtn = document.getElementById('empImport');
        if (importBtn) importBtn.onclick = () => document.getElementById('empImportFile').click();
        const importFile = document.getElementById('empImportFile');
        if (importFile) importFile.onchange = async () => {
            if (!importFile.files[0]) return;
            try {
                const result = await A.upload('/import/employees', importFile.files[0]);
                A.toast(result.message);
                await A.refresh();
            } catch (err) { A.toast(err.message, 'error'); }
        };
        A.bindActions({
            view: id => A.navigate('/employees/' + id),
            edit: id => employeeForm(A.employeeById(id)),
            del: async id => {
                const emp = A.employeeById(id);
                if (!(await A.confirm({ title: 'حذف موظف', message: `هل تريد حذف ${h(emp.name)}؟ لا يمكن التراجع.`, danger: true, confirmLabel: 'حذف' }))) return;
                try { await A.del('/collections/employees/' + id); A.toast('تم حذف الموظف'); await A.refresh(); } catch (err) { A.toast(err.message, 'error'); }
            }
        });
    }

    async function renderEmployeeProfile(view, id) {
        const data = await A.get(`/employees/${id}/profile`);
        const emp = data.employee;
        const att = data.attendance || {};
        const balances = data.balances || [];
        const serviceYears = emp.joinDate ? A.round2((Date.now() - new Date(emp.joinDate).getTime()) / (365.25 * 86400000)) : 0;
        const annualBalance = balances.filter(b => b.leaveTypeId === 'lt_annual').reduce((s, b) => s + A.num(b.balance), 0);

        view.innerHTML = `
            <button class="btn btn-sm mb" id="empBack">${A.icon('arrowLeft')} عودة للموظفين</button>
            <div class="card">
                <div class="profile-hero">
                    <div class="profile-avatar">${h(A.initials(emp.name))}</div>
                    <div style="flex:1;min-width:220px">
                        <h2>${h(emp.name)} ${A.badge(emp.status === 'terminated' ? 'terminated' : 'active')}</h2>
                        <div class="profile-meta">
                            <span>${A.icon('briefcase')} ${h(emp.jobTitle || 'بدون مسمى')}</span>
                            <span>${A.icon('building')} ${h(A.branchName(emp.branchId))} / ${h(A.deptName(emp.departmentId))}</span>
                            <span>${A.icon('user')} ${h(emp.employeeNumber || '—')}</span>
                            <span>${A.icon('clock')} ${serviceYears} سنة خدمة</span>
                        </div>
                    </div>
                    <div class="flex gap">
                        ${A.can('employees', 'edit') ? `<button class="btn" id="profileEdit">${A.icon('edit')} تعديل</button>` : ''}
                        ${A.can('leaves', 'add') ? `<button class="btn" id="profileLeave">${A.icon('palmtree')} طلب إجازة</button>` : ''}
                        ${A.can('payroll', 'add') ? `<button class="btn btn-primary" id="profileEos">${A.icon('money')} تسوية نهاية الخدمة</button>` : ''}
                    </div>
                </div>
            </div>

            <div class="grid grid-4 mt">
                ${kpiCard({ label: 'الراتب الأساسي', value: A.money(emp.baseSalary, false), sub: (A.state.data.settings || {}).currency || '', icon: 'wallet' })}
                ${kpiCard({ label: 'رصيد الإجازة السنوية', value: A.numFmt(annualBalance, 1) + ' يوم', sub: `${A.numFmt(att.paidLeaveDays, 1)} مستخدمة هذا الشهر`, icon: 'palmtree', tone: 'info' })}
                ${kpiCard({ label: 'أيام الحضور هذا الشهر', value: A.numFmt(att.presentDays), sub: `${A.numFmt(att.absentDays)} غياب • ${A.numFmt(att.lateDays)} تأخير`, icon: 'checkCircle' })}
                ${kpiCard({ label: 'دقائق التأخير', value: A.numFmt(att.lateMinutes), sub: `${A.numFmt(att.overtimeMinutes)} دقيقة إضافي`, icon: 'clock', tone: 'warn' })}
            </div>

            <div class="grid grid-2 mt">
                <div class="card">
                    <div class="card-head"><h3>البيانات الأساسية</h3></div>
                    <div class="card-pad info-list">
                        <div><span>الهوية / الإقامة</span><strong>${h(emp.nationalId || '—')}</strong></div>
                        <div><span>انتهاء الهوية</span><strong>${A.date(emp.idExpiryDate)}</strong></div>
                        <div><span>الجنسية</span><strong>${h(emp.nationality || '—')}</strong></div>
                        <div><span>الجنس</span><strong>${emp.gender === 'female' ? 'أنثى' : emp.gender === 'male' ? 'ذكر' : '—'}</strong></div>
                        <div><span>الهاتف</span><strong>${h(emp.phone || '—')}</strong></div>
                        <div><span>البريد</span><strong>${h(emp.email || '—')}</strong></div>
                        <div><span>تاريخ التعيين</span><strong>${A.date(emp.joinDate)}</strong></div>
                        <div><span>الدوام</span><strong>${h(A.shiftName(emp.shiftId))}</strong></div>
                        <div><span>البنك</span><strong>${h(emp.bankName || '—')}</strong></div>
                        <div><span>الحساب</span><strong>${h(emp.bankAccount || '—')}</strong></div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><h3>أرصدة الإجازات</h3></div>
                    <div class="card-pad">
                        ${balances.length ? balances.map(b => {
                            const type = (A.state.data.leaveTypes || []).find(t => t.id === b.leaveTypeId) || {};
                            return `<div class="stat-line"><span>${h(type.name || b.leaveTypeId)} (${b.year})</span><strong>${A.numFmt(b.balance, 1)} يوم</strong></div>`;
                        }).join('') : emptyState('لم تُنشأ أرصدة بعد — شغّل الاستحقاق من شاشة الإجازات')}
                    </div>
                </div>
            </div>

            <div class="card mt">
                ${tabsBar([{ id: 'attendance', label: 'الحضور' }, { id: 'payslips', label: 'كشوف الرواتب' }, { id: 'leaves', label: 'الإجازات' }, { id: 'docs', label: 'المستندات' }, { id: 'contracts', label: 'العقود' }, { id: 'compensation', label: 'البدلات والخصومات' }], 'attendance')}
                <div class="tab-pane" data-pane id="profilePane"></div>
            </div>`;

        const pane = document.getElementById('profilePane');
        const renderTab = async tab => {
            if (tab === 'attendance') {
                const month = await A.get(`/attendance/daily?from=${A.monthStart()}&to=${A.today()}&employeeId=${emp.id}`);
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="small muted">سجل الشهر الحالي</span><span class="grow"></span><button class="btn btn-sm" id="profileCorrect">${A.icon('edit')} معالجة بصمة</button></div>`
                    + A.table({
                        columns: [
                            { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                            { key: 'checkIn', label: 'الحضور', render: r => r.checkIn || '—' },
                            { key: 'checkOut', label: 'الانصراف', render: r => r.checkOut || '—' },
                            { key: 'lateMinutes', label: 'تأخير', align: 'left', render: r => r.lateMinutes ? r.lateMinutes + ' د' : '—' },
                            { key: 'overtimeMinutes', label: 'إضافي', align: 'left', render: r => r.overtimeMinutes ? r.overtimeMinutes + ' د' : '—' },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                        ], rows: month.data, empty: 'لا توجد سجلات هذا الشهر'
                    });
                const btn = document.getElementById('profileCorrect');
                if (btn) btn.onclick = () => openCorrectionModal(emp.id, A.today(), () => A.route());
            } else if (tab === 'payslips') {
                pane.innerHTML = A.table({
                    columns: [
                        { key: 'month', label: 'الفترة', render: r => `${A.monthName(r.month)} ${r.year}` },
                        { key: 'grossSalary', label: 'الإجمالي', align: 'left', render: r => A.money(r.grossSalary) },
                        { key: 'totalDeductionsAll', label: 'الخصومات', align: 'left', render: r => A.money(r.totalDeductionsAll) },
                        { key: 'netSalary', label: 'الصافي', align: 'left', render: r => `<strong>${A.money(r.netSalary)}</strong>` },
                        { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                    ],
                    rows: data.payslips,
                    actions: r => [{ title: 'عرض', icon: 'eye', action: 'viewSlip', html: `<button class="btn btn-icon btn-sm" onclick="App.viewPayslip('${h(r.id)}')" title="عرض الكشف">${A.icon('eye')}</button>` }],
                    empty: 'لا توجد كشوف رواتب'
                });
            } else if (tab === 'leaves') {
                pane.innerHTML = A.table({
                    columns: [
                        { key: 'leaveTypeId', label: 'النوع', render: r => h(A.leaveTypeName(r.leaveTypeId)) },
                        { key: 'fromDate', label: 'من', render: r => A.date(r.fromDate) },
                        { key: 'toDate', label: 'إلى', render: r => A.date(r.toDate) },
                        { key: 'days', label: 'الأيام', align: 'left' },
                        { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                    ], rows: data.leaves, empty: 'لا توجد إجازات مسجلة'
                });
            } else if (tab === 'docs') {
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('employees', 'edit') ? `<button class="btn btn-primary btn-sm" id="addDoc">${A.icon('plus')} إضافة مستند</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'name', label: 'المستند' },
                            { key: 'number', label: 'الرقم' },
                            { key: 'issueDate', label: 'الإصدار', render: r => A.date(r.issueDate) },
                            { key: 'expiryDate', label: 'الانتهاء', render: r => A.date(r.expiryDate) },
                            { key: 'notes', label: 'ملاحظات' }
                        ], rows: data.documents, actions: r => [{ title: 'حذف', icon: 'trash', action: 'delDoc' }], empty: 'لا توجد مستندات'
                    });
                const addDoc = document.getElementById('addDoc');
                if (addDoc) addDoc.onclick = () => A.formModal({
                    title: 'إضافة مستند',
                    fields: [
                        { key: 'name', label: 'اسم المستند', required: true },
                        { key: 'number', label: 'الرقم' },
                        { key: 'issueDate', label: 'تاريخ الإصدار', type: 'date' },
                        { key: 'expiryDate', label: 'تاريخ الانتهاء', type: 'date' },
                        { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
                    ],
                    onSubmit: async values => {
                        await A.post('/collections/employeeDocuments', { ...values, employeeId: emp.id });
                        A.closeModal(); A.toast('تمت إضافة المستند'); A.route();
                    }
                });
                A.bindActions({ delDoc: async docId => { await A.del('/collections/employeeDocuments/' + docId); A.toast('تم الحذف'); A.route(); } });
            } else if (tab === 'contracts') {
                pane.innerHTML = A.table({
                    columns: [
                        { key: 'contractType', label: 'النوع' },
                        { key: 'startDate', label: 'البداية', render: r => A.date(r.startDate) },
                        { key: 'endDate', label: 'النهاية', render: r => A.date(r.endDate) },
                        { key: 'salary', label: 'الراتب', align: 'left', render: r => A.money(r.salary) },
                        { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                    ], rows: data.contracts, empty: 'لا توجد عقود مسجلة'
                });
            } else {
                pane.innerHTML = `<div class="grid grid-2">
                    <div><h4 class="section-title">البدلات</h4>${A.table({ columns: [{ key: 'allowanceTypeId', label: 'البدل', render: r => h((A.state.data.allowanceTypes.find(t => t.id === r.allowanceTypeId) || {}).name || '—') }, { key: 'amount', label: 'المبلغ', align: 'left', render: r => A.money(r.amount) }], rows: data.allowances, empty: 'لا توجد بدلات' })}</div>
                    <div><h4 class="section-title">الخصومات</h4>${A.table({ columns: [{ key: 'deductionTypeId', label: 'الخصم', render: r => h((A.state.data.deductionTypes.find(t => t.id === r.deductionTypeId) || {}).name || '—') }, { key: 'amount', label: 'المبلغ', align: 'left', render: r => A.money(r.amount) }], rows: data.deductions, empty: 'لا توجد خصومات' })}</div>
                </div><div class="mt"><h4 class="section-title">السلف والقروض</h4>${A.table({
                    columns: [
                        { key: 'type', label: 'النوع', render: r => r.kind || 'سلفة' },
                        { key: 'totalAmount', label: 'المبلغ', align: 'left', render: r => A.money(r.totalAmount) },
                        { key: 'remainingAmount', label: 'المتبقي', align: 'left', render: r => A.money(r.remainingAmount) },
                        { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                    ], rows: [...data.advances.map(x => ({ ...x, kind: 'سلفة' })), ...data.loans.map(x => ({ ...x, kind: 'قرض' }))], empty: 'لا توجد سلف أو قروض'
                })}</div>`;
            }
        };
        bindTabs(view, [], 'attendance', renderTab);
        renderTab('attendance');

        document.getElementById('empBack').onclick = () => A.navigate('/employees');
        const editBtn = document.getElementById('profileEdit');
        if (editBtn) editBtn.onclick = () => employeeForm(emp);
        const leaveBtn = document.getElementById('profileLeave');
        if (leaveBtn) leaveBtn.onclick = () => openLeaveRequestModal(emp.id, () => A.route());
        const eosBtn = document.getElementById('profileEos');
        if (eosBtn) eosBtn.onclick = async () => {
            try {
                const result = await A.get(`/payroll/eos/${emp.id}?endDate=${A.today()}`);
                const eos = result.data;
                A.rawModal({
                    title: 'تسوية نهاية الخدمة',
                    body: `<div class="info-list">
                        <div><span>الموظف</span><strong>${h(eos.employeeName)}</strong></div>
                        <div><span>سنوات الخدمة</span><strong>${A.numFmt(eos.serviceYears, 2)} سنة</strong></div>
                        <div><span>آخر راتب</span><strong>${A.money(eos.lastSalary)}</strong></div>
                        <div><span>مكافأة الخدمة</span><strong>${A.money(eos.gratuity)}</strong></div>
                        <div><span>أيام إجازة غير مستخدمة</span><strong>${A.numFmt(eos.unusedLeaveDays, 1)}</strong></div>
                        <div><span>قيمة الإجازات</span><strong>${A.money(eos.leavePay)}</strong></div>
                        <div><span>الإجمالي</span><strong>${A.money(eos.total)}</strong></div>
                    </div>`,
                    footer: `<button class="btn btn-primary" id="saveEos">حفظ التسوية</button>`
                });
                document.getElementById('saveEos').onclick = async () => {
                    await A.post('/payroll/eos', { employeeId: emp.id, endDate: A.today() });
                    A.closeModal(); A.toast('تم حفظ تسوية نهاية الخدمة');
                };
            } catch (err) { A.toast(err.message, 'error'); }
        };
    }

    // ═══════════════════════════════════════════════════════════
    // المؤسسة: الفروع، الأقسام، الرتب، الدوام، العطلات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('organization', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'branches', label: 'الفروع' }, { id: 'departments', label: 'الأقسام' }, { id: 'grades', label: 'الرتب الوظيفية' }, { id: 'shifts', label: 'أوقات الدوام' }, { id: 'holidays', label: 'العطلات الرسمية' }], 'branches')}
                <div class="tab-pane" id="orgPane"></div>
            </div>`;
            const pane = document.getElementById('orgPane');
            const tab = async id => {
                if (id === 'branches') {
                    pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('organization', 'add') ? `<button class="btn btn-primary btn-sm" id="orgAdd">${A.icon('plus')} فرع جديد</button>` : ''}</div>`
                        + A.table({
                            columns: [
                                { key: 'name', label: 'الفرع', render: b => `<strong>${h(b.name)}</strong><br><span class="small muted">${h(b.code || '')}</span>` },
                                { key: 'address', label: 'العنوان', render: b => h(b.address || '—') },
                                { key: 'phone', label: 'الهاتف', render: b => h(b.phone || '—') },
                                { key: 'managerId', label: 'المدير', render: b => h(A.employeeName(b.managerId)) },
                                { key: 'employees', label: 'الموظفون', align: 'left', render: b => A.numFmt((A.state.data.employees || []).filter(e => e.branchId === b.id).length) }
                            ],
                            rows: A.state.data.branches,
                            actions: b => [
                                ...(A.can('organization', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'orgEdit' }] : []),
                                ...(A.can('organization', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'orgDel', class: 'btn-danger' }] : [])
                            ],
                            empty: 'لا توجد فروع'
                        });
                    const add = document.getElementById('orgAdd');
                    if (add) add.onclick = () => branchForm(null);
                    A.bindActions({ orgEdit: id => branchForm(A.state.data.branches.find(b => b.id === id)), orgDel: id => orgDelete('branches', id, A.state.data.branches.find(b => b.id === id)?.name) });
                } else if (id === 'departments') {
                    pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('organization', 'add') ? `<button class="btn btn-primary btn-sm" id="orgAdd">${A.icon('plus')} قسم جديد</button>` : ''}</div>`
                        + A.table({
                            columns: [
                                { key: 'name', label: 'القسم', render: d => `<strong>${h(d.name)}</strong>${d.costCenter ? `<br><span class="small muted">مركز تكلفة: ${h(d.costCenter)}</span>` : ''}` },
                                { key: 'branchId', label: 'الفرع', render: d => h(A.branchName(d.branchId)) },
                                { key: 'managerId', label: 'المدير', render: d => h(A.employeeName(d.managerId)) },
                                { key: 'employees', label: 'عدد الموظفين', align: 'left', render: d => A.numFmt((A.state.data.employees || []).filter(e => e.departmentId === d.id).length) }
                            ],
                            rows: A.state.data.departments,
                            actions: d => [
                                ...(A.can('organization', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'orgEdit' }] : []),
                                ...(A.can('organization', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'orgDel', class: 'btn-danger' }] : [])
                            ],
                            empty: 'لا توجد أقسام'
                        });
                    const add = document.getElementById('orgAdd');
                    if (add) add.onclick = () => departmentForm(null);
                    A.bindActions({ orgEdit: id => departmentForm(A.state.data.departments.find(d => d.id === id)), orgDel: id => orgDelete('departments', id, A.state.data.departments.find(d => d.id === id)?.name) });
                } else if (id === 'grades') {
                    pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('organization', 'add') ? `<button class="btn btn-primary btn-sm" id="orgAdd">${A.icon('plus')} رتبة جديدة</button>` : ''}</div>`
                        + A.table({
                            columns: [
                                { key: 'name', label: 'الرتبة' },
                                { key: 'minSalary', label: 'الحد الأدنى', align: 'left', render: g => A.money(g.minSalary) },
                                { key: 'maxSalary', label: 'الحد الأعلى', align: 'left', render: g => A.money(g.maxSalary) },
                                { key: 'description', label: 'الوصف', render: g => h(g.description || '—') }
                            ],
                            rows: A.state.data.jobGrades,
                            actions: g => [
                                ...(A.can('organization', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'orgEdit' }] : []),
                                ...(A.can('organization', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'orgDel', class: 'btn-danger' }] : [])
                            ],
                            empty: 'لا توجد رتب وظيفية'
                        });
                    const add = document.getElementById('orgAdd');
                    if (add) add.onclick = () => gradeForm(null);
                    A.bindActions({ orgEdit: id => gradeForm(A.state.data.jobGrades.find(g => g.id === id)), orgDel: id => orgDelete('jobGrades', id, A.state.data.jobGrades.find(g => g.id === id)?.name) });
                } else if (id === 'shifts') {
                    pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('organization', 'add') ? `<button class="btn btn-primary btn-sm" id="orgAdd">${A.icon('plus')} دوام جديد</button>` : ''}</div>`
                        + A.table({
                            columns: [
                                { key: 'name', label: 'اسم الدوام' },
                                {
                                    key: 'periods', label: 'الفترات', render: s => (s.periods || []).length
                                        ? `<div class="pill-list">${s.periods.map(p => `<span class="badge">${h(p.name || 'فترة')}: ${h(p.startTime)} - ${h(p.endTime)}</span>`).join('')}</div>`
                                        : '<span class="muted">—</span>'
                                },
                                { key: 'required', label: 'الساعات المطلوبة', align: 'left', render: s => {
                                    const minutes = (s.periods || []).reduce((sum, p) => {
                                        const [sh, sm] = String(p.startTime || '0:0').split(':').map(Number);
                                        const [eh, em] = String(p.endTime || '0:0').split(':').map(Number);
                                        const diff = (eh * 60 + em) - (sh * 60 + sm);
                                        return sum + (diff > 0 ? diff : diff + 1440);
                                    }, 0);
                                    return A.numFmt(minutes / 60, 1) + ' ساعة';
                                } },
                                { key: 'employees', label: 'الموظفون', align: 'left', render: s => A.numFmt((A.state.data.employees || []).filter(e => e.shiftId === s.id).length) }
                            ],
                            rows: A.state.data.workShifts,
                            actions: s => [
                                ...(A.can('organization', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'orgEdit' }] : []),
                                ...(A.can('organization', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'orgDel', class: 'btn-danger' }] : [])
                            ],
                            empty: 'لا توجد أوقات دوام'
                        });
                    const add = document.getElementById('orgAdd');
                    if (add) add.onclick = () => shiftForm(null);
                    A.bindActions({ orgEdit: id => shiftForm(A.state.data.workShifts.find(s => s.id === id)), orgDel: id => orgDelete('workShifts', id, A.state.data.workShifts.find(s => s.id === id)?.name) });
                } else {
                    pane.innerHTML = `<div class="toolbar" style="padding:0 0 12px;border:0"><span class="grow"></span>${A.can('organization', 'add') ? `<button class="btn btn-primary btn-sm" id="orgAdd">${A.icon('plus')} عطلة جديدة</button>` : ''}</div>`
                        + A.table({
                            columns: [
                                { key: 'name', label: 'المناسبة' },
                                { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                                { key: 'branchId', label: 'الفرع', render: r => r.branchId ? h(A.branchName(r.branchId)) : 'كل الفروع' },
                                { key: 'paid', label: 'مدفوعة', render: r => A.badge(r.paid === false ? 'rejected' : 'active', r.paid === false ? 'غير مدفوعة' : 'مدفوعة') }
                            ],
                            rows: (A.state.data.holidays || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')),
                            actions: r => [
                                ...(A.can('organization', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'orgEdit' }] : []),
                                ...(A.can('organization', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'orgDel', class: 'btn-danger' }] : [])
                            ],
                            empty: 'لا توجد عطلات مسجلة'
                        });
                    const add = document.getElementById('orgAdd');
                    if (add) add.onclick = () => holidayForm(null);
                    A.bindActions({ orgEdit: id => holidayForm(A.state.data.holidays.find(x => x.id === id)), orgDel: id => orgDelete('holidays', id, A.state.data.holidays.find(x => x.id === id)?.name) });
                }
            };
            bindTabs(view, [], 'branches', tab);
            tab('branches');
        }
    });

    function branchForm(branch) {
        A.formModal({
            title: branch ? 'تعديل فرع' : 'فرع جديد',
            fields: [
                { key: 'name', label: 'اسم الفرع', required: true },
                { key: 'code', label: 'الرمز' },
                { key: 'address', label: 'العنوان', full: true },
                { key: 'phone', label: 'الهاتف' },
                { key: 'managerId', label: 'مدير الفرع', type: 'select', options: A.options.employees(), placeholder: '—' },
                { key: 'active', label: 'نشط', type: 'checkbox', default: true }
            ],
            values: branch || { active: true },
            onSubmit: async data => {
                if (branch) await A.put('/collections/branches/' + branch.id, data);
                else await A.post('/collections/branches', data);
                A.closeModal(); A.toast('تم حفظ الفرع'); await A.refresh();
            }
        });
    }
    function departmentForm(dept) {
        A.formModal({
            title: dept ? 'تعديل قسم' : 'قسم جديد',
            fields: [
                { key: 'name', label: 'اسم القسم', required: true },
                { key: 'branchId', label: 'الفرع', type: 'select', options: A.options.branches(), placeholder: 'كل الفروع' },
                { key: 'managerId', label: 'مدير القسم', type: 'select', options: A.options.employees(), placeholder: '—' },
                { key: 'costCenter', label: 'مركز التكلفة' },
                { key: 'description', label: 'الوصف', type: 'textarea', full: true }
            ],
            values: dept || {},
            onSubmit: async data => {
                if (dept) await A.put('/collections/departments/' + dept.id, data);
                else await A.post('/collections/departments', data);
                A.closeModal(); A.toast('تم حفظ القسم'); await A.refresh();
            }
        });
    }
    function gradeForm(grade) {
        A.formModal({
            title: grade ? 'تعديل رتبة' : 'رتبة جديدة',
            fields: [
                { key: 'name', label: 'اسم الرتبة', required: true },
                { key: 'minSalary', label: 'الحد الأدنى للراتب', type: 'number', step: '0.01' },
                { key: 'maxSalary', label: 'الحد الأعلى للراتب', type: 'number', step: '0.01' },
                { key: 'description', label: 'الوصف', type: 'textarea', full: true }
            ],
            values: grade || {},
            onSubmit: async data => {
                if (grade) await A.put('/collections/jobGrades/' + grade.id, data);
                else await A.post('/collections/jobGrades', data);
                A.closeModal(); A.toast('تم حفظ الرتبة'); await A.refresh();
            }
        });
    }
    function holidayForm(holiday) {
        A.formModal({
            title: holiday ? 'تعديل عطلة' : 'عطلة رسمية جديدة',
            fields: [
                { key: 'name', label: 'المناسبة', required: true },
                { key: 'date', label: 'التاريخ', type: 'date', required: true },
                { key: 'branchId', label: 'الفرع', type: 'select', options: A.options.branches(), placeholder: 'كل الفروع' },
                { key: 'paid', label: 'عطلة مدفوعة', type: 'checkbox', default: true }
            ],
            values: holiday || { paid: true },
            onSubmit: async data => {
                if (holiday) await A.put('/collections/holidays/' + holiday.id, data);
                else await A.post('/collections/holidays', data);
                A.closeModal(); A.toast('تم حفظ العطلة'); await A.refresh();
            }
        });
    }

    function shiftForm(shift) {
        const periods = JSON.parse(JSON.stringify((shift && shift.periods) || [{ id: 'p1', name: 'الفترة الصباحية', startTime: '08:00', endTime: '17:00' }]));
        const rowHtml = (p, index) => `
            <div class="period-row" data-period="${index}">
                <div class="field"><label>اسم الفترة</label><input data-pname value="${h(p.name || '')}" placeholder="صباحية"></div>
                <div class="field"><label>البداية</label><input type="time" data-pstart value="${h(p.startTime || '08:00')}"></div>
                <div class="field"><label>النهاية</label><input type="time" data-pend value="${h(p.endTime || '17:00')}"></div>
                <div class="field"><label>سماح الدخول</label><input type="number" min="0" data-pgrace value="${p.graceMinutes !== undefined && p.graceMinutes !== null ? h(p.graceMinutes) : ''}" placeholder="افتراضي"></div>
                <div class="field"><label>سماح الخروج</label><input type="number" min="0" data-pearly value="${p.earlyGraceMinutes !== undefined && p.earlyGraceMinutes !== null ? h(p.earlyGraceMinutes) : ''}" placeholder="افتراضي"></div>
                <div class="field"><label>حد الغياب</label><input type="number" min="0" data-pabsence value="${p.absenceAfterMinutes !== undefined && p.absenceAfterMinutes !== null ? h(p.absenceAfterMinutes) : ''}" placeholder="معطّل"></div>
                <button type="button" class="btn btn-danger btn-sm" data-remove style="margin-bottom:2px">${A.icon('trash')}</button>
            </div>`;
        const modal = A.rawModal({
            title: shift ? 'تعديل دوام' : 'دوام جديد',
            size: 'md',
            body: `<div class="field"><label>اسم الدوام</label><input id="shiftName" value="${h(shift ? shift.name : '')}" placeholder="الدوام الرسمي"></div>
                   <div class="section-title">فترات الدوام</div>
                   <div id="periodsBox">${periods.map(rowHtml).join('')}</div>
                   <button type="button" class="btn btn-sm" id="addPeriod">${A.icon('plus')} إضافة فترة</button>
                   <div class="alert mt">${A.icon('clock')}<div>سماح الدخول: دقائق لا تُحسب تأخيرًا. سماح الخروج: دقائق لا تُحسب انصرافًا مبكرًا. حد الغياب: إذا تجاوز التأخير هذه الدقائق يُحتسب اليوم غيابًا حتى لو بصم. اتركها فارغة لاستخدام الإعداد العام.</div></div>`,
            footer: `<button class="btn btn-primary" id="saveShift">حفظ الدوام</button><button class="btn" data-close>إلغاء</button>`
        });
        const box = modal.querySelector('#periodsBox');
        const bindRemove = () => box.querySelectorAll('[data-remove]').forEach(btn => {
            btn.onclick = () => { if (box.children.length > 1) btn.closest('[data-period]').remove(); };
        });
        bindRemove();
        modal.querySelector('#addPeriod').onclick = () => {
            const div = document.createElement('div');
            div.innerHTML = rowHtml({ name: '', startTime: '08:00', endTime: '12:00' }, Date.now());
            box.appendChild(div.firstElementChild);
            bindRemove();
        };
        modal.querySelector('#saveShift').onclick = async () => {
            const name = modal.querySelector('#shiftName').value.trim();
            if (!name) return A.toast('اسم الدوام مطلوب', 'error');
            const rows = Array.from(box.querySelectorAll('[data-period]')).map((row, i) => ({
                id: 'p' + (i + 1), name: row.querySelector('[data-pname]').value || 'فترة',
                startTime: row.querySelector('[data-pstart]').value, endTime: row.querySelector('[data-pend]').value,
                graceMinutes: row.querySelector('[data-pgrace]').value === '' ? '' : A.num(row.querySelector('[data-pgrace]').value),
                earlyGraceMinutes: row.querySelector('[data-pearly]').value === '' ? '' : A.num(row.querySelector('[data-pearly]').value),
                absenceAfterMinutes: row.querySelector('[data-pabsence]').value === '' ? '' : A.num(row.querySelector('[data-pabsence]').value)
            }));
            if (!rows.length) return A.toast('أضف فترة واحدة على الأقل', 'error');
            try {
                if (shift) await A.put('/collections/workShifts/' + shift.id, { name, periods: rows });
                else await A.post('/collections/workShifts', { name, periods: rows });
                modal.close(); A.toast('تم حفظ الدوام'); await A.refresh();
            } catch (err) { A.toast(err.message, 'error'); }
        };
    }

    async function orgDelete(collection, id, name) {
        if (!(await A.confirm({ title: 'تأكيد الحذف', message: `هل تريد حذف «${h(name || '')}»؟`, danger: true, confirmLabel: 'حذف' }))) return;
        try { await A.del(`/collections/${collection}/${id}`); A.toast('تم الحذف'); await A.refresh(); }
        catch (err) { A.toast(err.message, 'error'); }
    }

    // ═══════════════════════════════════════════════════════════
    // الحضور والبصمة
    // ═══════════════════════════════════════════════════════════
    function openCorrectionModal(empId, date, onDone) {
        A.formModal({
            title: 'معالجة بصمة / حضور',
            fields: [
                { key: 'empId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                { key: 'date', label: 'التاريخ', type: 'date', required: true },
                { key: 'status', label: 'المعالجة', type: 'select', required: true, options: [
                    { value: 'present', label: 'حاضر (مع إلغاء التأخير)' },
                    { value: 'late', label: 'حاضر مع احتساب التأخير' },
                    { value: 'half_day', label: 'نصف يوم' },
                    { value: 'absent', label: 'غياب' },
                    { value: 'leave', label: 'إجازة' },
                    { value: 'remote', label: 'عمل عن بعد' }
                ] },
                { key: 'checkIn', label: 'وقت الحضور', type: 'time' },
                { key: 'checkOut', label: 'وقت الانصراف', type: 'time' },
                { key: 'leaveTypeId', label: 'نوع الإجازة (عند اختيار إجازة)', type: 'select', options: A.options.leaves(), placeholder: '—' },
                { key: 'dayPortion', label: 'نسبة اليوم', type: 'select', options: [{ value: '1', label: 'يوم كامل' }, { value: '0.5', label: 'نصف يوم' }, { value: '0.25', label: 'ربع يوم' }] },
                { key: 'reason', label: 'سبب المعالجة', type: 'textarea', full: true, help: 'تُسجل المعالجة في سجل التدقيق باسم المستخدم وتاريخ اليوم' }
            ],
            values: { empId, date, status: 'present', dayPortion: '1', checkIn: '08:00', checkOut: '17:00' },
            submitLabel: 'حفظ المعالجة',
            onSubmit: async data => {
                await A.post('/attendance/corrections', data);
                A.closeModal(); A.toast('تمت معالجة البصمة'); if (onDone) onDone();
            }
        });
    }

    A.registerModule('attendance', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'daily', label: 'سجل الحضور' }, { id: 'punches', label: 'البصمات الخام' }, { id: 'corrections', label: 'معالجات البصمات' }, { id: 'devices', label: 'أجهزة البصمة' }], 'daily')}
                <div class="tab-pane" id="attPane"></div>
            </div>`;
            const pane = document.getElementById('attPane');
            const filters = { from: A.monthStart(), to: A.today(), employeeId: '', status: '', branchId: '', shiftId: '' };

            const renderDaily = async () => {
                const result = await A.get(`/attendance/daily?from=${filters.from}&to=${filters.to}${filters.employeeId ? '&employeeId=' + filters.employeeId : ''}${filters.status ? '&status=' + filters.status : ''}${filters.branchId ? '&branchId=' + filters.branchId : ''}${filters.shiftId ? '&shiftId=' + filters.shiftId : ''}`);
                const rows = result.data || [];
                const periodCols = A.periodColumns(rows);
                const summary = {
                    present: rows.filter(r => ['present', 'late', 'missing_punch'].includes(r.status)).length,
                    absent: rows.filter(r => r.status === 'absent').length,
                    late: rows.filter(r => r.lateMinutes > 0).length,
                    ot: rows.reduce((s, r) => s + A.num(r.overtimeMinutes), 0)
                };
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <input type="date" id="attFrom" value="${filters.from}"><span class="small muted">إلى</span><input type="date" id="attTo" value="${filters.to}">
                        <select id="attBranch"><option value="">كل الفروع</option>${A.options.branches().map(o => `<option value="${h(o.value)}" ${filters.branchId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <select id="attEmp"><option value="">كل الموظفين</option>${A.options.employees().map(o => `<option value="${h(o.value)}" ${filters.employeeId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <select id="attStatus"><option value="">كل الحالات</option>${['present', 'late', 'absent', 'leave', 'half_day', 'missing_punch'].map(s => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${A.statusLabel(s)}</option>`).join('')}</select>
                        <select id="attShift"><option value="">كل الدوامات</option>${A.options.shifts().map(o => `<option value="${h(o.value)}" ${filters.shiftId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <span class="grow"></span>
                        ${A.can('attendance', 'edit') ? `<button class="btn btn-primary" id="attProcess">${A.icon('refresh')} معالجة الفترة</button><button class="btn" id="attConvert">${A.icon('exchange')} تحويل التأخير</button><button class="btn" id="attCorrect">${A.icon('plus')} معالجة بصمة</button>` : ''}
                    </div>
                    <div class="grid grid-4 mb">
                        ${kpiCard({ label: 'حضور', value: A.numFmt(summary.present), icon: 'checkCircle' })}
                        ${kpiCard({ label: 'غياب', value: A.numFmt(summary.absent), icon: 'alert', tone: 'danger' })}
                        ${kpiCard({ label: 'مرات التأخير', value: A.numFmt(summary.late), icon: 'clock', tone: 'warn' })}
                        ${kpiCard({ label: 'دقائق الإضافي', value: A.numFmt(summary.ot), icon: 'plus', tone: 'info' })}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                            { key: 'employeeName', label: 'الموظف', render: r => `<strong>${h(r.employeeName)}</strong><br><span class="small muted">${h(A.deptName(r.departmentId))}</span>` },
                            { key: 'shiftName', label: 'الدوام', render: r => r.shiftName ? h(r.shiftName) : '—' },
                            ...periodCols,
                            { key: 'checkIn', label: 'الحضور', render: r => r.checkIn || '—' },
                            { key: 'checkOut', label: 'الانصراف', render: r => r.checkOut || '—' },
                            { key: 'lateMinutes', label: 'تأخير', align: 'left', render: r => r.lateMinutes ? `<span class="badge warning">${r.lateMinutes} د</span>` : '—' },
                            { key: 'earlyMinutes', label: 'انصراف مبكر', align: 'left', render: r => r.earlyMinutes ? `${r.earlyMinutes} د` : '—' },
                            { key: 'overtimeMinutes', label: 'إضافي', align: 'left', render: r => r.overtimeMinutes ? `<span class="badge success">${r.overtimeMinutes} د</span>` : '—' },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) + (r.convertedToLeave ? ' <span class="badge purple">محوّل لإجازة</span>' : '') },
                            { key: 'source', label: 'المصدر', render: r => r.source === 'correction' ? 'تصحيح' : r.source === 'leave' ? 'إجازة' : r.source === 'fingerprint' ? 'بصمة' : 'النظام' }
                        ],
                        rows,
                        actions: r => A.can('attendance', 'edit') ? [
                            { title: 'اعتبارها حاضر', icon: 'check', action: 'markPresent' },
                            { title: 'نصف يوم', icon: 'clock', action: 'markHalf' },
                            { title: 'معالجة', icon: 'edit', action: 'correct' }
                        ] : [],
                        empty: 'لا توجد سجلات حضور للفترة المحددة — اضغط «معالجة الفترة» لاحتسابها من البصمات'
                    })}`;
                const apply = () => { filters.from = document.getElementById('attFrom').value; filters.to = document.getElementById('attTo').value; filters.branchId = document.getElementById('attBranch').value; filters.employeeId = document.getElementById('attEmp').value; filters.status = document.getElementById('attStatus').value; filters.shiftId = document.getElementById('attShift').value; renderDaily(); };
                ['attFrom', 'attTo', 'attBranch', 'attEmp', 'attStatus', 'attShift'].forEach(id => { const el = document.getElementById(id); if (el) el.onchange = apply; });
                const processBtn = document.getElementById('attProcess');
                if (processBtn) processBtn.onclick = async () => {
                    try {
                        const result = await A.post('/attendance/process', { from: filters.from, to: filters.to });
                        A.toast(`تمت معالجة ${result.summary.days} يوم حضور`);
                        renderDaily();
                    } catch (err) { A.toast(err.message, 'error'); }
                };
                const convertBtn = document.getElementById('attConvert');
                if (convertBtn) convertBtn.onclick = async () => {
                    const parts = filters.from.split('-');
                    const yes = await A.confirm({ title: 'تحويل التأخير إلى إجازات', message: `سيتم احتساب التأخير المتراكم لشهر ${A.monthName(parts[1])} ${parts[0]} وتحويل ما يتجاوز الحد المعتمد في سياسة الإجازات إلى رصيد إجازة للموظف. هل تريد المتابعة؟` });
                    if (!yes) return;
                    try {
                        const result = await A.post('/attendance/late-conversion/run', { year: parts[0], month: parts[1] });
                        A.toast(result.message);
                        renderDaily();
                    } catch (err) { A.toast(err.message, 'error'); }
                };
                const correctBtn = document.getElementById('attCorrect');
                if (correctBtn) correctBtn.onclick = () => openCorrectionModal(filters.employeeId || (A.options.employees()[0] || {}).value, A.today(), renderDaily);
                A.bindActions({
                    markPresent: id => quickCorrection(id, rows, 'present', renderDaily),
                    markHalf: id => quickCorrection(id, rows, 'half_day', renderDaily),
                    correct: id => { const row = rows.find(r => r.id === id); openCorrectionModal(row.empId, row.date, renderDaily); }
                });
            };

            const quickCorrection = async (id, rows, status, refresh) => {
                const row = rows.find(r => r.id === id);
                if (!row) return;
                const yes = await A.confirm({ title: status === 'present' ? 'اعتبار اليوم حاضرًا' : 'اعتبار اليوم نصف يوم', message: `الموظف: ${h(row.employeeName)} — التاريخ: ${A.date(row.date)}<br>سيتم إنشاء معالجة معتمدة وتحديث الحضور والراتب.` });
                if (!yes) return;
                try {
                    await A.post('/attendance/corrections', {
                        empId: row.empId, date: row.date, status,
                        checkIn: row.checkIn || '08:00', checkOut: row.checkOut || '17:00',
                        dayPortion: status === 'half_day' ? 0.5 : 1,
                        reason: 'معالجة سريعة من شاشة الحضور'
                    });
                    A.toast('تمت المعالجة'); refresh();
                } catch (err) { A.toast(err.message, 'error'); }
            };

            const renderPunches = async () => {
                const result = await A.get('/collections/attendanceRecords');
                const from = filters.from; const to = filters.to;
                const rows = (result.data || []).filter(r => {
                    const d = String(r.date || r.checkIn || r.punchTime || '').slice(0, 10);
                    return d >= from && d <= to;
                }).map(r => {
                    const emp = A.employeeById(r.empId) || {};
                    return {
                        ...r, empName: emp.name || r.employeeName || r.empId,
                        time: r.checkIn ? String(r.checkIn).slice(-8, -3) || String(r.checkIn) : (r.punchTime ? String(r.punchTime).slice(-8, -3) : ''),
                        typeLabel: r.checkOut ? 'دخول/خروج' : r.punchType === 1 ? 'خروج' : 'دخول'
                    };
                }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <input type="date" id="pFrom" value="${from}"><span class="small muted">إلى</span><input type="date" id="pTo" value="${to}">
                        <span class="grow"></span>
                        <span class="badge">${A.numFmt(rows.length)} بصمة</span>
                        <button class="btn" id="pRefresh">${A.icon('refresh')} تحديث</button>
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                            { key: 'empName', label: 'الموظف' },
                            { key: 'shiftName', label: 'الدوام', render: r => h(A.shiftName((A.employeeById(r.empId) || {}).shiftId)) },
                            { key: 'checkIn', label: 'الحضور', render: r => r.checkIn ? String(r.checkIn).replace('T', ' ').slice(0, 16) : '—' },
                            { key: 'checkOut', label: 'الانصراف', render: r => r.checkOut ? String(r.checkOut).replace('T', ' ').slice(0, 16) : '—' },
                            { key: 'typeLabel', label: 'النوع' },
                            { key: 'source', label: 'المصدر', render: r => A.badge(r.source === 'fingerprint' ? 'info' : '', r.source === 'fingerprint' ? 'جهاز بصمة' : r.source || 'يدوي') },
                            { key: 'deviceId', label: 'الجهاز', render: r => h(r.deviceId || '—') }
                        ], rows, empty: 'لا توجد بصمات في الفترة المحددة'
                    })}`;
                document.getElementById('pRefresh').onclick = renderPunches;
                ['pFrom', 'pTo'].forEach(id => { document.getElementById(id).onchange = () => { filters.from = document.getElementById('pFrom').value; filters.to = document.getElementById('pTo').value; renderPunches(); }; });
            };

            const renderCorrections = async () => {
                const result = await A.get('/attendance/corrections');
                const rows = result.data || [];
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">كل معالجات البصمات مع حالة الاعتماد والسبب</span>
                        <span class="grow"></span>
                        ${A.can('attendance', 'edit') ? `<button class="btn btn-primary" id="cAdd">${A.icon('plus')} معالجة جديدة</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                            { key: 'employeeName', label: 'الموظف', render: r => h(r.employeeName || A.employeeName(r.empId)) },
                            { key: 'status', label: 'المعالجة', render: r => A.badge(r.status === 'present' ? 'present' : r.status === 'absent' ? 'absent' : r.status === 'leave' ? 'leave' : r.status === 'half_day' ? 'half_day' : 'present') },
                            { key: 'checkIn', label: 'الحضور', render: r => r.checkIn || '—' },
                            { key: 'checkOut', label: 'الانصراف', render: r => r.checkOut || '—' },
                            { key: 'reason', label: 'السبب', render: r => h(r.reason || '—') },
                            { key: 'approvalStatus', label: 'الاعتماد', render: r => A.badge(r.approvalStatus === 'approved' ? 'approved' : r.approvalStatus === 'rejected' ? 'rejected' : 'pending') },
                            { key: 'requestedBy', label: 'بواسطة', render: r => h(r.requestedBy || '—') }
                        ],
                        rows,
                        actions: r => A.can('attendance', 'edit') ? [
                            ...(r.approvalStatus !== 'approved' ? [{ title: 'اعتماد', icon: 'check', action: 'approve' }] : []),
                            ...(r.approvalStatus !== 'rejected' ? [{ title: 'رفض', icon: 'xCircle', action: 'reject' }] : []),
                            { title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }
                        ] : [],
                        empty: 'لا توجد معالجات بصمات'
                    })}`;
                const add = document.getElementById('cAdd');
                if (add) add.onclick = () => openCorrectionModal((A.options.employees()[0] || {}).value, A.today(), renderCorrections);
                A.bindActions({
                    approve: async id => { await A.put(`/attendance/corrections/${id}/approve`); A.toast('تم الاعتماد'); renderCorrections(); },
                    reject: async id => { await A.put(`/attendance/corrections/${id}/reject`, { reason: 'رفض من شاشة الحضور' }); A.toast('تم الرفض'); renderCorrections(); },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف معالجة', message: 'سيتم حذف المعالجة وإعادة احتساب اليوم.', danger: true, confirmLabel: 'حذف' }))) return;
                        await A.del('/attendance/corrections/' + id); A.toast('تم الحذف'); renderCorrections();
                    }
                });
            };

            const renderDevices = async () => {
                const result = await A.get('/collections/fingerprintDevices');
                const rows = result.data || [];
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <div class="alert" style="flex:1">${A.icon('router')}<div>لربط الأجهزة استخدم واجهة الاستقبال <code dir="ltr">POST /api/fingerprint/receive</code> عبر وسيط ADMS/Push، أو أرسل السجلات دفعة واحدة مع معرّف كل موظف.</div></div>
                        <button class="btn btn-primary" id="devAdd">${A.icon('plus')} جهاز</button>
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'name', label: 'الجهاز', render: d => `<strong>${h(d.name || d.deviceIp)}</strong><br><span class="small muted">${h(d.deviceType || '')}</span>` },
                            { key: 'branchName', label: 'الفرع', render: d => h(A.branchName(d.branchId)) },
                            { key: 'deviceIp', label: 'IP', render: d => `<span dir="ltr">${h(d.deviceIp)}:${h(d.devicePort || 4370)}</span>` },
                            { key: 'status', label: 'الحالة', render: d => A.badge(d.status === 'online' ? 'active' : 'inactive', d.status === 'online' ? 'متصل' : 'غير متصل') },
                            { key: 'lastSeen', label: 'آخر اتصال', render: d => d.lastSeen ? A.dateTime(d.lastSeen) : '—' },
                            { key: 'totalRecords', label: 'سجلات', align: 'left', render: d => A.numFmt(d.totalRecords) }
                        ],
                        rows,
                        actions: d => [
                            { title: 'اختبار', icon: 'refresh', action: 'test' },
                            { title: 'تعديل', icon: 'edit', action: 'edit' },
                            { title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }
                        ],
                        empty: 'لم تُسجّل أجهزة بصمة بعد'
                    })}`;
                const add = document.getElementById('devAdd');
                if (add) add.onclick = () => deviceForm(null);
                A.bindActions({
                    test: async id => { try { const r = await A.post(`/fingerprint/devices/${id}/test`); A.toast(r.data.message); } catch (err) { A.toast(err.message, 'error'); } },
                    edit: id => deviceForm(rows.find(d => d.id === id)),
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف جهاز', message: 'هل تريد حذف جهاز البصمة؟', danger: true, confirmLabel: 'حذف' }))) return;
                        await A.del('/collections/fingerprintDevices/' + id); A.toast('تم الحذف'); renderDevices();
                    }
                });
            };
            const deviceForm = device => A.formModal({
                title: device ? 'تعديل جهاز' : 'جهاز بصمة جديد',
                fields: [
                    { key: 'name', label: 'اسم الجهاز', required: true },
                    { key: 'branchId', label: 'الفرع', type: 'select', options: A.options.branches(), required: true },
                    { key: 'deviceIp', label: 'عنوان IP', required: true },
                    { key: 'devicePort', label: 'المنفذ', type: 'number', default: 4370 },
                    { key: 'deviceType', label: 'النوع', type: 'select', options: ['zkteco', 'hikvision', 'anviz', 'suprema', 'other'].map(v => ({ value: v, label: v })) },
                    { key: 'syncMode', label: 'طريقة المزامنة', type: 'select', options: [{ value: 'push', label: 'Push تلقائي' }, { value: 'manual', label: 'يدوي' }] },
                    { key: 'enabled', label: 'مفعّل', type: 'checkbox', default: true }
                ],
                values: device || { deviceType: 'zkteco', devicePort: 4370, syncMode: 'push', enabled: true },
                onSubmit: async data => {
                    if (device) await A.put('/collections/fingerprintDevices/' + device.id, data);
                    else await A.post('/collections/fingerprintDevices', { ...data, status: 'offline' });
                    A.closeModal(); A.toast('تم حفظ الجهاز'); renderDevices();
                }
            });

            bindTabs(view, [], 'daily', id => {
                if (id === 'daily') renderDaily();
                else if (id === 'punches') renderPunches();
                else if (id === 'corrections') renderCorrections();
                else renderDevices();
            });
            renderDaily();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // الإجازات
    // ═══════════════════════════════════════════════════════════
    function openLeaveRequestModal(empId, onDone) {
        A.formModal({
            title: 'طلب إجازة',
            fields: [
                { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                { key: 'leaveTypeId', label: 'نوع الإجازة', type: 'select', options: A.options.leaves(), required: true },
                { key: 'fromDate', label: 'من تاريخ', type: 'date', required: true },
                { key: 'toDate', label: 'إلى تاريخ', type: 'date', required: true },
                { key: 'dayPortion', label: 'المدة', type: 'select', options: [{ value: '1', label: 'يوم كامل' }, { value: '0.5', label: 'نصف يوم' }] },
                { key: 'reason', label: 'السبب / ملاحظات', type: 'textarea', full: true }
            ],
            values: { employeeId: empId, fromDate: A.today(), toDate: A.today(), dayPortion: '1' },
            submitLabel: 'إرسال الطلب',
            onSubmit: async data => {
                const result = await A.post('/leaves/requests', data);
                A.closeModal(); A.toast(result.message); if (onDone) onDone();
            }
        });
    }

    A.registerModule('leaves', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'requests', label: 'طلبات الإجازات' }, { id: 'balances', label: 'الأرصدة' }, { id: 'types', label: 'أنواع الإجازات' }, { id: 'policy', label: 'السياسات والاستحقاق' }], 'requests')}
                <div class="tab-pane" id="leavePane"></div>
            </div>`;
            const pane = document.getElementById('leavePane');

            const renderRequests = async () => {
                const result = await A.get('/collections/leaveRequests');
                const rows = (result.data || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">${A.numFmt(rows.filter(r => r.status === 'pending').length)} طلب معلق من ${A.numFmt(rows.length)} طلب</span>
                        <span class="grow"></span>
                        ${A.can('leaves', 'add') ? `<button class="btn btn-primary" id="leaveAdd">${A.icon('plus')} طلب إجازة</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'employeeId', label: 'الموظف', render: r => `<strong>${h(A.employeeName(r.employeeId))}</strong><br><span class="small muted">${h(A.deptName((A.employeeById(r.employeeId) || {}).departmentId))}</span>` },
                            { key: 'leaveTypeId', label: 'النوع', render: r => h(A.leaveTypeName(r.leaveTypeId)) },
                            { key: 'fromDate', label: 'من', render: r => A.date(r.fromDate) },
                            { key: 'toDate', label: 'إلى', render: r => A.date(r.toDate) },
                            { key: 'days', label: 'الأيام', align: 'left', render: r => A.numFmt(r.days, 1) },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) },
                            { key: 'reason', label: 'السبب', render: r => h(r.reason || '—') }
                        ],
                        rows,
                        actions: r => [
                            ...(r.status === 'pending' && A.can('leaves', 'edit') ? [{ title: 'اعتماد', icon: 'check', action: 'approve' }, { title: 'رفض', icon: 'xCircle', action: 'reject', class: 'btn-danger' }] : []),
                            ...(r.status === 'approved' && A.can('leaves', 'edit') ? [{ title: 'إلغاء', icon: 'x', action: 'cancel' }] : []),
                            ...(A.can('leaves', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد طلبات إجازة'
                    })}`;
                const add = document.getElementById('leaveAdd');
                if (add) add.onclick = () => openLeaveRequestModal((A.options.employees()[0] || {}).value, renderRequests);
                A.bindActions({
                    approve: async id => {
                        try { const r = await A.put(`/leaves/requests/${id}/approve`); A.toast(r.message); renderRequests(); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    reject: async id => {
                        const reason = await promptReason('سبب رفض الإجازة');
                        if (reason === null) return;
                        try { await A.put(`/leaves/requests/${id}/reject`, { reason }); A.toast('تم رفض الطلب'); renderRequests(); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    cancel: async id => {
                        if (!(await A.confirm({ title: 'إلغاء إجازة معتمدة', message: 'سيتم إرجاع الأيام إلى رصيد الموظف وحذفها من الحضور.', danger: true, confirmLabel: 'إلغاء الإجازة' }))) return;
                        try { await A.put(`/leaves/requests/${id}/cancel`); A.toast('تم إلغاء الإجازة وإرجاع الرصيد'); renderRequests(); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف الطلب', message: 'هل تريد حذف طلب الإجازة نهائيًا؟', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del('/collections/leaveRequests/' + id); A.toast('تم الحذف'); renderRequests(); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const renderBalances = async () => {
                const year = new Date().getFullYear();
                const result = await A.get('/leaves/balances?year=' + year);
                const rows = result.data || [];
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">سنة ${year} — رصيد = الاستحقاق + المتراكم + المرحّل ± التسويات − المستخدم − المحوّل</span>
                        <span class="grow"></span>
                        ${A.can('leaves', 'edit') ? `<button class="btn" id="accrualBtn">${A.icon('refresh')} استحقاق الشهر</button><button class="btn" id="carryBtn">${A.icon('exchange')} ترحيل سنوي</button><button class="btn btn-primary" id="adjustBtn">${A.icon('edit')} تسوية رصيد</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'employeeName', label: 'الموظف', render: r => `<strong>${h(r.employeeName)}</strong><br><span class="small muted">${h(r.employeeNumber || '')}</span>` },
                            { key: 'leaveTypeName', label: 'نوع الإجازة' },
                            { key: 'entitlement', label: 'الاستحقاق', align: 'left', render: r => A.numFmt(r.entitlement, 1) },
                            { key: 'accrued', label: 'المتراكم', align: 'left', render: r => A.numFmt(r.accrued, 1) },
                            { key: 'carried', label: 'المرحّل', align: 'left', render: r => A.numFmt(r.carried, 1) },
                            { key: 'adjusted', label: 'تسويات', align: 'left', render: r => A.numFmt(r.adjusted, 1) },
                            { key: 'used', label: 'المستخدم', align: 'left', render: r => A.numFmt(r.used, 1) },
                            { key: 'converted', label: 'محوّل من التأخير', align: 'left', render: r => `<span class="badge purple">${A.numFmt(r.converted, 1)}</span>` },
                            { key: 'balance', label: 'الرصيد', align: 'left', render: r => `<strong>${A.numFmt(r.balance, 1)}</strong>` }
                        ],
                        rows,
                        empty: 'لا توجد أرصدة — اضغط «استحقاق الشهر» لإنشائها'
                    })}`;
                const accrue = document.getElementById('accrualBtn');
                if (accrue) accrue.onclick = async () => {
                    const now = new Date();
                    try { const r = await A.post('/leaves/accrue', { year: now.getFullYear(), month: now.getMonth() + 1 }); A.toast(r.message); renderBalances(); } catch (err) { A.toast(err.message, 'error'); }
                };
                const carry = document.getElementById('carryBtn');
                if (carry) carry.onclick = async () => {
                    const y = new Date().getFullYear();
                    if (!(await A.confirm({ title: 'ترحيل الأرصدة', message: `سيتم ترحيل الأرصدة المتبقية من ${y - 1} إلى ${y} حسب حدود الترحيل في سياسة الإجازات.` }))) return;
                    try { const r = await A.post('/leaves/carry-over', { fromYear: y - 1, toYear: y }); A.toast(r.message); renderBalances(); } catch (err) { A.toast(err.message, 'error'); }
                };
                const adjust = document.getElementById('adjustBtn');
                if (adjust) adjust.onclick = () => A.formModal({
                    title: 'تسوية رصيد إجازات',
                    fields: [
                        { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                        { key: 'leaveTypeId', label: 'نوع الإجازة', type: 'select', options: A.options.leaves(), required: true },
                        { key: 'days', label: 'عدد الأيام (+ إضافة / − خصم)', type: 'number', step: '0.5', required: true },
                        { key: 'reason', label: 'سبب التسوية', type: 'textarea', full: true }
                    ],
                    values: { days: 1 },
                    onSubmit: async data => {
                        const r = await A.post('/leaves/adjust', { ...data, year });
                        A.closeModal(); A.toast(r.message); renderBalances();
                    }
                });
            };

            const renderTypes = async () => {
                const rows = A.state.data.leaveTypes || [];
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">الاستحقاق والترحيل والدفع لكل نوع إجازة</span><span class="grow"></span>
                        ${A.can('leaves', 'add') ? `<button class="btn btn-primary" id="typeAdd">${A.icon('plus')} نوع إجازة</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'name', label: 'النوع', render: t => `<span class="badge" style="background:${h(t.color || '#0d9488')}22;color:${h(t.color || '#0d9488')}">${h(t.name)}</span>` },
                            { key: 'daysPerYear', label: 'أيام/سنة', align: 'left' },
                            { key: 'accrual', label: 'الاستحقاق', render: t => t.accrual === 'monthly' ? 'شهري' : t.accrual === 'manual' ? 'يدوي' : 'سنوي' },
                            { key: 'isPaid', label: 'مدفوعة', render: t => A.badge(t.isPaid !== false ? 'active' : 'rejected', t.isPaid !== false ? 'مدفوعة' : 'غير مدفوعة') },
                            { key: 'isCarryOver', label: 'الترحيل', render: t => t.isCarryOver ? `حتى ${A.numFmt(t.maxCarryOver)} يوم` : 'لا يترحّل' },
                            { key: 'requiresApproval', label: 'الاعتماد', render: t => t.requiresApproval !== false ? 'مطلوب' : 'تلقائي' }
                        ],
                        rows,
                        actions: t => [
                            ...(A.can('leaves', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'edit' }] : []),
                            ...(A.can('leaves', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد أنواع إجازات'
                    })}`;
                const add = document.getElementById('typeAdd');
                if (add) add.onclick = () => leaveTypeForm(null, renderTypes);
                A.bindActions({
                    edit: id => leaveTypeForm(rows.find(t => t.id === id), renderTypes),
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف نوع إجازة', message: 'لن يمكن حذف نوع مرتبط بطلبات معلقة.', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del('/collections/leaveTypes/' + id); A.toast('تم الحذف'); await A.refresh(); renderTypes(); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const renderPolicy = async () => {
                const policy = A.state.data.leavePolicy || {};
                const lc = policy.lateConversion || {};
                pane.innerHTML = `
                    <form id="policyForm" class="form-grid">
                        <div class="form-section full"><h4>${A.icon('palmtree')} قواعد الإجازات</h4></div>
                        <div class="field"><label>طريقة الاستحقاق</label><select id="p_accrualMode">
                            <option value="monthly" ${policy.accrualMode === 'monthly' ? 'selected' : ''}>شهري (1/12 سنويًا)</option>
                            <option value="annual" ${policy.accrualMode === 'annual' ? 'selected' : ''}>سنوي دفعة واحدة</option>
                            <option value="manual" ${policy.accrualMode === 'manual' ? 'selected' : ''}>يدوي</option>
                        </select></div>
                        <div class="field"><label>احتساب أيام العمل فقط</label><label class="switch"><input type="checkbox" id="p_workingDaysOnly" ${policy.workingDaysOnly !== false ? 'checked' : ''}> استثناء العطلات الأسبوعية والرسمية</label></div>
                        <div class="field"><label>السماح برصيد سالب</label><label class="switch"><input type="checkbox" id="p_allowNegativeBalance" ${policy.allowNegativeBalance ? 'checked' : ''}> السماح</label></div>
                        <div class="field"><label>الحد الأقصى للرصيد السالب</label><input type="number" step="0.5" id="p_maxNegativeDays" value="${policy.maxNegativeDays || 0}"></div>
                        <div class="field"><label>ترحيل الأرصدة</label><label class="switch"><input type="checkbox" id="p_carryOverEnabled" ${policy.carryOverEnabled !== false ? 'checked' : ''}> تفعيل الترحيل السنوي</label></div>
                        <div class="field"><label>حد الترحيل الافتراضي (يوم)</label><input type="number" id="p_maxCarryOverDays" value="${policy.maxCarryOverDays || 0}"></div>
                        <div class="field"><label>دعم نصف اليوم</label><label class="switch"><input type="checkbox" id="p_halfDayEnabled" ${policy.halfDayEnabled !== false ? 'checked' : ''}> متاح</label></div>
                        <div class="field"><label>أقصى مدة طلب (يوم)</label><input type="number" id="p_maxRequestDays" value="${policy.maxRequestDays || 90}"></div>

                        <div class="form-section full"><h4>${A.icon('exchange')} تحويل ساعات التأخير إلى إجازات</h4></div>
                        <div class="form-section full" style="border:0;padding:0;margin:-6px 0 6px"><div class="alert">${A.icon('clock')}<div>عند تجاوز حد التأخير الشهري تُخصم الساعات من رصيد الإجازة المحدد للموظف (أو النوع الافتراضي) بدل الخصم المالي. تُعاد الحسابات تلقائيًا عند تشغيل التحويل لكل شهر.</div></div></div>
                        <div class="field"><label>تفعيل التحويل</label><label class="switch"><input type="checkbox" id="p_lc_enabled" ${lc.enabled !== false ? 'checked' : ''}> مفعّل</label></div>
                        <div class="field"><label>حد التأخير قبل التحويل (دقيقة/شهر)</label><input type="number" id="p_lc_threshold" value="${lc.thresholdMinutes || 120}"></div>
                        <div class="field"><label>أقل تأخير يومي قابل للتحويل (دقيقة)</label><input type="number" id="p_lc_minDaily" value="${lc.minDailyLateMinutes || 0}"><div class="help">0 = أي تأخير. الأيام الأقل من هذا الحد لا تُحوَّل.</div></div>
                        <div class="field"><label>ما يُحوَّل</label><select id="p_lc_mode">
                            <option value="excess" ${lc.mode !== 'all' ? 'selected' : ''}>الزائد عن الحد فقط</option>
                            <option value="all" ${lc.mode === 'all' ? 'selected' : ''}>كل دقائق التأخير</option>
                        </select></div>
                        <div class="field"><label>نوع الإجازة الافتراضي</label><select id="p_lc_leaveTypeId"><option value="">اختر تلقائيًا (الإجازة السنوية)</option>${A.options.leaves().map(o => `<option value="${h(o.value)}" ${lc.leaveTypeId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select></div>
                        <div class="field"><label>سقف التحويل (ساعة/شهر)</label><input type="number" id="p_lc_maxHours" value="${lc.maxHoursPerMonth || 0}" help="0 = بدون سقف"></div>
                        <div class="field"><label>عدم الخصم المالي بعد التحويل</label><label class="switch"><input type="checkbox" id="p_lc_skipMoney" ${lc.skipMoneyDeduction !== false ? 'checked' : ''}> نعم</label></div>
                        <div class="field"><label>السماح بتخصيص نوع لكل موظف</label><label class="switch"><input type="checkbox" id="p_lc_employeeOverride" ${lc.employeeOverride !== false ? 'checked' : ''}> نعم</label></div>
                        <div class="field"><label>احتساب الانصراف المبكر ضمن التحويل</label><label class="switch"><input type="checkbox" id="p_lc_countEarly" ${lc.countEarlyDeparture !== false ? 'checked' : ''}> نعم</label></div>
                        <div class="full mt"><button type="submit" class="btn btn-primary">${A.icon('check')} حفظ سياسة الإجازات</button></div>
                    </form>`;
                document.getElementById('policyForm').onsubmit = async e => {
                    e.preventDefault();
                    const leavePolicy = {
                        accrualMode: val('p_accrualMode'), workingDaysOnly: checked('p_workingDaysOnly'),
                        allowNegativeBalance: checked('p_allowNegativeBalance'), maxNegativeDays: A.num(val('p_maxNegativeDays')),
                        carryOverEnabled: checked('p_carryOverEnabled'), maxCarryOverDays: A.num(val('p_maxCarryOverDays')),
                        halfDayEnabled: checked('p_halfDayEnabled'), maxRequestDays: A.num(val('p_maxRequestDays')),
                        lateConversion: {
                            enabled: checked('p_lc_enabled'), thresholdMinutes: A.num(val('p_lc_threshold')),
                            minDailyLateMinutes: A.num(val('p_lc_minDaily')),
                            mode: val('p_lc_mode'), leaveTypeId: val('p_lc_leaveTypeId'),
                            maxHoursPerMonth: A.num(val('p_lc_maxHours')),
                            skipMoneyDeduction: checked('p_lc_skipMoney'), employeeOverride: checked('p_lc_employeeOverride'),
                            countEarlyDeparture: checked('p_lc_countEarly')
                        }
                    };
                    try { await A.put('/payroll/settings', { leavePolicy }); A.toast('تم حفظ سياسة الإجازات'); await A.refresh(); renderPolicy(); }
                    catch (err) { A.toast(err.message, 'error'); }
                };
                const val = id => document.getElementById(id).value;
                const checked = id => document.getElementById(id).checked;
            };

            bindTabs(view, [], 'requests', id => {
                if (id === 'requests') renderRequests();
                else if (id === 'balances') renderBalances();
                else if (id === 'types') renderTypes();
                else renderPolicy();
            });
            renderRequests();
        }
    });

    function leaveTypeForm(type, onDone) {
        A.formModal({
            title: type ? 'تعديل نوع إجازة' : 'نوع إجازة جديد',
            fields: [
                { key: 'name', label: 'اسم النوع', required: true },
                { key: 'daysPerYear', label: 'الأيام المستحقة سنويًا', type: 'number', step: '0.5', required: true },
                { key: 'accrual', label: 'طريقة الاستحقاق', type: 'select', options: [{ value: 'monthly', label: 'شهري' }, { value: 'annual', label: 'سنوي' }, { value: 'manual', label: 'يدوي' }] },
                { key: 'isPaid', label: 'إجازة مدفوعة', type: 'checkbox', default: true },
                { key: 'isCarryOver', label: 'قابلة للترحيل', type: 'checkbox', default: true },
                { key: 'maxCarryOver', label: 'حد الترحيل (يوم)', type: 'number' },
                { key: 'countWeekends', label: 'احتساب عطلات الأسبوع', type: 'checkbox' },
                { key: 'requiresApproval', label: 'تحتاج اعتماد', type: 'checkbox', default: true },
                { key: 'gender', label: 'مخصصة لجنس', type: 'select', options: [{ value: '', label: 'للجميع' }, { value: 'female', label: 'إناث' }, { value: 'male', label: 'ذكور' }] },
                { key: 'color', label: 'اللون', type: 'color', default: '#0d9488' },
                { key: 'description', label: 'الوصف', type: 'textarea', full: true }
            ],
            values: type || { daysPerYear: 21, accrual: 'monthly', isPaid: true, isCarryOver: true, requiresApproval: true, color: '#0d9488' },
            onSubmit: async data => {
                data.daysPerYear = A.num(data.daysPerYear);
                if (type) await A.put('/collections/leaveTypes/' + type.id, data);
                else await A.post('/collections/leaveTypes', data);
                A.closeModal(); A.toast('تم حفظ نوع الإجازة'); await A.refresh(); if (onDone) onDone();
            }
        });
    }

    function promptReason(title) {
        return new Promise(resolve => {
            const modal = A.rawModal({
                title,
                body: `<div class="field"><label>السبب</label><textarea id="reasonInput" rows="3" placeholder="اكتب السبب..."></textarea></div>`,
                footer: `<button class="btn btn-primary" id="reasonOk">تأكيد</button><button class="btn" data-close>إلغاء</button>`
            });
            modal.querySelector('#reasonOk').onclick = () => { const value = modal.querySelector('#reasonInput').value; modal.close(); resolve(value); };
            modal.querySelector('[data-close]').onclick = () => { modal.close(); resolve(null); };
        });
    }

    // رابط عام لعرض كشف الراتب من أي مكان (يُعرّف في وحدة الرواتب)
    A.viewPayslip = A.viewPayslip || function () { A.toast('وحدة الرواتب غير محمّلة', 'error'); };
})();
