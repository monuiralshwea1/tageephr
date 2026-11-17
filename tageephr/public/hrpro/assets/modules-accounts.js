'use strict';

/* ═══════════════════════════════════════════════════════════════
   وحدة إدارة الحسابات: شجرة الحسابات، السندات والقيود، القيود
   الافتتاحية، كشف الحساب، والتقارير المالية (مدينة/دائنة/ميزان…)
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const h = A.h;

    A.registerRoutes([
        {
            path: 'accounts', module: 'accounts', label: 'إدارة الحسابات',
            subtitle: 'شجرة الحسابات والسندات والقيود وكشوف الحسابات والتقارير المالية',
            icon: 'money', group: 'المالية والمحاسبة', permission: 'accounts'
        }
    ]);

    const TYPE_LABELS = { asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' };
    const VOUCHER = {
        receipt: { label: 'سند قبض', icon: 'download' },
        payment: { label: 'سند صرف', icon: 'upload' },
        journal: { label: 'قيد يومية', icon: 'list' },
        opening: { label: 'قيد افتتاحي', icon: 'file' }
    };
    const STATUS = { draft: ['مسودة', ''], posted: ['مُرحّل', 'success'], cancelled: ['ملغي', 'danger'] };
    const PARTY = { '': 'بدون', customer: 'عميل', supplier: 'مورد', employee: 'موظف', other: 'أخرى' };

    const cache = { tree: [], summary: null, vouchers: [], reports: [] };
    let activeTab = 'overview';
    let container = null;
    let filters = {
        voucherType: '', voucherStatus: '', from: '', to: '', search: '',
        statementAccount: '', statementFrom: A.monthStart(), statementTo: A.today(),
        reportId: 'trial_balance', reportFrom: A.monthStart(), reportTo: A.today(), reportAccount: '', reportVoucherType: ''
    };
    let statementResult = null;
    let reportResult = null;

    const money = value => A.money(value, false);
    const codeCell = value => `<span style="font-family:ui-monospace,Consolas,monospace;direction:ltr;display:inline-block">${h(value)}</span>`;
    const badge = status => {
        const entry = STATUS[status] || STATUS.draft;
        return `<span class="badge ${entry[1]}">${h(entry[0])}</span>`;
    };
    const accountOptions = (includeGroups = true) => cache.tree
        .filter(a => includeGroups || !a.isGroup)
        .map(a => `<option value="${h(a.id)}">${h((a.code ? a.code + ' — ' : '') + a.name)}</option>`).join('');

    function treeRows(list) {
        const byParent = {};
        list.forEach(a => {
            const key = a.parentId || '';
            (byParent[key] = byParent[key] || []).push(a);
        });
        Object.keys(byParent).forEach(key => byParent[key].sort((x, y) => String(x.code).localeCompare(String(y.code), 'en', { numeric: true })));
        const out = [];
        const walk = parent => (byParent[parent] || []).forEach(node => { out.push(node); walk(node.id); });
        walk('');
        // أي حساب يتيم (أب محذوف) يظهر في النهاية
        list.forEach(a => { if (!out.includes(a)) out.push(a); });
        return out;
    }

    async function loadAll() {
        const [tree, summary, vouchers, reports] = await Promise.all([
            A.get('/accounts/tree'),
            A.get('/accounts/summary'),
            A.get('/vouchers?limit=1000'),
            A.get('/accounting/reports/catalog')
        ]);
        cache.tree = tree.data || [];
        cache.summary = summary.data || {};
        cache.vouchers = vouchers.data || [];
        cache.reports = reports.data || [];
    }

    // ═══════════════════ الإطار والتبويبات ═══════════════════
    const TABS = [
        { id: 'overview', label: 'نظرة عامة' },
        { id: 'chart', label: 'شجرة الحسابات' },
        { id: 'vouchers', label: 'السندات والقيود' },
        { id: 'opening', label: 'القيود الافتتاحية' },
        { id: 'statement', label: 'كشف حساب' },
        { id: 'reports', label: 'التقارير المالية' }
    ];

    function renderTabBar() {
        return `<div class="tabs" id="accTabs">${TABS.map(t => `<button class="tab ${t.id === activeTab ? 'active' : ''}" data-acc-tab="${t.id}">${h(t.label)}</button>`).join('')}</div>`;
    }

    function render() {
        if (!container) return;
        container.innerHTML = `${renderTabBar()}<div class="tab-pane" id="accBody" style="padding:18px 4px"></div>`;
        container.querySelectorAll('[data-acc-tab]').forEach(btn => btn.addEventListener('click', () => {
            activeTab = btn.dataset.accTab;
            render();
        }));
        renderBody();
    }

    function renderBody() {
        const body = document.getElementById('accBody');
        if (!body) return;
        if (activeTab === 'overview') return renderOverview(body);
        if (activeTab === 'chart') return renderChart(body);
        if (activeTab === 'vouchers') return renderVouchers(body, '');
        if (activeTab === 'opening') return renderOpening(body);
        if (activeTab === 'statement') return renderStatement(body);
        if (activeTab === 'reports') return renderReports(body);
    }

    // ═══════════════════ نظرة عامة ═══════════════════
    function renderOverview(body) {
        const s = cache.summary || {};
        const kpi = (label, value, icon, tone = '') => `
            <div class="kpi ${tone}"><div class="kpi-top"><span>${h(label)}</span>${A.icon(icon)}</div>
            <div class="kpi-value">${money(value)}</div></div>`;
        const recent = cache.vouchers.slice(0, 8);
        body.innerHTML = `
            <div class="grid grid-4 mb">${kpi('إجمالي الأصول', s.assets, 'building')}${kpi('الالتزامات', s.liabilities, 'credit', 'warn')}
                ${kpi('حقوق الملكية', s.equity, 'shield', 'info')}${kpi('صافي الربح', s.profit, 'chart', s.profit < 0 ? 'danger' : 'purple')}</div>
            <div class="grid grid-4 mb">${kpi('الإيرادات', s.revenue, 'download')}${kpi('المصروفات', s.expense, 'upload')}
                ${kpi('النقدية (صندوق/بنك)', s.cash, 'wallet')}
                <div class="kpi"><div class="kpi-top"><span>السندات والقيود</span>${A.icon('file')}</div><div class="kpi-value">${A.numFmt(s.vouchers)}</div></div></div>
            <div class="grid grid-2">
                <div class="card">
                    <div class="card-head"><h3>أحدث السندات والقيود</h3><span class="spacer"></span>
                        <button class="btn btn-sm" id="accGoVouchers">${A.icon('list')} عرض الكل</button></div>
                    <div class="card-pad" style="padding:0">
                        ${A.table({
                            columns: [
                                { key: 'number', label: 'الرقم' },
                                { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                                { key: 'type', label: 'النوع', render: r => h((VOUCHER[r.type] || {}).label || r.type) },
                                { key: 'amount', label: 'المبلغ', align: 'left', render: r => money(r.debit) },
                                { key: 'status', label: 'الحالة', render: r => badge(r.status) }
                            ],
                            rows: recent, empty: 'لم تُسجّل أي سندات بعد'
                        })}
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><h3>الحسابات الرئيسية</h3></div>
                    <div class="card-pad">
                        <div class="info-list">
                            <div class="info-row"><span>حسابات الشجرة</span><strong>${A.numFmt(s.accounts)}</strong></div>
                            <div class="info-row"><span>حسابات رئيسية/تجميعية</span><strong>${A.numFmt(s.groups)}</strong></div>
                            <div class="info-row"><span>سندات مُرحّلة</span><strong>${A.numFmt(s.posted)}</strong></div>
                            <div class="info-row"><span>مسودات</span><strong>${A.numFmt(s.draft)}</strong></div>
                            <div class="info-row"><span>قيود افتتاحية</span><strong>${A.numFmt(s.opening)}</strong></div>
                        </div>
                        <div class="row mt" style="gap:8px">
                            <button class="btn btn-sm btn-primary" id="accNewReceipt">${A.icon('plus')} سند قبض</button>
                            <button class="btn btn-sm" id="accNewPayment">${A.icon('plus')} سند صرف</button>
                            <button class="btn btn-sm" id="accNewJournal">${A.icon('plus')} قيد يومية</button>
                        </div>
                    </div>
                </div>
            </div>`;
        const go = id => document.getElementById(id);
        go('accGoVouchers').onclick = () => { activeTab = 'vouchers'; render(); };
        go('accNewReceipt').onclick = () => voucherModal('receipt');
        go('accNewPayment').onclick = () => voucherModal('payment');
        go('accNewJournal').onclick = () => voucherModal('journal');
    }

    // ═══════════════════ شجرة الحسابات ═══════════════════
    function renderChart(body) {
        const rows = treeRows(cache.tree);
        const canAdd = A.can('accounts', 'add');
        const canEdit = A.can('accounts', 'edit');
        const canDelete = A.can('accounts', 'delete');
        body.innerHTML = `
            <div class="toolbar mb" style="border:0">
                <span class="small muted">${A.numFmt(cache.tree.length)} حساب — الأكواد تُولَّد تلقائيًا ويمكن تعديلها</span>
                <span class="grow"></span>
                ${canAdd ? `<button class="btn btn-sm btn-primary" id="accAddRoot">${A.icon('plus')} حساب رئيسي</button>` : ''}
                <button class="btn btn-sm" id="accRefresh">${A.icon('refresh')} تحديث</button>
            </div>
            <div class="table-wrap">
                <table class="data">
                    <thead><tr><th style="width:90px">الكود</th><th>اسم الحساب</th><th>النوع</th><th>طبيعة الرصيد</th>
                        <th class="num">مدين</th><th class="num">دائن</th><th class="num">الرصيد</th><th class="no-print"></th></tr></thead>
                    <tbody>
                        ${rows.map(a => `
                            <tr data-acc-id="${h(a.id)}" class="${a.isGroup ? 'acc-group-row' : ''}">
                                <td>${codeCell(a.code)}</td>
                                <td style="padding-inline-start:${8 + (a.level - 1) * 20}px;font-weight:${a.isGroup ? 700 : 400}">
                                    ${a.isGroup ? A.icon('file') : ''} ${h(a.name)}
                                    ${a.description ? `<div class="small muted">${h(a.description)}</div>` : ''}
                                </td>
                                <td>${h(TYPE_LABELS[a.type] || a.type)}</td>
                                <td>${a.nature === 'debit' ? 'مدين' : 'دائن'}</td>
                                <td class="num">${money(a.debit)}</td>
                                <td class="num">${money(a.credit)}</td>
                                <td class="num" style="font-weight:700;color:${a.naturalBalance < 0 ? 'var(--danger)' : 'var(--text)'}">${money(a.naturalBalance)}</td>
                                <td class="no-print"><div class="actions-cell">
                                    ${canAdd ? `<button class="btn btn-icon btn-sm" title="إضافة حساب فرعي" data-acc-add="${h(a.id)}">${A.icon('plus')}</button>` : ''}
                                    ${canEdit ? `<button class="btn btn-icon btn-sm" title="تعديل" data-acc-edit="${h(a.id)}">${A.icon('edit')}</button>` : ''}
                                    ${canDelete ? `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-acc-del="${h(a.id)}">${A.icon('trash')}</button>` : ''}
                                </div></td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
        const rootBtn = document.getElementById('accAddRoot');
        if (rootBtn) rootBtn.onclick = () => accountModal(null, '');
        document.getElementById('accRefresh').onclick = () => refreshAll();
        body.querySelectorAll('[data-acc-add]').forEach(b => b.onclick = () => accountModal(null, b.dataset.accAdd));
        body.querySelectorAll('[data-acc-edit]').forEach(b => b.onclick = () => accountModal(cache.tree.find(a => a.id === b.dataset.accEdit), ''));
        body.querySelectorAll('[data-acc-del]').forEach(b => b.onclick = async () => {
            const account = cache.tree.find(a => a.id === b.dataset.accDel);
            if (!account) return;
            if (!(await A.confirm({ title: 'حذف الحساب', message: `هل تريد حذف «${h(account.name)}»؟`, danger: true, confirmLabel: 'حذف' }))) return;
            try {
                await A.del('/accounts/' + account.id);
                A.toast('تم حذف الحساب');
                await refreshAll(false);
            } catch (err) { A.toast(err.message, 'error'); }
        });
    }

    async function accountModal(account, parentId) {
        const isEdit = !!account;
        const parent = parentId ? cache.tree.find(a => a.id === parentId) : null;
        const groups = treeRows(cache.tree).filter(a => a.isGroup);
        let nextCode = isEdit ? String(account.code) : '';
        if (!isEdit) {
            try { nextCode = (await A.get('/accounts/next-code?parentId=' + encodeURIComponent(parentId || ''))).data.code; }
            catch (_) { nextCode = ''; }
        }
        const fields = [
            { type: 'section', label: 'بيانات الحساب', icon: 'file' },
            {
                key: 'parentId', label: 'الحساب الأب', type: 'select', placeholder: '— حساب رئيسي —',
                options: groups.map(a => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                default: parentId || (isEdit ? account.parentId : '')
            },
            { key: 'code', label: 'كود الحساب (تلقائي/يدوي)', default: nextCode, required: true, help: 'يمكنك تعديل الكود المقترح قبل الحفظ' },
            { key: 'name', label: 'اسم الحساب', required: true, default: isEdit ? account.name : '' },
            { key: 'nameEn', label: 'الاسم بالإنجليزية', default: isEdit ? account.nameEn : '' },
            {
                key: 'type', label: 'نوع الحساب', type: 'select',
                options: Object.keys(TYPE_LABELS).map(k => ({ value: k, label: TYPE_LABELS[k] })),
                default: isEdit ? account.type : ((parent && parent.type) || 'asset'), disabled: !!parent
            },
            { key: 'isGroup', label: 'حساب رئيسي (تجميعي — لا تُسجَّل عليه حركة)', type: 'checkbox', default: isEdit ? !!account.isGroup : false },
            {
                key: 'nature', label: 'طبيعة الرصيد', type: 'select',
                options: [{ value: 'debit', label: 'مدين' }, { value: 'credit', label: 'دائن' }],
                default: isEdit ? account.nature : (((parent && parent.nature) === 'credit') ? 'credit' : 'debit')
            },
            {
                key: 'partyType', label: 'نوع الطرف المرتبط', type: 'select',
                options: Object.keys(PARTY).map(k => ({ value: k, label: PARTY[k] })),
                default: isEdit ? (account.partyType || '') : ((parent && parent.partyType) || '')
            },
            { key: 'description', label: 'وصف', type: 'textarea', rows: 2, full: true, default: isEdit ? account.description : '' }
        ];
        A.formModal({
            title: isEdit ? 'تعديل حساب' : (parent ? `إضافة حساب فرعي تحت «${parent.name}»` : 'إضافة حساب رئيسي'),
            fields, size: 'md', submitLabel: 'حفظ الحساب',
            onOpen: (root, close, form) => {
                const parentSelect = form.querySelector('[name="parentId"]');
                const codeInput = form.querySelector('[name="code"]');
                const typeSelect = form.querySelector('[name="type"]');
                if (!parentSelect || !codeInput) return;
                parentSelect.onchange = async () => {
                    const selected = parentSelect.value;
                    const parentRow = cache.tree.find(a => a.id === selected);
                    if (typeSelect) {
                        typeSelect.value = (parentRow && parentRow.type) || typeSelect.value;
                        typeSelect.disabled = !!parentRow;
                    }
                    try {
                        const res = await A.get('/accounts/next-code?parentId=' + encodeURIComponent(selected));
                        codeInput.value = res.data.code;
                    } catch (_) { /* الكود اليدوي يبقى */ }
                };
            },
            onSubmit: async data => {
                const payload = {
                    parentId: data.parentId || '', code: data.code, name: data.name, nameEn: data.nameEn,
                    type: data.type, isGroup: data.isGroup, nature: data.nature,
                    partyType: data.partyType || '', description: data.description
                };
                if (isEdit) await A.put('/accounts/' + account.id, payload);
                else await A.post('/accounts', payload);
                A.closeModal();
                A.toast(isEdit ? 'تم تحديث الحساب' : 'تمت إضافة الحساب');
                await refreshAll(false);
            }
        });
    }

    // ═══════════════════ السندات ═══════════════════
    function voucherFilterBar(scope) {
        return `<div class="card card-pad mb">
            <div class="row" style="align-items:flex-end">
                <div class="field" style="margin:0"><label>النوع</label>
                    <select id="vFilterType"><option value="">كل الأنواع</option>
                    ${Object.keys(VOUCHER).map(k => `<option value="${k}" ${filters.voucherType === k ? 'selected' : ''}>${h(VOUCHER[k].label)}</option>`).join('')}</select></div>
                <div class="field" style="margin:0"><label>الحالة</label>
                    <select id="vFilterStatus"><option value="">كل الحالات</option>
                    ${Object.keys(STATUS).map(k => `<option value="${k}" ${filters.voucherStatus === k ? 'selected' : ''}>${h(STATUS[k][0])}</option>`).join('')}</select></div>
                <div class="field" style="margin:0"><label>من</label><input type="date" id="vFilterFrom" value="${h(filters.from)}"></div>
                <div class="field" style="margin:0"><label>إلى</label><input type="date" id="vFilterTo" value="${h(filters.to)}"></div>
                <div class="field" style="margin:0;min-width:180px"><label>بحث</label><input id="vFilterSearch" value="${h(filters.search)}" placeholder="رقم السند أو البيان"></div>
                <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn" id="vFilterApply">${A.icon('search')} بحث</button></div>
                <span class="grow"></span>
                ${A.can('accounts', 'add') ? `<button class="btn btn-primary" id="vNew${scope}">${A.icon('plus')} سند جديد</button>` : ''}
            </div>
        </div>`;
    }

    function bindVoucherFilters(body, onChange) {
        const read = () => {
            filters.voucherType = document.getElementById('vFilterType').value;
            filters.voucherStatus = document.getElementById('vFilterStatus').value;
            filters.from = document.getElementById('vFilterFrom').value;
            filters.to = document.getElementById('vFilterTo').value;
            filters.search = document.getElementById('vFilterSearch').value.trim();
        };
        document.getElementById('vFilterApply').onclick = () => { read(); onChange(); };
        document.getElementById('vFilterSearch').onkeydown = e => { if (e.key === 'Enter') { read(); onChange(); } };
    }

    function filteredVouchers(type) {
        return cache.vouchers.filter(v => {
            if (type && v.type !== type) return false;
            if (filters.voucherType && v.type !== filters.voucherType) return false;
            if (filters.voucherStatus && (v.status || 'draft') !== filters.voucherStatus) return false;
            const day = String(v.date || '').slice(0, 10);
            if (filters.from && day < filters.from) return false;
            if (filters.to && day > filters.to) return false;
            if (filters.search) {
                const haystack = `${v.number || ''} ${v.description || ''} ${v.party || ''} ${v.reference || ''}`.toLowerCase();
                if (!haystack.includes(filters.search.toLowerCase())) return false;
            }
            return true;
        });
    }

    function renderVouchers(body, forcedType) {
        const rows = filteredVouchers(forcedType);
        body.innerHTML = `${voucherFilterBar(forcedType)}
            <div class="card"><div class="toolbar"><span class="small muted">${A.numFmt(rows.length)} سند</span></div>
            <div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'number', label: 'الرقم' },
                    { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                    { key: 'type', label: 'النوع', render: r => h((VOUCHER[r.type] || {}).label || r.type) },
                    { key: 'description', label: 'البيان' },
                    { key: 'party', label: 'الطرف' },
                    { key: 'debit', label: 'المبلغ', align: 'left', render: r => money(r.debit) },
                    { key: 'status', label: 'الحالة', render: r => badge(r.status || 'draft') }
                ],
                rows,
                empty: 'لا توجد سندات مطابقة',
                actions: row => {
                    const acts = [];
                    acts.push({ html: `<button class="btn btn-icon btn-sm" title="طباعة/عرض" data-v-print="${h(row.id)}">${A.icon('print')}</button>` });
                    if ((row.status || 'draft') !== 'cancelled' && A.can('accounts', 'edit')) {
                        acts.push({ html: `<button class="btn btn-icon btn-sm" title="تعديل" data-v-edit="${h(row.id)}">${A.icon('edit')}</button>` });
                    }
                    if ((row.status || 'draft') === 'draft' && A.can('accounts', 'edit')) {
                        acts.push({ html: `<button class="btn btn-icon btn-sm" title="ترحيل" data-v-post="${h(row.id)}">${A.icon('check')}</button>` });
                    }
                    if ((row.status || 'draft') === 'posted' && A.can('accounts', 'edit')) {
                        acts.push({ html: `<button class="btn btn-icon btn-sm" title="إلغاء" data-v-cancel="${h(row.id)}">${A.icon('x')}</button>` });
                    }
                    if ((row.status || 'draft') !== 'posted' && A.can('accounts', 'delete')) {
                        acts.push({ html: `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-v-del="${h(row.id)}">${A.icon('trash')}</button>` });
                    }
                    return acts;
                }
            })}
            </div></div>`;

        bindVoucherFilters(body, () => renderVouchers(body, forcedType));
        const newBtn = document.getElementById('vNew' + forcedType);
        if (newBtn) newBtn.onclick = () => voucherModal(filters.voucherType || forcedType || 'journal');

        body.querySelectorAll('[data-v-print]').forEach(b => b.onclick = () => printVoucher(b.dataset.vPrint));
        body.querySelectorAll('[data-v-edit]').forEach(b => b.onclick = () => {
            const voucher = cache.vouchers.find(v => v.id === b.dataset.vEdit);
            if (voucher) voucherModal(voucher.type, voucher);
        });
        body.querySelectorAll('[data-v-post]').forEach(b => b.onclick = async () => {
            try {
                await A.post(`/vouchers/${b.dataset.vPost}/post`);
                A.toast('تم ترحيل السند');
                await refreshAll(false);
            } catch (err) { A.toast(err.message, 'error'); }
        });
        body.querySelectorAll('[data-v-cancel]').forEach(b => b.onclick = async () => {
            if (!(await A.confirm({ title: 'إلغاء السند', message: 'سيتم إلغاء السند وإخراجه من الأرصدة. متابعة؟', danger: true, confirmLabel: 'إلغاء السند' }))) return;
            try {
                await A.post(`/vouchers/${b.dataset.vCancel}/cancel`);
                A.toast('تم إلغاء السند');
                await refreshAll(false);
            } catch (err) { A.toast(err.message, 'error'); }
        });
        body.querySelectorAll('[data-v-del]').forEach(b => b.onclick = async () => {
            if (!(await A.confirm({ title: 'حذف السند', message: 'حذف نهائي للسند؟', danger: true, confirmLabel: 'حذف' }))) return;
            try {
                await A.del('/vouchers/' + b.dataset.vDel);
                A.toast('تم حذف السند');
                await refreshAll(false);
            } catch (err) { A.toast(err.message, 'error'); }
        });
    }

    // ═══════════════════ القيود الافتتاحية ═══════════════════
    function renderOpening(body) {
        const rows = cache.vouchers.filter(v => v.type === 'opening');
        const postedTotal = rows.filter(v => v.status === 'posted').reduce((sum, v) => sum + A.num(v.debit), 0);
        body.innerHTML = `
            <div class="alert info mb">${A.icon('alert')}<div>
                القيود الافتتاحية تُسجَّل عادةً في أول يوم من السنة المالية، وتُرحَّل مثل أي قيد يومية.
                يجب أن يتساوى المدين مع الدائن قبل الترحيل، ولا يمكن التسجيل على الحسابات الرئيسية.
            </div></div>
            <div class="grid grid-3 mb">
                <div class="kpi"><div class="kpi-top"><span>قيود افتتاحية</span>${A.icon('file')}</div><div class="kpi-value">${A.numFmt(rows.length)}</div></div>
                <div class="kpi info"><div class="kpi-top"><span>المُرحّل منها</span>${A.icon('checkCircle')}</div><div class="kpi-value">${A.numFmt(rows.filter(v => v.status === 'posted').length)}</div></div>
                <div class="kpi purple"><div class="kpi-top"><span>إجمالي المُرحّل</span>${A.icon('money')}</div><div class="kpi-value">${money(postedTotal)}</div></div>
            </div>
            <div class="toolbar mb" style="border:0"><span class="grow"></span>
                ${A.can('accounts', 'add') ? `<button class="btn btn-primary" id="openNewOpening">${A.icon('plus')} قيد افتتاحي جديد</button>` : ''}
            </div>
            <div class="card"><div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'number', label: 'الرقم' },
                    { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                    { key: 'description', label: 'البيان' },
                    { key: 'debit', label: 'المدين', align: 'left', render: r => money(r.debit) },
                    { key: 'credit', label: 'الدائن', align: 'left', render: r => money(r.credit) },
                    { key: 'status', label: 'الحالة', render: r => badge(r.status || 'draft') }
                ],
                rows, empty: 'لا توجد قيود افتتاحية',
                actions: row => [
                    { html: `<button class="btn btn-icon btn-sm" title="طباعة" data-v-print="${h(row.id)}">${A.icon('print')}</button>` },
                    { html: `<button class="btn btn-icon btn-sm" title="تعديل" data-v-edit="${h(row.id)}">${A.icon('edit')}</button>` },
                    (row.status || 'draft') === 'draft' ? { html: `<button class="btn btn-icon btn-sm" title="ترحيل" data-v-post="${h(row.id)}">${A.icon('check')}</button>` } : null,
                    (row.status || 'draft') !== 'posted' ? { html: `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-v-del="${h(row.id)}">${A.icon('trash')}</button>` } : null
                ].filter(Boolean)
            })}
            </div></div>`;
        const btn = document.getElementById('openNewOpening');
        if (btn) btn.onclick = () => voucherModal('opening');
        body.querySelectorAll('[data-v-print]').forEach(b => b.onclick = () => printVoucher(b.dataset.vPrint));
        body.querySelectorAll('[data-v-edit]').forEach(b => b.onclick = () => {
            const voucher = cache.vouchers.find(v => v.id === b.dataset.vEdit);
            if (voucher) voucherModal(voucher.type, voucher);
        });
        body.querySelectorAll('[data-v-post]').forEach(b => b.onclick = async () => {
            try { await A.post(`/vouchers/${b.dataset.vPost}/post`); A.toast('تم ترحيل القيد'); await refreshAll(false); }
            catch (err) { A.toast(err.message, 'error'); }
        });
        body.querySelectorAll('[data-v-del]').forEach(b => b.onclick = async () => {
            if (!(await A.confirm({ title: 'حذف القيد', message: 'حذف نهائي للقيد؟', danger: true, confirmLabel: 'حذف' }))) return;
            try { await A.del('/vouchers/' + b.dataset.vDel); A.toast('تم الحذف'); await refreshAll(false); }
            catch (err) { A.toast(err.message, 'error'); }
        });
    }

    // ═══════════════════ محرر السند ═══════════════════
    async function voucherModal(type, existing) {
        const isEdit = !!existing;
        const leaves = cache.tree.filter(a => !a.isGroup);
        if (!leaves.length) return A.toast('أضف حسابًا فرعيًا أولًا من شجرة الحسابات', 'warning');
        const vtype = existing ? existing.type : type;
        let number = existing ? existing.number : '';
        if (!isEdit) {
            try { number = (await A.get(`/vouchers/next-number?type=${vtype}&date=${A.today()}`)).data.number; } catch (_) { number = ''; }
        }
        const lines = existing && existing.lines && existing.lines.length
            ? existing.lines.map(l => ({ ...l }))
            : [{ accountId: '', description: '', party: '', dueDate: '', debit: '', credit: '' }, { accountId: '', description: '', party: '', dueDate: '', debit: '', credit: '' }];
        const branchOptions = (A.state.data.branches || []).map(b => `<option value="${h(b.id)}" ${existing && existing.branchId === b.id ? 'selected' : ''}>${h(b.name)}</option>`).join('');

        const modal = A.rawModal({
            title: `${isEdit ? 'تعديل' : 'إنشاء'} ${VOUCHER[vtype].label}`,
            size: 'xl',
            body: `
                <div class="form-grid">
                    <div class="field"><label>رقم السند</label><input id="vNumber" value="${h(number)}" required></div>
                    <div class="field"><label>التاريخ</label><input type="date" id="vDate" value="${h(existing ? String(existing.date).slice(0, 10) : A.today())}" required></div>
                    <div class="field"><label>الفرع</label><select id="vBranch"><option value="">— بدون —</option>${branchOptions}</select></div>
                    <div class="field"><label>المرجع / المستند</label><input id="vReference" value="${h(existing ? existing.reference : '')}"></div>
                    <div class="field"><label>الطرف</label><input id="vParty" value="${h(existing ? existing.party : '')}" placeholder="اسم العميل أو المورد"></div>
                    <div class="field"><label>نوع الطرف</label><select id="vPartyType">${Object.keys(PARTY).map(k => `<option value="${k}" ${existing && (existing.partyType || '') === k ? 'selected' : ''}>${PARTY[k]}</option>`).join('')}</select></div>
                    <div class="field full"><label>البيان</label><input id="vDescription" value="${h(existing ? existing.description : '')}" placeholder="وصف السند"></div>
                </div>
                <div class="toolbar" style="border:0;padding:8px 0"><strong>بنود السند</strong><span class="grow"></span>
                    <button type="button" class="btn btn-sm" id="vAddLine">${A.icon('plus')} إضافة بند</button></div>
                <div class="table-wrap"><table class="data" id="vLinesTable">
                    <thead><tr><th style="min-width:200px">الحساب</th><th>البيان</th><th style="min-width:120px">الطرف</th>
                        <th style="min-width:120px">الاستحقاق</th><th class="num" style="width:120px">مدين</th><th class="num" style="width:120px">دائن</th><th></th></tr></thead>
                    <tbody id="vLinesBody"></tbody>
                </table></div>
                <div class="row" style="justify-content:flex-end;gap:20px;margin-top:12px;font-size:13.5px">
                    <div>إجمالي المدين: <strong id="vTotalDebit">0.00</strong></div>
                    <div>إجمالي الدائن: <strong id="vTotalCredit">0.00</strong></div>
                    <div>الفرق: <strong id="vDiff">0.00</strong></div>
                </div>`,
            footer: `<button class="btn btn-primary" id="vSavePost">${A.icon('check')} حفظ وترحيل</button>
                     <button class="btn" id="vSaveDraft">${A.icon('file')} حفظ كمسودة</button>
                     <button class="btn" data-close>إغلاق</button>`
        });

        const body = modal.querySelector('.modal-body');
        const tbody = body.querySelector('#vLinesBody');
        const accountSelectHtml = selected => `<option value="">— اختر الحساب —</option>${leaves.map(a => `<option value="${h(a.id)}" ${a.id === selected ? 'selected' : ''}>${h(a.code + ' — ' + a.name)}</option>`).join('')}`;

        const drawLines = () => {
            tbody.innerHTML = lines.map((line, index) => `
                <tr>
                    <td><select data-line="accountId" data-index="${index}">${accountSelectHtml(line.accountId)}</select></td>
                    <td><input data-line="description" data-index="${index}" value="${h(line.description || '')}"></td>
                    <td><input data-line="party" data-index="${index}" value="${h(line.party || '')}"></td>
                    <td><input type="date" data-line="dueDate" data-index="${index}" value="${h(line.dueDate || '')}"></td>
                    <td><input type="number" step="0.01" min="0" class="num" data-line="debit" data-index="${index}" value="${h(line.debit === 0 ? '' : line.debit ?? '')}"></td>
                    <td><input type="number" step="0.01" min="0" class="num" data-line="credit" data-index="${index}" value="${h(line.credit === 0 ? '' : line.credit ?? '')}"></td>
                    <td><button type="button" class="btn btn-icon btn-sm btn-danger" data-line-del="${index}">${A.icon('trash')}</button></td>
                </tr>`).join('');
            tbody.querySelectorAll('[data-line]').forEach(el => {
                el.addEventListener('input', () => {
                    const index = Number(el.dataset.index);
                    const field = el.dataset.line;
                    lines[index][field] = el.value;
                    if (field === 'debit' && el.value) {
                        lines[index].credit = '';
                        const creditInput = tbody.querySelector(`[data-line="credit"][data-index="${index}"]`);
                        if (creditInput) creditInput.value = '';
                    }
                    if (field === 'credit' && el.value) {
                        lines[index].debit = '';
                        const debitInput = tbody.querySelector(`[data-line="debit"][data-index="${index}"]`);
                        if (debitInput) debitInput.value = '';
                    }
                    updateTotals();
                });
                el.addEventListener('change', () => { lines[Number(el.dataset.index)][el.dataset.line] = el.value; });
            });
            tbody.querySelectorAll('[data-line-del]').forEach(btn => btn.onclick = () => {
                if (lines.length <= 1) return A.toast('لا يمكن حذف كل البنود', 'warning');
                lines.splice(Number(btn.dataset.lineDel), 1);
                drawLines();
            });
            updateTotals();
        };

        const totals = () => {
            const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0);
            const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0);
            return { debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 };
        };
        const updateTotals = () => {
            const t = totals();
            body.querySelector('#vTotalDebit').textContent = A.numFmt(t.debit, 2);
            body.querySelector('#vTotalCredit').textContent = A.numFmt(t.credit, 2);
            const diff = Math.round((t.debit - t.credit) * 100) / 100;
            const diffEl = body.querySelector('#vDiff');
            diffEl.textContent = A.numFmt(diff, 2);
            diffEl.style.color = Math.abs(diff) > 0.009 ? 'var(--danger)' : 'var(--success)';
        };

        drawLines();
        body.querySelector('#vAddLine').onclick = () => {
            lines.push({ accountId: '', description: '', party: '', dueDate: '', debit: '', credit: '' });
            drawLines();
        };

        const save = async post => {
            const t = totals();
            if (post && Math.abs(t.debit - t.credit) > 0.009) return A.toast('لا يمكن الترحيل قبل توازن المدين والدائن', 'warning');
            const payload = {
                type: vtype,
                number: body.querySelector('#vNumber').value.trim(),
                date: body.querySelector('#vDate').value,
                branchId: body.querySelector('#vBranch').value,
                reference: body.querySelector('#vReference').value.trim(),
                party: body.querySelector('#vParty').value.trim(),
                partyType: body.querySelector('#vPartyType').value,
                description: body.querySelector('#vDescription').value.trim(),
                post: !!post,
                lines: lines.filter(l => l.accountId || parseFloat(l.debit) || parseFloat(l.credit)).map(l => ({
                    accountId: l.accountId, description: l.description || '',
                    party: l.party || '', partyType: body.querySelector('#vPartyType').value,
                    dueDate: l.dueDate || '',
                    debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0
                }))
            };
            const buttons = [body.parentElement.querySelector('#vSavePost'), body.parentElement.querySelector('#vSaveDraft')];
            buttons.forEach(b => b && (b.disabled = true));
            try {
                if (isEdit) await A.put('/vouchers/' + existing.id, payload);
                else await A.post('/vouchers', payload);
                modal.close();
                A.toast(post ? 'تم حفظ السند وترحيله' : 'تم حفظ السند كمسودة');
                await refreshAll(false);
            } catch (err) {
                A.toast(err.message, 'error');
            } finally {
                buttons.forEach(b => b && (b.disabled = false));
            }
        };
        body.parentElement.querySelector('#vSavePost').onclick = () => save(true);
        body.parentElement.querySelector('#vSaveDraft').onclick = () => save(false);
    }

    async function printVoucher(id) {
        try {
            const res = await A.get('/vouchers/' + id);
            const v = res.data;
            const typeLabel = (VOUCHER[v.type] || {}).label || v.type;
            const rows = (v.lines || []).map(l => {
                const account = cache.tree.find(a => a.id === l.accountId) || {};
                return `<tr><td>${h(account.code || '')} — ${h(account.name || '')}</td><td>${h(l.description || '')}</td>
                    <td class="num">${A.money(l.debit, false)}</td><td class="num">${A.money(l.credit, false)}</td></tr>`;
            }).join('');
            A.print({
                title: `${typeLabel} — ${v.number}`,
                subtitle: `${A.date(v.date)}${v.party ? ' — ' + v.party : ''}`,
                html: `<div style="margin-bottom:8px">${h(v.description || '')}${v.reference ? ' — مرجع: ' + h(v.reference) : ''}</div>
                    <table class="data"><thead><tr><th>الحساب</th><th>البيان</th><th>مدين</th><th>دائن</th></tr></thead>
                    <tbody>${rows}</tbody><tfoot><tr><td colspan="2">الإجمالي</td><td class="num">${A.money(v.debit, false)}</td><td class="num">${A.money(v.credit, false)}</td></tr></tfoot></table>
                    <div class="print-sign"><div>المحاسب: ................</div><div>المدير المالي: ................</div><div>المستلم: ................</div></div>`
            });
        } catch (err) { A.toast(err.message, 'error'); }
    }

    // ═══════════════════ كشف الحساب ═══════════════════
    function renderStatement(body) {
        body.innerHTML = `
            <div class="card card-pad mb">
                <div class="row" style="align-items:flex-end">
                    <div class="field" style="margin:0;min-width:280px"><label>الحساب</label>
                        <select id="stAccount"><option value="">— اختر الحساب —</option>${accountOptions(true)}</select></div>
                    <div class="field" style="margin:0"><label>من</label><input type="date" id="stFrom" value="${h(filters.statementFrom)}"></div>
                    <div class="field" style="margin:0"><label>إلى</label><input type="date" id="stTo" value="${h(filters.statementTo)}"></div>
                    <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-primary" id="stRun">${A.icon('play')} عرض الكشف</button></div>
                    <span class="grow"></span>
                    <button class="btn btn-sm" id="stPrint">${A.icon('print')} طباعة</button>
                    <button class="btn btn-sm" id="stExcel">${A.icon('download')} Excel</button>
                </div>
            </div>
            <div id="stResult">${A.table({ columns: [], rows: [], empty: 'اختر حسابًا ثم اضغط «عرض الكشف»' })}</div>`;
        const accountSelect = document.getElementById('stAccount');
        if (filters.statementAccount) accountSelect.value = filters.statementAccount;
        const run = async () => {
            filters.statementAccount = accountSelect.value;
            filters.statementFrom = document.getElementById('stFrom').value;
            filters.statementTo = document.getElementById('stTo').value;
            if (!filters.statementAccount) return A.toast('اختر الحساب أولًا', 'warning');
            const box = document.getElementById('stResult');
            box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                const res = await A.get(`/accounts/statement?accountId=${encodeURIComponent(filters.statementAccount)}&from=${filters.statementFrom}&to=${filters.statementTo}`);
                statementResult = res.data;
                renderStatementResult(box, res.data);
            } catch (err) {
                box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            }
        };
        document.getElementById('stRun').onclick = run;
        document.getElementById('stPrint').onclick = () => {
            if (!statementResult) return A.toast('اعرض الكشف أولًا', 'warning');
            A.print({ title: `كشف حساب — ${statementResult.account.name}`, subtitle: `${A.date(statementResult.from)} → ${A.date(statementResult.to)}`,
                html: statementTableHtml(statementResult) });
        };
        document.getElementById('stExcel').onclick = async () => {
            if (!statementResult) return A.toast('اعرض الكشف أولًا', 'warning');
            const rows = [{ 'التاريخ': 'رصيد افتتاحي', 'المستند': '', 'البيان': '', 'مدين': '', 'دائن': '', 'الرصيد': statementResult.opening },
                ...statementResult.rows.map(r => ({ 'التاريخ': r.date, 'المستند': r.number, 'البيان': r.description, 'مدين': r.debit, 'دائن': r.credit, 'الرصيد': r.balance }))];
            exportRows('statement-' + statementResult.account.code, rows);
        };
        if (filters.statementAccount) run();
    }

    function statementTableHtml(data) {
        return `<table class="data"><thead><tr><th>التاريخ</th><th>المستند</th><th>البيان</th><th>الطرف</th>
                <th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>
                <tr><td>—</td><td></td><td>رصيد افتتاحي</td><td></td><td></td><td></td><td class="num">${A.money(data.opening, false)}</td></tr>
                ${data.rows.map(r => `<tr><td>${A.date(r.date)}</td><td>${h(r.number)}</td><td>${h(r.description)}</td><td>${h(r.party || '')}</td>
                    <td class="num">${r.debit ? A.money(r.debit, false) : ''}</td><td class="num">${r.credit ? A.money(r.credit, false) : ''}</td>
                    <td class="num">${A.money(r.balance, false)}</td></tr>`).join('')}
                </tbody><tfoot><tr><td colspan="4">الإجمالي / الرصيد الختامي</td>
                <td class="num">${A.money(data.totalDebit, false)}</td><td class="num">${A.money(data.totalCredit, false)}</td>
                <td class="num">${A.money(data.closing, false)}</td></tr></tfoot></table>`;
    }

    function renderStatementResult(box, data) {
        box.innerHTML = `
            <div class="card mb"><div class="card-head"><h3>${h(data.account.code)} — ${h(data.account.name)}</h3>
                <span class="spacer"></span><span class="small muted">${A.date(data.from)} → ${A.date(data.to)}</span></div>
                <div class="grid grid-3 card-pad" style="border-bottom:1px solid var(--line)">
                    <div><div class="small muted">رصيد افتتاحي</div><strong>${money(data.opening)}</strong></div>
                    <div><div class="small muted">إجمالي الحركة</div><strong>${money(data.totalDebit)} / ${money(data.totalCredit)}</strong></div>
                    <div><div class="small muted">الرصيد الختامي</div><strong>${money(data.closing)}</strong></div>
                </div>
                <div class="card-pad" style="padding:0">${A.table({
                    columns: [
                        { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                        { key: 'number', label: 'المستند' },
                        { key: 'type', label: 'النوع', render: r => h(r.typeLabel) },
                        { key: 'description', label: 'البيان' },
                        { key: 'party', label: 'الطرف' },
                        { key: 'debit', label: 'مدين', align: 'left', render: r => r.debit ? money(r.debit) : '' },
                        { key: 'credit', label: 'دائن', align: 'left', render: r => r.credit ? money(r.credit) : '' },
                        { key: 'balance', label: 'الرصيد', align: 'left', render: r => money(r.balance) }
                    ],
                    rows: data.rows, empty: 'لا توجد حركة على هذا الحساب خلال الفترة'
                })}</div>
            </div>`;
    }

    // ═══════════════════ التقارير المالية ═══════════════════
    function renderReports(body) {
        body.innerHTML = `
            <div class="card card-pad mb">
                <div class="row" style="align-items:flex-end">
                    <div class="field" style="margin:0;min-width:260px"><label>التقرير</label>
                        <select id="rpSelect">${cache.reports.map(r => `<option value="${r.id}" ${filters.reportId === r.id ? 'selected' : ''}>${h(r.name)}</option>`).join('')}</select></div>
                    <div class="field" style="margin:0"><label>من</label><input type="date" id="rpFrom" value="${h(filters.reportFrom)}"></div>
                    <div class="field" style="margin:0"><label>إلى</label><input type="date" id="rpTo" value="${h(filters.reportTo)}"></div>
                    <div class="field" style="margin:0;min-width:220px" id="rpAccountWrap"><label>الحساب</label>
                        <select id="rpAccount"><option value="">كل الحسابات</option>${accountOptions(true)}</select></div>
                    <div class="field" style="margin:0" id="rpVoucherWrap"><label>نوع السند</label>
                        <select id="rpVoucherType"><option value="">الكل</option>${Object.keys(VOUCHER).map(k => `<option value="${k}">${h(VOUCHER[k].label)}</option>`).join('')}</select></div>
                    <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-primary" id="rpRun">${A.icon('play')} تشغيل</button></div>
                </div>
                <div class="small muted mt" id="rpDesc"></div>
            </div>
            <div class="card">
                <div class="toolbar"><strong id="rpTitle">—</strong><span class="grow"></span>
                    <button class="btn btn-sm" id="rpPrint">${A.icon('print')} طباعة</button>
                    <button class="btn btn-sm" id="rpExcel">${A.icon('download')} Excel</button>
                    <button class="btn btn-sm" id="rpCsv">${A.icon('download')} CSV</button>
                </div>
                <div id="rpResult">${A.table({ columns: [], rows: [], empty: 'اختر تقريرًا ثم اضغط «تشغيل»' })}</div>
            </div>`;
        const desc = document.getElementById('rpDesc');
        const syncDesc = () => {
            const report = cache.reports.find(r => r.id === document.getElementById('rpSelect').value);
            desc.textContent = report ? report.description : '';
            const showAccount = document.getElementById('rpSelect').value === 'general_ledger';
            const showVoucher = document.getElementById('rpSelect').value === 'journal_register';
            document.getElementById('rpAccountWrap').style.display = showAccount ? '' : 'none';
            document.getElementById('rpVoucherWrap').style.display = showVoucher ? '' : 'none';
        };
        document.getElementById('rpSelect').onchange = syncDesc;
        document.getElementById('rpAccount').value = filters.reportAccount || '';
        document.getElementById('rpVoucherType').value = filters.reportVoucherType || '';
        syncDesc();

        const run = async () => {
            filters.reportId = document.getElementById('rpSelect').value;
            filters.reportFrom = document.getElementById('rpFrom').value;
            filters.reportTo = document.getElementById('rpTo').value;
            filters.reportAccount = document.getElementById('rpAccount').value;
            filters.reportVoucherType = document.getElementById('rpVoucherType').value;
            const box = document.getElementById('rpResult');
            box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                const res = await A.post('/accounting/reports/run', {
                    reportId: filters.reportId,
                    filters: {
                        from: filters.reportFrom, to: filters.reportTo,
                        accountId: filters.reportAccount, voucherType: filters.reportVoucherType
                    }
                });
                reportResult = res.data;
                renderReportResult(box, res.data);
            } catch (err) {
                box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            }
        };
        document.getElementById('rpRun').onclick = run;

        document.getElementById('rpPrint').onclick = () => {
            if (!reportResult) return A.toast('شغّل التقرير أولًا', 'warning');
            A.print({
                title: reportResult.title, subtitle: reportResult.from || reportResult.to ? `${A.date(reportResult.from)} → ${A.date(reportResult.to)}` : '',
                landscape: reportResult.columns.length > 6,
                html: reportTableHtml(reportResult)
            });
        };
        const exportFile = async format => {
            if (!reportResult) return A.toast('شغّل التقرير أولًا', 'warning');
            try {
                await A.downloadPost('/accounting/reports/export', {
                    reportId: filters.reportId,
                    format,
                    filters: { from: filters.reportFrom, to: filters.reportTo, accountId: filters.reportAccount, voucherType: filters.reportVoucherType }
                }, `${filters.reportId}.${format === 'csv' ? 'csv' : 'xlsx'}`);
            } catch (err) { A.toast(err.message, 'error'); }
        };
        document.getElementById('rpExcel').onclick = () => exportFile('xlsx');
        document.getElementById('rpCsv').onclick = () => exportFile('csv');
        run();
    }

    function cellValue(column, row) {
        const value = row[column.key];
        if (column.type === 'money') return money(value);
        if (column.type === 'number') return A.numFmt(value);
        if (column.type === 'date') return A.date(value);
        return h(value === null || value === undefined ? '' : value);
    }

    function renderReportResult(box, data) {
        const columns = data.columns.map(c => ({
            key: c.key, label: c.label, align: (c.type === 'money' || c.type === 'number') ? 'left' : '',
            render: row => cellValue(c, row)
        }));
        const totals = data.totals || {};
        const footer = Object.keys(totals).length
            ? data.columns.map((c, index) => ({ content: index === 0 ? 'الإجمالي' : (totals[c.key] !== undefined ? cellValue(c, { [c.key]: totals[c.key] }) : ''), align: (c.type === 'money' || c.type === 'number') ? 'left' : '' }))
            : null;
        box.innerHTML = `<div class="card-pad" style="padding:0">${A.table({ columns, rows: data.rows, footer, empty: 'لا توجد بيانات للفترة المحددة' })}</div>`;
        document.getElementById('rpTitle').textContent = data.title;
    }

    function reportTableHtml(data) {
        return `<table class="data"><thead><tr>${data.columns.map(c => `<th>${h(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${data.rows.map(row => `<tr>${data.columns.map(c => `<td class="${c.type === 'money' || c.type === 'number' ? 'num' : ''}">${cellValue(c, row)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }

    function exportRows(name, rows) {
        const keys = Object.keys(rows[0] || {});
        const header = '<tr>' + keys.map(k => `<th>${h(k)}</th>`).join('') + '</tr>';
        const bodyRows = rows.map(row => '<tr>' + keys.map(k => `<td>${h(row[k] === null || row[k] === undefined ? '' : row[k])}</td>`).join('') + '</tr>').join('');
        const html = `<html dir="rtl"><head><meta charset="utf-8"></head><body><table border="1">${header}${bodyRows}</table></body></html>`;
        const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name + '.xls';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    // ═══════════════════ التحديث العام ═══════════════════
    async function refreshAll() {
        try {
            await loadAll();
            render();
            A.renderNav();
        } catch (err) {
            A.toast(err.message, 'error');
        }
    }

    A.registerModule('accounts', {
        render: async view => {
            container = view;
            activeTab = 'overview';
            view.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                await loadAll();
                render();
            } catch (err) {
                view.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            }
        }
    });
})();
