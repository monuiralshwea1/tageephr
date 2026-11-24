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
            subtitle: 'شجرة الحسابات والسندات والقيود والعملات وأسعار الصرف والإقفال السنوي والتقارير المالية',
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

    const cache = { tree: [], summary: null, vouchers: [], reports: [], mapping: null, mappingRows: [], currencies: [], baseCurrency: null, parties: [] };
    let activeTab = 'overview';
    let container = null;
    let displayCurrency = '';
    let filters = {
        voucherType: '', voucherStatus: '', from: '', to: '', search: '',
        statementAccount: '', statementFrom: A.monthStart(), statementTo: A.today(), statementCurrency: '',
        reportId: 'trial_balance', reportFrom: A.monthStart(), reportTo: A.today(), reportAccount: '',
        reportVoucherType: '', reportCurrency: '', voucherPartyType: '',
        partyType: '', partySearch: '',
        yearEndYear: new Date().getFullYear(), yearEndRetained: ''
    };
    let statementResult = null;
    let reportResult = null;

    const currencyRow = code => (cache.currencies || []).find(c => String(c.code).toUpperCase() === String(code || '').toUpperCase()) || null;
    const symbolOf = code => {
        const row = currencyRow(code);
        if (row) return row.symbol || '';
        if (cache.baseCurrency) return cache.baseCurrency.symbol || '';
        return (A.state.data.settings || {}).currency || '';
    };
    const money = (value, code) => `${A.money(value, false)} ${symbolOf(code || displayCurrency)}`;
    const currencyOptionsHtml = (selected, includeAll) => {
        const base = cache.baseCurrency || {};
        const rows = cache.currencies && cache.currencies.length ? cache.currencies : [{ code: base.code || '', name: base.name || 'العملة الأساسية', symbol: base.symbol || '' }];
        return (includeAll ? `<option value="">العملة الأساسية (${h(base.symbol || '')})</option>` : '')
            + rows.filter(c => c.active !== false || String(c.code) === String(selected || '')).map(c => `<option value="${h(c.code)}" ${String(c.code) === String(selected || '') ? 'selected' : ''}>${h(c.name)} (${h(c.symbol)})</option>`).join('');
    };
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
        const query = displayCurrency ? '?currency=' + encodeURIComponent(displayCurrency) : '';
        const [tree, summary, vouchers, reports, mapping, currencies, parties] = await Promise.all([
            A.get('/accounts/tree' + query),
            A.get('/accounts/summary' + query),
            A.get('/vouchers?limit=1000'),
            A.get('/accounting/reports/catalog'),
            A.get('/accounts/mapping'),
            A.get('/currencies'),
            A.get('/parties')
        ]);
        cache.tree = tree.data || [];
        cache.summary = summary.data || {};
        cache.vouchers = vouchers.data || [];
        cache.reports = reports.data || [];
        cache.mapping = mapping.data || null;
        cache.mappingRows = (mapping.data && mapping.data.rows) || [];
        cache.currencies = (currencies.data && currencies.data.currencies) || [];
        cache.baseCurrency = (currencies.data && currencies.data.base) || null;
        cache.parties = parties.data || [];
    }

    // ═══════════════════ الأطراف: عملاء / موردون / موظفون ═══════════════════
    const partiesOf = type => (cache.parties || []).filter(p => p.type === type);
    const partyLabel = p => `${p.name || ''}${p.code ? ' — ' + p.code : ''}${p.branchName ? ' (' + p.branchName + ')' : ''}`;
    const partyIdByName = (type, name) => ((partiesOf(type).find(p => p.name === name)) || {}).id || '';
    const partyOptionsHtml = (type, selectedName) => {
        const rows = partiesOf(type);
        const known = rows.some(p => p.name === selectedName);
        return `<option value="">— اختر ${PARTY[type] || 'الطرف'} —</option>`
            + (selectedName && !known ? `<option value="${h(selectedName)}" data-id="" selected>${h(selectedName)} (غير مسجل)</option>` : '')
            + rows.map(p => `<option value="${h(p.name)}" data-id="${h(p.id || '')}" ${p.name === selectedName ? 'selected' : ''}>${h(partyLabel(p))}${p.legacy ? ' (سابق)' : ''}</option>`).join('')
            + (type === 'employee' ? '' : `<option value="__new__">＋ إضافة ${PARTY[type] || 'طرف'} جديد…</option>`);
    };

    async function loadParties() {
        try { const res = await A.get('/parties'); cache.parties = res.data || []; }
        catch (_) { cache.parties = []; }
    }

    function partyModal(type, onDone) {
        const branchOptions = (A.state.data.branches || []).map(b => ({ value: b.id, label: b.name }));
        A.formModal({
            title: `إضافة ${PARTY[type] || 'طرف'}`,
            size: 'sm',
            fields: [
                { key: 'name', label: 'الاسم', required: true },
                {
                    key: 'type', label: 'نوع الطرف', type: 'select', default: type || 'customer',
                    options: [{ value: 'customer', label: 'عميل' }, { value: 'supplier', label: 'مورد' }, { value: 'other', label: 'أخرى' }]
                },
                { key: 'code', label: 'الرقم / الكود' },
                { key: 'phone', label: 'الهاتف' },
                { key: 'email', label: 'البريد الإلكتروني' },
                { key: 'taxNumber', label: 'الرقم الضريبي' },
                { key: 'branchId', label: 'الفرع', type: 'select', options: [{ value: '', label: '— بدون —' }].concat(branchOptions) }
            ],
            onSubmit: async data => {
                const res = await A.post('/collections/parties', data);
                A.closeModal();
                A.toast('تمت إضافة الطرف', 'success');
                await loadParties();
                if (onDone) onDone(res.data || data);
            }
        });
    }

    // ═══════════════════ الإطار والتبويبات ═══════════════════
    const TABS = [
        { id: 'overview', label: 'نظرة عامة' },
        { id: 'chart', label: 'شجرة الحسابات' },
        { id: 'parties', label: 'العملاء والموردون' },
        { id: 'vouchers', label: 'السندات والقيود' },
        { id: 'opening', label: 'القيود الافتتاحية' },
        { id: 'statement', label: 'كشف حساب' },
        { id: 'reports', label: 'التقارير المالية' },
        { id: 'currencies', label: 'العملات وأسعار الصرف' },
        { id: 'yearEnd', label: 'الإقفال السنوي' },
        { id: 'integration', label: 'الربط المحاسبي' }
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
        if (activeTab === 'parties') return renderParties(body);
        if (activeTab === 'vouchers') return renderVouchers(body, '');
        if (activeTab === 'opening') return renderOpening(body);
        if (activeTab === 'statement') return renderStatement(body);
        if (activeTab === 'reports') return renderReports(body);
        if (activeTab === 'currencies') return renderCurrencies(body);
        if (activeTab === 'yearEnd') return renderYearEnd(body);
        if (activeTab === 'integration') return renderIntegration(body);
    }

    // ═══════════════════ الربط المحاسبي التلقائي ═══════════════════
    function renderIntegration(body) {
        const mapping = (cache.mapping && cache.mapping.mapping) || cache.mapping || {};
        const enabled = mapping.enabled !== false;
        const rows = cache.mappingRows.length
            ? cache.mappingRows
            : Object.keys(mapping).filter(k => k !== 'enabled').map(k => ({ key: k, label: k, code: mapping[k] }));
        const postable = cache.tree.filter(a => !a.isGroup);
        body.innerHTML = `
            <div class="alert info mb">${A.icon('alert')}<div>
                كل عملية مالية (استحقاق رواتب، خصومات، بدلات، تأمينات، سلف وقروض، صرف رواتب، مكافأة نهاية خدمة)
                تُرحَّل تلقائيًا كقيد يومية على الحساب المحدد هنا. القيود الناتجة تظهر في تبويب «السندات والقيود»
                وتُحسب في الميزان والدفتر والميزانية وقائمة الدخل.
            </div></div>
            <div class="card mb">
                <div class="card-head"><h3>الترحيل التلقائي</h3><span class="spacer"></span>
                    <label class="switch"><input type="checkbox" id="accAutoPost" ${enabled ? 'checked' : ''}> مفعّل</label>
                </div>
                <div class="card-pad">
                    <div class="grid grid-2" id="accMappingGrid">
                        ${rows.map(r => `<div class="field"><label>${h(r.label)}</label>
                            <select data-acc-map="${h(r.key)}">${postable.map(a => `<option value="${h(a.code)}" ${String(a.code) === String(mapping[r.key] || r.code) ? 'selected' : ''}>${h((a.code ? a.code + ' — ' : '') + a.name)}</option>`).join('')}</select></div>`).join('')}
                    </div>
                </div>
                <div class="toolbar" style="padding:12px 16px;border-top:1px solid var(--line)">
                    <button class="btn btn-primary" id="accSaveMapping">${A.icon('check')} حفظ الربط</button>
                    <button class="btn" id="accSyncPostings">${A.icon('play')} ترحيل القيود الناقصة</button>
                    <span class="grow"></span>
                    <span class="small muted">${A.numFmt(rows.length)} بند محاسبي مربوط</span>
                </div>
            </div>`;

        const saveBtn = document.getElementById('accSaveMapping');
        if (saveBtn) saveBtn.onclick = async () => {
            const payload = { enabled: document.getElementById('accAutoPost').checked };
            body.querySelectorAll('[data-acc-map]').forEach(sel => { payload[sel.dataset.accMap] = sel.value; });
            try {
                await A.put('/accounts/mapping', { mapping: payload });
                A.toast('تم حفظ الربط المحاسبي');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        };
        const syncBtn = document.getElementById('accSyncPostings');
        if (syncBtn) syncBtn.onclick = async () => {
            if (!(await A.confirm({ title: 'ترحيل القيود الناقصة', message: 'سيتم إنشاء قيود محاسبية لكل العمليات المالية السابقة التي لم تُرحّل بعد. متابعة؟', confirmLabel: 'ترحيل' }))) return;
            try {
                const res = await A.post('/accounts/postings/sync', {});
                A.toast((res && res.message) || 'تم الترحيل', 'success');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        };
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
            <div class="grid acc-overview-split">
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
                <div class="field" style="margin:0;min-width:200px"><label>عرض المبالغ بعملة</label>
                    <select id="accDisplayCurrency">${currencyOptionsHtml(displayCurrency, true)}</select></div>
                ${canAdd ? `<button class="btn btn-sm btn-primary" id="accAddRoot">${A.icon('plus')} حساب رئيسي</button>` : ''}
                <button class="btn btn-sm" id="accRefresh">${A.icon('refresh')} تحديث</button>
            </div>
            <div class="table-wrap">
                <table class="data">
                    <thead><tr><th style="width:90px">الكود</th><th>اسم الحساب</th><th>النوع</th><th>العملة</th><th>طبيعة الرصيد</th>
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
                                <td>${a.currencySymbol ? `<span class="badge">${h(a.currencySymbol)}</span>` : '<span class="small muted">—</span>'}</td>
                                <td>${a.nature === 'debit' ? 'مدين' : 'دائن'}</td>
                                <td class="num">${money(a.debit)}</td>
                                <td class="num">${money(a.credit)}</td>
                                <td class="num" style="font-weight:700;color:${a.naturalBalance < 0 ? 'var(--danger)' : 'var(--text)'}">${money(a.naturalBalance)}</td>
                                <td class="no-print"><div class="actions-cell">
                                    ${canAdd ? `<button class="btn btn-icon btn-sm" title="إضافة حساب فرعي" data-acc-add="${h(a.id)}">${A.icon('plus')}</button>` : ''}
                                    ${canEdit && !a.isGroup ? `<button class="btn btn-icon btn-sm" title="تقسيم حسب العملات" data-acc-split="${h(a.id)}">${A.icon('exchange')}</button>` : ''}
                                    ${canEdit ? `<button class="btn btn-icon btn-sm" title="تعديل" data-acc-edit="${h(a.id)}">${A.icon('edit')}</button>` : ''}
                                    ${canDelete ? `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-acc-del="${h(a.id)}">${A.icon('trash')}</button>` : ''}
                                </div></td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
        const rootBtn = document.getElementById('accAddRoot');
        if (rootBtn) rootBtn.onclick = () => accountModal(null, '');
        const displaySelect = document.getElementById('accDisplayCurrency');
        if (displaySelect) displaySelect.onchange = () => { displayCurrency = displaySelect.value || ''; refreshAll(); };
        document.getElementById('accRefresh').onclick = () => refreshAll();
        body.querySelectorAll('[data-acc-split]').forEach(b => b.onclick = () => {
            const account = cache.tree.find(a => a.id === b.dataset.accSplit);
            if (account) splitCurrencyModal(account);
        });
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
            {
                key: 'currency', label: 'عملة الحساب (اختياري)', type: 'select',
                options: [{ value: '', label: '— عملة النظام الأساسية —' }]
                    .concat((cache.currencies || []).map(c => ({ value: c.code, label: `${c.name} (${c.symbol})` }))),
                default: isEdit ? (account.currency || '') : '',
                help: 'توضح عملة هذا الحساب وتظهر رمزها بجانبه في شجرة الحسابات'
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
                    partyType: data.partyType || '', currency: data.currency || '', description: data.description
                };
                if (isEdit) await A.put('/accounts/' + account.id, payload);
                else await A.post('/accounts', payload);
                A.closeModal();
                A.toast(isEdit ? 'تم تحديث الحساب' : 'تمت إضافة الحساب');
                await refreshAll(false);
            }
        });
    }

    function splitCurrencyModal(account) {
        const rows = (cache.currencies || []).filter(c => c.active !== false);
        A.formModal({
            title: `تقسيم «${account.name}» حسب العملات`,
            size: 'md', submitLabel: 'إنشاء الحسابات الفرعية',
            fields: [
                { type: 'html', full: true, html: `<div class="alert info" style="margin:0">سيصبح الحساب ${h(account.code)} حسابًا رئيسيًا، وتُنشأ تحته حسابات فرعية بعملة كل خيار تختاره. لا بد أن يكون الحساب بلا حركة محاسبية.</div>` },
                {
                    key: 'currencies', label: 'العملات', type: 'checks', required: true, full: true,
                    options: rows.map(c => ({ value: c.code, label: `${c.name} (${c.symbol})` })),
                    default: rows.map(c => c.code)
                }
            ],
            onSubmit: async data => {
                const codes = Array.isArray(data.currencies) ? data.currencies : [data.currencies].filter(Boolean);
                if (!codes.length) throw new Error('اختر عملة واحدة على الأقل');
                const res = await A.post(`/accounts/${account.id}/currency-split`, { currencies: codes });
                A.closeModal();
                A.toast((res && res.message) || 'تم إنشاء الحسابات الفرعية', 'success');
                await refreshAll();
            }
        });
    }

    // ═══════════════════ العملاء والموردون ═══════════════════
    function renderParties(body) {
        const canAdd = A.can('accounts', 'add');
        const canEdit = A.can('accounts', 'edit');
        const canDelete = A.can('accounts', 'delete');
        const all = (cache.parties || []).filter(p => p.type !== 'employee');
        const search = (filters.partySearch || '').toLowerCase();
        const rows = all.filter(p => (!filters.partyType || p.type === filters.partyType)
            && (!search || `${p.name || ''} ${p.code || ''} ${p.phone || ''} ${p.email || ''}`.toLowerCase().includes(search)));
        const count = type => all.filter(p => p.type === type).length;
        body.innerHTML = `
            <div class="grid grid-3 mb">
                <div class="kpi"><div class="kpi-top"><span>العملاء</span>${A.icon('users')}</div><div class="kpi-value">${A.numFmt(count('customer'))}</div></div>
                <div class="kpi info"><div class="kpi-top"><span>الموردون</span>${A.icon('briefcase')}</div><div class="kpi-value">${A.numFmt(count('supplier'))}</div></div>
                <div class="kpi purple"><div class="kpi-top"><span>أطراف أخرى</span>${A.icon('file')}</div><div class="kpi-value">${A.numFmt(count('other'))}</div></div>
            </div>
            <div class="card card-pad mb">
                <div class="row" style="align-items:flex-end">
                    <div class="field" style="margin:0"><label>النوع</label>
                        <select id="ptFilter">
                            <option value="">الكل</option>
                            <option value="customer" ${filters.partyType === 'customer' ? 'selected' : ''}>عميل</option>
                            <option value="supplier" ${filters.partyType === 'supplier' ? 'selected' : ''}>مورد</option>
                            <option value="other" ${filters.partyType === 'other' ? 'selected' : ''}>أخرى</option>
                        </select></div>
                    <div class="field" style="margin:0;min-width:220px"><label>بحث</label>
                        <input id="ptSearch" value="${h(filters.partySearch || '')}" placeholder="الاسم أو الرقم أو الهاتف"></div>
                    <span class="grow"></span>
                    ${canAdd ? `<button class="btn btn-primary" id="ptAdd">${A.icon('plus')} طرف جديد</button>` : ''}
                    <button class="btn btn-sm" id="ptRefresh">${A.icon('refresh')} تحديث</button>
                </div>
            </div>
            <div class="card"><div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'name', label: 'الاسم', render: r => `<strong>${h(r.name)}</strong>${r.legacy ? ' <span class="badge">من سند سابق</span>' : ''}` },
                    { key: 'type', label: 'النوع', render: r => `<span class="badge ${r.type === 'supplier' ? 'warn' : r.type === 'other' ? '' : 'info'}">${h(PARTY[r.type] || r.type)}</span>` },
                    { key: 'code', label: 'الكود' },
                    { key: 'phone', label: 'الهاتف' },
                    { key: 'taxNumber', label: 'الرقم الضريبي' },
                    { key: 'branchName', label: 'الفرع' }
                ],
                rows, empty: 'لا توجد أطراف مسجلة — أضف عميلًا أو موردًا ليظهروا في السندات',
                actions: row => row.legacy ? [] : [
                    canEdit ? { html: `<button class="btn btn-icon btn-sm" title="تعديل" data-pt-edit="${h(row.id)}">${A.icon('edit')}</button>` } : null,
                    canDelete ? { html: `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-pt-del="${h(row.id)}">${A.icon('trash')}</button>` } : null
                ].filter(Boolean)
            })}
            </div></div>`;
        document.getElementById('ptFilter').onchange = e => { filters.partyType = e.target.value; renderParties(body); };
        const searchInput = document.getElementById('ptSearch');
        searchInput.oninput = () => A.keepFocus(() => { filters.partySearch = searchInput.value.trim(); renderParties(body); }, body);
        document.getElementById('ptRefresh').onclick = async () => { await loadParties(); renderParties(body); };
        if (canAdd) document.getElementById('ptAdd').onclick = () => partyModal(filters.partyType || 'customer', () => renderParties(body));
        body.querySelectorAll('[data-pt-edit]').forEach(b => b.onclick = () => {
            const row = (cache.parties || []).find(p => p.id === b.dataset.ptEdit);
            if (!row) return;
            A.formModal({
                title: 'تعديل طرف', size: 'sm',
                fields: [
                    { key: 'name', label: 'الاسم', required: true, default: row.name },
                    { key: 'type', label: 'النوع', type: 'select', default: row.type || 'customer',
                      options: [{ value: 'customer', label: 'عميل' }, { value: 'supplier', label: 'مورد' }, { value: 'other', label: 'أخرى' }] },
                    { key: 'code', label: 'الكود', default: row.code },
                    { key: 'phone', label: 'الهاتف', default: row.phone },
                    { key: 'email', label: 'البريد الإلكتروني', default: row.email },
                    { key: 'taxNumber', label: 'الرقم الضريبي', default: row.taxNumber },
                    { key: 'branchId', label: 'الفرع', type: 'select', default: row.branchId || '',
                      options: [{ value: '', label: '— بدون —' }].concat((A.state.data.branches || []).map(x => ({ value: x.id, label: x.name }))) },
                    { key: 'active', label: 'نشط', type: 'checkbox', default: row.active !== false },
                    { key: 'notes', label: 'ملاحظات', type: 'textarea', full: true, default: row.notes }
                ],
                onSubmit: async data => {
                    await A.put('/collections/parties/' + row.id, data);
                    A.closeModal();
                    A.toast('تم حفظ الطرف');
                    await loadParties();
                    renderParties(body);
                }
            });
        });
        body.querySelectorAll('[data-pt-del]').forEach(b => b.onclick = async () => {
            const row = (cache.parties || []).find(p => p.id === b.dataset.ptDel);
            if (!row) return;
            if (!(await A.confirm({ title: 'حذف الطرف', message: `حذف «${h(row.name)}» من قائمة الأطراف؟ لن تتأثر السندات السابقة.`, danger: true, confirmLabel: 'حذف' }))) return;
            try {
                await A.del('/collections/parties/' + row.id);
                A.toast('تم حذف الطرف');
                await loadParties();
                renderParties(body);
            } catch (err) { A.toast(err.message, 'error'); }
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
                <div class="field" style="margin:0"><label>نوع الطرف</label>
                    <select id="vFilterParty"><option value="">كل الأطراف</option>
                    ${Object.keys(PARTY).filter(k => k).map(k => `<option value="${k}" ${filters.voucherPartyType === k ? 'selected' : ''}>${h(PARTY[k])}</option>`).join('')}</select></div>
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
            filters.voucherPartyType = document.getElementById('vFilterParty').value;
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
            if (filters.voucherPartyType) {
                const hasParty = (v.partyType || '') === filters.voucherPartyType
                    || (v.lines || []).some(l => (l.partyType || '') === filters.voucherPartyType);
                if (!hasParty) return false;
            }
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
                    { key: 'party', label: 'الطرف', render: r => r.party ? `${h(r.party)}${r.partyType ? `<div class="small muted">${h(PARTY[r.partyType] || '')}</div>` : ''}` : '<span class="small muted">—</span>' },
                    { key: 'debit', label: 'المبلغ', align: 'left', render: r => money(r.debit) },
                    { key: 'source', label: 'المصدر', render: r => r.auto ? `<span class="badge success">${h(r.eventLabel || 'تلقائي')}</span>` : '<span class="small muted">يدوي</span>' },
                    { key: 'status', label: 'الحالة', render: r => badge(r.status || 'draft') }
                ],
                rows,
                empty: 'لا توجد سندات مطابقة',
                actions: row => {
                    const acts = [];
                    acts.push({ html: `<button class="btn btn-icon btn-sm" title="طباعة/عرض" data-v-print="${h(row.id)}">${A.icon('print')}</button>` });
                    if (A.can('archive', 'add')) {
                        acts.push({ html: `<button class="btn btn-icon btn-sm" title="أرشفة السند" data-v-archive="${h(row.id)}">${A.icon('file')}</button>` });
                    }
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
        body.querySelectorAll('[data-v-archive]').forEach(b => b.onclick = () => {
            const voucher = cache.vouchers.find(v => v.id === b.dataset.vArchive);
            if (!voucher) return;
            sessionStorage.setItem('tageep_archive_voucher', JSON.stringify({
                voucherId: voucher.id, voucherNumber: voucher.number, title: `سند ${voucher.number}`
            }));
            location.hash = '#/archive';
        });
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
            : [{ accountId: '', description: '', party: '', partyId: '', dueDate: '', debit: '', credit: '' }, { accountId: '', description: '', party: '', partyId: '', dueDate: '', debit: '', credit: '' }];
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
                    <div class="field"><label>نوع الطرف</label><select id="vPartyType">${Object.keys(PARTY).map(k => `<option value="${k}" ${existing && (existing.partyType || '') === k ? 'selected' : ''}>${PARTY[k]}</option>`).join('')}</select>
                        <div class="help">يحدد قائمة الأطراف المتاحة في حقل «الطرف»</div></div>
                    <div class="field"><label>الطرف</label><div id="vPartyWrap"></div></div>
                    <div class="field"><label>عملة الإدخال</label><select id="vCurrency" ${isEdit ? 'disabled' : ''}>${currencyOptionsHtml('')}</select>
                        <div class="help">${isEdit ? 'عند التعديل تُعرض المبالغ بالعملة الأساسية' : 'اختر عملة أجنبية لتحويل المبالغ تلقائيًا عند الحفظ'}</div></div>
                    <div class="field full"><label>البيان</label><input id="vDescription" value="${h(existing ? existing.description : '')}" placeholder="وصف السند"></div>
                    <div class="full small muted" id="vFxNote"></div>
                </div>
                <div class="toolbar" style="border:0;padding:8px 0"><strong>بنود السند</strong><span class="grow"></span>
                    <button type="button" class="btn btn-sm" id="vAddLine">${A.icon('plus')} إضافة بند</button></div>
                <div class="table-wrap"><table class="data" id="vLinesTable">
                    <thead><tr><th style="min-width:200px">الحساب</th><th>البيان</th><th style="min-width:120px">الطرف</th>
                        <th style="min-width:120px">الاستحقاق</th><th class="num" style="width:120px">مدين</th><th class="num" style="width:120px">دائن</th><th></th></tr></thead>
                    <tbody id="vLinesBody"></tbody>
                </table></div>
                <div class="row" style="justify-content:flex-end;gap:20px;margin-top:12px;font-size:13.5px">
                    <div>إجمالي المدين: <strong id="vTotalDebit">0.00</strong> <span id="vTotalSymbol"></span></div>
                    <div>إجمالي الدائن: <strong id="vTotalCredit">0.00</strong></div>
                    <div>الفرق: <strong id="vDiff">0.00</strong></div>
                </div>`,
            footer: `<button class="btn btn-primary" id="vSavePost">${A.icon('check')} حفظ وترحيل</button>
                     <button class="btn" id="vSaveDraft">${A.icon('file')} حفظ كمسودة</button>
                     <button class="btn" data-close>إغلاق</button>`
        });

        const body = modal.querySelector('.modal-body');
        const tbody = body.querySelector('#vLinesBody');
        const accountSelectHtml = selected => `<option value="">— اختر الحساب —</option>${leaves.map(a => `<option value="${h(a.id)}" ${a.id === selected ? 'selected' : ''}>${h(a.code + ' — ' + a.name)}${a.partyType ? ' •' : ''}</option>`).join('')}`;
        const linePartyType = line => ((cache.tree.find(a => a.id === line.accountId)) || {}).partyType || '';
        const partyCellHtml = (line, index) => {
            const type = linePartyType(line);
            if (!type) return `<input data-line="party" data-index="${index}" value="${h(line.party || '')}" placeholder="—">`;
            return `<select data-party-index="${index}" title="${h(PARTY[type] || '')}">${partyOptionsHtml(type, line.party || '')}</select>`;
        };

        const drawLines = () => {
            tbody.innerHTML = lines.map((line, index) => `
                <tr>
                    <td><select data-account-index="${index}">${accountSelectHtml(line.accountId)}</select></td>
                    <td><input data-line="description" data-index="${index}" value="${h(line.description || '')}"></td>
                    <td>${partyCellHtml(line, index)}</td>
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
            tbody.querySelectorAll('[data-account-index]').forEach(select => {
                select.onchange = () => {
                    const index = Number(select.dataset.accountIndex);
                    lines[index].accountId = select.value;
                    const account = cache.tree.find(a => a.id === select.value) || {};
                    if (account.partyType) {
                        if (headerType() !== account.partyType) {
                            partyTypeSelect.value = account.partyType;
                            headerParty = lines[index].party || '';
                            renderHeaderParty();
                        }
                        if (!lines[index].party && headerParty) {
                            lines[index].party = headerParty;
                            lines[index].partyId = partyIdByName(account.partyType, headerParty);
                        }
                    } else if (lines[index].party) {
                        lines[index].party = '';
                        lines[index].partyId = '';
                    }
                    drawLines();
                };
            });
            tbody.querySelectorAll('[data-party-index]').forEach(select => {
                select.onchange = () => {
                    const index = Number(select.dataset.partyIndex);
                    const type = linePartyType(lines[index]);
                    if (select.value === '__new__') {
                        select.value = lines[index].party || '';
                        partyModal(type || 'customer', created => {
                            lines[index].party = created.name || '';
                            lines[index].partyId = created.id || '';
                            if (partyTypeSelect.value !== (created.type || type)) {
                                partyTypeSelect.value = created.type || type;
                                renderHeaderParty();
                            }
                            drawLines();
                        });
                        return;
                    }
                    lines[index].party = select.value;
                    const option = select.options[select.selectedIndex];
                    lines[index].partyId = (option && option.dataset.id) || '';
                };
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

        const partyTypeSelect = body.querySelector('#vPartyType');
        const partyWrap = body.querySelector('#vPartyWrap');
        let headerParty = existing ? (existing.party || '') : '';
        const headerType = () => partyTypeSelect.value;
        const fillEmptyLines = (name, type) => {
            if (!name) return;
            let changed = false;
            lines.forEach(line => {
                if (line.party) return;
                const account = cache.tree.find(a => a.id === line.accountId) || {};
                if (!line.accountId || !account.partyType || account.partyType === type) {
                    line.party = name;
                    line.partyId = partyIdByName(type, name);
                    changed = true;
                }
            });
            if (changed) drawLines();
        };
        const renderHeaderParty = () => {
            const type = headerType();
            if (!type) {
                partyWrap.innerHTML = `<input id="vParty" value="" placeholder="— بدون طرف —" disabled>`;
                return;
            }
            const rows = partiesOf(type);
            if (!rows.length && !headerParty) {
                partyWrap.innerHTML = `<input id="vParty" value="" placeholder="اكتب اسم ${h(PARTY[type] || 'الطرف')}">`;
                const input = partyWrap.querySelector('#vParty');
                input.oninput = () => { headerParty = input.value; };
                return;
            }
            partyWrap.innerHTML = `<select id="vParty">${partyOptionsHtml(type, headerParty)}</select>`;
            const select = partyWrap.querySelector('#vParty');
            select.onchange = () => {
                if (select.value === '__new__') {
                    select.value = headerParty || '';
                    partyModal(type, created => {
                        headerParty = created.name || '';
                        renderHeaderParty();
                        fillEmptyLines(headerParty, created.type || type);
                    });
                    return;
                }
                headerParty = select.value;
                fillEmptyLines(headerParty, type);
            };
        };
        partyTypeSelect.onchange = () => {
            headerParty = '';
            renderHeaderParty();
        };
        const firstLineType = linePartyType(lines.find(l => l.accountId) || {});
        if (!headerType() && firstLineType) partyTypeSelect.value = firstLineType;
        drawLines();
        renderHeaderParty();
        const currencySelect = body.querySelector('#vCurrency');
        const baseCode = (cache.baseCurrency || {}).code || '';
        const fxNote = body.querySelector('#vFxNote');
        body.querySelector('#vTotalSymbol').textContent = symbolOf(baseCode);
        const syncFx = () => {
            const row = currencyRow(currencySelect.value);
            if (!row || !row.code || row.code === baseCode) { fxNote.textContent = ''; return; }
            fxNote.textContent = `المبالغ ستُحوَّل إلى ${(cache.baseCurrency || {}).name || ''} بسعر 1 ${row.code} = ${A.numFmt(row.rate, 4)} ${symbolOf(baseCode)} — تُحفظ الأرصدة بالعملة الأساسية.`;
        };
        currencySelect.onchange = syncFx;
        syncFx();
        if (isEdit && existing.currency && existing.currency !== baseCode && existing.exchangeRate) {
            fxNote.textContent = `أُدخل هذا السند أصلًا بعملة ${existing.currency} بسعر ${A.numFmt(existing.exchangeRate, 4)} — المبالغ المعروضة هنا بالعملة الأساسية.`;
        }
        body.querySelector('#vAddLine').onclick = () => {
            lines.push({ accountId: '', description: '', party: '', partyId: '', dueDate: '', debit: '', credit: '' });
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
                party: headerParty.trim(),
                partyId: partyIdByName(headerType(), headerParty.trim()),
                partyType: headerType(),
                description: body.querySelector('#vDescription').value.trim(),
                currency: currencySelect.value,
                post: !!post,
                lines: lines.filter(l => l.accountId || parseFloat(l.debit) || parseFloat(l.credit)).map(l => ({
                    accountId: l.accountId, description: l.description || '',
                    party: l.party || '', partyId: l.partyId || '',
                    partyType: linePartyType(l) || headerType(),
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
            const sym = symbolOf(v.currency);
            const rows = (v.lines || []).map(l => {
                const account = cache.tree.find(a => a.id === l.accountId) || {};
                return `<tr><td>${h(account.code || '')} — ${h(account.name || '')}</td><td>${h(l.description || '')}</td>
                    <td class="num">${A.money(l.debit, false)} ${h(sym)}</td><td class="num">${A.money(l.credit, false)} ${h(sym)}</td></tr>`;
            }).join('');
            const fxNote = v.exchangeRate && Number(v.exchangeRate) !== 1
                ? `<div class="small muted">أُدخل بعملة ${h(v.currency)} بسعر صرف ${A.numFmt(v.exchangeRate, 4)} — المبالغ بالعملة الأساسية</div>` : '';
            A.print({
                title: `${typeLabel} — ${v.number}`,
                subtitle: `${A.date(v.date)}${v.party ? ' — ' + v.party : ''}`,
                html: `<div style="margin-bottom:8px">${h(v.description || '')}${v.reference ? ' — مرجع: ' + h(v.reference) : ''}</div>${fxNote}
                    <table class="data"><thead><tr><th>الحساب</th><th>البيان</th><th>مدين</th><th>دائن</th></tr></thead>
                    <tbody>${rows}</tbody><tfoot><tr><td colspan="2">الإجمالي</td><td class="num">${A.money(v.debit, false)} ${h(sym)}</td><td class="num">${A.money(v.credit, false)} ${h(sym)}</td></tr></tfoot></table>
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
                    <div class="field" style="margin:0;min-width:180px"><label>عملة العرض</label>
                        <select id="stCurrency">${currencyOptionsHtml(filters.statementCurrency, true)}</select></div>
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
            filters.statementCurrency = document.getElementById('stCurrency').value;
            if (!filters.statementAccount) return A.toast('اختر الحساب أولًا', 'warning');
            const box = document.getElementById('stResult');
            box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                const res = await A.get(`/accounts/statement?accountId=${encodeURIComponent(filters.statementAccount)}&from=${filters.statementFrom}&to=${filters.statementTo}&currency=${encodeURIComponent(filters.statementCurrency)}`);
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
        const sym = h((data.currency && data.currency.symbol) || symbolOf());
        const amount = value => `${A.money(value, false)} ${sym}`;
        return `<table class="data"><thead><tr><th>التاريخ</th><th>المستند</th><th>البيان</th><th>الطرف</th>
                <th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody>
                <tr><td>—</td><td></td><td>رصيد افتتاحي</td><td></td><td></td><td></td><td class="num">${amount(data.opening)}</td></tr>
                ${data.rows.map(r => `<tr><td>${A.date(r.date)}</td><td>${h(r.number)}</td><td>${h(r.description)}</td><td>${h(r.party || '')}</td>
                    <td class="num">${r.debit ? amount(r.debit) : ''}</td><td class="num">${r.credit ? amount(r.credit) : ''}</td>
                    <td class="num">${amount(r.balance)}</td></tr>`).join('')}
                </tbody><tfoot><tr><td colspan="4">الإجمالي / الرصيد الختامي</td>
                <td class="num">${amount(data.totalDebit)}</td><td class="num">${amount(data.totalCredit)}</td>
                <td class="num">${amount(data.closing)}</td></tr></tfoot></table>`;
    }

    function renderStatementResult(box, data) {
        const code = (data.currency && data.currency.code) || '';
        box.innerHTML = `
            <div class="card mb"><div class="card-head"><h3>${h(data.account.code)} — ${h(data.account.name)}</h3>
                <span class="spacer"></span><span class="small muted">${A.date(data.from)} → ${A.date(data.to)} · العملة: ${h((data.currency && data.currency.name) || '')}</span></div>
                <div class="grid grid-3 card-pad" style="border-bottom:1px solid var(--line)">
                    <div><div class="small muted">رصيد افتتاحي</div><strong>${money(data.opening, code)}</strong></div>
                    <div><div class="small muted">إجمالي الحركة</div><strong>${money(data.totalDebit, code)} / ${money(data.totalCredit, code)}</strong></div>
                    <div><div class="small muted">الرصيد الختامي</div><strong>${money(data.closing, code)}</strong></div>
                </div>
                <div class="card-pad" style="padding:0">${A.table({
                    columns: [
                        { key: 'date', label: 'التاريخ', render: r => A.date(r.date) },
                        { key: 'number', label: 'المستند' },
                        { key: 'type', label: 'النوع', render: r => h(r.typeLabel) },
                        { key: 'description', label: 'البيان' },
                        { key: 'party', label: 'الطرف' },
                        { key: 'debit', label: 'مدين', align: 'left', render: r => r.debit ? money(r.debit, code) : '' },
                        { key: 'credit', label: 'دائن', align: 'left', render: r => r.credit ? money(r.credit, code) : '' },
                        { key: 'balance', label: 'الرصيد', align: 'left', render: r => money(r.balance, code) }
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
                    <div class="field" style="margin:0;min-width:180px"><label>عملة العرض</label>
                        <select id="rpCurrency">${currencyOptionsHtml(filters.reportCurrency, true)}</select></div>
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
            filters.reportCurrency = document.getElementById('rpCurrency').value;
            const box = document.getElementById('rpResult');
            box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                const res = await A.post('/accounting/reports/run', {
                    reportId: filters.reportId,
                    filters: {
                        from: filters.reportFrom, to: filters.reportTo,
                        accountId: filters.reportAccount, voucherType: filters.reportVoucherType,
                        currency: filters.reportCurrency
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
                    filters: { from: filters.reportFrom, to: filters.reportTo, accountId: filters.reportAccount,
                        voucherType: filters.reportVoucherType, currency: filters.reportCurrency }
                }, `${filters.reportId}.${format === 'csv' ? 'csv' : 'xlsx'}`);
            } catch (err) { A.toast(err.message, 'error'); }
        };
        document.getElementById('rpExcel').onclick = () => exportFile('xlsx');
        document.getElementById('rpCsv').onclick = () => exportFile('csv');
        run();
    }

    function cellValue(column, row, code) {
        const value = row[column.key];
        if (column.type === 'money') return money(value, code);
        if (column.type === 'number') return A.numFmt(value);
        if (column.type === 'date') return A.date(value);
        return h(value === null || value === undefined ? '' : value);
    }

    function renderReportResult(box, data) {
        const code = (data.currency && data.currency.code) || '';
        const columns = data.columns.map(c => ({
            key: c.key, label: c.label, align: (c.type === 'money' || c.type === 'number') ? 'left' : '',
            render: row => cellValue(c, row, code)
        }));
        const totals = data.totals || {};
        const footer = Object.keys(totals).length
            ? data.columns.map((c, index) => ({ content: index === 0 ? 'الإجمالي' : (totals[c.key] !== undefined ? cellValue(c, { [c.key]: totals[c.key] }, code) : ''), align: (c.type === 'money' || c.type === 'number') ? 'left' : '' }))
            : null;
        box.innerHTML = `<div class="card-pad" style="padding:0">${A.table({ columns, rows: data.rows, footer, empty: 'لا توجد بيانات للفترة المحددة' })}</div>`;
        document.getElementById('rpTitle').textContent = data.title;
    }

    function reportTableHtml(data) {
        const code = (data.currency && data.currency.code) || '';
        return `<table class="data"><thead><tr>${data.columns.map(c => `<th>${h(c.label)}</th>`).join('')}</tr></thead>
            <tbody>${data.rows.map(row => `<tr>${data.columns.map(c => `<td class="${c.type === 'money' || c.type === 'number' ? 'num' : ''}">${cellValue(c, row, code)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
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

    // ═══════════════════ العملات وأسعار الصرف ═══════════════════
    function renderCurrencies(body) {
        const base = cache.baseCurrency || {};
        const rows = cache.currencies || [];
        const canAdd = A.can('accounts', 'add');
        const canEdit = A.can('accounts', 'edit');
        const canDelete = A.can('accounts', 'delete');
        const missing = A.CURRENCIES.filter(c => !rows.some(r => String(r.code).toUpperCase() === c.code));
        body.innerHTML = `
            <div class="alert info mb">${A.icon('alert')}<div>
                العملة الأساسية للنظام: <strong>${h(base.name || '')} (${h(base.symbol || '')})</strong> — تُحفظ كل السندات والأرصدة بها،
                ويُستخدم سعر الصرف لعرض المبالغ بأي عملة أخرى. سعر الصرف = كم وحدة من العملة الأساسية يساوي <strong>1</strong> من العملة الأخرى.
                تُغيَّر العملة الأساسية من الإعدادات ← عام.
            </div></div>
            <div class="card mb">
                <div class="card-head"><h3>سجل العملات وأسعار الصرف</h3><span class="spacer"></span>
                    ${canAdd && missing.length ? `<button class="btn btn-sm btn-primary" id="curAdd">${A.icon('plus')} إضافة عملة</button>` : ''}
                    <button class="btn btn-sm" id="curRefresh">${A.icon('refresh')} تحديث</button></div>
                <div class="card-pad" style="padding:0">
                    <table class="data"><thead><tr><th>الرمز</th><th>الكود</th><th>العملة</th>
                        <th class="num">سعر الصرف</th><th class="num">مثال: 1 من العملة =</th><th>الحالة</th><th></th></tr></thead>
                    <tbody>${rows.map(c => `<tr>
                        <td><strong style="font-size:15px">${h(c.symbol)}</strong></td>
                        <td>${codeCell(c.code)}</td>
                        <td>${h(c.name)}${c.isBase ? ' <span class="badge success">أساسية</span>' : ''}</td>
                        <td class="num">${c.isBase ? '1.00' : `<input type="number" step="0.0001" min="0" class="num" style="width:120px" data-cur-rate="${h(c.id)}" value="${h(c.rate)}" ${canEdit ? '' : 'disabled'}>`}</td>
                        <td class="num">${c.isBase ? '—' : `${A.numFmt(c.rate, 2)} ${h(base.symbol || '')}`}</td>
                        <td>${c.active === false ? '<span class="badge danger">موقوفة</span>' : '<span class="badge success">مفعّلة</span>'}</td>
                        <td><div class="actions-cell">
                            ${canEdit ? `<button class="btn btn-icon btn-sm" data-cur-toggle="${h(c.id)}" title="${c.active === false ? 'تفعيل' : 'إيقاف'}">${A.icon(c.active === false ? 'check' : 'x')}</button>` : ''}
                            ${!c.isBase && canDelete ? `<button class="btn btn-icon btn-sm btn-danger" data-cur-del="${h(c.id)}" title="حذف">${A.icon('trash')}</button>` : ''}
                        </div></td>
                    </tr>`).join('')}</tbody></table>
                    ${canEdit && rows.some(c => !c.isBase) ? `<div class="toolbar" style="border-top:1px solid var(--line);padding:12px 16px">
                        <button class="btn btn-primary" id="curSaveRates">${A.icon('check')} حفظ أسعار الصرف</button>
                        <span class="small muted">يسري السعر الجديد على التقارير والتحويلات والسندات الجديدة</span></div>` : ''}
                </div>
            </div>
            <div class="grid grid-2">
                <div class="card"><div class="card-head"><h3>حاسبة التحويل</h3></div><div class="card-pad">
                    <div class="row" style="align-items:flex-end">
                        <div class="field" style="margin:0"><label>المبلغ</label><input type="number" step="0.01" id="cvAmount" value="100" class="num"></div>
                        <div class="field" style="margin:0"><label>من</label><select id="cvFrom">${currencyOptionsHtml(base.code)}</select></div>
                        <div class="field" style="margin:0"><label>إلى</label><select id="cvTo">${currencyOptionsHtml((rows.find(c => !c.isBase) || {}).code || base.code)}</select></div>
                        <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn" id="cvGo">${A.icon('refresh')} تحويل</button></div>
                    </div>
                    <div class="mt" id="cvResult" style="font-size:18px;font-weight:800"></div>
                </div></div>
                <div class="card"><div class="card-head"><h3>تقسيم حساب حسب العملات</h3></div><div class="card-pad">
                    <p class="small muted">يحوّل حسابًا فرعيًا بلا حركة إلى حسابات فرعية بعملة كل عملة، مثل:<br>
                        <strong>1101 النقدية بالصندوق</strong> ← 110101 بالريال اليمني، 110102 بالدولار.</p>
                    <div class="field"><label>الحساب الفرعي</label><select id="cvSplitAccount">
                        ${cache.tree.filter(a => !a.isGroup).map(a => `<option value="${h(a.id)}">${h((a.code ? a.code + ' — ' : '') + a.name)}</option>`).join('')}</select></div>
                    <button class="btn btn-primary" id="cvSplitGo" ${canEdit ? '' : 'disabled'}>${A.icon('exchange')} تقسيم الحساب</button>
                </div></div>
            </div>`;

        document.getElementById('curRefresh').onclick = () => refreshAll();
        const addBtn = document.getElementById('curAdd');
        if (addBtn) addBtn.onclick = () => currencyModal(missing);
        const saveBtn = document.getElementById('curSaveRates');
        if (saveBtn) saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            try {
                const inputs = Array.from(body.querySelectorAll('[data-cur-rate]'));
                for (const input of inputs) {
                    const row = rows.find(c => c.id === input.dataset.curRate);
                    if (row && A.num(row.rate) !== A.num(input.value)) {
                        await A.put('/currencies/' + row.id, { rate: A.num(input.value) });
                    }
                }
                A.toast('تم حفظ أسعار الصرف');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); saveBtn.disabled = false; }
        };
        body.querySelectorAll('[data-cur-toggle]').forEach(b => b.onclick = async () => {
            const row = rows.find(c => c.id === b.dataset.curToggle);
            if (!row) return;
            try {
                await A.put('/currencies/' + row.id, { active: row.active === false });
                A.toast(row.active === false ? 'تم تفعيل العملة' : 'تم إيقاف العملة');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        });
        body.querySelectorAll('[data-cur-del]').forEach(b => b.onclick = async () => {
            const row = rows.find(c => c.id === b.dataset.curDel);
            if (!row) return;
            if (!(await A.confirm({ title: 'حذف العملة', message: `حذف عملة ${h(row.name)}؟ لا يمكن الحذف إن كانت مستخدمة في حسابات أو سندات.`, danger: true, confirmLabel: 'حذف' }))) return;
            try {
                await A.del('/currencies/' + row.id);
                A.toast('تم حذف العملة');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        });
        document.getElementById('cvGo').onclick = () => {
            const amount = A.num(document.getElementById('cvAmount').value);
            const from = currencyRow(document.getElementById('cvFrom').value) || {};
            const to = currencyRow(document.getElementById('cvTo').value) || {};
            const result = A.round2(amount * (A.num(from.rate) || 1) / (A.num(to.rate) || 1));
            document.getElementById('cvResult').innerHTML =
                `${A.numFmt(amount, 2)} ${h(from.symbol || '')} = <span style="color:var(--brand)">${A.numFmt(result, 2)} ${h(to.symbol || '')}</span>`;
        };
        document.getElementById('cvSplitGo').onclick = () => {
            const account = cache.tree.find(a => a.id === document.getElementById('cvSplitAccount').value);
            if (account) splitCurrencyModal(account);
        };
    }

    function currencyModal(codes) {
        A.formModal({
            title: 'إضافة عملة', size: 'md', submitLabel: 'إضافة العملة',
            fields: [
                { key: 'code', label: 'كود العملة (ISO)', type: 'select', required: true,
                  options: codes.map(c => ({ value: c.code, label: `${c.name} (${c.code})` })) },
                { key: 'symbol', label: 'رمز العملة', required: true, placeholder: 'مثال: ر.س', help: 'یظهر بجانب الحسابات والمبالغ' },
                { key: 'name', label: 'اسم العملة', required: true },
                { key: 'rate', label: `سعر الصرف مقابل ${(cache.baseCurrency || {}).name || 'العملة الأساسية'}`, type: 'number', step: '0.0001', min: 0, required: true,
                  help: `كم ${(cache.baseCurrency || {}).symbol || ''} يساوي 1 من هذه العملة؟` }
            ],
            onOpen: (root, close, form) => {
                const codeSelect = form.querySelector('[name="code"]');
                const fill = () => {
                    const preset = A.CURRENCIES.find(c => c.code === codeSelect.value);
                    const symbolInput = form.querySelector('[name="symbol"]');
                    const nameInput = form.querySelector('[name="name"]');
                    if (preset && symbolInput && !symbolInput.value) symbolInput.value = preset.symbol;
                    if (preset && nameInput && !nameInput.value) nameInput.value = preset.name;
                };
                codeSelect.onchange = fill;
                fill();
            },
            onSubmit: async data => {
                await A.post('/currencies', data);
                A.closeModal();
                A.toast('تمت إضافة العملة');
                await refreshAll();
            }
        });
    }

    // ═══════════════════ الإقفال السنوي ═══════════════════
    function renderYearEnd(body) {
        const equity = cache.tree.filter(a => !a.isGroup && (a.type === 'equity' || a.type === 'liability'));
        const options = equity.length ? equity : cache.tree.filter(a => !a.isGroup);
        body.innerHTML = `
            <div class="alert info mb">${A.icon('alert')}<div>
                الإقفال السنوي يُرحّل أرصدة الإيرادات والمصروفات إلى حساب الأرباح المحتجزة بقيد واحد،
                ثم يقفل الفترة حتى نهاية السنة فلا يُقبل فيها إنشاء أو تعديل أو إلغاء أي سند.
                راجع المسودات قبل الإقفال — أي سند مسودة في الفترة يمنع الإقفال.
            </div></div>
            <div class="card card-pad mb">
                <div class="row" style="align-items:flex-end">
                    <div class="field" style="margin:0"><label>السنة المالية</label>
                        <input type="number" id="yeYear" min="2000" max="2100" value="${h(filters.yearEndYear)}" style="width:110px"></div>
                    <div class="field" style="margin:0;min-width:280px"><label>حساب الأرباح المحتجزة</label>
                        <select id="yeRetained"><option value="">— تلقائي (3102) —</option>
                        ${options.map(a => `<option value="${h(a.id)}" ${filters.yearEndRetained === a.id ? 'selected' : ''}>${h((a.code ? a.code + ' — ' : '') + a.name)}</option>`).join('')}</select></div>
                    <div class="field" style="margin:0"><label>&nbsp;</label>
                        <button class="btn btn-primary" id="yePreview">${A.icon('search')} معاينة الإقفال</button></div>
                    <span class="grow"></span>
                    <button class="btn btn-sm" id="yeRefresh">${A.icon('refresh')} تحديث</button>
                </div>
            </div>
            <div id="yeResult"><div class="empty">اختر السنة واضغط «معاينة الإقفال»</div></div>`;
        const preview = async () => {
            filters.yearEndYear = parseInt(document.getElementById('yeYear').value, 10) || new Date().getFullYear();
            filters.yearEndRetained = document.getElementById('yeRetained').value;
            const box = document.getElementById('yeResult');
            box.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                const res = await A.get(`/accounting/year-end?year=${filters.yearEndYear}&retainedAccountId=${encodeURIComponent(filters.yearEndRetained)}`);
                renderYearEndResult(box, res.data);
            } catch (err) {
                box.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            }
        };
        document.getElementById('yePreview').onclick = preview;
        document.getElementById('yeRefresh').onclick = () => refreshAll();
        if (filters.yearEndYear) preview();
    }

    function renderYearEndResult(box, data) {
        const stateBadge = data.closed
            ? `<span class="badge danger">مقفلة</span>`
            : `<span class="badge success">مفتوحة</span>`;
        const names = {};
        cache.tree.forEach(a => { names[a.id] = `${a.code} — ${a.name}`; });
        box.innerHTML = `
            <div class="grid grid-4 mb">
                <div class="kpi"><div class="kpi-top"><span>إيرادات ${h(data.year)}</span>${A.icon('download')}</div><div class="kpi-value">${money(data.revenue)}</div></div>
                <div class="kpi warn"><div class="kpi-top"><span>مصروفات ${h(data.year)}</span>${A.icon('upload')}</div><div class="kpi-value">${money(data.expense)}</div></div>
                <div class="kpi ${data.profit < 0 ? 'danger' : 'purple'}"><div class="kpi-top"><span>صافي الربح / الخسارة</span>${A.icon('chart')}</div><div class="kpi-value">${money(data.profit)}</div></div>
                <div class="kpi"><div class="kpi-top"><span>حالة السنة</span>${A.icon('file')}</div><div class="kpi-value" style="font-size:18px">${stateBadge}</div>
                    <div class="small muted">${h(data.from)} → ${h(data.to)}</div></div>
            </div>
            ${(data.warnings || []).map(w => `<div class="alert ${w.level === 'danger' ? 'danger' : 'info'} mb">${A.icon('alert')}<div>${h(w.text)}</div></div>`).join('')}
            <div class="grid grid-2 mb">
                <div class="card"><div class="card-head"><h3>أرصدة الإيرادات والمصروفات</h3><span class="spacer"></span><span class="small muted">${A.numFmt(data.rows.length)} حساب</span></div>
                    <div class="card-pad" style="padding:0">${A.table({
                        columns: [
                            { key: 'code', label: 'الكود' },
                            { key: 'name', label: 'الحساب' },
                            { key: 'typeLabel', label: 'النوع' },
                            { key: 'balance', label: 'الرصيد', align: 'left', render: r => money(r.balance) },
                            { key: 'entrySide', label: 'طرف الإقفال', render: r => r.entrySide === 'debit' ? 'مدين' : 'دائن' }
                        ], rows: data.rows, empty: 'لا توجد أرصدة مفتوحة في هذه السنة'
                    })}</div></div>
                <div class="card"><div class="card-head"><h3>قيد الإقفال المقترح</h3></div>
                    <div class="card-pad" style="padding:0">${A.table({
                        columns: [
                            { key: 'accountId', label: 'الحساب', render: r => h(names[r.accountId] || r.accountId) },
                            { key: 'description', label: 'البيان' },
                            { key: 'debit', label: 'مدين', align: 'left', render: r => r.debit ? money(r.debit) : '' },
                            { key: 'credit', label: 'دائن', align: 'left', render: r => r.credit ? money(r.credit) : '' }
                        ], rows: data.lines, empty: 'لا يوجد قيد مقترح'
                    })}</div></div>
            </div>
            <div class="card card-pad mb">
                <div class="row" style="gap:10px;flex-wrap:wrap">
                    ${!data.closed ? `<button class="btn btn-primary" id="yeClose">${A.icon('checkCircle')} إقفال السنة ${h(data.year)}</button>` : ''}
                    ${data.closed ? `<button class="btn btn-danger" id="yeReopen">${A.icon('refresh')} إعادة فتح السنة ${h(data.year)}</button>` : ''}
                    <span class="grow"></span>
                    <span class="small muted">حساب الأرباح المحتجزة: ${h(data.retained.name || '—')} · قفل حتى: ${h(data.lockedThrough || '—')}</span>
                </div>
            </div>
            <div class="card"><div class="card-head"><h3>سجل الإقفالات</h3></div>
                <div class="card-pad" style="padding:0">${A.table({
                    columns: [
                        { key: 'year', label: 'السنة' },
                        { key: 'from', label: 'من', render: r => A.date(r.from) },
                        { key: 'to', label: 'إلى', render: r => A.date(r.to) },
                        { key: 'voucherNumber', label: 'قيد الإقفال' },
                        { key: 'profit', label: 'صافي الربح', align: 'left', render: r => money(r.profit) },
                        { key: 'closedAt', label: 'تاريخ الإقفال', render: r => A.dateTime(r.closedAt) }
                    ], rows: data.history || [], empty: 'لا توجد سنوات مقفلة بعد'
                })}</div></div>`;

        const closeBtn = document.getElementById('yeClose');
        if (closeBtn) closeBtn.onclick = async () => {
            const warn = data.drafts ? `\nيوجد ${data.drafts} سند مسودة في الفترة، سيُتجاوز فحصها.` : '';
            if (!(await A.confirm({ title: `إقفال السنة ${data.year}`,
                message: `سيُنشأ قيد إقفال بقيمة صافي ${data.profit >= 0 ? 'ربح' : 'خسارة'} ${money(Math.abs(data.profit))} ويُقفل كل السندات حتى ${data.to}.${warn}`,
                confirmLabel: 'إقفال السنة' }))) return;
            try {
                const res = await A.post('/accounting/year-end/close', {
                    year: data.year, retainedAccountId: data.retained.id || '',
                    notes: '', force: data.drafts > 0
                });
                A.toast((res && res.message) || 'تم الإقفال', 'success');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        };
        const reopenBtn = document.getElementById('yeReopen');
        if (reopenBtn) reopenBtn.onclick = async () => {
            if (!(await A.confirm({ title: `إعادة فتح السنة ${data.year}`,
                message: 'سيُلغى قيد الإقفال وتُفتح الفترة للتعديل. متابعة؟', danger: true, confirmLabel: 'إعادة الفتح' }))) return;
            try {
                await A.post('/accounting/year-end/reopen', { year: data.year, reason: 'إعادة فتح من الواجهة' });
                A.toast('تم إعادة فتح السنة');
                await refreshAll();
            } catch (err) { A.toast(err.message, 'error'); }
        };
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
