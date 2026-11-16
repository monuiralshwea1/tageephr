'use strict';

/* ═══════════════════════════════════════════════════════════════
   وحدة المهام والطلبات
   إسناد المهام للموظفين، متابعة سير العمل ونسبة الإنجاز،
   مراجعة طلبات الخدمة الذاتية (سلف، شكاوى، طلبات عامة)
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const h = A.h;

    A.registerRoutes([
        { path: 'tasks', module: 'tasks', label: 'المهام والطلبات', subtitle: 'إسناد المهام ومتابعة الإنجاز وطلبات الموظفين', icon: 'check', group: 'الموارد البشرية', permission: 'tasks' }
    ]);

    const STATUS = {
        new: { label: 'جديدة', badge: 'info', color: '#2563eb' },
        in_progress: { label: 'قيد التنفيذ', badge: 'warning', color: '#d97706' },
        on_hold: { label: 'معلّقة', badge: 'purple', color: '#7c3aed' },
        completed: { label: 'مكتملة', badge: 'success', color: '#16a34a' },
        cancelled: { label: 'ملغاة', badge: 'danger', color: '#dc2626' }
    };
    const PRIORITY = { low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة' };
    const PRIORITY_BADGE = { low: '', normal: 'info', high: 'warning', urgent: 'danger' };
    const REQUEST_TYPES = { advance: 'سلفة', complaint: 'شكوى', other: 'طلب عام', leave: 'إجازة' };
    const REQUEST_STATUS = { pending: 'معلّق', approved: 'معتمد', rejected: 'مرفوض' };
    const REQUEST_STATUS_BADGE = { pending: 'warning', approved: 'success', rejected: 'danger' };
    const CATEGORIES = ['إدارية', 'تشغيلية', 'مالية', 'موارد بشرية', 'تدريب وتطوير', 'مشروع', 'أخرى'];

    const tabsBar = (tabs, active) => `<div class="tabs">${tabs.map(t => `<button class="tab ${t.id === active ? 'active' : ''}" data-tab="${t.id}">${h(t.label)}</button>`).join('')}</div>`;
    const empty = message => `<div class="empty">${A.icon('file')}<div>${h(message || 'لا توجد بيانات')}</div></div>`;

    function bindTabs(view, active, onChange) {
        view.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => onChange(btn.dataset.tab)));
        onChange(active);
    }

    const statusOf = t => STATUS[t.status] || STATUS.new;
    const daysLeft = task => {
        if (!task.dueDate) return null;
        const due = new Date(String(task.dueDate).slice(0, 10) + 'T00:00:00');
        const now = new Date(A.today() + 'T00:00:00');
        return Math.round((due - now) / 86400000);
    };
    const isOverdue = task => !['completed', 'cancelled'].includes(task.status) && daysLeft(task) !== null && daysLeft(task) < 0;

    function progressBar(value, color) {
        const p = Math.max(0, Math.min(100, A.num(value)));
        return `<div class="task-progress"><div class="tp-track"><div class="tp-fill" style="width:${p}%;background:${color || 'var(--brand)'}"></div></div><span>${A.numFmt(p)}%</span></div>`;
    }

    // ───────────── نموذج المهمة ─────────────
    function taskForm(task) {
        const today = A.today();
        const values = {
            status: 'new', priority: 'normal', progress: 0, startDate: today,
            dueDate: today, ...(task || {})
        };
        A.formModal({
            title: task ? `تعديل المهمة — ${task.title}` : 'إسناد مهمة جديدة',
            size: 'lg',
            fields: [
                { type: 'section', label: 'بيانات المهمة', icon: 'check' },
                { key: 'title', label: 'عنوان المهمة', required: true, full: true },
                { key: 'description', label: 'وصف المهمة والمطلوب تنفيذه', type: 'textarea', full: true, rows: 3 },
                { key: 'employeeId', label: 'الموظف المسؤول', type: 'select', options: A.options.employees(), required: true },
                { key: 'branchId', label: 'الفرع', type: 'select', options: A.options.branches(), placeholder: 'فرع الموظف' },
                { key: 'category', label: 'التصنيف', type: 'select', options: CATEGORIES.map(c => ({ value: c, label: c })), default: 'إدارية' },
                { key: 'priority', label: 'الأولوية', type: 'select', options: Object.keys(PRIORITY).map(k => ({ value: k, label: PRIORITY[k] })), default: 'normal' },
                { type: 'section', label: 'الفترة الزمنية والتنفيذ', icon: 'clock' },
                { key: 'startDate', label: 'تاريخ البدء', type: 'date', default: today },
                { key: 'dueDate', label: 'تاريخ الاستحقاق', type: 'date', required: true, default: today },
                { key: 'dueTime', label: 'وقت الاستحقاق', type: 'time', default: '17:00' },
                { key: 'estimatedHours', label: 'الساعات التقديرية', type: 'number', step: '0.5', min: 0 },
                { key: 'status', label: 'حالة المهمة', type: 'select', options: Object.keys(STATUS).map(k => ({ value: k, label: STATUS[k].label })), default: 'new' },
                { key: 'progress', label: 'نسبة الإنجاز الحالية (%)', type: 'number', min: 0, max: 100, step: 5, default: 0 },
                { key: 'notes', label: 'ملاحظات / معايير الإنجاز', type: 'textarea', full: true, rows: 2 }
            ],
            values,
            submitLabel: task ? 'حفظ التعديلات' : 'إسناد المهمة',
            onSubmit: async data => {
                const employee = A.employeeById(data.employeeId) || {};
                const payload = {
                    ...data,
                    employeeName: employee.name || '',
                    branchId: data.branchId || employee.branchId || '',
                    departmentId: employee.departmentId || '',
                    progress: Math.max(0, Math.min(100, A.num(data.progress))),
                    estimatedHours: A.num(data.estimatedHours)
                };
                if (payload.progress >= 100) payload.status = 'completed';
                if (task) await A.put('/collections/tasks/' + task.id, payload);
                else await A.post('/collections/tasks', payload);
                A.closeModal();
                A.toast(task ? 'تم حفظ المهمة' : 'تم إسناد المهمة وإشعار الموظف');
                await A.refresh();
            }
        });
    }

    // ───────────── متابعة الإنجاز (متاحة للموظف المسؤول أيضًا) ─────────────
    A.taskProgressModal = (task, onDone) => {
        const modal = A.rawModal({
            title: `متابعة المهمة — ${task.title}`,
            size: 'lg',
            body: `<div class="grid grid-2" style="gap:12px">
                    <div class="stat-line"><span>الموظف المسؤول</span><strong>${h(A.employeeName(task.employeeId) || '—')}</strong></div>
                    <div class="stat-line"><span>الاستحقاق</span><strong>${A.date(task.dueDate)} ${h(task.dueTime || '')}</strong></div>
                    <div class="stat-line"><span>الأولوية</span><strong>${h(PRIORITY[task.priority] || '—')}</strong></div>
                    <div class="stat-line"><span>الحالة الحالية</span><strong>${h(statusOf(task).label)}</strong></div>
                </div>
                ${task.description ? `<div class="alert mt">${A.icon('file')}<div>${h(task.description)}</div></div>` : ''}
                <div class="form-grid mt">
                    <div class="field"><label>نسبة الإنجاز (%)</label><input type="range" id="tpRange" min="0" max="100" step="5" value="${A.num(task.progress)}" style="padding:0"></div>
                    <div class="field"><label>النسبة المحددة</label><input type="number" id="tpValue" min="0" max="100" step="1" value="${A.num(task.progress)}"></div>
                    <div class="field"><label>الحالة</label><select id="tpStatus">${Object.keys(STATUS).map(k => `<option value="${k}" ${task.status === k ? 'selected' : ''}>${h(STATUS[k].label)}</option>`).join('')}</select></div>
                    <div class="field"><label>ملاحظة التحديث</label><input id="tpNote" placeholder="ما الذي أُنجز؟"></div>
                </div>
                <div class="section-title mt">سجل التحديثات</div>
                <div id="tpTimeline" class="small muted">جارٍ تحميل السجل...</div>`,
            footer: `<button class="btn btn-primary" id="tpSave">${A.icon('check')} حفظ التحديث</button><button class="btn" data-close>إغلاق</button>`
        });
        const range = modal.querySelector('#tpRange');
        const value = modal.querySelector('#tpValue');
        const timeline = modal.querySelector('#tpTimeline');
        range.oninput = () => { value.value = range.value; };
        value.oninput = () => { range.value = value.value; };
        const renderTimeline = comments => {
            if (!comments.length) { timeline.innerHTML = '<div class="muted">لا توجد تحديثات مسجلة بعد</div>'; return; }
            timeline.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${comments.slice().reverse().map(c => `
                <div class="stat-line" style="display:block">
                    <div><strong>${h(c.authorName || '')}</strong> — ${A.numFmt(c.progress)}% (${h((STATUS[c.status] || {}).label || c.status || '')})</div>
                    ${c.note ? `<div class="small">${h(c.note)}</div>` : ''}
                    <div class="small muted">${A.dateTime(c.createdAt)}</div>
                </div>`).join('')}</div>`;
        };
        A.get('/tasks/' + task.id + '/timeline')
            .then(res => renderTimeline((res.data || {}).comments || []))
            .catch(err => { timeline.textContent = err.message; });
        modal.querySelector('#tpSave').onclick = async () => {
            try {
                const progress = A.num(value.value);
                const status = modal.querySelector('#tpStatus').value;
                await A.post(`/tasks/${task.id}/progress`, { progress, status, note: modal.querySelector('#tpNote').value });
                modal.close();
                A.toast('تم تحديث نسبة الإنجاز');
                if (onDone) onDone(); else await A.refresh();
            } catch (err) { A.toast(err.message, 'error'); }
        };
    };

    // ───────────── طلبات الخدمة الذاتية ─────────────
    A.selfRequestModal = (type, employee, onDone) => {
        const labels = { advance: 'طلب سلفة', complaint: 'تقديم شكوى / ملاحظة', other: 'طلب عام' };
        const fields = [
            { key: 'subject', label: 'الموضوع', required: true, full: true, default: labels[type] || 'طلب' },
            { key: 'details', label: 'التفاصيل', type: 'textarea', full: true, rows: 4, required: type !== 'advance' }
        ];
        if (type === 'advance') {
            fields.push(
                { key: 'amount', label: 'المبلغ المطلوب', type: 'number', step: '0.01', required: true },
                { key: 'monthlyDeduction', label: 'القسط الشهري المقترح', type: 'number', step: '0.01', help: 'اتركه فارغًا ليحدده المحاسب' }
            );
        }
        fields.push({ key: 'priority', label: 'الأهمية', type: 'select', options: Object.keys(PRIORITY).map(k => ({ value: k, label: PRIORITY[k] })), default: 'normal' });
        A.formModal({
            title: labels[type] || 'طلب',
            size: 'lg',
            fields,
            onSubmit: async data => {
                const res = await A.post('/self/requests', { ...data, type });
                A.closeModal();
                A.toast(res.message);
                if (onDone) onDone(); else await A.refresh();
            }
        });
    };

    function requestReviewModal(request, onDone) {
        const modal = A.rawModal({
            title: `مراجعة الطلب — ${REQUEST_TYPES[request.type] || request.type}`,
            size: 'lg',
            body: `<div class="grid grid-2" style="gap:12px">
                    <div class="stat-line"><span>الموظف</span><strong>${h(request.employeeName || '')}</strong></div>
                    <div class="stat-line"><span>التاريخ</span><strong>${A.dateTime(request.createdAt)}</strong></div>
                    <div class="stat-line"><span>الموضوع</span><strong>${h(request.subject || '')}</strong></div>
                    <div class="stat-line"><span>الحالة</span><strong>${h(REQUEST_STATUS[request.status] || request.status)}</strong></div>
                    ${request.amount ? `<div class="stat-line"><span>المبلغ المطلوب</span><strong>${A.money(request.amount)}</strong></div>` : ''}
                    ${request.monthlyDeduction ? `<div class="stat-line"><span>القسط المقترح</span><strong>${A.money(request.monthlyDeduction)}</strong></div>` : ''}
                </div>
                <div class="alert mt">${A.icon('file')}<div>${h(request.details || 'لا توجد تفاصيل')}</div></div>
                ${request.reviewNote ? `<div class="alert mt">${A.icon('checkCircle')}<div>${h(request.reviewNote)}</div></div>` : ''}
                <div class="field mt"><label>ملاحظة المراجعة (تظهر للموظف)</label><input id="reqNote" value="${h(request.reviewNote || '')}"></div>`,
            footer: `<button class="btn btn-primary" id="reqApprove">${A.icon('check')} اعتماد</button><button class="btn btn-danger" id="reqReject">${A.icon('x')} رفض</button><button class="btn" data-close>إغلاق</button>`
        });
        const review = async status => {
            try {
                const note = modal.querySelector('#reqNote').value;
                const res = await A.put(`/self/requests/${request.id}/review`, { status, note });
                modal.close();
                A.toast(res.message);
                if (onDone) onDone(); else await A.refresh();
            } catch (err) { A.toast(err.message, 'error'); }
        };
        modal.querySelector('#reqApprove').onclick = () => review('approved');
        modal.querySelector('#reqReject').onclick = () => review('rejected');
    }

    // ───────────── الوحدة ─────────────
    A.registerModule('tasks', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'tasks', label: 'المهام' }, { id: 'requests', label: 'طلبات الموظفين' }], 'tasks')}
                <div class="tab-pane" id="tasksPane"></div>
            </div>`;
            const pane = document.getElementById('tasksPane');
            const taskFilters = { search: '', status: '', priority: '', employeeId: '', branchId: '', overdue: false };
            const reqFilters = { search: '', type: '', status: '', employeeId: '' };

            const renderTasks = () => {
                const all = (A.state.data.tasks || []).slice();
                const rows = all.filter(t => {
                    if (taskFilters.status && t.status !== taskFilters.status) return false;
                    if (taskFilters.priority && t.priority !== taskFilters.priority) return false;
                    if (taskFilters.employeeId && t.employeeId !== taskFilters.employeeId) return false;
                    if (taskFilters.branchId && t.branchId !== taskFilters.branchId) return false;
                    if (taskFilters.overdue && !isOverdue(t)) return false;
                    if (taskFilters.search) {
                        const q = taskFilters.search.toLowerCase();
                        if (!`${t.title || ''} ${t.description || ''} ${A.employeeName(t.employeeId)} ${t.category || ''}`.toLowerCase().includes(q)) return false;
                    }
                    return true;
                }).sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));

                const open = all.filter(t => !['completed', 'cancelled'].includes(t.status));
                const overdue = all.filter(isOverdue);
                const completed = all.filter(t => t.status === 'completed');
                const avgProgress = open.length ? Math.round(open.reduce((sum, t) => sum + A.num(t.progress), 0) / open.length) : 0;

                pane.innerHTML = `
                    <div class="grid grid-4" style="margin-bottom:16px">
                        <div class="kpi"><div class="kpi-top"><span>مهام مفتوحة</span>${A.icon('list')}</div><div class="kpi-value">${A.numFmt(open.length)}</div><div class="kpi-sub">قيد التنفيذ والمعلّقة</div></div>
                        <div class="kpi warn"><div class="kpi-top"><span>متأخرة</span>${A.icon('clock')}</div><div class="kpi-value">${A.numFmt(overdue.length)}</div><div class="kpi-sub">تجاوزت تاريخ الاستحقاق</div></div>
                        <div class="kpi info"><div class="kpi-top"><span>مكتملة</span>${A.icon('checkCircle')}</div><div class="kpi-value">${A.numFmt(completed.length)}</div><div class="kpi-sub">إجمالي المنجز</div></div>
                        <div class="kpi"><div class="kpi-top"><span>متوسط الإنجاز</span>${A.icon('chart')}</div><div class="kpi-value">${avgProgress}%</div><div class="kpi-sub">لللمهام المفتوحة</div></div>
                    </div>
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <input class="search" id="taskSearch" placeholder="بحث في المهام" value="${h(taskFilters.search)}">
                        <select id="taskStatus"><option value="">كل الحالات</option>${Object.keys(STATUS).map(k => `<option value="${k}" ${taskFilters.status === k ? 'selected' : ''}>${h(STATUS[k].label)}</option>`).join('')}</select>
                        <select id="taskPriority"><option value="">كل الأولويات</option>${Object.keys(PRIORITY).map(k => `<option value="${k}" ${taskFilters.priority === k ? 'selected' : ''}>${h(PRIORITY[k])}</option>`).join('')}</select>
                        <select id="taskEmployee"><option value="">كل الموظفين</option>${A.options.employees().map(o => `<option value="${h(o.value)}" ${taskFilters.employeeId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <select id="taskBranch"><option value="">كل الفروع</option>${A.options.branches().map(o => `<option value="${h(o.value)}" ${taskFilters.branchId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <label class="switch"><input type="checkbox" id="taskOverdue" ${taskFilters.overdue ? 'checked' : ''}> المتأخرة فقط</label>
                        <span class="grow"></span>
                        <button class="btn" id="taskPrint">${A.icon('print')} طباعة</button>
                        ${A.can('tasks', 'add') ? `<button class="btn btn-primary" id="taskAdd">${A.icon('plus')} مهمة جديدة</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            {
                                key: 'title', label: 'المهمة', render: t => `<div><strong>${h(t.title)}</strong><div class="small muted">${h(t.category || '—')}${t.description ? ' • ' + h(String(t.description).slice(0, 60)) : ''}</div></div>`
                            },
                            { key: 'employeeId', label: 'الموظف', render: t => h(A.employeeName(t.employeeId) || t.employeeName || '—') },
                            { key: 'branchId', label: 'الفرع', render: t => h(A.branchName(t.branchId) || '—') },
                            { key: 'priority', label: 'الأولوية', render: t => A.badge(PRIORITY_BADGE[t.priority] || '', PRIORITY[t.priority] || '—') },
                            {
                                key: 'dueDate', label: 'الاستحقاق', render: t => {
                                    const left = daysLeft(t);
                                    const late = isOverdue(t);
                                    return `<div>${A.date(t.dueDate)} ${h(t.dueTime || '')}<div class="small ${late ? 'text-danger' : 'muted'}">${left === null ? '—' : late ? `متأخرة ${Math.abs(left)} يوم` : left === 0 ? 'تستحق اليوم' : `متبقٍ ${left} يوم`}</div></div>`;
                                }
                            },
                            { key: 'progress', label: 'الإنجاز', render: t => progressBar(t.progress, statusOf(t).color) },
                            { key: 'status', label: 'الحالة', render: t => A.badge(statusOf(t).badge, statusOf(t).label) }
                        ],
                        rows,
                        actions: t => [
                            { title: 'متابعة الإنجاز', icon: 'checkCircle', action: 'taskProgress' },
                            ...(A.can('tasks', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'taskEdit' }] : []),
                            ...(A.can('tasks', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'taskDel', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد مهام مطابقة للفلاتر'
                    })}`;
                const apply = () => {
                    taskFilters.search = document.getElementById('taskSearch').value;
                    taskFilters.status = document.getElementById('taskStatus').value;
                    taskFilters.priority = document.getElementById('taskPriority').value;
                    taskFilters.employeeId = document.getElementById('taskEmployee').value;
                    taskFilters.branchId = document.getElementById('taskBranch').value;
                    taskFilters.overdue = document.getElementById('taskOverdue').checked;
                    renderTasks();
                };
                document.getElementById('taskSearch').oninput = () => { clearTimeout(view._t); view._t = setTimeout(apply, 250); };
                ['taskStatus', 'taskPriority', 'taskEmployee', 'taskBranch', 'taskOverdue'].forEach(id => { document.getElementById(id).onchange = apply; });
                const add = document.getElementById('taskAdd');
                if (add) add.onclick = () => taskForm(null);
                document.getElementById('taskPrint').onclick = () => A.printTable({
                    title: 'تقرير المهام', subtitle: `${rows.length} مهمة`,
                    columns: [
                        { label: 'الموظف', render: t => h(A.employeeName(t.employeeId) || t.employeeName || '') },
                        { label: 'الفرع', render: t => h(A.branchName(t.branchId) || '') },
                        { label: 'المهمة', render: t => h(t.title) },
                        { label: 'الأولوية', render: t => h(PRIORITY[t.priority] || '') },
                        { label: 'البداية', render: t => A.date(t.startDate) },
                        { label: 'الاستحقاق', render: t => `${A.date(t.dueDate)} ${h(t.dueTime || '')}` },
                        { label: 'الإنجاز', render: t => A.numFmt(t.progress) + '%' },
                        { label: 'الحالة', render: t => h(statusOf(t).label) }
                    ],
                    rows, landscape: true
                });
                A.bindActions({
                    taskProgress: id => A.taskProgressModal(rows.find(t => t.id === id) || {}, renderTasks),
                    taskEdit: id => taskForm(rows.find(t => t.id === id)),
                    taskDel: async id => {
                        if (!(await A.confirm({ title: 'حذف مهمة', message: 'هل تريد حذف هذه المهمة نهائيًا؟', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del('/collections/tasks/' + id); A.toast('تم حذف المهمة'); await A.refresh(); }
                        catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const renderRequests = () => {
                const all = (A.state.data.selfRequests || []).slice();
                const rows = all.filter(r => {
                    if (reqFilters.type && r.type !== reqFilters.type) return false;
                    if (reqFilters.status && r.status !== reqFilters.status) return false;
                    if (reqFilters.employeeId && r.employeeId !== reqFilters.employeeId) return false;
                    if (reqFilters.search) {
                        const q = reqFilters.search.toLowerCase();
                        if (!`${r.employeeName || ''} ${r.subject || ''} ${r.details || ''}`.toLowerCase().includes(q)) return false;
                    }
                    return true;
                });
                const pending = all.filter(r => r.status === 'pending');
                pane.innerHTML = `
                    <div class="grid grid-4" style="margin-bottom:16px">
                        <div class="kpi warn"><div class="kpi-top"><span>طلبات معلّقة</span>${A.icon('clock')}</div><div class="kpi-value">${A.numFmt(pending.length)}</div><div class="kpi-sub">بحاجة إلى مراجعة</div></div>
                        <div class="kpi"><div class="kpi-top"><span>سلف</span>${A.icon('credit')}</div><div class="kpi-value">${A.numFmt(all.filter(r => r.type === 'advance').length)}</div><div class="kpi-sub">طلبات سلف مقدّمة</div></div>
                        <div class="kpi info"><div class="kpi-top"><span>شكاوى</span>${A.icon('alert')}</div><div class="kpi-value">${A.numFmt(all.filter(r => r.type === 'complaint').length)}</div><div class="kpi-sub">شكاوى وملاحظات</div></div>
                        <div class="kpi"><div class="kpi-top"><span>معتمدة</span>${A.icon('checkCircle')}</div><div class="kpi-value">${A.numFmt(all.filter(r => r.status === 'approved').length)}</div><div class="kpi-sub">إجمالي المعتمد</div></div>
                    </div>
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <input class="search" id="reqSearch" placeholder="بحث في الطلبات" value="${h(reqFilters.search)}">
                        <select id="reqType"><option value="">كل الأنواع</option>${Object.keys(REQUEST_TYPES).map(k => `<option value="${k}" ${reqFilters.type === k ? 'selected' : ''}>${h(REQUEST_TYPES[k])}</option>`).join('')}</select>
                        <select id="reqStatus"><option value="">كل الحالات</option>${Object.keys(REQUEST_STATUS).map(k => `<option value="${k}" ${reqFilters.status === k ? 'selected' : ''}>${h(REQUEST_STATUS[k])}</option>`).join('')}</select>
                        <select id="reqEmployee"><option value="">كل الموظفين</option>${A.options.employees().map(o => `<option value="${h(o.value)}" ${reqFilters.employeeId === o.value ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>
                        <span class="grow"></span>
                        <button class="btn" id="reqPrint">${A.icon('print')} طباعة</button>
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'createdAt', label: 'التاريخ', render: r => A.dateTime(r.createdAt) },
                            { key: 'employeeName', label: 'الموظف' },
                            { key: 'type', label: 'النوع', render: r => A.badge('info', REQUEST_TYPES[r.type] || r.type) },
                            { key: 'subject', label: 'الموضوع' },
                            { key: 'amount', label: 'المبلغ', align: 'left', render: r => r.amount ? A.money(r.amount) : '—' },
                            { key: 'status', label: 'الحالة', render: r => A.badge(REQUEST_STATUS_BADGE[r.status] || '', REQUEST_STATUS[r.status] || r.status) },
                            { key: 'reviewedBy', label: 'راجعه', render: r => h(r.reviewedBy || '—') }
                        ],
                        rows,
                        actions: r => [{ title: 'مراجعة', icon: 'eye', action: 'reqView' }],
                        empty: 'لا توجد طلبات من الخدمة الذاتية'
                    })}`;
                const apply = () => {
                    reqFilters.search = document.getElementById('reqSearch').value;
                    reqFilters.type = document.getElementById('reqType').value;
                    reqFilters.status = document.getElementById('reqStatus').value;
                    reqFilters.employeeId = document.getElementById('reqEmployee').value;
                    renderRequests();
                };
                document.getElementById('reqSearch').oninput = () => { clearTimeout(view._r); view._r = setTimeout(apply, 250); };
                ['reqType', 'reqStatus', 'reqEmployee'].forEach(id => { document.getElementById(id).onchange = apply; });
                document.getElementById('reqPrint').onclick = () => A.printTable({
                    title: 'تقرير طلبات الموظفين', subtitle: `${rows.length} طلب`,
                    columns: [
                        { label: 'التاريخ', render: r => A.dateTime(r.createdAt) },
                        { label: 'الموظف', render: r => h(r.employeeName || '') },
                        { label: 'النوع', render: r => h(REQUEST_TYPES[r.type] || r.type) },
                        { label: 'الموضوع', render: r => h(r.subject || '') },
                        { label: 'المبلغ', render: r => r.amount ? A.money(r.amount) : '' },
                        { label: 'الحالة', render: r => h(REQUEST_STATUS[r.status] || r.status) },
                        { label: 'ملاحظة المراجعة', render: r => h(r.reviewNote || '') }
                    ],
                    rows, landscape: true
                });
                A.bindActions({ reqView: id => requestReviewModal(all.find(r => r.id === id), renderRequests) });
            };

            bindTabs(view, 'tasks', id => {
                view.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === id));
                if (id === 'requests') renderRequests(); else renderTasks();
            });
        }
    });
})();
