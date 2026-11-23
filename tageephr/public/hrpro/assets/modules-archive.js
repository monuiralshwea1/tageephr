'use strict';

/* ═══════════════════════════════════════════════════════════════
   وحدة الأرشيف الإلكتروني: أرشفة الملفات والسندات ومستندات
   الموظفين مع فلاتر شاملة (التاريخ، الاسم، الرقم، الفرع، التصنيف)
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const h = A.h;

    A.registerRoutes([
        {
            path: 'archive', module: 'archive', label: 'الأرشيف الإلكتروني',
            subtitle: 'أرشفة الملفات والسندات ومستندات الموظفين مع بحث وفلاتر شاملة',
            icon: 'file', group: 'المكتبة والأرشفة', permission: 'archive'
        }
    ]);

    const KINDS = { document: 'مستند', voucher: 'سند محاسبي', employee: 'ملف موظف', contract: 'عقد', other: 'أخرى' };
    const STATUS = { active: ['نشط', 'success'], archived: ['مؤرشف', ''] };
    const PREVIEWABLE = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'txt', 'csv'];
    const MIME = {
        pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
        txt: 'text/plain', csv: 'text/csv'
    };

    const cache = { categories: [], employees: [], overview: null, items: [], total: 0, pages: 1, facets: {}, vouchers: [] };
    const filters = {
        q: '', categoryId: '', kind: '', employeeId: '', branchId: '',
        from: '', to: '', tags: '', status: '', sort: 'archivedAt', order: 'desc'
    };
    let activeTab = 'library';
    let page = 1;
    let pageSize = 25;
    let container = null;
    let searchTimer = null;

    const branches = () => A.state.data.branches || [];
    const categoryById = id => (cache.categories || []).find(c => c.id === id) || {};
    const kindLabel = kind => KINDS[kind] || KINDS.document;
    const extOf = name => String(name || '').split('.').pop().toLowerCase();
    const mimeOf = item => MIME[extOf(item.fileName || item.storedName)] || 'application/octet-stream';
    const sizeText = bytes => {
        const value = Number(bytes) || 0;
        if (!value) return '—';
        if (value < 1024) return `${A.numFmt(value, 0)} B`;
        if (value < 1024 * 1024) return `${A.numFmt(value / 1024, 1)} KB`;
        return `${A.numFmt(value / (1024 * 1024), 2)} MB`;
    };
    const badge = status => {
        const entry = STATUS[status] || STATUS.active;
        return `<span class="badge ${entry[1]}">${h(entry[0])}</span>`;
    };
    const expiryCell = date => {
        if (!date) return '<span class="small muted">—</span>';
        const day = String(date).slice(0, 10);
        const today = A.today();
        const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        if (day < today) return `<span style="color:var(--danger);font-weight:600">${A.date(day)}</span>`;
        if (day <= soon) return `<span style="color:#d97706;font-weight:600">${A.date(day)}</span>`;
        return A.date(day);
    };

    function queryString(extra) {
        const params = new URLSearchParams();
        Object.entries({ ...filters, page, pageSize, ...(extra || {}) }).forEach(([key, value]) => {
            if (value !== '' && value !== null && value !== undefined) params.set(key, value);
        });
        return params.toString();
    }

    function readFilters() {
        const read = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        filters.q = read('arcSearch').trim();
        filters.categoryId = read('arcCategory');
        filters.kind = read('arcKind');
        filters.employeeId = read('arcEmployee');
        filters.branchId = read('arcBranch');
        filters.from = read('arcFrom');
        filters.to = read('arcTo');
        filters.tags = read('arcTags').trim();
        filters.status = read('arcStatus');
    }

    // ═══════════════ الإطار ═══════════════
    const TABS = [
        { id: 'library', label: 'الأرشيف' },
        { id: 'employees', label: 'أرشيف الموظفين' },
        { id: 'vouchers', label: 'سندات محفوظة' },
        { id: 'categories', label: 'التصنيفات' }
    ];

    function render() {
        if (!container) return;
        container.innerHTML = `<div class="tabs" id="arcTabs">${TABS.map(t => `<button class="tab ${t.id === activeTab ? 'active' : ''}" data-arc-tab="${t.id}">${h(t.label)}</button>`).join('')}</div>
            <div class="tab-pane" id="arcBody" style="padding:18px 4px"></div>`;
        container.querySelectorAll('[data-arc-tab]').forEach(btn => btn.onclick = () => {
            activeTab = btn.dataset.arcTab;
            render();
        });
        const body = document.getElementById('arcBody');
        if (!body) return;
        if (activeTab === 'library') renderLibrary(body);
        else if (activeTab === 'employees') renderEmployees(body);
        else if (activeTab === 'vouchers') renderVouchersTab(body);
        else renderCategories(body);
    }

    async function loadMeta() {
        const [categories, employees, overview] = await Promise.all([
            A.get('/collections/archiveCategories').catch(() => ({ data: [] })),
            A.get('/parties?type=employee').catch(() => ({ data: [] })),
            A.get('/archive/overview').catch(() => ({ data: {} }))
        ]);
        cache.categories = categories.data || [];
        cache.employees = employees.data || [];
        cache.overview = overview.data || {};
    }

    async function loadItems() {
        const res = await A.get('/archive/items?' + queryString());
        cache.items = res.data || [];
        cache.total = res.total || 0;
        cache.pages = res.pages || 1;
        cache.facets = res.facets || {};
        page = res.page || page;
    }

    // ═══════════════ المكتبة ═══════════════
    function renderLibrary(body) {
        const s = cache.overview || {};
        const kpi = (label, value, icon, tone) => `<div class="kpi ${tone || ''}"><div class="kpi-top"><span>${h(label)}</span>${A.icon(icon)}</div><div class="kpi-value">${value}</div></div>`;
        const categoryOptions = cache.categories.map(c => `<option value="${h(c.id)}" ${filters.categoryId === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('');
        const employeeOptions = cache.employees
            .map(e => `<option value="${h(e.id)}" ${filters.employeeId === e.id ? 'selected' : ''}>${h(e.name)}${e.code ? ' — ' + h(e.code) : ''}</option>`).join('');
        body.innerHTML = `
            <div class="grid grid-4 mb">
                ${kpi('ملفات مؤرشفة', A.numFmt(s.total || 0), 'file')}
                ${kpi('حجم الأرشيف', sizeText(s.size), 'database', 'info')}
                ${kpi('موظفون لديهم أرشيف', A.numFmt(s.employees || 0), 'users', 'purple')}
                ${kpi('تنتهي خلال 30 يومًا', A.numFmt(s.expiring || 0), 'alert', (s.expiring ? 'warn' : ''))}
            </div>
            <div class="card card-pad mb">
                <div class="row" style="align-items:flex-end;gap:10px">
                    <div class="field" style="margin:0;min-width:220px"><label>بحث شامل</label>
                        <input id="arcSearch" value="${h(filters.q)}" placeholder="اسم الملف أو رقمه أو الموظف أو السند"></div>
                    <div class="field" style="margin:0"><label>التصنيف</label>
                        <select id="arcCategory"><option value="">كل التصنيفات</option>${categoryOptions}</select></div>
                    <div class="field" style="margin:0"><label>النوع</label>
                        <select id="arcKind"><option value="">كل الأنواع</option>
                        ${Object.keys(KINDS).map(k => `<option value="${k}" ${filters.kind === k ? 'selected' : ''}>${h(KINDS[k])}</option>`).join('')}</select></div>
                    <div class="field" style="margin:0;min-width:170px"><label>الموظف</label>
                        <select id="arcEmployee"><option value="">كل الموظفين</option>${employeeOptions}</select></div>
                    <div class="field" style="margin:0;min-width:150px"><label>الفرع</label>
                        <select id="arcBranch"><option value="">كل الفروع</option>
                        ${branches().map(b => `<option value="${h(b.id)}" ${filters.branchId === b.id ? 'selected' : ''}>${h(b.name)}</option>`).join('')}</select></div>
                </div>
                <div class="row mt" style="align-items:flex-end;gap:10px">
                    <div class="field" style="margin:0"><label>أرشيف من</label><input type="date" id="arcFrom" value="${h(filters.from)}"></div>
                    <div class="field" style="margin:0"><label>إلى</label><input type="date" id="arcTo" value="${h(filters.to)}"></div>
                    <div class="field" style="margin:0;min-width:150px"><label>وسم</label><input id="arcTags" value="${h(filters.tags)}" placeholder="مثال: 2026"></div>
                    <div class="field" style="margin:0"><label>الحالة</label>
                        <select id="arcStatus"><option value="">الكل</option>
                        ${Object.keys(STATUS).map(k => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${h(STATUS[k][0])}</option>`).join('')}</select></div>
                    <span class="grow"></span>
                    <button class="btn btn-sm" id="arcReset">${A.icon('refresh')} مسح الفلاتر</button>
                    ${A.can('archive', 'add') ? `<button class="btn btn-primary" id="arcUpload">${A.icon('upload')} أرشفة ملف</button>` : ''}
                    <button class="btn" id="arcExport">${A.icon('download')} Excel</button>
                </div>
            </div>
            <div class="card">
                <div class="card-head"><h3>الملفات المؤرشفة</h3><span class="spacer"></span>
                    <span class="small muted">${A.numFmt(cache.total)} ملف</span></div>
                <div class="card-pad" style="padding:0">
                    ${A.table({
                        columns: [
                            {
                                key: 'title', label: 'العنوان',
                                render: r => `<div style="display:flex;align-items:center;gap:8px">
                                    <span style="width:4px;height:26px;border-radius:3px;background:${h(categoryById(r.categoryId).color || 'var(--line)')}"></span>
                                    <div><strong>${h(r.title)}</strong>
                                    <div class="small muted">${h(r.fileName || 'بدون ملف')}${r.fileName ? ' — ' + sizeText(r.size) : ''}</div></div></div>`
                            },
                            { key: 'categoryName', label: 'التصنيف', render: r => h(r.categoryName || categoryById(r.categoryId).name || '—') },
                            { key: 'kind', label: 'النوع', render: r => `<span class="badge">${h(kindLabel(r.kind))}</span>` },
                            { key: 'employeeName', label: 'الموظف', render: r => r.employeeId ? `${h(r.employeeName)}<div class="small muted">${h(r.employeeNumber || '')}</div>` : '<span class="small muted">—</span>' },
                            { key: 'branchName', label: 'الفرع', render: r => h(r.branchName || '—') },
                            { key: 'documentNumber', label: 'رقم المستند', render: r => r.voucherNumber ? `<span class="badge info">${h(r.voucherNumber)}</span>` : h(r.documentNumber || '—') },
                            { key: 'archivedAt', label: 'تاريخ الأرشفة', render: r => A.date(String(r.archivedAt || '').slice(0, 10)) },
                            { key: 'expiryDate', label: 'الانتهاء', render: r => expiryCell(r.expiryDate) },
                            { key: 'status', label: 'الحالة', render: r => badge(r.status) }
                        ],
                        rows: cache.items,
                        empty: 'لا توجد ملفات مؤرشفة مطابقة — اضغط «أرشفة ملف» للبدء',
                        actions: row => {
                            const acts = [];
                            if (row.storedName) {
                                if (PREVIEWABLE.includes(extOf(row.fileName || row.storedName))) {
                                    acts.push({ html: `<button class="btn btn-icon btn-sm" title="معاينة" data-arc-view="${h(row.id)}">${A.icon('eye')}</button>` });
                                }
                                acts.push({ html: `<button class="btn btn-icon btn-sm" title="تنزيل" data-arc-down="${h(row.id)}">${A.icon('download')}</button>` });
                            }
                            if (A.can('archive', 'edit')) acts.push({ html: `<button class="btn btn-icon btn-sm" title="تعديل البيانات" data-arc-edit="${h(row.id)}">${A.icon('edit')}</button>` });
                            if (A.can('archive', 'delete')) acts.push({ html: `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-arc-del="${h(row.id)}">${A.icon('trash')}</button>` });
                            return acts;
                        }
                    })}
                </div>
                <div class="row" style="justify-content:space-between;align-items:center;padding:10px 16px;border-top:1px solid var(--line)">
                    <span class="small muted">صفحة ${A.numFmt(page)} من ${A.numFmt(cache.pages)} — ${A.numFmt(cache.total)} نتيجة</span>
                    <div class="row" style="gap:6px">
                        <button class="btn btn-sm" id="arcPrev" ${page <= 1 ? 'disabled' : ''}>السابق</button>
                        <button class="btn btn-sm" id="arcNext" ${page >= cache.pages ? 'disabled' : ''}>التالي</button>
                    </div>
                </div>
            </div>`;

        const bind = id => document.getElementById(id);
        ['arcCategory', 'arcKind', 'arcEmployee', 'arcBranch', 'arcFrom', 'arcTo', 'arcStatus'].forEach(id => {
            const el = bind(id);
            if (el) el.onchange = () => { readFilters(); page = 1; refresh(); };
        });
        const search = bind('arcSearch');
        if (search) search.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { readFilters(); page = 1; refresh(); }, 350);
        };
        const tags = bind('arcTags');
        if (tags) tags.onkeydown = e => { if (e.key === 'Enter') { readFilters(); page = 1; refresh(); } };
        bind('arcReset').onclick = () => {
            Object.keys(filters).forEach(key => { filters[key] = key === 'sort' ? 'archivedAt' : key === 'order' ? 'desc' : ''; });
            page = 1;
            refresh();
        };
        bind('arcPrev').onclick = () => { if (page > 1) { page -= 1; refresh(); } };
        bind('arcNext').onclick = () => { if (page < cache.pages) { page += 1; refresh(); } };
        bind('arcExport').onclick = () => A.downloadPost('/archive/export', { ...filters }, `archive-${A.today()}.xlsx`)
            .catch(err => A.toast(err.message, 'error'));
        const upload = bind('arcUpload');
        if (upload) upload.onclick = () => openItemModal(null, { kind: 'document' });

        body.querySelectorAll('[data-arc-view]').forEach(b => b.onclick = () => previewItem(b.dataset.arcView));
        body.querySelectorAll('[data-arc-down]').forEach(b => b.onclick = () => downloadItem(b.dataset.arcDown));
        body.querySelectorAll('[data-arc-edit]').forEach(b => b.onclick = () => {
            const item = cache.items.find(r => r.id === b.dataset.arcEdit);
            if (item) openItemModal(item);
        });
        body.querySelectorAll('[data-arc-del]').forEach(b => b.onclick = () => deleteItem(b.dataset.arcDel, refresh));
    }

    async function refresh() {
        try {
            await Promise.all([loadMeta(), loadItems()]);
            render();
        } catch (err) { A.toast(err.message, 'error'); }
    }

    // ═══════════════ أرشيف الموظفين ═══════════════
    async function renderEmployees(body) {
        body.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
        let rows = [];
        let unlinked = 0;
        try {
            const res = await A.get('/archive/employee-summary');
            rows = res.data || [];
            unlinked = res.unlinked || 0;
        } catch (err) {
            body.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            return;
        }
        const withFiles = rows.filter(r => r.count > 0);
        body.innerHTML = `
            <div class="grid grid-3 mb">
                <div class="kpi"><div class="kpi-top"><span>موظفون لديهم أرشيف</span>${A.icon('users')}</div><div class="kpi-value">${A.numFmt(withFiles.length)}</div></div>
                <div class="kpi info"><div class="kpi-top"><span>ملفات مرتبطة بموظف</span>${A.icon('file')}</div><div class="kpi-value">${A.numFmt(withFiles.reduce((sum, r) => sum + r.count, 0))}</div></div>
                <div class="kpi purple"><div class="kpi-top"><span>ملفات غير مرتبطة</span>${A.icon('alert')}</div><div class="kpi-value">${A.numFmt(unlinked)}</div></div>
            </div>
            <div class="alert info mb">${A.icon('alert')}<div>كل ملف يُربط بموظف يظهر في ملفه الشخصي عبر شاشة الأرشيف — اختر الموظف لعرض مستنداته وعقوده وهويته في مكان واحد.</div></div>
            <div class="card"><div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'employeeName', label: 'الموظف' },
                    { key: 'employeeNumber', label: 'الرقم' },
                    { key: 'branchName', label: 'الفرع' },
                    { key: 'jobTitle', label: 'المسمى الوظيفي' },
                    { key: 'count', label: 'عدد الملفات', align: 'left', render: r => `<strong>${A.numFmt(r.count)}</strong>` },
                    { key: 'size', label: 'الحجم', align: 'left', render: r => sizeText(r.size) },
                    { key: 'last', label: 'آخر أرشفة', render: r => r.last ? A.date(r.last) : '—' },
                    { key: 'expiring', label: 'تنتهي قريبًا', align: 'left', render: r => r.expiring ? `<span class="badge warn">${A.numFmt(r.expiring)}</span>` : '—' }
                ],
                rows,
                empty: 'لا يوجد موظفون',
                actions: row => [
                    { html: `<button class="btn btn-sm" data-arc-emp="${h(row.employeeId)}">${A.icon('file')} ملفاته (${A.numFmt(row.count)})</button>` },
                    A.can('archive', 'add') ? { html: `<button class="btn btn-icon btn-sm" title="أرشفة ملف لهذا الموظف" data-arc-emp-add="${h(row.employeeId)}">${A.icon('plus')}</button>` } : null
                ].filter(Boolean)
            })}
            </div></div>`;
        body.querySelectorAll('[data-arc-emp]').forEach(b => b.onclick = () => {
            filters.employeeId = b.dataset.arcEmp;
            filters.categoryId = '';
            activeTab = 'library';
            page = 1;
            refresh();
        });
        body.querySelectorAll('[data-arc-emp-add]').forEach(b => b.onclick = () => {
            const employee = (cache.employees || []).find(e => e.id === b.dataset.arcEmpAdd) || {};
            openItemModal(null, { kind: 'employee', employeeId: employee.id || '', title: `ملف ${employee.name || 'موظف'}` });
        });
    }

    // ═══════════════ السندات المحفوظة ═══════════════
    async function renderVouchersTab(body) {
        body.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
        let rows = [];
        try {
            const res = await A.get('/archive/items?kind=voucher&pageSize=100&sort=archivedAt&order=desc');
            rows = res.data || [];
        } catch (err) {
            body.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            return;
        }
        body.innerHTML = `
            <div class="alert info mb">${A.icon('alert')}<div>لأرشفة سند: اضغط «أرشفة ملف» واختر النوع «سند محاسبي» ثم اختر رقم السند — تُربط نسخة السند ورقمه ومرفقاته بالأرشيف وتظهر في فلاتر البحث.</div></div>
            <div class="toolbar mb" style="border:0"><span class="small muted">${A.numFmt(rows.length)} سند مؤرشف</span><span class="grow"></span>
                ${A.can('archive', 'add') ? `<button class="btn btn-primary" id="arcVoucherAdd">${A.icon('plus')} أرشفة سند</button>` : ''}</div>
            <div class="card"><div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'voucherNumber', label: 'رقم السند' },
                    { key: 'title', label: 'العنوان' },
                    { key: 'documentNumber', label: 'المرجع' },
                    { key: 'archivedAt', label: 'تاريخ الأرشفة', render: r => A.date(String(r.archivedAt || '').slice(0, 10)) },
                    { key: 'size', label: 'الحجم', align: 'left', render: r => sizeText(r.size) }
                ],
                rows,
                empty: 'لا توجد سندات مؤرشفة — ابدأ بأرشفة أول سند',
                actions: row => [
                    row.storedName ? { html: `<button class="btn btn-icon btn-sm" title="تنزيل" data-arc-down="${h(row.id)}">${A.icon('download')}</button>` } : null
                ].filter(Boolean)
            })}
            </div></div>`;
        const add = document.getElementById('arcVoucherAdd');
        if (add) add.onclick = () => openItemModal(null, { kind: 'voucher' });
        body.querySelectorAll('[data-arc-down]').forEach(b => b.onclick = async () => {
            const item = rows.find(r => r.id === b.dataset.arcDown);
            if (!item) return;
            A.downloadGet('/archive/file/' + item.id, item.fileName || `archive-${item.id}`)
                .catch(err => A.toast(err.message, 'error'));
        });
    }

    // ═══════════════ التصنيفات ═══════════════
    function renderCategories(body) {
        body.innerHTML = `
            <div class="toolbar mb" style="border:0">
                <span class="small muted">${A.numFmt(cache.categories.length)} تصنيف — تنظم الفلاتر وتلوين الملفات</span>
                <span class="grow"></span>
                ${A.can('archive', 'add') ? `<button class="btn btn-primary" id="arcCatAdd">${A.icon('plus')} تصنيف جديد</button>` : ''}
            </div>
            <div class="card"><div class="card-pad" style="padding:0">
            ${A.table({
                columns: [
                    { key: 'name', label: 'التصنيف', render: r => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${h(r.color || '#0d9488')};margin-inline-end:8px"></span>${h(r.name)}` },
                    { key: 'description', label: 'الوصف' },
                    { key: 'count', label: 'ملفات', align: 'left', render: r => A.numFmt(((cache.overview || {}).byCategory || {})[r.id] || 0) }
                ],
                rows: cache.categories,
                empty: 'لا توجد تصنيفات',
                actions: row => [
                    A.can('archive', 'edit') ? { html: `<button class="btn btn-icon btn-sm" title="تعديل" data-cat-edit="${h(row.id)}">${A.icon('edit')}</button>` } : null,
                    A.can('archive', 'delete') ? { html: `<button class="btn btn-icon btn-sm btn-danger" title="حذف" data-cat-del="${h(row.id)}">${A.icon('trash')}</button>` } : null
                ].filter(Boolean)
            })}
            </div></div>`;
        const add = document.getElementById('arcCatAdd');
        if (add) add.onclick = () => categoryModal(null);
        body.querySelectorAll('[data-cat-edit]').forEach(b => b.onclick = () => {
            const row = cache.categories.find(c => c.id === b.dataset.catEdit);
            if (row) categoryModal(row);
        });
        body.querySelectorAll('[data-cat-del]').forEach(b => b.onclick = async () => {
            const row = cache.categories.find(c => c.id === b.dataset.catDel);
            if (!row) return;
            if (!(await A.confirm({ title: 'حذف التصنيف', message: `حذف «${h(row.name)}»؟ الملفات ستبقى بدون تصنيف.`, danger: true, confirmLabel: 'حذف' }))) return;
            try {
                await A.del('/collections/archiveCategories/' + row.id);
                A.toast('تم حذف التصنيف');
                await loadMeta();
                render();
            } catch (err) { A.toast(err.message, 'error'); }
        });
    }

    function categoryModal(row) {
        A.formModal({
            title: row ? 'تعديل تصنيف' : 'تصنيف أرشيف جديد',
            size: 'sm',
            fields: [
                { key: 'name', label: 'اسم التصنيف', required: true, default: row ? row.name : '' },
                { key: 'color', label: 'اللون', type: 'color', default: row ? (row.color || '#0d9488') : '#0d9488' },
                { key: 'description', label: 'الوصف', type: 'textarea', full: true, default: row ? (row.description || '') : '' }
            ],
            onSubmit: async data => {
                if (row) await A.put('/collections/archiveCategories/' + row.id, data);
                else await A.post('/collections/archiveCategories', data);
                A.closeModal();
                A.toast('تم حفظ التصنيف');
                await loadMeta();
                render();
            }
        });
    }

    // ═══════════════ إضافة / تعديل ملف ═══════════════
    function openItemModal(item, preset) {
        const isEdit = !!item;
        const base = item || {};
        const options = {
            kind: base.kind || (preset && preset.kind) || 'document',
            employeeId: base.employeeId || (preset && preset.employeeId) || '',
            title: base.title || (preset && preset.title) || ''
        };
        const categoryOptions = cache.categories.map(c => `<option value="${h(c.id)}" ${base.categoryId === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('');
        const employeeOptions = cache.employees.map(e => `<option value="${h(e.id)}" ${options.employeeId === e.id ? 'selected' : ''}>${h(e.name)}${e.code ? ' — ' + h(e.code) : ''}</option>`).join('');
        const branchOptions = branches().map(b => `<option value="${h(b.id)}" ${base.branchId === b.id ? 'selected' : ''}>${h(b.name)}</option>`).join('');
        const modal = A.rawModal({
            title: isEdit ? 'تعديل بيانات ملف مؤرشف' : 'أرشفة ملف جديد',
            size: 'lg',
            body: `
                <div class="form-grid">
                    <div class="field full"><label>عنوان الملف *</label><input id="arcTitle" value="${h(options.title)}" placeholder="مثال: عقد عمل — محمد علي"></div>
                    <div class="field"><label>التصنيف</label><select id="arcCat">${categoryOptions || '<option value="">— بدون تصنيف —</option>'}</select></div>
                    <div class="field"><label>النوع</label><select id="arcKindSel">
                        ${Object.keys(KINDS).map(k => `<option value="${k}" ${options.kind === k ? 'selected' : ''}>${h(KINDS[k])}</option>`).join('')}
                    </select></div>
                    <div class="field"><label>الموظف</label><select id="arcEmp"><option value="">— غير مرتبط —</option>${employeeOptions}</select>
                        <div class="help">عند الاختيار يُربط الملف بملف الموظف ويُملأ الفرع تلقائيًا</div></div>
                    <div class="field"><label>الفرع</label><select id="arcBranchSel"><option value="">— بدون —</option>${branchOptions}</select></div>
                    <div class="field"><label>رقم / مرجع المستند</label><input id="arcDocNo" value="${h(base.documentNumber || '')}"></div>
                    <div class="field"><label>السند المرتبط</label><select id="arcVoucher"><option value="">— بدون سند —</option></select>
                        <div class="help">اختر سندًا محاسبيًا لربط نسخته بالأرشيف</div></div>
                    <div class="field"><label>تاريخ الإصدار</label><input type="date" id="arcIssue" value="${h(base.issueDate || '')}"></div>
                    <div class="field"><label>تاريخ الانتهاء</label><input type="date" id="arcExpiry" value="${h(base.expiryDate || '')}"></div>
                    <div class="field"><label>الحالة</label><select id="arcStatusSel">
                        ${Object.keys(STATUS).map(k => `<option value="${k}" ${(base.status || 'active') === k ? 'selected' : ''}>${h(STATUS[k][0])}</option>`).join('')}
                    </select></div>
                    <div class="field"><label>الوسوم (مفصولة بفاصلة)</label><input id="arcTagsInput" value="${h((base.tags || []).join(', '))}" placeholder="عقد، 2026"></div>
                    <div class="field full"><label>الوصف</label><textarea id="arcDesc" rows="2">${h(base.description || '')}</textarea></div>
                    <div class="field checkbox"><input type="checkbox" id="arcConf" ${base.confidential ? 'checked' : ''}><label for="arcConf">ملف سري (عرض محدود)</label></div>
                    ${isEdit ? `<div class="full small muted">الملف الحالي: ${h(base.fileName || 'بدون ملف')} — لتغيير الملف احذف السجل وأرشفه من جديد.</div>`
                        : `<div class="field full"><label>الملف (حتى 25 ميجابايت)</label><input type="file" id="arcFile">
                           <div class="help">PDF، صور، Word، Excel، ZIP — يُحفظ الملف في مجلد الأرشيف الخاص بالموقع</div></div>`}
                    <div class="field full"><label>ملاحظات</label><textarea id="arcNotes" rows="2">${h(base.notes || '')}</textarea></div>
                </div>`,
            footer: `<button class="btn btn-primary" id="arcSave">${A.icon('check')} ${isEdit ? 'حفظ التعديلات' : 'أرشفة'}</button>
                     <button class="btn" data-close>إلغاء</button>`
        });
        const body = modal.querySelector('.modal-body');
        const presetEmployee = cache.employees.find(e => e.id === options.employeeId);
        if (!base.branchId && presetEmployee && presetEmployee.branchId) {
            body.querySelector('#arcBranchSel').value = presetEmployee.branchId;
        }
        const fileInput = body.querySelector('#arcFile');
        if (fileInput) fileInput.onchange = () => {
            const file = fileInput.files && fileInput.files[0];
            const titleInput = body.querySelector('#arcTitle');
            if (file && titleInput && !titleInput.value.trim()) titleInput.value = file.name.replace(/\.[^.]+$/, '');
        };
        body.querySelector('#arcEmp').onchange = e => {
            const employee = cache.employees.find(x => x.id === e.target.value);
            if (employee && employee.branchId) {
                const branchSelect = body.querySelector('#arcBranchSel');
                if (branchSelect) branchSelect.value = employee.branchId;
            }
            const titleInput = body.querySelector('#arcTitle');
            if (employee && titleInput && !titleInput.value.trim()) titleInput.value = `ملف ${employee.name}`;
        };
        // قائمة السندات للربط (تُحمّل عند الحاجة فقط)
        const selectedVoucherId = base.voucherId || (preset && preset.voucherId) || '';
        let vouchersLoaded = false;
        const loadVoucherOptions = async () => {
            if (vouchersLoaded) return;
            vouchersLoaded = true;
            try {
                const res = await A.get('/archive/vouchers');
                const select = body.querySelector('#arcVoucher');
                select.innerHTML = `<option value="">— بدون سند —</option>` + (res.data || []).map(v =>
                    `<option value="${h(v.id)}" data-number="${h(v.number)}" ${selectedVoucherId === v.id ? 'selected' : ''}>${h(v.number)} — ${A.date(v.date)} ${v.party ? '— ' + h(v.party) : ''}</option>`).join('');
                if (selectedVoucherId) select.value = selectedVoucherId;
            } catch (_) { /* لا صلاحية للسندات */ }
        };
        body.querySelector('#arcVoucher').onfocus = loadVoucherOptions;
        if (selectedVoucherId) loadVoucherOptions();

        const saveBtn = modal.querySelector('#arcSave');
        saveBtn.onclick = async () => {
            const read = id => { const el = body.querySelector(id); return el ? el.value : ''; };
            const payload = {
                title: read('#arcTitle').trim(),
                categoryId: read('#arcCat'),
                categoryName: (cache.categories.find(c => c.id === read('#arcCat')) || {}).name || '',
                kind: read('#arcKindSel'),
                employeeId: read('#arcEmp'),
                branchId: read('#arcBranchSel'),
                documentNumber: read('#arcDocNo').trim(),
                issueDate: read('#arcIssue'),
                expiryDate: read('#arcExpiry'),
                status: read('#arcStatusSel'),
                tags: read('#arcTagsInput').split(/[,،]/).map(t => t.trim()).filter(Boolean),
                description: read('#arcDesc').trim(),
                notes: read('#arcNotes').trim(),
                confidential: !!body.querySelector('#arcConf').checked
            };
            const voucherSelect = body.querySelector('#arcVoucher');
            if (voucherSelect && voucherSelect.value) {
                payload.voucherId = voucherSelect.value;
                payload.voucherNumber = voucherSelect.options[voucherSelect.selectedIndex].dataset.number || '';
                payload.kind = payload.kind || 'voucher';
            }
            if (!payload.title) return A.toast('عنوان الملف مطلوب', 'warning');
            saveBtn.disabled = true;
            try {
                if (isEdit) {
                    await A.put('/collections/archiveItems/' + base.id, payload);
                } else {
                    const file = fileInput && fileInput.files && fileInput.files[0];
                    if (file) {
                        if (file.size > 25 * 1024 * 1024) throw new Error('حجم الملف يتجاوز 25 ميجابايت');
                        const uploaded = await A.upload('/archive/upload', file);
                        const meta = (uploaded && uploaded.message && uploaded.message.data) || (uploaded && uploaded.data) || (uploaded && uploaded.message) || {};
                        payload.storedName = meta.storedName || '';
                        payload.fileName = meta.fileName || file.name;
                        payload.ext = meta.ext || extOf(file.name);
                        payload.size = meta.size || file.size;
                        if (!payload.title) payload.title = file.name.replace(/\.[^.]+$/, '');
                    }
                    await A.post('/collections/archiveItems', payload);
                }
                modal.close();
                A.toast(isEdit ? 'تم تحديث بيانات الملف' : 'تمت أرشفة الملف', 'success');
                await refresh();
            } catch (err) {
                A.toast(err.message, 'error');
            } finally {
                saveBtn.disabled = false;
            }
        };
    }

    // ═══════════════ عمليات الملف ═══════════════
    async function previewItem(id) {
        const item = cache.items.find(r => r.id === id);
        if (!item) return;
        try {
            const url = await A.blobUrl('/archive/file/' + item.id, mimeOf(item));
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (err) { A.toast(err.message, 'error'); }
    }

    function downloadItem(id) {
        const item = cache.items.find(r => r.id === id);
        if (!item) return;
        A.downloadGet('/archive/file/' + item.id, item.fileName || `archive-${item.id}`)
            .catch(err => A.toast(err.message, 'error'));
    }

    async function deleteItem(id, after) {
        const item = cache.items.find(r => r.id === id);
        if (!item) return;
        if (!(await A.confirm({ title: 'حذف من الأرشيف', message: `سيُحذف «${h(item.title)}» وملفه نهائيًا. متابعة؟`, danger: true, confirmLabel: 'حذف' }))) return;
        try {
            await A.del('/collections/archiveItems/' + id);
            A.toast('تم حذف الملف من الأرشيف');
            if (after) await after();
        } catch (err) { A.toast(err.message, 'error'); }
    }

    A.registerModule('archive', {
        render: async view => {
            container = view;
            activeTab = 'library';
            page = 1;
            const pendingEmployee = sessionStorage.getItem('tageep_archive_employee');
            if (pendingEmployee) {
                sessionStorage.removeItem('tageep_archive_employee');
                filters.employeeId = pendingEmployee;
            }
            let pendingVoucher = null;
            try {
                pendingVoucher = JSON.parse(sessionStorage.getItem('tageep_archive_voucher') || 'null');
                sessionStorage.removeItem('tageep_archive_voucher');
            } catch (_) { pendingVoucher = null; }
            view.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
            try {
                await loadMeta();
                await loadItems();
                render();
                if (pendingVoucher && A.can('archive', 'add')) {
                    openItemModal(null, {
                        kind: 'voucher', title: pendingVoucher.title || '',
                        voucherId: pendingVoucher.voucherId || '', voucherNumber: pendingVoucher.voucherNumber || ''
                    });
                }
            } catch (err) {
                view.innerHTML = `<div class="alert danger">${A.icon('alert')}<div>${h(err.message)}</div></div>`;
            }
        }
    });
})();
