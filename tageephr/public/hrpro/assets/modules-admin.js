'use strict';

/* ═══════════════════════════════════════════════════════════════
   وحدات الرواتب، المستحقات والخصومات، التقارير، الإشعارات،
   المستخدمون والصلاحيات، الإعدادات، الخدمة الذاتية
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const h = A.h;

    A.registerRoutes([
        { path: 'payroll', module: 'payroll', label: 'الرواتب', subtitle: 'مسير الرواتب والكشوف والإعدادات', icon: 'wallet', group: 'الرواتب والمالية', permission: 'payroll' },
        { path: 'compensation', module: 'compensation', label: 'المستحقات والخصومات', subtitle: 'البدلات والحوافز والسلف والقروض', icon: 'credit', group: 'الرواتب والمالية', permission: 'compensation' },
        { path: 'reports', module: 'reports', label: 'التقارير', subtitle: 'تقارير يومية وشهرية وبصمة قابلة للتخصيص', icon: 'chart', group: 'التحليل والمتابعة', permission: 'reports' },
        { path: 'notifications', module: 'notifications', label: 'الإشعارات', subtitle: 'تنبيهات ذكية للموارد البشرية', icon: 'bell', group: 'التحليل والمتابعة', permission: 'notifications' },
        { path: 'users', module: 'users', label: 'المستخدمون والصلاحيات', subtitle: 'الحسابات والأدوار وسجل التدقيق', icon: 'shield', group: 'الإدارة', permission: 'users' },
        { path: 'settings', module: 'settings', label: 'الإعدادات', subtitle: 'النظام والأمان وقاعدة البيانات والنسخ', icon: 'settings', group: 'الإدارة', permission: 'settings' },
        { path: 'self', module: 'self', label: 'خدمتي الذاتية', subtitle: 'بياناتي وكشوف رواتبي وإجازاتي', icon: 'user', group: 'الرئيسية', permission: 'self' }
    ]);

    const money = v => A.money(v, false);
    const kpi = (label, value, icon, tone = '', sub = '') => `
        <div class="kpi ${tone}">
            <div class="kpi-top"><span>${h(label)}</span>${A.icon(icon)}</div>
            <div class="kpi-value">${value}</div>
            ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
        </div>`;
    const empty = message => `<div class="empty">${A.icon('file')}<div>${h(message || 'لا توجد بيانات')}</div></div>`;
    const tabsBar = (tabs, active) => `<div class="tabs">${tabs.map(t => `<button class="tab ${t.id === active ? 'active' : ''}" data-tab="${t.id}">${h(t.label)}</button>`).join('')}</div>`;
    function bindTabs(view, initial, onChange) {
        view.querySelectorAll('[data-tab]').forEach(btn => {
            if (btn.dataset.boundTab) return;
            btn.dataset.boundTab = '1';
            btn.addEventListener('click', () => {
                view.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
                onChange(btn.dataset.tab);
            });
        });
    }

    // ═══════════════════════════════════════════════════════════
    // الرواتب
    // ═══════════════════════════════════════════════════════════
    const payslipStatus = s => s === 'paid' ? 'paid' : s === 'approved' ? 'approved' : 'draft';

    function payslipHtml(slip, employee) {
        const settings = A.state.data.settings || {};
        const earnings = [];
        earnings.push({ name: 'الراتب الأساسي (حسب أيام الاستحقاق)', amount: slip.basicEarning });
        for (const a of slip.allowances || []) earnings.push({ name: a.name, amount: a.amount });
        for (const inc of slip.incentives || []) earnings.push({ name: 'حافز / مكافأة', amount: inc.amount });
        if (A.num(slip.overtimeAmount)) earnings.push({ name: `بدل عمل إضافي (${A.numFmt(slip.overtimeMinutes)} دقيقة)`, amount: slip.overtimeAmount });
        for (const item of slip.items || []) if (item.type === 'earning') earnings.push({ name: item.name, amount: item.amount });
        const deductions = [];
        if (A.num(slip.absenceDeduction)) deductions.push({ name: `خصم غياب (${A.numFmt(slip.absentDays)} يوم)`, amount: slip.absenceDeduction });
        if (A.num(slip.unpaidLeaveDeduction)) deductions.push({ name: 'خصم إجازة غير مدفوعة', amount: slip.unpaidLeaveDeduction });
        if (A.num(slip.halfDayDeduction)) deductions.push({ name: 'خصم نصف يوم', amount: slip.halfDayDeduction });
        if (A.num(slip.lateDeduction)) deductions.push({ name: `خصم تأخير (${A.numFmt(slip.lateMinutes)} دقيقة)`, amount: slip.lateDeduction });
        if (A.num(slip.earlyDeduction)) deductions.push({ name: 'خصم انصراف مبكر', amount: slip.earlyDeduction });
        if (A.num(slip.gosiEmployeeShare)) deductions.push({ name: 'التأمينات الاجتماعية — حصة الموظف', amount: slip.gosiEmployeeShare });
        if (A.num(slip.tax)) deductions.push({ name: 'ضريبة', amount: slip.tax });
        if (A.num(slip.advanceDeduction)) deductions.push({ name: 'خصم سلف', amount: slip.advanceDeduction });
        if (A.num(slip.loanDeduction)) deductions.push({ name: 'خصم قروض', amount: slip.loanDeduction });
        for (const d of slip.otherDeductionsList || []) deductions.push({ name: d.name, amount: d.amount });
        for (const item of slip.items || []) if (item.type === 'deduction') deductions.push({ name: item.name, amount: item.amount });
        const rowsOf = list => list.length ? list.map(i => `<tr><td>${h(i.name)}</td><td style="text-align:left">${money(i.amount)}</td></tr>`).join('') : '<tr><td colspan="2" class="muted">—</td></tr>';
        return `<div class="payslip">
            <div class="payslip-head">
                <div>
                    <h2>${h(settings.companyName || 'الشركة')}</h2>
                    <div style="color:#475569">كشف راتب — ${h(A.monthName(slip.month))} ${slip.year}</div>
                    ${settings.taxNumber ? `<div class="small" style="color:#64748b">الرقم الضريبي: ${h(settings.taxNumber)}</div>` : ''}
                </div>
                <div style="text-align:left;color:#475569">
                    <div><strong>${h(slip.employeeName)}</strong></div>
                    <div>الرقم: ${h(slip.employeeNumber || '—')}</div>
                    <div>${h(A.branchName(slip.branchId))} / ${h(A.deptName(slip.departmentId))}</div>
                    <div class="small">أيام العمل: ${A.numFmt(slip.totalWorkingDays)} • الحضور: ${A.numFmt(slip.presentDays)} • الإجازات: ${A.numFmt(slip.paidLeaveDays, 1)}</div>
                </div>
            </div>
            <div class="payslip-cols">
                <div><h3 style="font-size:13px;margin-bottom:6px">المستحقات</h3><table><thead><tr><th>البند</th><th>المبلغ</th></tr></thead><tbody>${rowsOf(earnings)}</tbody><tfoot><tr class="total-row"><td>إجمالي المستحقات</td><td style="text-align:left">${money(slip.grossSalary)}</td></tr></tfoot></table></div>
                <div><h3 style="font-size:13px;margin-bottom:6px">الاستقطاعات</h3><table><thead><tr><th>البند</th><th>المبلغ</th></tr></thead><tbody>${rowsOf(deductions)}</tbody><tfoot><tr class="total-row"><td>إجمالي الاستقطاعات</td><td style="text-align:left">${money(slip.totalDeductionsAll)}</td></tr></tfoot></table></div>
            </div>
            <table><tbody>
                <tr class="net"><td>صافي الراتب المستحق</td><td style="text-align:left">${A.money(slip.netSalary)}</td></tr>
                ${A.state.data.payrollSettings.payslipShowEmployerContributions !== false && A.num(slip.gosiEmployerShare) ? `<tr><td class="small">حصة المنشأة في التأمينات (لا تُخصم من الموظف)</td><td style="text-align:left" class="small">${money(slip.gosiEmployerShare)}</td></tr>` : ''}
            </tbody></table>
            <div class="payslip-sign"><span>توقيع الموظف: ____________________</span><span>توقيع الموارد البشرية: ____________________</span></div>
            ${settings.payslipFooterNote ? `<div class="small" style="color:#64748b;margin-top:12px">${h(settings.payslipFooterNote)}</div>` : ''}
        </div>`;
    }

    A.viewPayslip = async id => {
        try {
            const result = await A.get('/collections/payslips?limit=1&id=' + id);
            const slip = (result.data || [])[0];
            if (!slip) throw new Error('الكشف غير موجود');
            const emp = A.employeeById(slip.employeeId);
            A.rawModal({
                title: `كشف راتب — ${slip.employeeName || emp.name || ''}`,
                size: 'lg',
                body: payslipHtml(slip, emp),
                footer: `<button class="btn btn-primary" id="printSlip">${A.icon('print')} طباعة / PDF</button><button class="btn" data-close>إغلاق</button>`
            });
            document.getElementById('printSlip').onclick = () => A.print({
                title: `كشف راتب — ${slip.employeeName}`,
                subtitle: `${A.monthName(slip.month)} ${slip.year}`,
                html: payslipHtml(slip, emp)
            });
        } catch (err) { A.toast(err.message, 'error'); }
    };

    A.registerModule('payroll', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'payslips', label: 'كشوف الرواتب' }, { id: 'periods', label: 'الفترات' }, { id: 'settings', label: 'إعدادات الرواتب' }, { id: 'eos', label: 'تسوية نهاية الخدمة' }], 'payslips')}
                <div class="tab-pane" id="payPane"></div>
            </div>`;
            const pane = document.getElementById('payPane');
            const filters = { periodId: '', status: '' };

            // الكشوف والفترات تُجلب مرة واحدة وتُحفظ في الذاكرة، فيظهر التبويب فورًا عند تبديله
            // بدل انتظار الخادم في كل ضغطة، ويُلغى الحفظ فقط عند تعديل البيانات.
            const store = { slips: null, periods: null };
            let pendingData = null;
            let paintSeq = 0;
            const startPaint = () => ++paintSeq;
            const paint = (token, html) => { if (token === paintSeq) pane.innerHTML = html; };
            const paintError = (token, err) => {
                if (token === paintSeq) pane.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message || 'تعذر تحميل البيانات')}</div></div>`;
            };
            const loadPayrollData = (force = false) => {
                if (force) { store.slips = null; store.periods = null; pendingData = null; }
                if (store.slips && store.periods) return Promise.resolve();
                if (!pendingData) {
                    pendingData = Promise.all([A.get('/collections/payslips'), A.get('/collections/payrollPeriods')])
                        .then(([slipsRes, periodsRes]) => {
                            store.slips = slipsRes.data || [];
                            store.periods = periodsRes.data || [];
                        })
                        .finally(() => { pendingData = null; });
                }
                return pendingData;
            };

            const renderPayslips = async (force = false) => {
                const token = startPaint();
                if (!(store.slips && store.periods)) paint(token, A.loading());
                try { await loadPayrollData(force); } catch (err) { paintError(token, err); return; }
                if (token !== paintSeq) return;
                const periods = store.periods.slice().sort((a, b) => (b.year - a.year) || (b.month - a.month));
                let rows = store.slips.slice();
                if (filters.periodId) rows = rows.filter(s => s.periodId === filters.periodId);
                if (filters.status) rows = rows.filter(s => s.status === filters.status);
                rows.sort((a, b) => (b.year - a.year) || (b.month - a.month) || String(a.employeeName).localeCompare(String(b.employeeName), 'ar'));
                const totals = {
                    gross: rows.reduce((s, r) => s + A.num(r.grossSalary), 0),
                    net: rows.reduce((s, r) => s + A.num(r.netSalary), 0),
                    deductions: rows.reduce((s, r) => s + A.num(r.totalDeductionsAll), 0)
                };
                const mode = (A.state.data.payrollSettings || {}).payslipMode || 'auto';
                const allowanceNames = [];
                (A.state.data.allowanceTypes || []).forEach(t => { if (t.name && !allowanceNames.includes(t.name)) allowanceNames.push(t.name); });
                rows.forEach(r => (r.allowances || []).forEach(a => { if (a.name && !allowanceNames.includes(a.name)) allowanceNames.push(a.name); }));
                const allowanceColumns = allowanceNames.map(name => ({
                    key: `alw_${name}`, label: name, align: 'left',
                    render: r => {
                        const item = (r.allowances || []).find(a => a.name === name);
                        return item ? A.money(item.amount) : '—';
                    }
                }));
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <select id="payPeriod"><option value="">كل الفترات</option>${periods.map(p => `<option value="${p.id}" ${filters.periodId === p.id ? 'selected' : ''}>${h(p.name)} (${p.status === 'closed' ? 'مغلقة' : 'مفتوحة'})</option>`).join('')}</select>
                        <select id="payStatus"><option value="">كل الحالات</option><option value="draft" ${filters.status === 'draft' ? 'selected' : ''}>مسودة</option><option value="approved" ${filters.status === 'approved' ? 'selected' : ''}>معتمد</option><option value="paid" ${filters.status === 'paid' ? 'selected' : ''}>مدفوع</option></select>
                        <span class="grow"></span>
                        <span class="badge ${mode === 'auto' ? 'success' : 'info'}">الوضع: ${mode === 'auto' ? 'توليد تلقائي' : 'إنشاء يدوي'}</span>
                        ${A.can('payroll', 'add') ? `<button class="btn btn-primary" id="payGenerate">${A.icon('play')} توليد كشوف</button>` : ''}
                        ${A.can('payroll', 'edit') ? `<button class="btn" id="paySettingsShortcut">${A.icon('settings')} إعدادات</button>` : ''}
                    </div>
                    <div class="grid grid-3 mb">
                        ${kpi('إجمالي المستحقات', A.money(totals.gross, false), 'money')}
                        ${kpi('إجمالي الاستقطاعات', A.money(totals.deductions, false), 'credit', 'warn')}
                        ${kpi('صافي الرواتب', A.money(totals.net, false), 'wallet', 'info')}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'employeeName', label: 'الموظف', render: r => `<div class="employee-cell"><div class="avatar">${h(A.initials(r.employeeName))}</div><div><strong>${h(r.employeeName)}</strong><small>${h(r.employeeNumber || '')} • ${h(A.deptName(r.departmentId))}</small></div></div>` },
                            { key: 'branchId', label: 'الفرع', render: r => h(A.branchName(r.branchId)) },
                            { key: 'month', label: 'الفترة', render: r => `${A.monthName(r.month)} ${r.year}` },
                            ...allowanceColumns,
                            { key: 'presentDays', label: 'حضور', align: 'left', render: r => A.numFmt(r.presentDays) },
                            { key: 'grossSalary', label: 'الإجمالي', align: 'left', render: r => A.money(r.grossSalary) },
                            { key: 'totalDeductionsAll', label: 'الخصومات', align: 'left', render: r => A.money(r.totalDeductionsAll) },
                            { key: 'netSalary', label: 'الصافي', align: 'left', render: r => `<strong>${A.money(r.netSalary)}</strong>` },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                        ],
                        rows,
                        actions: r => [
                            { title: 'عرض الكشف', icon: 'eye', action: 'view' },
                            ...(r.status === 'draft' && A.can('payroll', 'edit') ? [{ title: 'تعديل البنود', icon: 'edit', action: 'edit' }] : []),
                            ...(r.status === 'draft' && A.can('payroll', 'edit') ? [{ title: 'اعتماد', icon: 'check', action: 'approve' }] : []),
                            ...(r.status !== 'paid' && A.can('payroll', 'edit') ? [{ title: 'صرف', icon: 'money', action: 'pay' }] : [])
                        ],
                        empty: 'لا توجد كشوف رواتب — أنشئ فترة ثم اضغط «توليد كشوف»'
                    })}`;
                ['payPeriod', 'payStatus'].forEach(id => {
                    document.getElementById(id).onchange = () => {
                        filters.periodId = document.getElementById('payPeriod').value;
                        filters.status = document.getElementById('payStatus').value;
                        renderPayslips();
                    };
                });
                const genBtn = document.getElementById('payGenerate');
                if (genBtn) genBtn.onclick = () => generateModal(periods, () => renderPayslips(true));
                const settingsBtn = document.getElementById('paySettingsShortcut');
                if (settingsBtn) settingsBtn.onclick = () => {
                    view.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'settings'));
                    renderSettings();
                };
                A.bindActions({
                    view: id => A.viewPayslip(id),
                    edit: id => editPayslipModal(rows.find(r => r.id === id), () => renderPayslips(true)),
                    approve: async id => {
                        try { await A.post(`/payroll/payslips/${id}/approve`); A.toast('تم اعتماد الكشف'); renderPayslips(true); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    pay: async id => {
                        const slip = rows.find(r => r.id === id);
                        if (!(await A.confirm({ title: 'صرف الراتب', message: `سيتم صرف ${A.money(slip.netSalary)} للموظف ${h(slip.employeeName)} وتسجيل السداد والقيود المحاسبية.` }))) return;
                        try { await A.post(`/payroll/payslips/${id}/pay`, { paymentMethod: 'bank' }); A.toast('تم تسجيل صرف الراتب'); renderPayslips(true); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const generateModal = (periods, refresh) => {
                const mode = (A.state.data.payrollSettings || {}).payslipMode || 'auto';
                A.formModal({
                    title: 'توليد كشوف الرواتب',
                    fields: [
                        { key: 'periodId', label: 'فترة الرواتب', type: 'select', required: true, options: periods.filter(p => p.status !== 'closed').map(p => ({ value: p.id, label: `${p.name} (${p.fromDate} → ${p.toDate})` })), placeholder: periods.filter(p => p.status !== 'closed').length ? '' : 'لا توجد فترات مفتوحة' },
                        { key: 'mode', label: 'طريقة التوليد', type: 'select', options: [{ value: 'auto', label: 'تلقائي لكل الموظفين' }, { value: 'manual', label: 'يدوي — لموظفين محددين' }], default: mode },
                        { key: 'employeeIds', label: 'الموظفون (للوضع اليدوي)', type: 'checks', options: A.options.employees(), full: true, help: 'اختر موظفًا أو أكثر — يُتجاهل هذا الاختيار في الوضع التلقائي' }
                    ],
                    values: { mode },
                    submitLabel: 'توليد الكشوف',
                    onSubmit: async data => {
                        if (!data.periodId) throw new Error('أنشئ فترة رواتب أولًا من تبويب الفترات');
                        const body = { periodId: data.periodId, mode: data.mode };
                        if (data.mode === 'manual') {
                            if (!data.employeeIds || !data.employeeIds.length) throw new Error('اختر موظفًا واحدًا على الأقل');
                            body.employeeIds = data.employeeIds;
                        }
                        const result = await A.post('/payroll/generate', body);
                        A.closeModal(); A.toast(result.message); refresh();
                    }
                });
            };

            const editPayslipModal = (slip, refresh) => {
                const items = JSON.parse(JSON.stringify(slip.items || []));
                const rowHtml = (item, index) => `<div class="row" data-item="${index}" style="margin-bottom:8px">
                    <input data-name style="flex:2" placeholder="اسم البند" value="${h(item.name || '')}">
                    <select data-type style="width:120px"><option value="earning" ${item.type === 'earning' ? 'selected' : ''}>إضافة</option><option value="deduction" ${item.type === 'deduction' ? 'selected' : ''}>خصم</option></select>
                    <input type="number" step="0.01" data-amount style="width:120px" placeholder="المبلغ" value="${A.num(item.amount)}">
                    <button type="button" class="btn btn-danger btn-sm" data-remove>${A.icon('trash')}</button>
                </div>`;
                const modal = A.rawModal({
                    title: `تعديل كشف ${slip.employeeName}`,
                    size: 'lg',
                    body: `<div class="alert">${A.icon('sparkles')}<div>أضف بنودًا يدوية (مكافأة، خصم جزاء، بدل انتقال...) وسيُعاد حساب الإجمالي والصافي تلقائيًا مع الحضور والبدلات والسلف.</div></div>
                        <div class="section-title mt">بنود إضافية</div>
                        <div id="itemsBox">${items.map(rowHtml).join('')}</div>
                        <button type="button" class="btn btn-sm" id="addItem">${A.icon('plus')} إضافة بند</button>
                        <div class="field mt"><label>ملاحظات</label><textarea id="slipNotes" rows="2">${h(slip.notes || '')}</textarea></div>`,
                    footer: `<button class="btn btn-primary" id="saveSlip">إعادة الحساب والحفظ</button><button class="btn" data-close>إلغاء</button>`
                });
                const box = modal.querySelector('#itemsBox');
                const bind = () => box.querySelectorAll('[data-remove]').forEach(btn => {
                    btn.onclick = () => btn.closest('[data-item]').remove();
                });
                bind();
                modal.querySelector('#addItem').onclick = () => {
                    const div = document.createElement('div');
                    div.innerHTML = rowHtml({ type: 'earning', amount: 0 }, Date.now());
                    box.appendChild(div.firstElementChild);
                    bind();
                };
                modal.querySelector('#saveSlip').onclick = async () => {
                    const newItems = Array.from(box.querySelectorAll('[data-item]')).map((row, i) => ({
                        id: 'pi_' + i, name: row.querySelector('[data-name]').value.trim() || 'بند',
                        type: row.querySelector('[data-type]').value,
                        amount: A.num(row.querySelector('[data-amount]').value)
                    }));
                    try {
                        await A.put(`/payroll/payslips/${slip.id}`, { items: newItems, notes: modal.querySelector('#slipNotes').value });
                        modal.close(); A.toast('تم تحديث الكشف'); refresh();
                    } catch (err) { A.toast(err.message, 'error'); }
                };
            };

            const renderPeriods = async (force = false) => {
                const token = startPaint();
                if (!(store.slips && store.periods)) paint(token, A.loading());
                try { await loadPayrollData(force); } catch (err) { paintError(token, err); return; }
                if (token !== paintSeq) return;
                const periods = store.periods.slice().sort((a, b) => (b.year - a.year) || (b.month - a.month));
                const slips = store.slips;
                pane.innerHTML = `
                    <div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">الفترة تحدد أيام العمل والعطلات وتُقفل بعد اعتماد كل الكشوف</span>
                        <span class="grow"></span>
                        ${A.can('payroll', 'add') ? `<button class="btn btn-primary" id="periodAdd">${A.icon('plus')} فترة جديدة</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'name', label: 'الفترة', render: p => `<strong>${h(p.name)}</strong><br><span class="small muted">${A.date(p.fromDate)} → ${A.date(p.toDate)}</span>` },
                            { key: 'month', label: 'الشهر', render: p => `${A.monthName(p.month)} ${p.year}` },
                            { key: 'slips', label: 'عدد الكشوف', align: 'left', render: p => A.numFmt(slips.filter(s => s.periodId === p.id).length) },
                            { key: 'net', label: 'صافي الرواتب', align: 'left', render: p => A.money(slips.filter(s => s.periodId === p.id).reduce((s, x) => s + A.num(x.netSalary), 0)) },
                            { key: 'status', label: 'الحالة', render: p => A.badge(p.status === 'closed' ? 'closed' : p.status === 'draft' ? 'draft' : 'open') }
                        ],
                        rows: periods,
                        actions: p => [
                            ...(p.status !== 'closed' && A.can('payroll', 'add') ? [{ title: 'توليد', icon: 'play', action: 'generate' }] : []),
                            ...(p.status !== 'closed' && A.can('payroll', 'edit') ? [{ title: 'إغلاق', icon: 'lock', action: 'close' }] : []),
                            ...(A.can('payroll', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد فترات رواتب'
                    })}`;
                const add = document.getElementById('periodAdd');
                if (add) add.onclick = () => {
                    const now = new Date();
                    A.formModal({
                        title: 'فترة رواتب جديدة',
                        fields: [
                            { key: 'month', label: 'الشهر', type: 'select', options: Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: A.monthName(i + 1) })), default: String(now.getMonth() + 1) },
                            { key: 'year', label: 'السنة', type: 'number', default: now.getFullYear() },
                            { key: 'name', label: 'اسم الفترة', help: 'اختياري — يُولّد تلقائيًا' },
                            { key: 'fromDate', label: 'من تاريخ', type: 'date', help: 'اختياري — افتراضيًا أول الشهر' },
                            { key: 'toDate', label: 'إلى تاريخ', type: 'date', help: 'اختياري — افتراضيًا آخر الشهر' }
                        ],
                        values: { month: String(now.getMonth() + 1), year: now.getFullYear() },
                        onSubmit: async data => {
                            await A.post('/payroll/periods', data);
                            A.closeModal(); A.toast('تم إنشاء الفترة'); renderPeriods(true);
                        }
                    });
                };
                A.bindActions({
                    generate: async id => {
                        if (!(await A.confirm({ title: 'توليد الكشوف', message: 'سيتم حساب الحضور والبدلات والسلف والغياب والتأخير وتوليد كشوف لكل الموظفين.' }))) return;
                        try { const r = await A.post('/payroll/generate', { periodId: id }); A.toast(r.message); renderPeriods(true); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    close: async id => {
                        if (!(await A.confirm({ title: 'إغلاق الفترة', message: 'لن يمكن توليد أو تعديل كشوف بعد الإغلاق. تأكد من اعتماد كل الكشوف أولًا.', danger: true, confirmLabel: 'إغلاق' }))) return;
                        try { const r = await A.post(`/payroll/periods/${id}/close`); A.toast(r.message); renderPeriods(true); } catch (err) { A.toast(err.message, 'error'); }
                    },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف الفترة', message: 'سيتم حذف الفترة فقط، وليس الكشوف المرتبطة.', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del('/collections/payrollPeriods/' + id); A.toast('تم الحذف'); renderPeriods(true); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const renderSettings = async () => {
                startPaint();
                const ps = A.state.data.payrollSettings || {};
                const field = (key, label, type = 'number', extra = {}) => {
                    const value = ps[key] !== undefined ? ps[key] : '';
                    if (type === 'checkbox') return `<div class="field"><label>${h(label)}</label><label class="switch"><input type="checkbox" id="ps_${key}" ${value ? 'checked' : ''}> ${h(extra.text || 'مفعّل')}</label></div>`;
                    if (type === 'select') return `<div class="field"><label>${h(label)}</label><select id="ps_${key}">${extra.options.map(o => `<option value="${h(o.value)}" ${String(value) === String(o.value) ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select></div>`;
                    if (type === 'textarea') return `<div class="field full"><label>${h(label)}</label><textarea id="ps_${key}" rows="4">${h(value)}</textarea><div class="help">${h(extra.help || '')}</div></div>`;
                    return `<div class="field"><label>${h(label)}</label><input type="${type}" step="${extra.step || '0.01'}" id="ps_${key}" value="${h(value)}" ${extra.min !== undefined ? `min="${extra.min}"` : ''}></div>`;
                };
                pane.innerHTML = `
                    <form id="paySettingsForm">
                        <div class="form-grid">
                            <div class="form-section full"><h4>${A.icon('wallet')} نمط الكشوف والدوام</h4></div>
                            ${field('payslipMode', 'طريقة إنشاء الكشوف', 'select', { options: [{ value: 'auto', label: 'تلقائي — لكل الموظفين' }, { value: 'manual', label: 'يدوي — اختيار الموظفين' }] })}
                            ${field('autoGenerateDay', 'يوم التوليد المقترح شهريًا')}
                            ${field('workMinutesPerDay', 'دقائق العمل اليومية')}
                            ${field('dailyWageBasis', 'أساس الأجر اليومي', 'select', { options: [{ value: 'monthly_30', label: 'الراتب ÷ 30' }, { value: 'working_days', label: 'الراتب ÷ أيام العمل' }] })}
                            <div class="form-section full"><h4>${A.icon('clock')} التأخير والغياب</h4></div>
                            ${field('lateDeductionMode', 'طريقة خصم التأخير', 'select', { options: [{ value: 'none', label: 'بدون خصم مالي' }, { value: 'per_minute', label: 'لكل دقيقة' }, { value: 'per_hour_block', label: 'لكل ساعة أو جزء منها' }] })}
                            ${field('lateDeductionMultiplier', 'معامل خصم التأخير')}
                            ${field('lateDeductionMinimumMinutes', 'أقل دقائق تستوجب الخصم')}
                            ${field('earlyDeductionEnabled', 'خصم الانصراف المبكر', 'checkbox', { text: 'مفعّل' })}
                            ${field('halfDayDeductionFactor', 'نسبة خصم نصف اليوم')}
                            ${field('unpaidLeaveDeduction', 'خصم الإجازة غير المدفوعة', 'checkbox', { text: 'مفعّل' })}
                            ${field('absenceDeductionDays', 'أيام الخصم لكل يوم غياب')}
                            ${field('skipLateDeductionForConvertedLeave', 'إلغاء الخصم المالي للتأخير المحوّل لإجازة', 'checkbox', { text: 'مفعّل' })}
                            <div class="form-section full"><h4>${A.icon('plus')} العمل الإضافي</h4></div>
                            ${field('overtimeEnabled', 'احتساب الإضافي', 'checkbox', { text: 'مفعّل' })}
                            ${field('overtimeCountEarlyArrival', 'احتساب الحضور المبكر إضافيًا', 'checkbox', { text: 'مفعّل' })}
                            ${field('overtimeCountLateDeparture', 'احتساب الخروج المتأخر إضافيًا', 'checkbox', { text: 'مفعّل' })}
                            ${field('overtimeMultiplier', 'معامل الإضافي العادي')}
                            ${field('overtimeHolidayMultiplier', 'معامل الإضافي في العطلات')}
                            ${field('overtimeMinMinutes', 'أقل دقائق إضافي مستحقة')}
                            ${field('overtimeRequiresApproval', 'يتطلب اعتماد الإضافي', 'checkbox', { text: 'مفعّل' })}
                            <div class="form-section full"><h4>${A.icon('shield')} التأمينات والضرائب</h4></div>
                            ${field('gosiEnabled', 'تطبيق التأمينات', 'checkbox', { text: 'مفعّل' })}
                            ${field('gosiBaseIncludesAllowances', 'احتساب البدلات في وعاء التأمينات', 'checkbox', { text: 'مفعّل' })}
                            ${field('taxEnabled', 'تطبيق الضريبة', 'checkbox', { text: 'مفعّل' })}
                            ${field('taxMode', 'طريقة الضريبة', 'select', { options: [{ value: 'flat', label: 'نسبة ثابتة' }, { value: 'brackets', label: 'شرائح تصاعدية' }] })}
                            ${field('taxBrackets', 'شرائح الضريبة', 'textarea', { help: 'صيغة JSON: [{"upTo":5000,"rate":0},{"upTo":10000,"rate":5}] — اتركها فارغة للنسبة الثابتة' })}
                            ${field('maxDeductionPercentOfGross', 'سقف الاستقطاعات من الإجمالي % (0 = بدون سقف)')}
                            ${field('advanceMaxPercentOfSalary', 'سقف السلف من الراتب %')}
                            ${field('loanRespectRemaining', 'عدم تجاوز المتبقي من القرض', 'checkbox', { text: 'مفعّل' })}
                            <div class="form-section full"><h4>${A.icon('checkCircle')} نهاية الخدمة والمحاسبة</h4></div>
                            ${field('eosEnabled', 'احتساب مكافأة نهاية الخدمة', 'checkbox', { text: 'مفعّل' })}
                            ${field('eosFirstFiveYearsDays', 'أيام مكافأة كل سنة (أول 5 سنوات)')}
                            ${field('eosAfterFiveYearsDays', 'أيام مكافأة كل سنة (بعد 5 سنوات)')}
                            ${field('journalEntriesEnabled', 'توليد قيود محاسبية عند الصرف', 'checkbox', { text: 'مفعّل' })}
                            ${field('payslipShowEmployerContributions', 'إظهار حصة المنشأة في الكشف', 'checkbox', { text: 'مفعّل' })}
                        </div>
                        <button type="submit" class="btn btn-primary mt">${A.icon('check')} حفظ إعدادات الرواتب</button>
                    </form>`;
                document.getElementById('paySettingsForm').onsubmit = async e => {
                    e.preventDefault();
                    const get = id => document.getElementById(id);
                    const num = id => A.num(get('ps_' + id).value);
                    const val = id => get('ps_' + id).value;
                    const chk = id => get('ps_' + id).checked;
                    let brackets = [];
                    try { brackets = val('taxBrackets') ? JSON.parse(val('taxBrackets')) : []; }
                    catch (_) { return A.toast('صيغة شرائح الضريبة غير صحيحة (يجب أن تكون JSON)', 'error'); }
                    const payrollSettings = {
                        payslipMode: val('payslipMode'), autoGenerateDay: num('autoGenerateDay'),
                        workMinutesPerDay: num('workMinutesPerDay'), dailyWageBasis: val('dailyWageBasis'),
                        lateDeductionMode: val('lateDeductionMode'), lateDeductionMultiplier: num('lateDeductionMultiplier'),
                        lateDeductionMinimumMinutes: num('lateDeductionMinimumMinutes'), earlyDeductionEnabled: chk('earlyDeductionEnabled'),
                        halfDayDeductionFactor: num('halfDayDeductionFactor'), unpaidLeaveDeduction: chk('unpaidLeaveDeduction'),
                        absenceDeductionDays: num('absenceDeductionDays'), skipLateDeductionForConvertedLeave: chk('skipLateDeductionForConvertedLeave'),
                        overtimeEnabled: chk('overtimeEnabled'), overtimeCountEarlyArrival: chk('overtimeCountEarlyArrival'),
                        overtimeCountLateDeparture: chk('overtimeCountLateDeparture'), overtimeMultiplier: num('overtimeMultiplier'),
                        overtimeHolidayMultiplier: num('overtimeHolidayMultiplier'), overtimeMinMinutes: num('overtimeMinMinutes'),
                        overtimeRequiresApproval: chk('overtimeRequiresApproval'),
                        gosiEnabled: chk('gosiEnabled'), gosiBaseIncludesAllowances: chk('gosiBaseIncludesAllowances'),
                        taxEnabled: chk('taxEnabled'), taxMode: val('taxMode'), taxBrackets: brackets,
                        maxDeductionPercentOfGross: num('maxDeductionPercentOfGross'), advanceMaxPercentOfSalary: num('advanceMaxPercentOfSalary'),
                        loanRespectRemaining: chk('loanRespectRemaining'), eosEnabled: chk('eosEnabled'),
                        eosFirstFiveYearsDays: num('eosFirstFiveYearsDays'), eosAfterFiveYearsDays: num('eosAfterFiveYearsDays'),
                        journalEntriesEnabled: chk('journalEntriesEnabled'), payslipShowEmployerContributions: chk('payslipShowEmployerContributions')
                    };
                    try {
                        await A.put('/payroll/settings', { payrollSettings });
                        A.toast('تم حفظ إعدادات الرواتب');
                        await A.refresh({ rerender: false });
                    } catch (err) { A.toast(err.message, 'error'); }
                };
            };

            const renderEos = async () => {
                startPaint();
                pane.innerHTML = `
                    <div class="alert mb">${A.icon('money')}<div>تُحسب المكافأة حسب نظام العمل: نصف شهر لكل سنة من أول 5 سنوات، وشهر كامل لكل سنة تالية، إضافة إلى قيمة أرصدة الإجازات غير المستخدمة.</div></div>
                    <div class="card card-pad">
                        <div class="form-grid">
                            <div class="field"><label>الموظف</label><select id="eosEmp">${A.options.employees().map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select></div>
                            <div class="field"><label>تاريخ نهاية الخدمة</label><input type="date" id="eosDate" value="${A.today()}"></div>
                        </div>
                        <button class="btn btn-primary" id="eosCalc">${A.icon('play')} حساب التسوية</button>
                        <div id="eosResult" class="mt"></div>
                    </div>`;
                document.getElementById('eosCalc').onclick = async () => {
                    const empId = document.getElementById('eosEmp').value;
                    const date = document.getElementById('eosDate').value;
                    const box = document.getElementById('eosResult');
                    try {
                        const result = await A.get(`/payroll/eos/${empId}?endDate=${date}`);
                        const eos = result.data;
                        box.innerHTML = `<div class="grid grid-3 mt">
                            ${kpi('سنوات الخدمة', A.numFmt(eos.serviceYears, 2), 'clock')}
                            ${kpi('مكافأة الخدمة', A.money(eos.gratuity, false), 'money')}
                            ${kpi('قيمة الإجازات', A.money(eos.leavePay, false), 'palmtree', 'info')}
                        </div>
                        <div class="card card-pad mt">
                            <div class="stat-line"><span>آخر راتب</span><strong>${A.money(eos.lastSalary)}</strong></div>
                            <div class="stat-line"><span>أيام الخدمة</span><strong>${A.numFmt(eos.totalDays)} يوم</strong></div>
                            <div class="stat-line"><span>أيام إجازة غير مستخدمة</span><strong>${A.numFmt(eos.unusedLeaveDays, 1)}</strong></div>
                            <div class="stat-line"><span>إجمالي التسوية</span><strong>${A.money(eos.total)}</strong></div>
                            <button class="btn btn-primary mt" id="eosSave">${A.icon('check')} حفظ التسوية</button>
                        </div>`;
                        document.getElementById('eosSave').onclick = async () => {
                            await A.post('/payroll/eos', { employeeId: empId, endDate: date });
                            A.toast('تم حفظ التسوية');
                        };
                    } catch (err) { box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`; }
                };
            };

            bindTabs(view, 'payslips', id => {
                if (id === 'payslips') renderPayslips();
                else if (id === 'periods') renderPeriods();
                else if (id === 'settings') renderSettings();
                else renderEos();
            });
            renderPayslips();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // المستحقات والخصومات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('compensation', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'allowances', label: 'أنواع البدلات' }, { id: 'deductions', label: 'أنواع الخصومات' }, { id: 'assignments', label: 'بدلات وخصومات الموظفين' }, { id: 'incentives', label: 'الحوافز' }, { id: 'advances', label: 'السلف' }, { id: 'loans', label: 'القروض' }, { id: 'insurance', label: 'التأمينات' }], 'allowances')}
                <div class="tab-pane" id="compPane"></div>
            </div>`;
            const pane = document.getElementById('compPane');

            const typeTab = async (collection, kind) => {
                const types = A.state.data[collection] || [];
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">${kind === 'allowance' ? 'بدلات ثابتة أو نسبة من الراتب الأساسي' : 'خصومات ثابتة أو نسبة تُخصم شهريًا'}</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="typeAdd">${A.icon('plus')} ${kind === 'allowance' ? 'نوع بدل' : 'نوع خصم'}</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'name', label: 'الاسم' },
                            { key: 'calculationType', label: 'طريقة الحساب', render: t => t.calculationType === 'percentage' ? 'نسبة %' : 'مبلغ ثابت' },
                            { key: 'value', label: 'القيمة', align: 'left', render: t => t.calculationType === 'percentage' ? A.numFmt(t.value, 2) + '%' : A.money(t.value) },
                            ...(kind === 'allowance' ? [{ key: 'isInsuranceBased', label: 'داخل التأمينات', render: t => t.isInsuranceBased ? 'نعم' : 'لا' }] : []),
                            { key: 'assigned', label: 'عدد الموظفين', align: 'left', render: t => A.numFmt((A.state.data[kind === 'allowance' ? 'employeeAllowances' : 'employeeDeductions'] || []).filter(x => (kind === 'allowance' ? x.allowanceTypeId : x.deductionTypeId) === t.id).length) }
                        ],
                        rows: types,
                        actions: t => [
                            ...(A.can('compensation', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'edit' }] : []),
                            ...(A.can('compensation', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: kind === 'allowance' ? 'لا توجد أنواع بدلات' : 'لا توجد أنواع خصومات'
                    });
                const add = document.getElementById('typeAdd');
                if (add) add.onclick = () => typeForm(collection, kind, null, () => typeTab(collection, kind));
                A.bindActions({
                    edit: id => typeForm(collection, kind, types.find(t => t.id === id), () => typeTab(collection, kind)),
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف', message: 'هل تريد حذف هذا النوع؟', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del(`/collections/${collection}/${id}`); A.toast('تم الحذف'); await A.refresh(); typeTab(collection, kind); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const typeForm = (collection, kind, type, onDone) => A.formModal({
                title: type ? 'تعديل النوع' : (kind === 'allowance' ? 'نوع بدل جديد' : 'نوع خصم جديد'),
                fields: [
                    { key: 'name', label: 'الاسم', required: true },
                    { key: 'calculationType', label: 'طريقة الحساب', type: 'select', options: [{ value: 'fixed', label: 'مبلغ ثابت' }, { value: 'percentage', label: 'نسبة من الأساسي' }] },
                    { key: 'value', label: 'القيمة', type: 'number', step: '0.01', required: true },
                    ...(kind === 'allowance' ? [{ key: 'isInsuranceBased', label: 'يدخل في وعاء التأمينات', type: 'checkbox' }, { key: 'isTaxable', label: 'خاضع للضريبة', type: 'checkbox', default: true }] : []),
                    { key: 'description', label: 'الوصف', type: 'textarea', full: true }
                ],
                values: type || { calculationType: 'fixed', value: 0 },
                onSubmit: async data => {
                    if (type) await A.put(`/collections/${collection}/${type.id}`, data);
                    else await A.post(`/collections/${collection}`, data);
                    A.closeModal(); A.toast('تم الحفظ'); await A.refresh(); if (onDone) onDone();
                }
            });

            const renderAssignments = async () => {
                const rows = [
                    ...(A.state.data.employeeAllowances || []).map(x => ({ ...x, kind: 'بدل', typeName: (A.state.data.allowanceTypes.find(t => t.id === x.allowanceTypeId) || {}).name })),
                    ...(A.state.data.employeeDeductions || []).map(x => ({ ...x, kind: 'خصم', typeName: (A.state.data.deductionTypes.find(t => t.id === x.deductionTypeId) || {}).name }))
                ];
                const typesRes = await Promise.all([A.get('/collections/employeeAllowances'), A.get('/collections/employeeDeductions')]);
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">تُطبق البدلات والخصومات تلقائيًا في مسير الرواتب حسب تاريخ السريان</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="assignAdd">${A.icon('plus')} إسناد بدل/خصم</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'kind', label: 'النوع', render: r => A.badge(r.kind === 'بدل' ? 'info' : 'danger', r.kind) },
                            { key: 'employeeId', label: 'الموظف', render: r => h(A.employeeName(r.employeeId)) },
                            { key: 'typeName', label: 'البند', render: r => h(r.typeName || '—') },
                            { key: 'amount', label: 'المبلغ', align: 'left', render: r => A.money(r.amount) },
                            { key: 'effectiveDate', label: 'تاريخ السريان', render: r => A.date(r.effectiveDate) },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status === 'inactive' ? 'inactive' : 'active') }
                        ],
                        rows: [...typesRes[0].data.map(x => ({ ...x, kind: 'بدل', typeName: (A.state.data.allowanceTypes.find(t => t.id === x.allowanceTypeId) || {}).name })), ...typesRes[1].data.map(x => ({ ...x, kind: 'خصم', typeName: (A.state.data.deductionTypes.find(t => t.id === x.deductionTypeId) || {}).name }))],
                        actions: r => [
                            ...(A.can('compensation', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'edit' }] : []),
                            ...(A.can('compensation', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد بدلات أو خصومات مسندة'
                    });
                const add = document.getElementById('assignAdd');
                if (add) add.onclick = () => assignmentForm(null, () => renderAssignments());
                A.bindActions({
                    edit: id => {
                        const rec = rows.find(r => r.id === id);
                        if (rec) assignmentForm(rec, () => renderAssignments());
                    },
                    del: async id => {
                        const rec = rows.find(r => r.id === id);
                        if (!rec || !(await A.confirm({ title: 'حذف', message: 'هل تريد حذف هذا الإسناد؟', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del(`/collections/${rec.kind === 'بدل' ? 'employeeAllowances' : 'employeeDeductions'}/${id}`); A.toast('تم الحذف'); renderAssignments(); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const assignmentForm = (record, onDone) => A.formModal({
                title: record ? 'تعديل إسناد' : 'إسناد بدل أو خصم',
                fields: [
                    { key: 'kind', label: 'النوع', type: 'select', options: [{ value: 'allowance', label: 'بدل' }, { value: 'deduction', label: 'خصم' }], default: 'allowance' },
                    { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                    { key: 'allowanceTypeId', label: 'نوع البدل', type: 'select', options: A.options.allowances(), placeholder: '—' },
                    { key: 'deductionTypeId', label: 'نوع الخصم', type: 'select', options: A.options.deductions(), placeholder: '—' },
                    { key: 'amount', label: 'المبلغ (فارغ = قيمة النوع)', type: 'number', step: '0.01' },
                    { key: 'effectiveDate', label: 'تاريخ السريان', type: 'date', default: A.today() },
                    { key: 'endDate', label: 'تاريخ الانتهاء', type: 'date' },
                    { key: 'status', label: 'الحالة', type: 'select', options: [{ value: 'active', label: 'نشط' }, { value: 'inactive', label: 'موقوف' }] },
                    { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
                ],
                values: record || { kind: record ? (record.kind === 'بدل' ? 'allowance' : 'deduction') : 'allowance', effectiveDate: A.today(), status: 'active' },
                onSubmit: async data => {
                    const isAllowance = data.kind === 'allowance';
                    const collection = isAllowance ? 'employeeAllowances' : 'employeeDeductions';
                    const payload = {
                        employeeId: data.employeeId,
                        [isAllowance ? 'allowanceTypeId' : 'deductionTypeId']: isAllowance ? data.allowanceTypeId : data.deductionTypeId,
                        amount: data.amount === '' ? '' : A.num(data.amount),
                        effectiveDate: data.effectiveDate, endDate: data.endDate, status: data.status, notes: data.notes
                    };
                    if (record) {
                        const oldCollection = record.kind === 'بدل' ? 'employeeAllowances' : 'employeeDeductions';
                        if (oldCollection !== collection) { await A.del(`/collections/${oldCollection}/${record.id}`); await A.post(`/collections/${collection}`, payload); }
                        else await A.put(`/collections/${collection}/${record.id}`, payload);
                    } else await A.post(`/collections/${collection}`, payload);
                    A.closeModal(); A.toast('تم الحفظ'); await A.refresh(); if (onDone) onDone();
                }
            });

            const renderIncentives = async () => {
                const result = await A.get('/collections/incentives');
                const rows = (result.data || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">تُضاف الحوافز المعتمدة تلقائيًا إلى كشف الراتب في شهرها</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="incAdd">${A.icon('plus')} حافز / مكافأة</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'employeeId', label: 'الموظف', render: r => h(A.employeeName(r.employeeId)) },
                            { key: 'type', label: 'النوع', render: r => h(r.type || 'مكافأة') },
                            { key: 'amount', label: 'المبلغ', align: 'left', render: r => A.money(r.amount) },
                            { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                        ],
                        rows,
                        actions: r => [
                            ...(r.status !== 'approved' && A.can('compensation', 'edit') ? [{ title: 'اعتماد', icon: 'check', action: 'approve' }] : []),
                            ...(A.can('compensation', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد حوافز'
                    });
                const add = document.getElementById('incAdd');
                if (add) add.onclick = () => A.formModal({
                    title: 'حافز / مكافأة',
                    fields: [
                        { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                        { key: 'type', label: 'النوع', placeholder: 'مكافأة أداء' },
                        { key: 'amount', label: 'المبلغ', type: 'number', step: '0.01', required: true },
                        { key: 'date', label: 'التاريخ', type: 'date', default: A.today() },
                        { key: 'month', label: 'شهر الاستحقاق', type: 'select', options: Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: A.monthName(i + 1) })), default: String(new Date().getMonth() + 1) },
                        { key: 'year', label: 'السنة', type: 'number', default: new Date().getFullYear() },
                        { key: 'status', label: 'الحالة', type: 'select', options: [{ value: 'pending', label: 'معلق' }, { value: 'approved', label: 'معتمد' }] },
                        { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
                    ],
                    values: { date: A.today(), month: String(new Date().getMonth() + 1), year: new Date().getFullYear(), status: 'approved' },
                    onSubmit: async data => {
                        await A.post('/collections/incentives', data);
                        A.closeModal(); A.toast('تم حفظ الحافز'); renderIncentives();
                    }
                });
                A.bindActions({
                    approve: async id => { await A.put('/collections/incentives/' + id, { status: 'approved' }); A.toast('تم الاعتماد'); renderIncentives(); },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف', message: 'هل تريد حذف الحافز؟', danger: true, confirmLabel: 'حذف' }))) return;
                        await A.del('/collections/incentives/' + id); A.toast('تم الحذف'); renderIncentives();
                    }
                });
            };

            const renderAdvances = async () => {
                const result = await A.get('/collections/advances');
                const rows = result.data || [];
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">تُخصم السلف من الراتب حسب القسط الشهري حتى انتهاء الرصيد</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="advAdd">${A.icon('plus')} سلفة جديدة</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'employeeId', label: 'الموظف', render: r => h(A.employeeName(r.employeeId)) },
                            { key: 'totalAmount', label: 'المبلغ', align: 'left', render: r => A.money(r.totalAmount) },
                            { key: 'monthlyDeduction', label: 'القسط الشهري', align: 'left', render: r => A.money(r.monthlyDeduction) },
                            { key: 'remainingAmount', label: 'المتبقي', align: 'left', render: r => A.money(r.remainingAmount) },
                            { key: 'startDate', label: 'البداية', render: r => A.date(r.startDate) },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status === 'closed' ? 'closed' : 'active') }
                        ],
                        rows,
                        actions: r => [
                            ...(r.status !== 'closed' && A.can('compensation', 'edit') ? [{ title: 'تسجيل سداد', icon: 'money', action: 'pay' }] : []),
                            ...(A.can('compensation', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد سلف'
                    });
                const add = document.getElementById('advAdd');
                if (add) add.onclick = () => A.formModal({
                    title: 'سلفة جديدة',
                    fields: [
                        { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                        { key: 'totalAmount', label: 'مبلغ السلفة', type: 'number', step: '0.01', required: true },
                        { key: 'monthlyDeduction', label: 'القسط الشهري', type: 'number', step: '0.01', required: true },
                        { key: 'startDate', label: 'تاريخ الصرف', type: 'date', default: A.today() },
                        { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
                    ],
                    values: { startDate: A.today() },
                    onSubmit: async data => {
                        await A.post('/collections/advances', { ...data, remainingAmount: A.num(data.totalAmount), status: 'active' });
                        A.closeModal(); A.toast('تم تسجيل السلفة'); renderAdvances();
                    }
                });
                A.bindActions({
                    pay: id => {
                        const adv = rows.find(r => r.id === id);
                        A.formModal({
                            title: 'تسجيل سداد سلفة',
                            fields: [
                                { key: 'amount', label: 'المبلغ المسدد', type: 'number', step: '0.01', default: adv.monthlyDeduction, required: true },
                                { key: 'date', label: 'تاريخ السداد', type: 'date', default: A.today() },
                                { key: 'notes', label: 'ملاحظات', full: true }
                            ],
                            onSubmit: async data => {
                                const remaining = Math.max(0, A.num(adv.remainingAmount) - A.num(data.amount));
                                await A.put('/collections/advances/' + adv.id, { remainingAmount: remaining, status: remaining <= 0 ? 'closed' : 'active' });
                                await A.post('/collections/advancePayments', { advanceId: adv.id, employeeId: adv.employeeId, amount: A.num(data.amount), date: data.date, notes: data.notes });
                                A.closeModal(); A.toast('تم تسجيل السداد'); renderAdvances();
                            }
                        });
                    },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف سلفة', message: 'هل تريد حذف السلفة؟', danger: true, confirmLabel: 'حذف' }))) return;
                        await A.del('/collections/advances/' + id); A.toast('تم الحذف'); renderAdvances();
                    }
                });
            };

            const renderLoans = async () => {
                const result = await A.get('/collections/loans');
                const rows = result.data || [];
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">أقساط شهرية تُخصم من الراتب مع احترام الرصيد المتبقي</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="loanAdd">${A.icon('plus')} قرض جديد</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'employeeId', label: 'الموظف', render: r => h(A.employeeName(r.employeeId)) },
                            { key: 'totalAmount', label: 'المبلغ', align: 'left', render: r => A.money(r.totalAmount) },
                            { key: 'monthlyPayment', label: 'القسط', align: 'left', render: r => A.money(r.monthlyPayment) },
                            { key: 'remainingAmount', label: 'المتبقي', align: 'left', render: r => A.money(r.remainingAmount) },
                            { key: 'paidPayments', label: 'الأقساط المسددة', align: 'left' },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status === 'closed' ? 'closed' : 'active') }
                        ],
                        rows,
                        actions: r => [
                            ...(r.status !== 'closed' && A.can('compensation', 'edit') ? [{ title: 'تسجيل قسط', icon: 'money', action: 'pay' }] : []),
                            ...(A.can('compensation', 'delete') ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا توجد قروض'
                    });
                const add = document.getElementById('loanAdd');
                if (add) add.onclick = () => A.formModal({
                    title: 'قرض جديد',
                    fields: [
                        { key: 'employeeId', label: 'الموظف', type: 'select', options: A.options.employees(), required: true },
                        { key: 'totalAmount', label: 'مبلغ القرض', type: 'number', step: '0.01', required: true },
                        { key: 'monthlyPayment', label: 'القسط الشهري', type: 'number', step: '0.01', required: true },
                        { key: 'installments', label: 'عدد الأقساط', type: 'number' },
                        { key: 'startDate', label: 'تاريخ الصرف', type: 'date', default: A.today() },
                        { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true }
                    ],
                    values: { startDate: A.today() },
                    onSubmit: async data => {
                        await A.post('/collections/loans', { ...data, remainingAmount: A.num(data.totalAmount), paidPayments: 0, status: 'active' });
                        A.closeModal(); A.toast('تم تسجيل القرض'); renderLoans();
                    }
                });
                A.bindActions({
                    pay: id => {
                        const loan = rows.find(r => r.id === id);
                        A.formModal({
                            title: 'تسجيل سداد قسط',
                            fields: [
                                { key: 'amount', label: 'مبلغ القسط', type: 'number', step: '0.01', default: loan.monthlyPayment, required: true },
                                { key: 'date', label: 'التاريخ', type: 'date', default: A.today() }
                            ],
                            onSubmit: async data => {
                                const remaining = Math.max(0, A.num(loan.remainingAmount) - A.num(data.amount));
                                await A.put('/collections/loans/' + loan.id, { remainingAmount: remaining, paidPayments: A.num(loan.paidPayments) + 1, status: remaining <= 0 ? 'closed' : 'active' });
                                await A.post('/collections/loanPayments', { loanId: loan.id, employeeId: loan.employeeId, amount: A.num(data.amount), paidDate: data.date, status: 'paid', month: new Date().getMonth() + 1, year: new Date().getFullYear() });
                                A.closeModal(); A.toast('تم تسجيل القسط'); renderLoans();
                            }
                        });
                    },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف قرض', message: 'هل تريد حذف القرض؟', danger: true, confirmLabel: 'حذف' }))) return;
                        await A.del('/collections/loans/' + id); A.toast('تم الحذف'); renderLoans();
                    }
                });
            };

            const renderInsurance = async () => {
                const rows = (A.state.data.insuranceRecords || []).slice().sort((a, b) => (b.year - a.year) || (b.month - a.month));
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">احتساب التأمينات حسب النسب والسقف في الإعدادات العامة</span><span class="grow"></span>${A.can('compensation', 'add') ? `<button class="btn btn-primary" id="insCalc">${A.icon('refresh')} احتساب الشهر</button>` : ''}</div>`
                    + A.table({
                        columns: [
                            { key: 'employeeId', label: 'الموظف', render: r => h(A.employeeName(r.employeeId)) },
                            { key: 'month', label: 'الشهر', render: r => `${A.monthName(r.month)} ${r.year}` },
                            { key: 'baseSalary', label: 'الأجر الخاضع', align: 'left', render: r => A.money(r.baseSalary) },
                            { key: 'employeeShare', label: 'حصة الموظف', align: 'left', render: r => A.money(r.employeeShare) },
                            { key: 'employerShare', label: 'حصة المنشأة', align: 'left', render: r => A.money(r.employerShare) },
                            { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                        ],
                        rows,
                        empty: 'لا توجد سجلات تأمينات'
                    });
                const btn = document.getElementById('insCalc');
                if (btn) btn.onclick = async () => {
                    const now = new Date();
                    const settings = A.state.data.settings || {};
                    const active = (A.state.data.employees || []).filter(e => e.status !== 'terminated' && e.insuranceEligible !== false);
                    const cap = A.num(settings.socialInsuranceSalaryCap, 45000);
                    for (const emp of active) {
                        const base = Math.min(A.num(emp.gosiBase || emp.baseSalary), cap || Infinity);
                        const employeeShare = A.round2(base * A.num(settings.gosiEmployeeRate, 11) / 100);
                        const employerShare = A.round2(base * A.num(settings.gosiEmployerRate, 11.75) / 100);
                        const exists = (A.state.data.insuranceRecords || []).some(r => r.employeeId === emp.id && A.num(r.month) === now.getMonth() + 1 && A.num(r.year) === now.getFullYear());
                        if (exists) continue;
                        await A.post('/collections/insuranceRecords', {
                            employeeId: emp.id, baseSalary: base, employeeShare, employerShare,
                            totalContribution: A.round2(employeeShare + employerShare),
                            month: now.getMonth() + 1, year: now.getFullYear(), status: 'calculated'
                        });
                    }
                    A.toast('تم احتساب التأمينات للشهر'); await A.refresh({ rerender: false }); renderInsurance();
                };
            };

            bindTabs(view, 'allowances', id => {
                if (id === 'allowances') typeTab('allowanceTypes', 'allowance');
                else if (id === 'deductions') typeTab('deductionTypes', 'deduction');
                else if (id === 'assignments') renderAssignments();
                else if (id === 'incentives') renderIncentives();
                else if (id === 'advances') renderAdvances();
                else if (id === 'loans') renderLoans();
                else renderInsurance();
            });
            typeTab('allowanceTypes', 'allowance');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // التقارير
    // ═══════════════════════════════════════════════════════════
    A.registerModule('reports', {
        render: async view => {
            const catalogRes = await A.get('/reports/catalog');
            const catalog = catalogRes.data || [];
            const columnsMap = catalogRes.columns || {};
            const categories = catalogRes.categories || {};
            const [templatesRes, periodsRes] = await Promise.all([A.get('/collections/reportTemplates'), A.get('/collections/payrollPeriods')]);
            const templates = templatesRes.data || [];
            const periods = periodsRes.data || [];
            const state = {
                reportId: 'monthly_attendance', from: A.monthStart(), to: A.today(),
                branchId: '', departmentId: '', employeeId: '', periodId: '',
                columns: null, result: null
            };
            const reportGroups = Object.keys(categories).map(key => ({ key, label: categories[key], items: catalog.filter(r => r.category === key) }));

            view.innerHTML = `
                <div class="split reports-split">
                    <div>
                        <div class="card card-pad mb">
                            <div class="row" style="align-items:flex-start">
                                <div style="flex:1;min-width:260px">
                                    <label class="section-title">التقرير</label>
                                    <select id="repSelect" class="w-full" style="padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--text)">
                                        ${reportGroups.map(g => `<optgroup label="${h(g.label)}">${g.items.map(r => `<option value="${r.id}" ${state.reportId === r.id ? 'selected' : ''}>${h(r.name)}</option>`).join('')}</optgroup>`).join('')}
                                    </select>
                                    <div class="small muted mt" id="repDesc"></div>
                                </div>
                                <div class="field" style="margin:0"><label>من</label><input type="date" id="repFrom" value="${state.from}"></div>
                                <div class="field" style="margin:0"><label>إلى</label><input type="date" id="repTo" value="${state.to}"></div>
                                <div class="field" style="margin:0"><label>الفرع</label><select id="repBranch"><option value="">كل الفروع</option>${A.options.branches().map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>القسم</label><select id="repDept"><option value="">كل الأقسام</option>${A.options.departments().map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>الموظف</label><select id="repEmp"><option value="">كل الموظفين</option>${A.options.employees().map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>الدوام</label><select id="repShift"><option value="">كل الدوامات</option>${A.options.shifts().map(o => `<option value="${h(o.value)}">${h(o.label)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>الحالة</label><select id="repStatus"><option value="">كل الحالات</option>${[['new', 'جديدة'], ['in_progress', 'قيد التنفيذ'], ['on_hold', 'معلّقة'], ['completed', 'مكتملة'], ['cancelled', 'ملغاة'], ['pending', 'طلبات معلّقة'], ['approved', 'معتمد'], ['rejected', 'مرفوض']].map(([v, l]) => `<option value="${v}">${h(l)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>الأولوية</label><select id="repPriority"><option value="">كل الأولويات</option>${[['low', 'منخفضة'], ['normal', 'عادية'], ['high', 'عالية'], ['urgent', 'عاجلة']].map(([v, l]) => `<option value="${v}">${h(l)}</option>`).join('')}</select></div>
                                <label class="switch" style="margin:0 0 14px"><input type="checkbox" id="repOverdue"> المتأخرة فقط</label>
                                <div class="field" style="margin:0"><label>فترة الرواتب</label><select id="repPeriod"><option value="">حسب التاريخ</option>${periods.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('')}</select></div>
                                <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-primary" id="repRun">${A.icon('play')} تشغيل</button></div>
                            </div>
                        </div>
                        <div class="card">
                            <div class="toolbar">
                                <div id="repTitle" style="font-weight:700">—</div>
                                <span class="grow"></span>
                                                <input type="search" id="repSearch" placeholder="بحث في النتائج..." style="max-width:220px">
                                <button class="btn btn-sm" id="repColumns">${A.icon('filter')} الأعمدة</button>
                                <button class="btn btn-sm" id="repExcel">${A.icon('download')} Excel</button>
                                <button class="btn btn-sm" id="repCsv">${A.icon('download')} CSV</button>
                                <button class="btn btn-sm" id="repPrint">${A.icon('print')} طباعة</button>
                                <button class="btn btn-sm" id="repSaveTemplate">${A.icon('copy')} حفظ قالب</button>
                            </div>
                            <div id="repResult">${empty('اختر تقريرًا ثم اضغط «تشغيل»')}</div>
                        </div>
                    </div>
                    <div>
                        <div class="card mb">
                            <div class="card-head"><h3>فئات التقارير</h3></div>
                            <div class="card-pad" style="display:flex;flex-direction:column;gap:5px">
                                ${catalog.map(r => `<button class="btn" style="justify-content:flex-start;text-align:right" data-report="${r.id}">${A.icon(r.icon || 'chart')}<span style="flex:1">${h(r.name)}</span></button>`).join('')}
                            </div>
                        </div>
                        <div class="card">
                            <div class="card-head"><h3>القوالب المحفوظة</h3></div>
                            <div class="card-pad" id="templatesBox">
                                ${templates.length ? templates.map(t => `<div class="stat-line"><button class="btn btn-sm" data-template="${t.id}" style="flex:1;justify-content:flex-start">${h(t.name)}</button><button class="btn btn-sm btn-danger" data-del-template="${t.id}">${A.icon('trash')}</button></div>`).join('') : '<div class="small muted">لا توجد قوالب محفوظة</div>'}
                            </div>
                        </div>
                    </div>
                </div>`;

            const desc = document.getElementById('repDesc');
            const updateDesc = () => {
                const report = catalog.find(r => r.id === state.reportId);
                desc.textContent = report ? report.description : '';
                document.getElementById('repTitle').textContent = report ? report.name : '—';
            };
            updateDesc();

            const getFilters = () => ({
                from: document.getElementById('repFrom').value,
                to: document.getElementById('repTo').value,
                year: parseInt((document.getElementById('repFrom').value || '').slice(0, 4), 10) || new Date().getFullYear(),
                month: parseInt((document.getElementById('repFrom').value || '').slice(5, 7), 10) || new Date().getMonth() + 1,
                branchId: document.getElementById('repBranch').value,
                departmentId: document.getElementById('repDept').value,
                employeeId: document.getElementById('repEmp').value,
                shiftId: document.getElementById('repShift') ? document.getElementById('repShift').value : '',
                status: document.getElementById('repStatus') ? document.getElementById('repStatus').value : '',
                priority: document.getElementById('repPriority') ? document.getElementById('repPriority').value : '',
                onlyOverdue: document.getElementById('repOverdue') ? document.getElementById('repOverdue').checked : false,
                periodId: document.getElementById('repPeriod').value
            });

            const run = async () => {
                const filters = getFilters();
                state.from = filters.from; state.to = filters.to;
                const box = document.getElementById('repResult');
                box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
                try {
                    const result = await A.post('/reports/run', { reportId: state.reportId, filters, columns: state.columns });
                    state.result = result.data;
                    state.filters = filters;
                    renderResult();
                } catch (err) {
                    box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
                }
            };

            const visibleRows = () => {
                const r = state.result;
                if (!r) return [];
                const query = String(state.query || '').trim().toLowerCase();
                if (!query) return r.rows;
                return r.rows.filter(row => r.columns.some(c => String(row[c.key] === undefined || row[c.key] === null ? '' : row[c.key]).toLowerCase().includes(query)));
            };

            const renderResult = () => {
                const r = state.result;
                if (!r) return;
                const rows = visibleRows();
                document.getElementById('repTitle').textContent = `${r.title} — ${A.date(r.from)} إلى ${A.date(r.to)}`;
                const columns = r.columns.map(c => ({
                    key: c.key, label: c.label, align: c.type === 'number' || c.type === 'money' ? 'left' : '',
                    render: row => {
                        const v = row[c.key];
                        if (c.type === 'money') return A.money(v);
                        if (c.type === 'number') return A.numFmt(v, 0);
                        if (c.type === 'date') return A.date(v);
                        if (c.type === 'datetime') return A.dateTime(v);
                        return h(v);
                    }
                }));
                const hasTotals = Object.keys(r.totals || {}).length > 0;
                const footerCells = hasTotals ? r.columns.map((c, i) => ({ content: i === 0 ? 'الإجمالي' : (r.totals[c.key] !== undefined ? (c.type === 'money' ? A.money(r.totals[c.key]) : A.numFmt(r.totals[c.key])) : ''), align: c.type === 'money' || c.type === 'number' ? 'left' : '' })) : null;
                document.getElementById('repResult').innerHTML = `
                    <div class="toolbar" style="border-bottom:0"><span class="small muted">${A.numFmt(rows.length)} سجل${state.query ? ` من ${A.numFmt(r.count)}` : ''}</span></div>
                    ${A.table({ columns, rows, footer: footerCells, empty: 'لا توجد نتائج للفلاتر المحددة' })}`;
            };

            document.getElementById('repSelect').onchange = e => { state.reportId = e.target.value; state.columns = null; updateDesc(); };
            catalog.forEach(() => {});
            view.querySelectorAll('[data-report]').forEach(btn => btn.addEventListener('click', () => {
                state.reportId = btn.dataset.report;
                document.getElementById('repSelect').value = state.reportId;
                state.columns = null;
                updateDesc();
                run();
            }));
            document.getElementById('repRun').onclick = run;
            const searchInput = document.getElementById('repSearch');
            if (searchInput) searchInput.oninput = e => { state.query = e.target.value; renderResult(); };

            document.getElementById('repExcel').onclick = async () => {
                if (!state.result) return A.toast('شغّل التقرير أولًا', 'warning');
                try {
                    await A.downloadPost('/reports/export', { reportId: state.reportId, filters: state.filters, columns: state.columns, format: 'xlsx' }, `${state.reportId}.xlsx`);
                } catch (err) { A.toast(err.message, 'error'); }
            };
            document.getElementById('repCsv').onclick = async () => {
                if (!state.result) return A.toast('شغّل التقرير أولًا', 'warning');
                try {
                    await A.downloadPost('/reports/export', { reportId: state.reportId, filters: state.filters, columns: state.columns, format: 'csv' }, `${state.reportId}.csv`);
                } catch (err) { A.toast(err.message, 'error'); }
            };
            document.getElementById('repPrint').onclick = () => {
                if (!state.result) return A.toast('شغّل التقرير أولًا', 'warning');
                A.print({
                    title: state.result.title,
                    subtitle: `${A.date(state.result.from)} → ${A.date(state.result.to)}`,
                    landscape: state.result.columns.length > 7,
                    html: `<table class="data"><thead><tr>${state.result.columns.map(c => `<th>${h(c.label)}</th>`).join('')}</tr></thead><tbody>${visibleRows().map(row => `<tr>${state.result.columns.map(c => `<td>${c.type === 'money' ? A.money(row[c.key]) : c.type === 'number' ? A.numFmt(row[c.key]) : c.type === 'date' ? A.date(row[c.key]) : c.type === 'datetime' ? A.dateTime(row[c.key]) : h(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
                });
            };
            document.getElementById('repColumns').onclick = () => {
                const cols = columnsMap[state.reportId] || [];
                if (!cols.length) return A.toast('لا توجد أعمدة قابلة للتخصيص', 'warning');
                const selected = state.columns || cols.map(c => c.key);
                A.rawModal({
                    title: 'تخصيص أعمدة التقرير',
                    body: `<div class="checks">${cols.map(c => `<label><input type="checkbox" value="${h(c.key)}" ${selected.includes(c.key) ? 'checked' : ''}> ${h(c.label)}</label>`).join('')}</div>`,
                    footer: `<button class="btn btn-primary" id="applyCols">تطبيق</button><button class="btn" data-close>إلغاء</button>`
                });
                document.getElementById('applyCols').onclick = () => {
                    const chosen = Array.from(document.querySelectorAll('.modal-backdrop .checks input:checked')).map(el => el.value);
                    state.columns = chosen.length ? chosen : null;
                    A.closeModal();
                    if (state.result) run();
                };
            };
            document.getElementById('repSaveTemplate').onclick = () => {
                A.formModal({
                    title: 'حفظ قالب تقرير',
                    fields: [{ key: 'name', label: 'اسم القالب', required: true, full: true }],
                    onSubmit: async data => {
                        await A.post('/collections/reportTemplates', { name: data.name, reportId: state.reportId, filters: getFilters(), columns: state.columns });
                        A.closeModal(); A.toast('تم حفظ القالب'); await A.refresh({ rerender: false });
                        A.route();
                    }
                });
            };
            view.querySelectorAll('[data-template]').forEach(btn => btn.addEventListener('click', () => {
                const template = templates.find(t => t.id === btn.dataset.template);
                if (!template) return;
                state.reportId = template.reportId;
                state.columns = template.columns || null;
                document.getElementById('repSelect').value = template.reportId;
                const f = template.filters || {};
                if (f.from) document.getElementById('repFrom').value = f.from;
                if (f.to) document.getElementById('repTo').value = f.to;
                if (f.branchId) document.getElementById('repBranch').value = f.branchId;
                if (f.departmentId) document.getElementById('repDept').value = f.departmentId;
                if (f.employeeId) document.getElementById('repEmp').value = f.employeeId;
                if (f.shiftId) document.getElementById('repShift').value = f.shiftId;
                if (f.periodId) document.getElementById('repPeriod').value = f.periodId;
                updateDesc();
                run();
            }));
            view.querySelectorAll('[data-del-template]').forEach(btn => btn.addEventListener('click', async () => {
                if (!(await A.confirm({ title: 'حذف القالب', message: 'هل تريد حذف هذا القالب؟', danger: true, confirmLabel: 'حذف' }))) return;
                await A.del('/collections/reportTemplates/' + btn.dataset.delTemplate);
                A.route();
            }));
        }
    });

    // ═══════════════════════════════════════════════════════════
    // الإشعارات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('notifications', {
        render: async view => {
            const result = await A.get('/notifications');
            let rows = result.data || [];
            const filter = { unread: false, type: '' };
            const types = Array.from(new Set(rows.map(n => n.type).filter(Boolean)));
            const paint = () => {
                const list = rows.filter(n => (!filter.unread || !n.read) && (!filter.type || n.type === filter.type));
                view.innerHTML = `<div class="card">
                    <div class="toolbar">
                        <select id="notifType"><option value="">كل الأنواع</option>${types.map(t => `<option value="${h(t)}" ${filter.type === t ? 'selected' : ''}>${h(t)}</option>`).join('')}</select>
                        <label class="switch"><input type="checkbox" id="notifUnread" ${filter.unread ? 'checked' : ''}> غير المقروء فقط</label>
                        <span class="grow"></span>
                        <span class="badge">${A.numFmt(list.length)} إشعار</span>
                        <button class="btn" id="notifScan">${A.icon('refresh')} فحص ذكي</button>
                        <button class="btn" id="notifReadAll">${A.icon('check')} قراءة الكل</button>
                    </div>
                    <div class="card-pad">
                        ${list.length ? list.map(n => `
                            <div class="notif-item" style="padding:14px 0;border-color:var(--line);${n.read ? '' : 'background:transparent'}">
                                <div class="notif-icon ${h(n.severity || 'info')}">${A.icon(n.severity === 'danger' ? 'alert' : n.severity === 'warning' ? 'clock' : 'bell')}</div>
                                <div style="flex:1">
                                    <strong>${h(n.title)} ${n.read ? '' : '<span class="badge info">جديد</span>'}</strong>
                                    <p>${h(n.message)}</p>
                                    <div class="small muted">${A.dateTime(n.createdAt)} ${n.link ? `<button class="btn btn-sm" data-open="${h(n.link)}" style="margin-right:8px">فتح</button>` : ''}</div>
                                </div>
                                ${!n.read ? `<button class="btn btn-sm" data-read="${n.id}">تعليم كمقروء</button>` : ''}
                                <button class="btn btn-sm btn-danger" data-dismiss="${n.id}">${A.icon('x')}</button>
                            </div>`).join('') : empty('لا توجد إشعارات مطابقة')}
                    </div>
                </div>`;
                document.getElementById('notifType').onchange = e => { filter.type = e.target.value; paint(); };
                document.getElementById('notifUnread').onchange = e => { filter.unread = e.target.checked; paint(); };
                document.getElementById('notifScan').onclick = async () => { await A.post('/notifications/scan'); A.toast('تم الفحص'); A.route(); };
                document.getElementById('notifReadAll').onclick = async () => { await A.post('/notifications/read-all'); await A.loadBootstrap(); A.route(); };
                view.querySelectorAll('[data-read]').forEach(btn => btn.addEventListener('click', async () => {
                    await A.post(`/notifications/${btn.dataset.read}/read`);
                    rows = rows.map(n => n.id === btn.dataset.read ? { ...n, read: true } : n);
                    await A.loadBootstrap(); A.updateNotifDot(); paint();
                }));
                view.querySelectorAll('[data-dismiss]').forEach(btn => btn.addEventListener('click', async () => {
                    await A.del('/notifications/' + btn.dataset.dismiss);
                    rows = rows.filter(n => n.id !== btn.dataset.dismiss);
                    await A.loadBootstrap(); A.updateNotifDot(); paint();
                }));
                view.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => A.navigate(btn.dataset.open.replace(/^#/, ''))));
            };
            paint();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // المستخدمون والصلاحيات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('users', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'list', label: 'المستخدمون' }, { id: 'audit', label: 'سجل التدقيق' }], 'list')}
                <div class="tab-pane" id="userPane"></div>
            </div>`;
            const pane = document.getElementById('userPane');
            const roles = A.state.data.roles || {};

            const renderUsers = async () => {
                const result = await A.get('/users');
                const rows = result.data || [];
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0">
                        <span class="small muted">الأدوار تحدد الصلاحيات افتراضيًا، ويمكن تخصيص كل وحدة</span>
                        <span class="grow"></span>
                        ${A.can('users', 'add') ? `<button class="btn" id="userSelfBulk">${A.icon('user')} حسابات الخدمة الذاتية</button><button class="btn btn-primary" id="userAdd">${A.icon('plus')} مستخدم جديد</button>` : ''}
                    </div>
                    ${A.table({
                        columns: [
                            { key: 'name', label: 'المستخدم', render: u => `<div class="employee-cell"><div class="avatar">${h(A.initials(u.name))}</div><div><strong>${h(u.name)}</strong><small>${h(u.username || '')}</small></div></div>` },
                            { key: 'role', label: 'الدور', render: u => A.badge('info', (roles[u.role] || {}).label || u.role) },
                            { key: 'branchId', label: 'الفرع', render: u => u.branchId ? h(A.branchName(u.branchId)) : 'كل الفروع' },
                            { key: 'employeeId', label: 'الموظف المرتبط', render: u => u.employeeId ? h(A.employeeName(u.employeeId)) : '—' },
                            { key: 'lastLoginAt', label: 'آخر دخول', render: u => u.lastLoginAt ? A.dateTime(u.lastLoginAt) : '—' },
                            { key: 'disabled', label: 'الحالة', render: u => A.badge(u.disabled ? 'rejected' : 'active', u.disabled ? 'موقوف' : 'نشط') }
                        ],
                        rows,
                        actions: u => [
                            ...(A.can('users', 'edit') ? [{ title: 'تعديل', icon: 'edit', action: 'edit' }, { title: 'إعادة تعيين كلمة المرور', icon: 'key', action: 'reset' }] : []),
                            ...(A.can('users', 'delete') && u.id !== (A.state.user || {}).id ? [{ title: 'حذف', icon: 'trash', action: 'del', class: 'btn-danger' }] : [])
                        ],
                        empty: 'لا يوجد مستخدمون'
                    })}`;
                const add = document.getElementById('userAdd');
                if (add) add.onclick = () => userForm(null, renderUsers);
                const bulk = document.getElementById('userSelfBulk');
                if (bulk) bulk.onclick = async () => {
                    const yes = await A.confirm({
                        title: 'حسابات الخدمة الذاتية',
                        message: 'سيُنشأ حساب خدمة ذاتية لكل موظف نشط ليس لديه حساب. تُعرض كلمات المرور مرة واحدة فقط.',
                        confirmLabel: 'إنشاء الحسابات'
                    });
                    if (!yes) return;
                    try {
                        const result = await A.post('/users/self-accounts');
                        const data = result.data || {};
                        const created = data.created || [];
                        A.rawModal({
                            title: 'حسابات الخدمة الذاتية',
                            body: created.length
                                ? `<div class="alert warning">${A.icon('alert')}<div>انسخ كلمات المرور وسلّمها للموظفين الآن — لن تُعرض مرة أخرى.</div></div>
                                    <div class="table-wrap"><table class="data"><thead><tr><th>الموظف</th><th>الفرع</th><th>اسم الدخول</th><th>كلمة المرور</th></tr></thead><tbody>
                                    ${created.map(c => `<tr><td>${h(c.name)}</td><td>${h(c.branchName || '—')}</td><td dir="ltr">${h(c.username)}</td><td dir="ltr">${h(c.password)}</td></tr>`).join('')}
                                    </tbody></table></div>`
                                : `<div class="empty">${A.icon('checkCircle')}<div>لا توجد حسابات جديدة — تم تخطي ${A.numFmt(data.skipped)} موظف لديه حساب بالفعل.</div></div>`,
                            footer: '<button class="btn btn-primary" data-close>تم</button>'
                        });
                        A.toast(result.message);
                    } catch (err) { A.toast(err.message, 'error'); }
                };
                A.bindActions({
                    edit: id => userForm(rows.find(u => u.id === id), renderUsers),
                    reset: id => {
                        const user = rows.find(u => u.id === id);
                        A.formModal({
                            title: `إعادة تعيين كلمة مرور — ${user.name}`,
                            fields: [{ key: 'password', label: 'كلمة المرور الجديدة', type: 'password', required: true, full: true, help: 'سيُطلب من المستخدم تغييرها عند أول دخول' }],
                            onSubmit: async data => {
                                await A.post(`/users/${id}/reset-password`, { password: data.password });
                                A.closeModal(); A.toast('تم إعادة تعيين كلمة المرور');
                            }
                        });
                    },
                    del: async id => {
                        if (!(await A.confirm({ title: 'حذف مستخدم', message: 'هل تريد حذف هذا المستخدم نهائيًا؟', danger: true, confirmLabel: 'حذف' }))) return;
                        try { await A.del('/collections/users/' + id); A.toast('تم الحذف'); renderUsers(); } catch (err) { A.toast(err.message, 'error'); }
                    }
                });
            };

            const userForm = (user, onDone) => {
                const modules = A.state.data.modules || {};
                const roleOptions = Object.keys(roles).map(key => ({ value: key, label: roles[key].label }));
                const permFields = Object.keys(modules).filter(m => m !== 'dashboard').map(m => ({
                    key: 'perm_' + m, label: modules[m], type: 'select',
                    options: ['none', 'view', 'add', 'edit', 'delete', 'all'].map(level => ({ value: level, label: { none: 'بدون', view: 'عرض', add: 'إضافة', edit: 'تعديل', delete: 'حذف', all: 'كل الصلاحيات' }[level] })),
                    default: (user && user.permissions && user.permissions[m]) || 'none'
                }));
                A.formModal({
                    title: user ? `تعديل المستخدم ${user.name}` : 'مستخدم جديد',
                    size: 'lg',
                    fields: [
                        { type: 'section', label: 'بيانات الحساب', icon: 'user' },
                        { key: 'name', label: 'الاسم', required: true },
                        { key: 'username', label: 'اسم الدخول', required: true },
                        { key: 'password', label: user ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور', type: 'password', required: !user },
                        { key: 'role', label: 'الدور', type: 'select', options: roleOptions, required: true },
                        { key: 'branchId', label: 'الفرع المصرح', type: 'select', options: A.options.branches(), placeholder: 'كل الفروع' },
                        { key: 'employeeId', label: 'الموظف المرتبط (للخدمة الذاتية)', type: 'select', options: A.options.employees(), placeholder: '—' },
                        { key: 'disabled', label: 'إيقاف الحساب', type: 'checkbox' },
                        { type: 'section', label: 'صلاحيات مخصصة (تتجاوز الدور)', icon: 'shield' },
                        ...permFields
                    ],
                    values: { role: 'hr_officer', ...(user || {}), permissions: undefined },
                    submitLabel: user ? 'حفظ' : 'إنشاء المستخدم',
                    onSubmit: async data => {
                        const permissions = {};
                        for (const key of Object.keys(data)) if (key.startsWith('perm_')) permissions[key.slice(5)] = data[key];
                        const payload = {
                            name: data.name, username: data.username, role: data.role,
                            branchId: data.branchId, employeeId: data.employeeId, disabled: data.disabled,
                            permissions
                        };
                        if (data.password) payload.password = data.password;
                        if (user) await A.put('/collections/users/' + user.id, payload);
                        else await A.post('/collections/users', payload);
                        A.closeModal(); A.toast('تم حفظ المستخدم'); await A.refresh({ rerender: false }); if (onDone) onDone();
                    },
                    onOpen: (root, close, form) => {
                        if (user && user.permissions) {
                            for (const [m, level] of Object.entries(user.permissions)) {
                                const el = form.querySelector(`[name="perm_${m}"]`);
                                if (el) el.value = level;
                            }
                        }
                    }
                });
            };

            const renderAudit = async () => {
                const result = await A.get('/audit?limit=500');
                const rows = result.data || [];
                pane.innerHTML = `<div class="toolbar" style="padding:0 0 14px;border:0"><span class="small muted">كل عمليات الإضافة والتعديل والحذف والدخول مسجلة بالمستخدم والوقت وعنوان IP</span><span class="grow"></span><button class="btn" id="auditRefresh">${A.icon('refresh')} تحديث</button></div>`
                    + A.table({
                        columns: [
                            { key: 'at', label: 'الوقت', render: a => A.dateTime(a.at) },
                            { key: 'userName', label: 'المستخدم' },
                            { key: 'action', label: 'الإجراء', render: a => A.badge('info', a.action) },
                            { key: 'module', label: 'الوحدة' },
                            { key: 'collection', label: 'المجموعة' },
                            { key: 'details', label: 'التفاصيل', render: a => h(a.details || '') },
                            { key: 'ip', label: 'IP', render: a => `<span dir="ltr">${h(a.ip || '')}</span>` }
                        ], rows, empty: 'لا توجد عمليات مسجلة'
                    });
                document.getElementById('auditRefresh').onclick = renderAudit;
            };

            bindTabs(view, 'list', id => { if (id === 'list') renderUsers(); else renderAudit(); });
            renderUsers();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // الإعدادات
    // ═══════════════════════════════════════════════════════════
    A.registerModule('settings', {
        render: async view => {
            view.innerHTML = `<div class="card">
                ${tabsBar([{ id: 'general', label: 'عام' }, { id: 'security', label: 'الأمان' }, { id: 'database', label: 'قاعدة البيانات' }, { id: 'backup', label: 'النسخ والاستعادة' }, { id: 'fingerprint', label: 'البصمة' }, { id: 'notifications', label: 'الإشعارات' }, { id: 'network', label: 'الشبكة والوصول' }, { id: 'license', label: 'الترخيص' }], 'general')}
                <div class="tab-pane" id="settingsPane"></div>
            </div>`;
            const pane = document.getElementById('settingsPane');

            const renderGeneral = () => {
                const s = A.state.data.settings || {};
                const LEGACY_SIDEBARS = ['#0b1526', '#3f51b5', '#283593'];
                const SIDEBAR_DEFAULT = '#0070CC';
                const sidebarColor = (s.sidebarColor && !LEGACY_SIDEBARS.includes(String(s.sidebarColor).toLowerCase())) ? s.sidebarColor : SIDEBAR_DEFAULT;
                const weeks = [{ v: '0', l: 'الأحد' }, { v: '1', l: 'الاثنين' }, { v: '2', l: 'الثلاثاء' }, { v: '3', l: 'الأربعاء' }, { v: '4', l: 'الخميس' }, { v: '5', l: 'الجمعة' }, { v: '6', l: 'السبت' }];
                const weeklyOff = Array.isArray(s.weeklyOffDays) ? s.weeklyOffDays : ['5'];
                pane.innerHTML = `<form id="generalForm" class="form-grid">
                    <div class="form-section full"><h4>${A.icon('building')} بيانات المنشأة</h4></div>
                    <div class="field"><label>اسم الشركة</label><input id="s_companyName" value="${h(s.companyName || '')}" required></div>
                    <div class="field"><label>الاسم بالإنجليزية</label><input id="s_companyNameEn" value="${h(s.companyNameEn || '')}"></div>
                    <div class="field"><label>الرقم الضريبي</label><input id="s_taxNumber" value="${h(s.taxNumber || '')}"></div>
                    <div class="field"><label>السجل التجاري</label><input id="s_crNumber" value="${h(s.crNumber || '')}"></div>
                    <div class="field"><label>الهاتف</label><input id="s_phone" value="${h(s.phone || '')}"></div>
                    <div class="field"><label>البريد الإلكتروني</label><input id="s_email" value="${h(s.email || '')}"></div>
                    <div class="field full"><label>العنوان</label><input id="s_address" value="${h(s.address || '')}"></div>
                    ${A.imageField({ key: 'logo', label: 'شعار الشركة', value: s.logo || '', maxWidth: 480, help: 'ارفع شعار الشركة من ملفات الجهاز أو ألصق رابط الصورة — يظهر في القائمة الجانبية وفي رأس المطبوعات.' })}
                    <div class="form-section full"><h4>${A.icon('print')} رأس الطباعة وخط المطبوعات</h4></div>
                    ${A.imageField({ key: 'printHeaderImage', label: 'صورة رأس صفحة الطباعة', value: s.printHeaderImage || '', maxWidth: 1600, wide: true, help: 'صورة عريضة (المقاس المقترح 1600×220) تظهر في أعلى الصفحة المطبوعة بعرض الصفحة كامل، ويمكن أن تتضمن الشعار واسم الشركة وبيانات التواصل.' })}
                    <div class="field"><label>ارتفاع صورة رأس الطباعة (px)</label><input type="number" min="40" max="400" step="1" id="s_printHeaderHeight" value="${s.printHeaderHeight || 170}"><div class="help">ارتفاع الصورة في الطباعة بالبكسل — الافتراضي 170. يظهر تحتها خط فاصل بعرض الصفحة ثم اسم التقرير والفلاتر.</div></div>
                    <div class="field"><label>نوع خط الطباعة</label><select id="s_printFontFamily">${A.printFontOptionsHtml(s.printFontFamily || A.PRINT_FONTS[0].value)}</select><div class="help">يُطبّق على كل التقارير والكشوف المطبوعة.</div></div>
                    <div class="field"><label>حجم خط الطباعة (px)</label><input type="number" min="7" max="24" step="1" id="s_printFontSize" value="${s.printFontSize || 12}"><div class="help">من 7 إلى 24 — الافتراضي 12.</div></div>
                    <div class="field"><label>اسم مدير الموارد البشرية (في توقيع المطبوعات)</label><input id="s_printHrManagerName" value="${h(s.printHrManagerName || '')}" placeholder="اتركه فارغًا لترك خط التوقيع فقط"></div>
                    <div class="field"><label>اسم المدير العام / نائب المدير العام</label><input id="s_printDirectorName" value="${h(s.printDirectorName || '')}" placeholder="يظهر تحت خط التوقيع في أسفل كل صفحة مطبوعة"><div class="help">يُطبع تحت الجدول في كل صفحة، ويُكتب أسفله اسم المستخدم الذي طبع المستند ووقت الطباعة.</div></div>
                    <div class="field full"><button type="button" class="btn" id="printPreviewBtn">${A.icon('print')} معاينة الطباعة</button><div class="help">تعرض نموذجًا بالقيم المحفوظة حاليًا — احفظ الإعدادات ثم عاين لرؤية رأس الصفحة والخط الجديدين.</div></div>
                    <div class="form-section full"><h4>${A.icon('calendar')} العمل والدوام</h4></div>
                    <div class="field"><label>العملة</label><select id="s_currency">${A.currencyOptionsHtml(s.currency || 'ر.ي')}</select><div class="help">الافتراضي الريال اليمني (ر.ي) — وتظهر بجانب كل المبالغ في النظام والتقارير والمطبوعات.</div></div>
                    <div class="field"><label>بداية اليوم التشغيلي</label><input type="time" id="s_operationalDayStart" value="${h(s.operationalDayStart || '06:00')}"></div>
                    <div class="field"><label>فترة السماح للتأخير (دقيقة)</label><input type="number" id="s_gracePeriodMinutes" value="${s.gracePeriodMinutes || 15}"></div>
                    <div class="field"><label>فترة السماح للانصراف المبكر (دقيقة)</label><input type="number" id="s_earlyDepartureGraceMinutes" value="${s.earlyDepartureGraceMinutes || 15}"></div>
                    <div class="field"><label>أيام الخصم لكل غياب</label><input type="number" step="0.5" id="s_absentDeductionDays" value="${s.absentDeductionDays || 1}"></div>
                    <div class="field"><label>بداية تتبع الحضور (لا يُحتسب قبلها غياب)</label><input type="date" id="s_attendanceStartDate" value="${h(s.attendanceStartDate || '')}"></div>
                    <div class="field"><label>حد الغياب العام (دقيقة تأخير)</label><input type="number" min="0" id="s_lateAbsenceMinutes" value="${s.lateAbsenceMinutes || 0}"><div class="help">0 = معطّل. عند تجاوز هذا الحد يُحتسب اليوم غيابًا حتى لو بصم الموظف.</div></div>
                    <div class="form-section full"><h4>${A.icon('menu')} المظهر والقائمة الجانبية</h4></div>
                    <div class="field"><label>لون النظام الأساسي</label><input type="color" id="s_themeColor" value="${h(s.themeColor || '#0d9488')}" style="height:40px;padding:3px"></div>
                    <div class="field"><label>لون القائمة الجانبية الافتراضي</label><input type="color" id="s_sidebarColor" value="${h(sidebarColor)}" style="height:40px;padding:3px">
                        <div class="help">الافتراضي ${SIDEBAR_DEFAULT} — يُطبَّق على شريط القائمة الجانبية وإطار العنصر النشط وألوان البطاقات المشتقة منه.</div>
                        <button type="button" class="btn" id="sidebarColorReset" style="margin-top:8px">${A.icon('refresh')} استعادة اللون الافتراضي</button>
                    </div>
                    <div class="field full"><label>معاينة مباشرة</label>
                        <div id="sidebarColorPreview" style="display:flex;align-items:center;gap:9px;min-height:46px;padding:10px 14px;border:2px solid var(--tg-sb-card-border);border-inline-end:4px solid var(--tg-sb-accent);border-radius:13px;background:var(--tg-sb-card-bg);color:var(--tg-sb-text);font-weight:600;max-width:320px">
                            <span style="width:14px;height:14px;border-radius:4px;background:var(--tg-sb-accent);flex:none"></span> القائمة الجانبية
                        </div>
                        <div class="help">تتغيّر المعاينة والقائمة الفعلية فور اختيار اللون، وتُحفظ مع الإعدادات.</div>
                    </div>
                    <div class="field full"><label>أيام العطلة الأسبوعية</label><div class="checks">${weeks.map(w => `<label><input type="checkbox" name="weeklyOff" value="${w.v}" ${weeklyOff.includes(w.v) ? 'checked' : ''}> ${w.l}</label>`).join('')}</div></div>
                    <div class="form-section full"><h4>${A.icon('shield')} التأمينات والضرائب</h4></div>
                    <div class="field"><label>نسبة التأمينات — الموظف %</label><input type="number" step="0.01" id="s_gosiEmployeeRate" value="${s.gosiEmployeeRate || 0}"></div>
                    <div class="field"><label>نسبة التأمينات — المنشأة %</label><input type="number" step="0.01" id="s_gosiEmployerRate" value="${s.gosiEmployerRate || 0}"></div>
                    <div class="field"><label>سقف الأجر الخاضع للتأمينات</label><input type="number" step="0.01" id="s_socialInsuranceSalaryCap" value="${s.socialInsuranceSalaryCap || 0}"></div>
                    <div class="field"><label>الحد الأدنى للأجر الخاضع</label><input type="number" step="0.01" id="s_socialInsuranceSalaryFloor" value="${s.socialInsuranceSalaryFloor || 0}"></div>
                    <div class="field"><label>نسبة الضريبة الثابتة %</label><input type="number" step="0.01" id="s_taxRate" value="${s.taxRate || 0}"></div>
                    <div class="field"><label>الإعفاء الضريبي</label><input type="number" step="0.01" id="s_taxExemptLimit" value="${s.taxExemptLimit || 0}"></div>
                    <div class="field full"><label>ملاحظة أسفل كشوف الرواتب</label><textarea id="s_payslipFooterNote" rows="2">${h(s.payslipFooterNote || '')}</textarea></div>
                    <div class="full"><button type="submit" class="btn btn-primary">${A.icon('check')} حفظ الإعدادات العامة</button></div>
                </form>`;
                const generalForm = document.getElementById('generalForm');
                A.bindImageField(generalForm, 'logo', { maxWidth: 480 });
                A.bindImageField(generalForm, 'printHeaderImage', { maxWidth: 1600 });
                const sidebarColorInput = document.getElementById('s_sidebarColor');
                const previewSidebar = () => A.applyTheme({ ...(A.state.data.settings || {}), sidebarColor: sidebarColorInput.value || SIDEBAR_DEFAULT });
                sidebarColorInput.addEventListener('input', previewSidebar);
                document.getElementById('sidebarColorReset').onclick = () => { sidebarColorInput.value = SIDEBAR_DEFAULT; previewSidebar(); };
                document.getElementById('printPreviewBtn').onclick = () => A.print({
                    title: 'معاينة الطباعة', subtitle: 'نموذج تجريبي',
                    html: `<table class="data"><thead><tr><th>البيان</th><th>المبلغ</th></tr></thead><tbody><tr><td>الراتب الأساسي</td><td class="num">${A.money(150000)}</td></tr><tr><td>البدلات</td><td class="num">${A.money(25000)}</td></tr><tr><td>صافي المستحق</td><td class="num">${A.money(175000)}</td></tr></tbody></table>`
                });
                generalForm.onsubmit = async e => {
                    e.preventDefault();
                    const val = id => document.getElementById(id).value;
                    const weeklyOffDays = Array.from(document.querySelectorAll('input[name="weeklyOff"]:checked')).map(el => el.value);
                    const settings = {
                        companyName: val('s_companyName'), companyNameEn: val('s_companyNameEn'),
                        taxNumber: val('s_taxNumber'), crNumber: val('s_crNumber'), phone: val('s_phone'),
                        email: val('s_email'), address: val('s_address'), logo: A.imageFieldValue(generalForm, 'logo'),
                        printHeaderImage: A.imageFieldValue(generalForm, 'printHeaderImage'),
                        printHeaderHeight: A.num(val('s_printHeaderHeight'), 170),
                        printHrManagerName: val('s_printHrManagerName'), printDirectorName: val('s_printDirectorName'),
                        printFontFamily: val('s_printFontFamily'), printFontSize: A.num(val('s_printFontSize'), 12),
                        currency: val('s_currency'), currencyCode: (A.currencyOption(val('s_currency')) || {}).code || '',
                        operationalDayStart: val('s_operationalDayStart'),
                        gracePeriodMinutes: A.num(val('s_gracePeriodMinutes')), earlyDepartureGraceMinutes: A.num(val('s_earlyDepartureGraceMinutes')),
                        absentDeductionDays: A.num(val('s_absentDeductionDays')), attendanceStartDate: val('s_attendanceStartDate'),
                        lateAbsenceMinutes: A.num(val('s_lateAbsenceMinutes')),
                        themeColor: val('s_themeColor'), sidebarColor: val('s_sidebarColor'),
                        weeklyOffDays,
                        gosiEmployeeRate: A.num(val('s_gosiEmployeeRate')), gosiEmployerRate: A.num(val('s_gosiEmployerRate')),
                        socialInsuranceSalaryCap: A.num(val('s_socialInsuranceSalaryCap')), socialInsuranceSalaryFloor: A.num(val('s_socialInsuranceSalaryFloor')),
                        taxRate: A.num(val('s_taxRate')), taxExemptLimit: A.num(val('s_taxExemptLimit')),
                        payslipFooterNote: val('s_payslipFooterNote')
                    };
                    try { await A.put('/settings', { settings }); A.toast('تم حفظ الإعدادات العامة'); await A.refresh({ rerender: false }); }
                    catch (err) { A.toast(err.message, 'error'); }
                };
            };

            const renderSecurity = async () => {
                pane.innerHTML = `<div class="grid grid-2">
                    <div class="card card-pad">
                        <h4>${A.icon('lock')} حماية الحساب</h4>
                        <p class="small muted">كلمات المرور مشفّرة بـ scrypt، والجلسات موقّعة بـ HMAC ومحدودة المدة، مع قفل مؤقت بعد محاولات دخول فاشلة متكررة.</p>
                        <button class="btn btn-primary mt" id="secPassword">${A.icon('key')} تغيير كلمة المرور</button>
                        <div class="stat-line mt"><span>اسم المستخدم</span><strong>${h((A.state.user || {}).username || '—')}</strong></div>
                        <div class="stat-line"><span>الدور</span><strong>${h((A.state.user || {}).roleLabel || (A.state.user || {}).role)}</strong></div>
                        <div class="stat-line"><span>آخر دخول</span><strong>${(A.state.user || {}).lastLoginAt ? A.dateTime(A.state.user.lastLoginAt) : '—'}</strong></div>
                    </div>
                    <div class="card card-pad">
                        <h4>${A.icon('shield')} تشفير البيانات والنسخ</h4>
                        <p class="small muted">تشفير التخزين (at-rest) بـ AES-256-GCM يشفّر كل مجموعات البيانات داخل قاعدة البيانات. النسخ الاحتياطية تُشفّر أيضًا بـ AES-256-GCM مع PBKDF2.</p>
                        <div class="stat-line"><span>تشفير التخزين</span><strong>${(A.state.data.db || {}).encryptAtRest ? 'مفعّل' : 'معطّل'}</strong></div>
                        <div class="stat-line"><span>نوع قاعدة البيانات</span><strong>${h((A.state.data.db || {}).type)}</strong></div>
                        <div class="stat-line"><span>آخر حفظ</span><strong>${(A.state.data.db || {}).lastSavedAt ? A.dateTime(A.state.data.db.lastSavedAt) : '—'}</strong></div>
                        <label class="switch mt"><input type="checkbox" id="encToggle" ${(A.state.data.db || {}).encryptAtRest ? 'checked' : ''}> تشفير التخزين at-rest</label>
                        <div class="alert mt">${A.icon('alert')}<div>احتفظ بمفتاح التشفير في <code>data/.hr-key</code> وبنَسخ احتياطية آمنة. فقدان المفتاح يعني تعذر قراءة البيانات المشفرة.</div></div>
                    </div>
                </div>`;
                document.getElementById('secPassword').onclick = () => A.showChangePassword();
                document.getElementById('encToggle').onchange = async e => {
                    try {
                        await A.post('/db/encryption', { encryptAtRest: e.target.checked });
                        A.toast('تم تحديث إعداد التشفير'); await A.refresh({ rerender: false }); renderSecurity();
                    } catch (err) { A.toast(err.message, 'error'); e.target.checked = !e.target.checked; }
                };
            };

            const renderDatabase = async () => {
                const status = await A.get('/db/status');
                const data = status.data;
                const cfg = data.config || {};
                pane.innerHTML = `
                    <div class="grid grid-3 mb">
                        ${kpi('قاعدة البيانات الحالية', h({ sqlite: 'SQLite', mssql: 'SQL Server', mysql: 'MySQL', json: 'JSON' }[data.type] || data.type), 'database')}
                        ${kpi('تشفير التخزين', data.encryptAtRest ? 'مفعّل' : 'معطّل', 'shield', data.encryptAtRest ? '' : 'warn')}
                        ${kpi('النسخ الاحتياطية', A.numFmt((data.backups || []).length), 'file', 'info')}
                    </div>
                    <div class="alert mb">${A.icon('database')}<div>التبديل بين SQL Server والقاعدة المحلية ينقل بياناتك الحالية إلى القاعدة الجديدة بعدإنشاء نسخة أمان مشفرة تلقائيًا. يمكنك الاختبار قبل التبديل.</div></div>
                    <div class="card card-pad">
                        <div class="form-grid">
                            <div class="field"><label>نوع قاعدة البيانات</label><select id="dbType">
                                ${data.supported.map(s => `<option value="${s.type}" ${data.type === s.type ? 'selected' : ''}>${h(s.name)}</option>`).join('')}
                            </select></div>
                            <div class="field"><label>ملاحظة</label><input value="${h((data.supported.find(s => s.type === data.type) || {}).description || '')}" disabled></div>
                        </div>
                        <div id="dbSqlFields" class="form-grid ${data.type === 'mssql' ? '' : 'hidden'}">
                            <div class="form-section full"><h4>${A.icon('database')} إعدادات SQL Server</h4></div>
                            <div class="field"><label>الخادم</label><input id="mssql_server" value="${h((cfg.mssql || {}).server || 'localhost')}" placeholder="localhost\\SQLEXPRESS"></div>
                            <div class="field"><label>المنفذ</label><input type="number" id="mssql_port" value="${h((cfg.mssql || {}).port || 1433)}"></div>
                            <div class="field"><label>قاعدة البيانات</label><input id="mssql_database" value="${h((cfg.mssql || {}).database || 'tageep')}"></div>
                            <div class="field"><label>المستخدم</label><input id="mssql_user" value="${h((cfg.mssql || {}).user || 'sa')}"></div>
                            <div class="field"><label>كلمة المرور</label><input type="password" id="mssql_password" placeholder="••••••••"></div>
                            <div class="field"><label>تشفير الاتصال</label><label class="switch"><input type="checkbox" id="mssql_encrypt" checked> TLS</label></div>
                            <div class="field"><label>الثقة بالشهادة</label><label class="switch"><input type="checkbox" id="mssql_trust" checked> trustServerCertificate</label></div>
                        </div>
                        <div id="dbMysqlFields" class="form-grid ${data.type === 'mysql' ? '' : 'hidden'}">
                            <div class="form-section full"><h4>${A.icon('database')} إعدادات MySQL</h4></div>
                            <div class="field"><label>الخادم</label><input id="mysql_host" value="${h((cfg.mysql || {}).host || 'localhost')}"></div>
                            <div class="field"><label>المنفذ</label><input type="number" id="mysql_port" value="${h((cfg.mysql || {}).port || 3306)}"></div>
                            <div class="field"><label>قاعدة البيانات</label><input id="mysql_database" value="${h((cfg.mysql || {}).database || 'tageep')}"></div>
                            <div class="field"><label>المستخدم</label><input id="mysql_user" value="${h((cfg.mysql || {}).user || 'root')}"></div>
                            <div class="field"><label>كلمة المرور</label><input type="password" id="mysql_password" placeholder="••••••••"></div>
                        </div>
                        <div class="row mt">
                            <button class="btn" id="dbTest">${A.icon('refresh')} اختبار الاتصال</button>
                            <button class="btn btn-primary" id="dbSwitch">${A.icon('database')} التبديل ونقل البيانات</button>
                            <label class="switch"><input type="checkbox" id="dbKeep"> استخدام بيانات القاعدة الهدف إن وجدت</label>
                        </div>
                        <div id="dbResult" class="mt"></div>
                        <div class="form-section"><h4>${A.icon('file')} النسخ الاحتياطية المتاحة</h4></div>
                        <div>${(data.backups || []).slice(0, 6).map(b => `<div class="stat-line"><span>${h(b.name)} ${b.encrypted ? '<span class="badge success">مشفّرة</span>' : ''}</span><strong>${(b.size / 1024).toFixed(1)} KB</strong></div>`).join('') || '<span class="small muted">لا توجد نسخ</span>'}</div>
                    </div>`;
                const typeSelect = document.getElementById('dbType');
                typeSelect.onchange = () => {
                    document.getElementById('dbSqlFields').classList.toggle('hidden', typeSelect.value !== 'mssql');
                    document.getElementById('dbMysqlFields').classList.toggle('hidden', typeSelect.value !== 'mysql');
                };
                const collect = () => ({
                    type: typeSelect.value,
                    mssql: {
                        server: document.getElementById('mssql_server').value,
                        port: A.num(document.getElementById('mssql_port').value),
                        database: document.getElementById('mssql_database').value,
                        user: document.getElementById('mssql_user').value,
                        password: document.getElementById('mssql_password').value || (cfg.mssql || {}).password,
                        encrypt: document.getElementById('mssql_encrypt').checked,
                        trustServerCertificate: document.getElementById('mssql_trust').checked
                    },
                    mysql: {
                        host: document.getElementById('mysql_host').value,
                        port: A.num(document.getElementById('mysql_port').value),
                        database: document.getElementById('mysql_database').value,
                        user: document.getElementById('mysql_user').value,
                        password: document.getElementById('mysql_password').value || (cfg.mysql || {}).password
                    }
                });
                document.getElementById('dbTest').onclick = async () => {
                    const box = document.getElementById('dbResult');
                    box.innerHTML = `<div class="alert">${A.icon('refresh')}<div>جارٍ اختبار الاتصال...</div></div>`;
                    try {
                        const result = await A.post('/db/test', collect());
                        box.innerHTML = `<div class="alert success">${A.icon('checkCircle')}<div>${h(result.message)}</div></div>`;
                    } catch (err) { box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`; }
                };
                document.getElementById('dbSwitch').onclick = async () => {
                    const body = { ...collect(), keepTargetData: document.getElementById('dbKeep').checked };
                    const yes = await A.confirm({ title: 'تبديل قاعدة البيانات', message: 'سيتم إنشاء نسخة أمان مشفرة ثم نقل البيانات الحالية إلى قاعدة البيانات الجديدة. تأكد من صحة بيانات الاتصال.', danger: true, confirmLabel: 'بدء التبديل' });
                    if (!yes) return;
                    const box = document.getElementById('dbResult');
                    box.innerHTML = `<div class="alert">${A.icon('refresh')}<div>جارٍ التبديل ونقل البيانات...</div></div>`;
                    try {
                        const result = await A.post('/db/switch', body);
                        box.innerHTML = `<div class="alert success">${A.icon('checkCircle')}<div>${h(result.message)}</div></div>`;
                        A.toast('تم تبديل قاعدة البيانات');
                        await A.refresh({ rerender: false });
                    } catch (err) { box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`; }
                };
            };

            const renderBackup = async () => {
                const status = await A.get('/db/status');
                const backups = status.data.backups || [];
                pane.innerHTML = `
                    <div class="grid grid-2">
                        <div class="card card-pad">
                            <h4>${A.icon('lock')} إنشاء نسخة احتياطية مشفّرة</h4>
                            <p class="small muted">تُشفّر النسخة بـ AES-256-GCM مع مفتاح مشتق من كلمة المرور (PBKDF2-SHA256، 210,000 دورة). احفظ كلمة المرور في مكان آمن — لا يمكن استعادة النسخة بدونها.</p>
                            <div class="field"><label>كلمة مرور النسخة</label><input type="password" id="backupPass" placeholder="كلمة مرور قوية"></div>
                            <button class="btn btn-primary" id="backupCreate">${A.icon('download')} إنشاء وتنزيل النسخة</button>
                            <div class="alert warning mt">${A.icon('alert')}<div>تُنشأ نسخة أمان تلقائية مشفرة يوميًا وعند كل عملية استعادة أو تبديل قاعدة بيانات.</div></div>
                        </div>
                        <div class="card card-pad">
                            <h4>${A.icon('upload')} استعادة نسخة احتياطية</h4>
                            <p class="small muted">سيتم إنشاء نسخة أمان للحالة الحالية قبل الاستعادة. يدعم النظام نسخ <code>.hrbak</code> المشفرة وملفات JSON القديمة.</p>
                            <div class="field"><label>ملف النسخة</label><input type="file" id="restoreFile" accept=".hrbak,.json"></div>
                            <div class="field"><label>كلمة مرور النسخة (إن كانت مشفرة)</label><input type="password" id="restorePass"></div>
                            <button class="btn btn-danger" id="restoreBtn">${A.icon('upload')} استعادة البيانات</button>
                        </div>
                    </div>
                    <div class="card mt">
                        <div class="card-head"><h3>النسخ المتاحة على الخادم</h3></div>
                        <div class="card-pad">
                            ${backups.length ? backups.map(b => `<div class="stat-line"><span>${h(b.name)} ${b.encrypted ? '<span class="badge success">مشفّرة</span>' : '<span class="badge warning">غير مشفرة</span>'}</span><span class="flex gap-sm center"><span class="small muted">${(b.size / 1024).toFixed(1)} KB • ${A.dateTime(b.createdAt)}</span><button class="btn btn-sm" data-download="${h(b.name)}">${A.icon('download')}</button></span></div>`).join('') : '<div class="small muted">لا توجد نسخ</div>'}
                        </div>
                    </div>`;
                document.getElementById('backupCreate').onclick = async () => {
                    const passphrase = document.getElementById('backupPass').value;
                    if (passphrase && passphrase.length < 8) return A.toast('كلمة المرور يجب أن تكون 8 أحرف على الأقل', 'error');
                    try {
                        await A.downloadPost('/db/backup/download', { passphrase }, `tageep-backup-${A.today()}.hrbak`);
                        A.toast('تم تنزيل النسخة المشفرة');
                        A.route();
                    } catch (err) { A.toast(err.message, 'error'); }
                };
                document.getElementById('restoreBtn').onclick = async () => {
                    const file = document.getElementById('restoreFile').files[0];
                    if (!file) return A.toast('اختر ملف النسخة', 'warning');
                    if (!(await A.confirm({ title: 'استعادة البيانات', message: 'سيتم استبدال البيانات الحالية بمحتوى النسخة بعد إنشاء نسخة أمان. هل أنت متأكد؟', danger: true, confirmLabel: 'استعادة' }))) return;
                    try {
                        const result = await A.upload('/db/restore', file, { passphrase: document.getElementById('restorePass').value });
                        A.toast(result.message); await A.refresh();
                    } catch (err) { A.toast(err.message, 'error'); }
                };
                pane.querySelectorAll('[data-download]').forEach(btn => btn.addEventListener('click', () => {
                    A.downloadGet(`/db/backups/${encodeURIComponent(btn.dataset.download)}/download`, btn.dataset.download).catch(err => A.toast(err.message, 'error'));
                }));
            };

            const renderFingerprint = () => {
                const s = A.state.data.settings || {};
                const device = s.fingerprintDevice || {};
                pane.innerHTML = `<form id="fpForm" class="form-grid">
                    <div class="form-section full"><h4>${A.icon('fingerprint')} إعداد جهاز البصمة</h4></div>
                    <div class="field"><label>نوع الجهاز</label><select id="fp_type">
                        ${[{ v: 'none', l: 'غير مربوط' }, { v: 'zkteco', l: 'ZKTeco' }, { v: 'hikvision', l: 'Hikvision' }, { v: 'anviz', l: 'Anviz' }, { v: 'middleware', l: 'وسيط ADMS / Push' }].map(o => `<option value="${o.v}" ${device.type === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
                    </select></div>
                    <div class="field"><label>عنوان IP</label><input id="fp_ip" value="${h(device.ip || '')}"></div>
                    <div class="field"><label>المنفذ</label><input type="number" id="fp_port" value="${device.port || 4370}"></div>
                    <div class="field"><label>طريقة المزامنة</label><select id="fp_sync"><option value="manual" ${device.syncMode === 'manual' ? 'selected' : ''}>يدوي</option><option value="push" ${device.syncMode === 'push' ? 'selected' : ''}>Push تلقائي</option></select></div>
                    <div class="field"><label>مفتاح واجهة الاستقبال (API Key)</label><input id="fp_apiKey" value="${h(device.apiKey || '')}" placeholder="اتركه فارغًا لعدم اشتراط مفتاح" autocomplete="off"><div class="help">يُرسل في ترويسة <code dir="ltr">X-Device-Key</code> عند إرسال البصمات.</div></div>
                    <div class="field"><label>كلمة مرور جهاز البصمة (اختياري)</label><input type="password" id="fp_pass" value=""></div>
                    <div class="full"><button type="submit" class="btn btn-primary">${A.icon('check')} حفظ إعداد البصمة</button></div>
                </form>
                <div class="alert mt">${A.icon('router')}<div>واجهات استقبال البصمات: <code dir="ltr">POST /api/fingerprint/punches</code> للوسيط (بدون تكرار)، و<code dir="ltr">POST /api/fingerprint/receive</code> للأجهزة. يُطابق الموظف بـ<b>الرقم الوظيفي</b> الذي يجب أن يساوي رقمه في جهاز البصمة.</div></div>
                <div class="mt" id="fpBridge"><div class="card card-pad"><div class="empty">جارٍ تجهيز رابط الربط…</div></div></div>
                <div class="mt" id="fpDevices"></div>`;
                document.getElementById('fpForm').onsubmit = async e => {
                    e.preventDefault();
                    const fingerprintDevice = {
                        type: document.getElementById('fp_type').value,
                        ip: document.getElementById('fp_ip').value,
                        port: A.num(document.getElementById('fp_port').value),
                        syncMode: document.getElementById('fp_sync').value,
                        apiKey: document.getElementById('fp_apiKey').value.trim()
                    };
                    try { await A.put('/settings', { settings: { fingerprintDevice } }); A.toast('تم حفظ إعداد البصمة'); await A.refresh({ rerender: false }); loadBridgePanel(); }
                    catch (err) { A.toast(err.message, 'error'); }
                };

                const copyText = async (text, label) => {
                    try { await navigator.clipboard.writeText(text); A.toast('تم نسخ ' + label); }
                    catch (_) {
                        const area = document.createElement('textarea');
                        area.value = text; document.body.appendChild(area); area.select();
                        document.execCommand('copy'); area.remove(); A.toast('تم نسخ ' + label);
                    }
                };

                const loadBridgePanel = async () => {
                    const box = document.getElementById('fpBridge');
                    if (!box) return;
                    const settings = (A.state.data.settings || {}).fingerprintDevice || {};
                    const key = settings.apiKey || '';
                    let net = {};
                    try { net = (await A.get('/system/network')).data || {}; } catch (_) { }
                    const url = (net.lanUrls && net.lanUrls[0]) || net.origin || location.origin;
                    const code = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ s: url, k: key }))));
                    box.innerHTML = `<div class="card card-pad">
                        <h4>${A.icon('router')} ربط تطبيق الوسيط (Bridge)</h4>
                        <div class="form-grid">
                            <div class="field"><label>عنوان النظام للوسيط</label><input id="bridgeUrl" dir="ltr" readonly value="${h(url)}"><div class="help">انسخه في خانة «عنوان النظام» داخل تطبيق الوسيط.</div></div>
                            <div class="field"><label>مفتاح الجهاز</label><input id="bridgeKey" dir="ltr" readonly value="${h(key || 'غير مفعّل — اضبط مفتاحًا أعلاه')}"></div>
                            <div class="full"><label>رمز الربط (يملأ الوسيط الحقول تلقائيًا)</label><textarea id="bridgeCode" readonly rows="2" dir="ltr" style="font-family:monospace;font-size:12px">${h(code)}</textarea></div>
                        </div>
                        <div class="btn-row mt">
                            <button type="button" class="btn" id="copyBridgeUrl">${A.icon('copy')} نسخ العنوان</button>
                            <button type="button" class="btn" id="copyBridgeCode">${A.icon('copy')} نسخ رمز الربط</button>
                            <button type="button" class="btn" id="reloadBridge">${A.icon('refresh')} تحديث</button>
                        </div>
                        <div class="alert mt">${A.icon('alert')}<div>شغّل <b>TageepBridge.exe</b> على جهاز الفرع، ثم الصق رمز الربط واضغط «تطبيق الرمز» ← «اختبار الاتصال بالخادم» ← «اختبار الاتصال بالجهاز» ثم «مزامنة الآن».</div></div>
                    </div>`;
                    document.getElementById('copyBridgeUrl').onclick = () => copyText(url, 'العنوان');
                    document.getElementById('copyBridgeCode').onclick = () => copyText(code, 'رمز الربط');
                    document.getElementById('reloadBridge').onclick = () => loadBridgePanel();
                    loadDevices();
                };

                const loadDevices = async () => {
                    const box = document.getElementById('fpDevices');
                    if (!box) return;
                    let rows = [];
                    try { rows = (await A.get('/collections/fingerprintDevices')).data || []; } catch (_) { }
                    const header = `<h4>${A.icon('fingerprint')} أجهزة البصمة المسجلة (${rows.length})</h4>`;
                    if (!rows.length) {
                        box.innerHTML = `<div class="card card-pad">${header}<div class="empty">لم يتصل أي جهاز بعد. بعد أول مزامنة من الوسيط ستظهر بيانات الجهاز وعدد بصماته هنا.</div></div>`;
                        return;
                    }
                    box.innerHTML = `<div class="card card-pad">${header}
                        <div class="table-wrap"><table class="data"><thead><tr><th>الجهاز</th><th>العنوان</th><th>الحالة</th><th>المستخدمون</th><th>السجلات</th><th>آخر اتصال</th></tr></thead><tbody>
                        ${rows.map(d => `<tr><td>${h(d.name || d.sn || '—')}</td><td dir="ltr">${h((d.deviceIp || '') + (d.port ? ':' + d.port : ''))}</td><td><strong style="color:${d.status === 'online' ? 'var(--success,#16a34a)' : 'var(--muted,#888)'}">${d.status === 'online' ? 'متصل' : 'غير متصل'}</strong></td><td>${d.deviceEmployeeCount != null ? d.deviceEmployeeCount : '—'}</td><td>${d.deviceLogCount != null ? d.deviceLogCount : '—'}</td><td dir="ltr">${d.lastSeen ? String(d.lastSeen).slice(0, 16).replace('T', ' ') : '—'}</td></tr>`).join('')}
                        </tbody></table></div></div>`;
                };

                loadBridgePanel();
            };

            const renderNotificationSettings = () => {
                const s = A.state.data.settings || {};
                const n = s.notifications || {};
                pane.innerHTML = `<form id="notifForm" class="form-grid">
                    <div class="form-section full"><h4>${A.icon('bell')} قواعد الإشعارات الذكية</h4></div>
                    <div class="field"><label>تفعيل الإشعارات</label><label class="switch"><input type="checkbox" id="n_enabled" ${n.enabled !== false ? 'checked' : ''}> مفعّل</label></div>
                    <div class="field"><label>حد التأخير للتنبيه (دقيقة)</label><input type="number" id="n_late" value="${n.lateMinutes || 30}"></div>
                    <div class="field"><label>تنبيه البصمة الناقصة</label><label class="switch"><input type="checkbox" id="n_missing" ${n.missingPunch !== false ? 'checked' : ''}> مفعّل</label></div>
                    <div class="field"><label>تنبيه انتهاء العقود (يوم)</label><input type="number" id="n_contract" value="${n.contractExpiryDays || 60}"></div>
                    <div class="field"><label>تنبيه انتهاء المستندات (يوم)</label><input type="number" id="n_doc" value="${n.documentExpiryDays || 60}"></div>
                    <div class="field"><label>حد رصيد الإجازات المنخفض (يوم)</label><input type="number" id="n_low" value="${n.lowLeaveBalanceDays || 3}"></div>
                    <div class="field"><label>حد تعليق طلب الإجازة (يوم)</label><input type="number" id="n_pending" value="${n.pendingLeaveDays || 2}"></div>
                    <div class="field"><label>انقطاع جهاز البصمة (ساعة)</label><input type="number" id="n_device" value="${n.deviceOfflineHours || 24}"></div>
                    <div class="full"><button type="submit" class="btn btn-primary">${A.icon('check')} حفظ إعدادات الإشعارات</button></div>
                </form>`;
                document.getElementById('notifForm').onsubmit = async e => {
                    e.preventDefault();
                    const notifications = {
                        enabled: document.getElementById('n_enabled').checked,
                        lateMinutes: A.num(document.getElementById('n_late').value),
                        missingPunch: document.getElementById('n_missing').checked,
                        contractExpiryDays: A.num(document.getElementById('n_contract').value),
                        documentExpiryDays: A.num(document.getElementById('n_doc').value),
                        lowLeaveBalanceDays: A.num(document.getElementById('n_low').value),
                        pendingLeaveDays: A.num(document.getElementById('n_pending').value),
                        deviceOfflineHours: A.num(document.getElementById('n_device').value)
                    };
                    try { await A.put('/settings', { settings: { notifications } }); A.toast('تم حفظ إعدادات الإشعارات'); await A.refresh({ rerender: false }); }
                    catch (err) { A.toast(err.message, 'error'); }
                };
            };

            const renderNetwork = async () => {
                pane.innerHTML = `<div class="alert mb">${A.icon('router')}<div>يمكن للموظفين الوصول للنظام من الفروع البعيدة عبر عنوان IP ثابت أو دومين (DDNS) مع تحويل المنفذ إلى هذا الخادم. يُفضّل تشغيل HTTPS عبر وكيل عكسي (Nginx / IIS) لحماية كلمات المرور.</div></div>
                    <div class="card card-pad" id="netCard"><div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div></div>`;
                try {
                    const res = await A.get('/system/network');
                    const net = res.data || {};
                    document.getElementById('netCard').innerHTML = `
                        <h4>${A.icon('router')} منافذ وعناوين الوصول</h4>
                        <div class="stat-line"><span>اسم الجهاز</span><strong>${h(net.hostname || '')}</strong></div>
                        <div class="stat-line"><span>المنفذ</span><strong>${h(net.port || '')}</strong></div>
                        <div class="stat-line"><span>الوصول الحالي</span><strong dir="ltr">${h(net.origin || '')}</strong></div>
                        <div class="stat-line"><span>HTTPS</span><strong>${net.https ? 'مفعّل' : 'غير مفعّل'}</strong></div>
                        <div class="stat-line"><span>خلف وكيل عكسي</span><strong>${net.trustProxy ? 'نعم (' + h(net.trustProxy) + ')' : 'لا'}</strong></div>
                        <div class="section-title mt">عناوين الشبكة المحلية</div>
                        ${(net.addresses || []).length ? (net.addresses || []).map(a => `<div class="stat-line"><span>${h(a.iface)} — ${h(a.address)}</span><strong dir="ltr">http://${h(a.address)}:${h(net.port)}</strong></div>`).join('') : '<div class="small muted">لا توجد عناوين شبكة</div>'}
                        <div class="alert mt">${A.icon('shield')}<div>الوصول من خارج الشبكة: افتح المنفذ ${h(net.port || '')} في جدار الحماية، ووجّه Doman/DDNS إلى IP الخادم. للحماية الكاملة استخدم HTTPS ووكيل عكسي، واضبط TRUST_PROXY=1 في متغيرات البيئة.</div></div>`;
                } catch (err) {
                    document.getElementById('netCard').innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
                }
            };

            const renderLicense = async () => {
                let status = {};
                try { status = await A.get('/license/status'); } catch (_) { }
                const dev = status.mode === 'developer';
                pane.innerHTML = `<div class="grid grid-2">
                    <div class="card card-pad">
                        <h4>${A.icon('shield')} حالة الترخيص</h4>
                        <div class="stat-line"><span>الحالة</span><strong>${status.licensed ? 'مفعّل' : 'غير مفعّل'}</strong></div>
                        <div class="stat-line"><span>نوع الترخيص</span><strong>${h(status.typeLabel || '—')}</strong></div>
                        <div class="stat-line"><span>العميل</span><strong>${h(status.customer || '—')}</strong></div>
                        <div class="stat-line"><span>تاريخ الإصدار</span><strong>${status.issuedAt ? A.date(status.issuedAt) : '—'}</strong></div>
                        <div class="stat-line"><span>الانتهاء</span><strong>${status.expiresAt ? A.date(status.expiresAt) : (status.type === 'permanent' ? 'دائم' : '—')}</strong></div>
                        ${status.daysLeft !== null && status.daysLeft !== undefined ? `<div class="stat-line"><span>الأيام المتبقية</span><strong>${A.numFmt(status.daysLeft)}</strong></div>` : ''}
                        <div class="stat-line"><span>الرقم التسلسلي للجهاز</span><strong dir="ltr">${h(status.machineId || '—')}</strong></div>
                        <button class="btn btn-sm mt" id="licCopy">${A.icon('copy')} نسخ الرقم التسلسلي</button>
                        ${status.message ? `<div class="alert mt">${A.icon('alert')}<div>${h(status.message)}</div></div>` : ''}
                    </div>
                    <div class="card card-pad">
                        <h4>${A.icon('key')} تفعيل / تجديد الترخيص</h4>
                        <p class="small muted">ألصق مفتاح الترخيص الذي يرسله المطوّر. التجريبي والمحدود ينتهيان تلقائيًا في تاريخهما، والدائم لا ينتهي.</p>
                        <div class="field"><label>مفتاح الترخيص</label><textarea id="licKey" rows="5" style="font-size:11px;direction:ltr;text-align:left"></textarea></div>
                        <button class="btn btn-primary" id="licActivate">${A.icon('check')} تفعيل الترخيص</button>
                        <div id="licResult" class="mt"></div>
                        ${dev ? `<div class="alert mt">${A.icon('checkCircle')}<div>وضع المطور مفعّل — لا يلزم ترخيص عند تشغيل الخادم بالأمر <code>node server.js --dev</code>.</div></div>` : ''}
                    </div>
                </div>`;
                document.getElementById('licCopy').onclick = async () => {
                    try { await navigator.clipboard.writeText(status.machineId || ''); A.toast('تم نسخ الرقم التسلسلي'); } catch (_) { A.toast('تعذر النسخ التلقائي', 'warning'); }
                };
                document.getElementById('licActivate').onclick = async () => {
                    const box = document.getElementById('licResult');
                    const key = document.getElementById('licKey').value.trim();
                    if (!key) return A.toast('ألصق مفتاح الترخيص أولًا', 'warning');
                    try {
                        const result = await A.post('/license/activate', { key });
                        box.innerHTML = `<div class="alert success">${A.icon('checkCircle')}<div>${h(result.message)}</div></div>`;
                        A.toast('تم تفعيل الترخيص');
                        setTimeout(renderLicense, 900);
                    } catch (err) {
                        box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
                    }
                };
            };

            bindTabs(view, 'general', id => {
                if (id === 'general') renderGeneral();
                else if (id === 'security') renderSecurity();
                else if (id === 'database') renderDatabase();
                else if (id === 'backup') renderBackup();
                else if (id === 'fingerprint') renderFingerprint();
                else if (id === 'network') renderNetwork();
                else if (id === 'license') renderLicense();
                else renderNotificationSettings();
            });
            renderGeneral();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // الخدمة الذاتية
    // ═══════════════════════════════════════════════════════════
    A.registerModule('self', {
        render: async view => {
            const user = A.state.user || {};
            const employee = user.employeeId ? A.employeeById(user.employeeId) : null;
            if (!employee) {
                view.innerHTML = `<div class="alert warning">${A.icon('alert')}<div>لم يتم ربط حسابك بملف موظف. تواصل مع مدير الموارد البشرية لربط الحساب من شاشة المستخدمين.</div></div>`;
                return;
            }
            const [data, overviewRes, punchRes] = await Promise.all([
                A.get(`/employees/${employee.id}/profile`),
                A.get('/self/overview').catch(() => ({ data: {} })),
                A.get('/self/attendance/context').catch(() => ({ data: {} }))
            ]);
            const overview = overviewRes.data || {};
            const punchCtx = punchRes.data || {};
            const geo = punchCtx.geo || {};
            const todayRow = punchCtx.today || {};
            const myPunches = punchCtx.punches || [];
            const punchLabel = punchCtx.nextPunch === 'out' ? 'بصمة انصراف' : 'بصمة حضور';
            const bio = punchCtx.biometric || {};
            const bioRequired = bio.required !== false;
            const bioEnrolled = !!bio.enrolled;
            const canPunchNow = !!punchCtx.canPunch && (bioEnrolled || !bioRequired);
            const punchHint = !punchCtx.canPunch
                ? (punchCtx.reason || 'البصمة من الجوال غير متاحة لحسابك')
                : (bioRequired && !bioEnrolled ? 'فعّل بصمة جوالك أولاً — لن تُقبل بصمتك من أي جوال آخر' : 'بصمة الجوال بديل عند تعطل جهاز البصمة — تُقبل داخل نطاق الفرع وببصمة إصبعك أو وجهك');
            const todayText = todayRow.checkIn
                ? `${todayRow.checkIn}${todayRow.checkOut ? ' ← ' + todayRow.checkOut : ''}`
                : 'لم تُسجّل بعد';
            const lastPunch = myPunches[myPunches.length - 1];
            const myTasks = overview.tasks || (A.state.data.tasks || []).filter(t => t.employeeId === employee.id);
            const myRequests = overview.requests || [];
            const myAdvances = overview.advances || [];
            const att = data.attendance || {};
            const balances = data.balances || overview.balances || [];
            view.innerHTML = `
                <div class="card">
                    <div class="profile-hero">
                        <div class="profile-avatar">${h(A.initials(employee.name))}</div>
                        <div style="flex:1">
                            <h2>${h(employee.name)}</h2>
                            <div class="profile-meta">
                                <span>${A.icon('briefcase')} ${h(employee.jobTitle || '')}</span>
                                <span>${A.icon('building')} ${h(A.deptName(employee.departmentId))}</span>
                                <span>${A.icon('user')} ${h(employee.employeeNumber || '')}</span>
                            </div>
                        </div>
                        <div class="row" style="gap:8px">
                            <button class="btn btn-primary" id="selfLeave">${A.icon('palmtree')} طلب إجازة</button>
                            <button class="btn" id="selfAdvance">${A.icon('credit')} طلب سلفة</button>
                            <button class="btn" id="selfComplaint">${A.icon('alert')} شكوى أو طلب</button>
                        </div>
                    </div>
                </div>
                <div class="card mt">
                    <div class="punch-mini ${canPunchNow ? '' : 'has-note'}">
                        <button class="btn btn-primary punch-btn" id="selfPunch" ${canPunchNow ? '' : 'disabled'}>${A.icon('fingerprint')} ${punchLabel}</button>
                        ${bioRequired || bioEnrolled ? `<button class="btn btn-sm punch-btn" id="selfBio">${A.icon('shield')} ${bioEnrolled ? 'إعادة تسجيل بصمة جوالك' : 'تفعيل بصمة جوالك'}</button>` : ''}
                        <div class="punch-meta">
                            <span>اليوم: <strong>${h(todayText)}</strong></span>
                            ${geo.enabled ? `<span>النطاق: <strong>${A.numFmt(geo.radius)}م</strong></span>` : ''}
                            ${lastPunch ? `<span>آخر بصمة: <strong>${h(lastPunch.time)}</strong></span>` : ''}
                        </div>
                        <div class="punch-note ${punchCtx.canPunch ? '' : 'warn'}">${h(punchHint)}</div>
                    </div>
                </div>
                <div class="grid grid-4 mt">
                    ${kpi('الراتب الأساسي', A.money(employee.baseSalary, false), 'wallet')}
                    ${kpi('رصيد الإجازة', A.numFmt(balances.reduce((s, b) => s + A.num(b.balance), 0), 1) + ' يوم', 'palmtree', 'info')}
                    ${kpi('مهامي المفتوحة', A.numFmt(myTasks.filter(t => !['completed', 'cancelled'].includes(t.status)).length), 'check', 'warn')}
                    ${kpi('طلباتي المعلّقة', A.numFmt(myRequests.filter(r => r.status === 'pending').length), 'list', 'warn')}
                </div>
                <div class="grid grid-auto mt" style="gap:10px">
                    <div class="stat-line"><span>حضور الشهر</span><strong>${A.numFmt(att.presentDays)} يوم</strong></div>
                    <div class="stat-line"><span>تأخير الشهر</span><strong>${A.numFmt(att.lateMinutes)} دقيقة</strong></div>
                    <div class="stat-line"><span>إجمالي سلفي النشطة</span><strong>${A.money(myAdvances.reduce((s, a) => s + A.num(a.remainingAmount), 0))}</strong></div>
                </div>
                <div class="card mt">
                    <div class="card-head"><h3>مهامي</h3><span class="spacer"></span><span class="small muted">${myTasks.length} مهمة</span></div>
                    ${A.table({
                        columns: [
                            { key: 'title', label: 'المهمة', render: t => `<div><strong>${h(t.title)}</strong><div class="small muted">${h(t.category || '')}${t.description ? ' • ' + h(String(t.description).slice(0, 50)) : ''}</div></div>` },
                            { key: 'dueDate', label: 'الاستحقاق', render: t => `${A.date(t.dueDate)} ${h(t.dueTime || '')}` },
                            { key: 'progress', label: 'الإنجاز', render: t => `<div class="task-progress"><div class="tp-track"><div class="tp-fill" style="width:${Math.max(0, Math.min(100, A.num(t.progress)))}%;background:var(--brand)"></div></div><span>${A.numFmt(t.progress)}%</span></div>` },
                            { key: 'status', label: 'الحالة', render: t => A.badge(({ new: 'info', in_progress: 'warning', on_hold: 'purple', completed: 'success', cancelled: 'danger' })[t.status] || '', ({ new: 'جديدة', in_progress: 'قيد التنفيذ', on_hold: 'معلّقة', completed: 'مكتملة', cancelled: 'ملغاة' })[t.status] || t.status) }
                        ],
                        rows: myTasks,
                        actions: t => [{ title: 'تحديث الإنجاز', icon: 'checkCircle', action: 'selfTask' }],
                        empty: 'لا توجد مهام مسندة إليك'
                    })}
                </div>
                <div class="card mt">
                    <div class="card-head"><h3>طلباتي وشكاواي</h3><span class="spacer"></span><span class="small muted">${myRequests.length} طلب</span></div>
                    ${A.table({
                        columns: [
                            { key: 'createdAt', label: 'التاريخ', render: r => A.dateTime(r.createdAt) },
                            { key: 'type', label: 'النوع', render: r => h(({ advance: 'سلفة', complaint: 'شكوى', other: 'طلب عام', leave: 'إجازة' })[r.type] || r.type) },
                            { key: 'subject', label: 'الموضوع' },
                            { key: 'amount', label: 'المبلغ', align: 'left', render: r => r.amount ? A.money(r.amount) : '—' },
                            { key: 'status', label: 'الحالة', render: r => A.badge(({ pending: 'warning', approved: 'success', rejected: 'danger' })[r.status] || '', ({ pending: 'معلّق', approved: 'معتمد', rejected: 'مرفوض' })[r.status] || r.status) },
                            { key: 'reviewNote', label: 'ملاحظة المراجعة', render: r => h(r.reviewNote || '—') }
                        ],
                        rows: myRequests, empty: 'لا توجد طلبات مقدّمة'
                    })}
                </div>
                <div class="grid grid-2 mt">
                    <div class="card"><div class="card-head"><h3>كشوف رواتبي</h3></div>
                        ${A.table({
                            columns: [
                                { key: 'month', label: 'الفترة', render: r => `${A.monthName(r.month)} ${r.year}` },
                                { key: 'netSalary', label: 'الصافي', align: 'left', render: r => A.money(r.netSalary) },
                                { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                            ], rows: data.payslips,
                            actions: r => [{ title: 'عرض', icon: 'eye', html: `<button class="btn btn-icon btn-sm" onclick="App.viewPayslip('${h(r.id)}')">${A.icon('eye')}</button>` }],
                            empty: 'لا توجد كشوف'
                        })}
                    </div>
                    <div class="card"><div class="card-head"><h3>إجازاتي</h3></div>
                        ${A.table({
                            columns: [
                                { key: 'leaveTypeId', label: 'النوع', render: r => h(A.leaveTypeName(r.leaveTypeId)) },
                                { key: 'fromDate', label: 'من', render: r => A.date(r.fromDate) },
                                { key: 'toDate', label: 'إلى', render: r => A.date(r.toDate) },
                                { key: 'days', label: 'الأيام', align: 'left' },
                                { key: 'status', label: 'الحالة', render: r => A.badge(r.status) }
                            ], rows: data.leaves, empty: 'لا توجد إجازات'
                        })}
                    </div>
                </div>
                <div class="card mt"><div class="card-head"><h3>أرصدة إجازاتي</h3></div><div class="card-pad">
                    ${balances.length ? balances.map(b => `<div class="stat-line"><span>${h(A.leaveTypeName(b.leaveTypeId))} (${b.year})</span><strong>${A.numFmt(b.balance, 1)} يوم</strong></div>`).join('') : empty('لا توجد أرصدة')}
                </div></div>`;
            document.getElementById('selfLeave').onclick = () => A.formModal({
                title: 'طلب إجازة',
                fields: [
                    { key: 'leaveTypeId', label: 'نوع الإجازة', type: 'select', options: A.options.leaves(), required: true },
                    { key: 'fromDate', label: 'من', type: 'date', default: A.today(), required: true },
                    { key: 'toDate', label: 'إلى', type: 'date', default: A.today(), required: true },
                    { key: 'reason', label: 'السبب', type: 'textarea', full: true }
                ],
                onSubmit: async values => {
                    const result = await A.post('/leaves/requests', { ...values, employeeId: employee.id });
                    A.closeModal(); A.toast(result.message); A.route();
                }
            });
            document.getElementById('selfAdvance').onclick = () => A.selfRequestModal('advance', employee, () => A.route());
            document.getElementById('selfComplaint').onclick = () => A.selfRequestModal('complaint', employee, () => A.route());
            // ── بصمة جهاز الموظف (WebAuthn): لا تُقبل بصمة الحضور إلا من جواله هو ──
            const b64ToBytes = value => {
                const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
                const raw = atob(text + '='.repeat((4 - text.length % 4) % 4));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                return bytes;
            };
            const bytesToB64 = buffer => {
                const bytes = new Uint8Array(buffer);
                let text = '';
                for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
                return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            };
            const biometricSupported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
            const registerBiometric = async retried => {
                if (!biometricSupported()) throw new Error('هذا المتصفح لا يدعم بصمة الجوال — افتح النظام عبر HTTPS من جوالك');
                const res = await A.post('/self/biometric/register/options', {});
                const pk = ((res || {}).data || {}).publicKey || {};
                let credential;
                try {
                    credential = await navigator.credentials.create({ publicKey: {
                        challenge: b64ToBytes(pk.challenge),
                        rp: pk.rp,
                        user: { id: b64ToBytes(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
                        pubKeyCredParams: pk.pubKeyCredParams,
                        authenticatorSelection: pk.authenticatorSelection,
                        attestation: 'none',
                        timeout: pk.timeout || 120000,
                        excludeCredentials: (pk.excludeCredentials || []).map(c => ({ ...c, id: b64ToBytes(c.id) }))
                    } });
                } catch (err) {
                    // بصمة قديمة على الجوال: تُلغى من الخادم ثم يُعاد التسجيل
                    if (!retried && err && err.name === 'InvalidStateError') {
                        try { await A.post('/self/biometric/reset'); } catch (_) {}
                        return registerBiometric(true);
                    }
                    throw new Error(err && err.name === 'NotAllowedError'
                        ? 'لم يتم تأكيد بصمة جوالك — أعد المحاولة واسمح بالبصمة'
                        : err && err.name === 'NotSupportedError'
                            ? 'جوالك لا يدعم بصمة الإصبع أو الوجه — فعّل قفل الشاشة أولاً أو استخدم جهاز البصمة'
                            : (err && err.message) || 'تعذر قراءة بصمة جوالك');
                }
                if (!credential) throw new Error('لم تُسجَّل بصمة الجوال');
                try {
                    return await A.post('/self/biometric/register', {
                        id: credential.id,
                        rawId: bytesToB64(credential.rawId),
                        clientDataJSON: bytesToB64(credential.response.clientDataJSON),
                        attestationObject: bytesToB64(credential.response.attestationObject),
                        transports: (credential.response.getTransports && credential.response.getTransports()) || ['internal'],
                        deviceLabel: String(navigator.userAgent || '').slice(0, 150)
                    });
                } catch (err) {
                    throw new Error(err.message || 'تعذر حفظ بصمة الجوال');
                }
            };
            const readBiometric = async () => {
                if (!biometricSupported()) throw new Error('هذا المتصفح لا يدعم بصمة الجوال — افتح النظام عبر HTTPS من جوالك');
                const res = await A.post('/self/biometric/assert/options', {});
                const pk = ((res || {}).data || {}).publicKey || {};
                let assertion;
                try {
                    assertion = await navigator.credentials.get({ publicKey: {
                        challenge: b64ToBytes(pk.challenge),
                        rpId: pk.rpId,
                        timeout: pk.timeout || 120000,
                        userVerification: 'required',
                        allowCredentials: (pk.allowCredentials || []).map(c => ({ ...c, id: b64ToBytes(c.id) }))
                    } });
                } catch (err) {
                    throw new Error(err && err.name === 'NotAllowedError'
                        ? 'لم يتم تأكيد بصمة جوالك — أعد المحاولة'
                        : (err && err.message) || 'تعذر قراءة بصمة جوالك');
                }
                if (!assertion) throw new Error('لم يتم تأكيد بصمة جوالك');
                return {
                    id: assertion.id,
                    rawId: bytesToB64(assertion.rawId),
                    clientDataJSON: bytesToB64(assertion.response.clientDataJSON),
                    authenticatorData: bytesToB64(assertion.response.authenticatorData),
                    signature: bytesToB64(assertion.response.signature),
                    userHandle: assertion.response.userHandle ? bytesToB64(assertion.response.userHandle) : ''
                };
            };
            const positionOnce = () => new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
            });
            const explainGeoError = err => {
                if (err && err.code === 1) return A.toast('اسمح بالوصول إلى الموقع من إعدادات المتصفح ثم أعد المحاولة', 'error');
                if (err && err.code === 2) return A.toast('تعذر تحديد موقعك — تأكد من تشغيل GPS وحاول مجددًا', 'error');
                if (err && err.code === 3) return A.toast('انتهت مهلة تحديد الموقع — حاول في مكان مفتوح', 'error');
                return A.toast((err && err.message) || 'تعذر تحديد موقعك', 'error');
            };
            const enrollBtn = document.getElementById('selfBio');
            if (enrollBtn) enrollBtn.onclick = async () => {
                enrollBtn.disabled = true;
                A.toast('اتبع مطالبة الجوال لتسجيل بصمة إصبعك أو وجهك...');
                try {
                    const result = await registerBiometric();
                    A.toast((result && result.message) || 'تم تفعيل بصمة جوالك');
                    A.route();
                } catch (err) {
                    enrollBtn.disabled = false;
                    A.toast(err.message || 'تعذر تفعيل بصمة الجوال', 'error');
                }
            };
            const punchBtn = document.getElementById('selfPunch');
            if (punchBtn) punchBtn.onclick = async () => {
                if (!navigator.geolocation) return A.toast('جهازك لا يدعم تحديد الموقع', 'error');
                punchBtn.disabled = true;
                try {
                    A.toast('جارٍ تحديد موقعك...');
                    const position = await positionOnce();
                    A.toast('أكّد بصمة جوالك لإتمام البصمة...');
                    const biometric = bioRequired ? await readBiometric() : null;
                    const result = await A.post('/self/attendance/punch', {
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                        accuracy: position.coords.accuracy,
                        biometric
                    });
                    A.toast(result.message);
                    A.route();
                } catch (err) {
                    punchBtn.disabled = false;
                    if (err && typeof err.code === 'number') explainGeoError(err);
                    else A.toast((err && err.message) || 'تعذر تسجيل البصمة', 'error');
                }
            };
            A.bindActions({
                selfTask: id => {
                    const task = myTasks.find(t => t.id === id);
                    if (!task || !A.taskProgressModal) return A.toast('تعذر فتح المهمة', 'error');
                    A.taskProgressModal(task, () => A.route());
                }
            });
        }
    });
})();
