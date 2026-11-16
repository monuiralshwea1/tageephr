'use strict';

/**
 * Tageep HRMS — النواة: واجهة API، الحالة، المكونات، التوجيه
 */
(function () {
    const App = {
        token: localStorage.getItem('tageep_token') || '',
        state: { user: null, permissions: {}, data: {} },
        modules: {},
        routes: [],
        currentRoute: null,
        searchQuery: '',
        modalStack: []
    };
    window.App = App;

    // ───────────── أدوات عامة ─────────────
    const escapeHtml = value => String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    App.h = escapeHtml;
    App.num = (value, fallback = 0) => { const v = parseFloat(value); return isNaN(v) ? fallback : v; };
    App.round2 = value => Math.round(((parseFloat(value) || 0) + Number.EPSILON) * 100) / 100;
    App.money = (value, currency) => {
        const v = parseFloat(value) || 0;
        const cur = currency === false ? '' : ' ' + ((App.state.data.settings || {}).currency || 'ر.ي');
        return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + cur;
    };
    App.numFmt = (value, digits = 0) => (parseFloat(value) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    App.date = value => {
        if (!value) return '';
        const s = String(value);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
    };
    App.today = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    App.monthStart = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    };
    App.monthName = m => ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'][(parseInt(m, 10) || 1) - 1];
    App.dateTime = value => {
        if (!value) return '';
        const d = new Date(value);
        if (isNaN(d)) return String(value);
        return `${App.date(d.toISOString().slice(0, 10))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    App.initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');

    // ───────────── العملات والخطوط ─────────────
    App.CURRENCIES = [
        { code: 'YER', symbol: 'ر.ي', name: 'ريال يمني' },
        { code: 'SAR', symbol: 'ر.س', name: 'ريال سعودي' },
        { code: 'USD', symbol: '$', name: 'دولار أمريكي' },
        { code: 'EUR', symbol: '€', name: 'يورو' },
        { code: 'GBP', symbol: '£', name: 'جنيه إسترليني' },
        { code: 'EGP', symbol: 'ج.م', name: 'جنيه مصري' },
        { code: 'AED', symbol: 'د.إ', name: 'درهم إماراتي' },
        { code: 'KWD', symbol: 'د.ك', name: 'دينار كويتي' },
        { code: 'IQD', symbol: 'د.ع', name: 'دينار عراقي' },
        { code: 'BHD', symbol: 'د.ب', name: 'دينار بحريني' },
        { code: 'OMR', symbol: 'ر.ع', name: 'ريال عماني' },
        { code: 'QAR', symbol: 'ر.ق', name: 'ريال قطري' },
        { code: 'JOD', symbol: 'د.أ', name: 'دينار أردني' },
        { code: 'SYP', symbol: 'ل.س', name: 'ليرة سورية' },
        { code: 'SDG', symbol: 'ج.س', name: 'جنيه سوداني' },
        { code: 'TRY', symbol: '₺', name: 'ليرة تركية' }
    ];
    App.currencyOption = symbol => App.CURRENCIES.find(c => c.symbol === symbol) || null;
    App.currencyOptionsHtml = selected => {
        const list = App.CURRENCIES.slice();
        if (selected && !list.some(c => c.symbol === selected)) list.unshift({ code: '', symbol: selected, name: 'عملة مخصصة' });
        return list.map(c => `<option value="${escapeHtml(c.symbol)}" ${c.symbol === selected ? 'selected' : ''}>${escapeHtml(c.name)} — ${escapeHtml(c.symbol)}${c.code ? ' (' + escapeHtml(c.code) + ')' : ''}</option>`).join('');
    };
    App.PRINT_FONTS = [
        { value: '"Segoe UI", Tahoma, sans-serif', label: 'Segoe UI (افتراضي)' },
        { value: 'Tahoma, sans-serif', label: 'Tahoma' },
        { value: 'Arial, sans-serif', label: 'Arial' },
        { value: '"Cairo", "Segoe UI", sans-serif', label: 'Cairo' },
        { value: '"Traditional Arabic", "Times New Roman", serif', label: 'Traditional Arabic' },
        { value: '"Simplified Arabic", Tahoma, serif', label: 'Simplified Arabic' },
        { value: '"Arabic Typesetting", "Traditional Arabic", serif', label: 'Arabic Typesetting' },
        { value: '"Amiri", "Traditional Arabic", serif', label: 'Amiri' },
        { value: '"Times New Roman", serif', label: 'Times New Roman' }
    ];
    App.printFontOptionsHtml = selected => App.PRINT_FONTS.map(f => `<option value="${escapeHtml(f.value)}" ${f.value === selected ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');

    // ───────────── أيقونات ─────────────
    const ICONS = {
        dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/>',
        users: '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>',
        building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01"/>',
        fingerprint: '<path d="M12 10a2 2 0 00-2 2c0 3-1 5-1 5"/><path d="M8 4.5A7 7 0 0119 11c0 3-.5 5-1 6"/><path d="M5 8a8 8 0 0114 5c0 2-.3 4-1 5"/><path d="M12 14v3"/><path d="M8 21c1-1.5 2-4 2-7a2 2 0 014 0"/>',
        palmtree: '<path d="M12 21V9"/><path d="M8 9a4 4 0 018 0"/><path d="M4 11c1-3 4-4 6-2"/><path d="M20 11c-1-3-4-4-6-2"/><path d="M6 21h12"/>',
        wallet: '<path d="M20 7H5a2 2 0 01-2-2 2 2 0 012-2h13v4"/><path d="M3 5v14a2 2 0 002 2h15v-6"/><path d="M16 13h5v4h-5a2 2 0 010-4z"/>',
        credit: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
        chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 5-7"/>',
        bell: '<path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
        logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        edit: '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z"/>',
        trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
        check: '<path d="M20 6L9 17l-5-5"/>',
        x: '<path d="M18 6L6 18M6 6l12 12"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
        download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
        upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
        print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>',
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        alert: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
        key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l3 3"/>',
        menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
        refresh: '<path d="M21 12a9 9 0 11-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
        filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
        eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>',
        more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
        money: '<circle cx="12" cy="12" r="9"/><path d="M8 8h8M8 12h8M12 8v8"/><path d="M9 16h6"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
        briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>',
        arrowLeft: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
        checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
        xCircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
        play: '<path d="M5 3l14 9-14 9z"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
        database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>',
        sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
        exchange: '<path d="M7 3L3 7l4 4"/><path d="M3 7h13a5 5 0 010 10h-1"/><path d="M17 21l4-4-4-4"/><path d="M21 17H8"/>',
        receipt: '<path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
        router: '<rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 17.5h.01M10 17.5h.01"/><path d="M12 14V6"/><path d="M8 6a4 4 0 018 0"/>'
    };
    App.icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.sparkles}</svg>`;

    // ───────────── API ─────────────
    const HRPRO_BASE = window.HRPRO_API_BASE || '/api/method/tageephr.hrpro.api.dispatch';
    function hrproUrl(path) {
        return HRPRO_BASE + '?path=' + encodeURIComponent(path);
    }
    async function api(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (!options.raw && options.body !== undefined) headers['Content-Type'] = 'application/json';
        if (App.token) headers['X-Hrpro-Token'] = App.token;
        if (window.HRPRO_CSRF) headers['X-Frappe-CSRF-Token'] = window.HRPRO_CSRF;
        let response;
        try {
            response = await fetch(hrproUrl(path), { ...options, headers });
        } catch (err) {
            throw new Error('تعذر الاتصال بالخادم. تأكد من تشغيل الخادم ثم أعد المحاولة.');
        }
        const isJson = (response.headers.get('content-type') || '').includes('application/json');
        const payload = isJson ? await response.json().catch(() => ({})) : null;
        const body = payload && payload.message !== undefined ? payload.message : payload;
        if (body && body.__error) {
            if (body.status === 401 && !path.startsWith('/auth/login')) {
                App.logout(true);
                throw new Error('انتهت الجلسة، سجّل الدخول مرة أخرى');
            }
            throw new Error(body.__error);
        }
        if (!response.ok) {
            const message = body && (body.message || body.__error) ? (body.message || body.__error) : ('خطأ ' + response.status);
            throw new Error(message);
        }
        return body;
    }
    App.api = api;
    App.get = path => api(path);
    App.post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
    App.put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) });
    App.del = path => api(path, { method: 'DELETE' });

    App.upload = async (path, file, extra = {}) => {
        const form = new FormData();
        form.append('file', file);
        for (const [key, value] of Object.entries(extra)) form.append(key, value);
        const response = await fetch(hrproUrl(path), { method: 'POST', body: form, headers: { 'X-Hrpro-Token': App.token || '', 'X-Frappe-CSRF-Token': window.HRPRO_CSRF || '' } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'فشل الرفع');
        return payload;
    };

    App.downloadPost = async (path, body, filename) => {
        const response = await fetch(hrproUrl(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hrpro-Token': App.token || '', 'X-Frappe-CSRF-Token': window.HRPRO_CSRF || '' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || 'فشل التصدير');
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    App.downloadGet = async (path, filename) => {
        const response = await fetch(hrproUrl(path), { headers: { 'X-Hrpro-Token': App.token || '' } });
        if (!response.ok) throw new Error('فشل التنزيل');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    // ───────────── تنبيهات ─────────────
    App.toast = (message, type = 'success') => {
        const root = document.getElementById('toastRoot');
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.innerHTML = `${App.icon(type === 'error' ? 'alert' : type === 'warning' ? 'alert' : 'checkCircle')}<span>${escapeHtml(message)}</span>`;
        root.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 3600);
    };

    // ───────────── النوافذ ─────────────
    App.closeModal = () => {
        const modal = App.modalStack.pop();
        if (modal) modal.remove();
    };

    App.rawModal = ({ title, body, footer, size = '', onOpen, dismissable = true }) => {
        const root = document.getElementById('modalRoot');
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal ${size}" role="dialog" aria-modal="true">
                <div class="modal-head"><h3>${escapeHtml(title || '')}</h3>${dismissable ? '<button class="close-x" data-close>&times;</button>' : ''}</div>
                <div class="modal-body">${body || ''}</div>
                ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
            </div>`;
        root.appendChild(backdrop);
        App.modalStack.push(backdrop);
        const close = () => {
            const idx = App.modalStack.indexOf(backdrop);
            if (idx >= 0) App.modalStack.splice(idx, 1);
            backdrop.remove();
        };
        if (dismissable) {
            backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
            backdrop.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', close));
        }
        backdrop.close = close;
        if (onOpen) onOpen(backdrop.querySelector('.modal'), close, backdrop);
        return backdrop;
    };

    App.confirm = ({ title = 'تأكيد العملية', message = '', confirmLabel = 'تأكيد', danger = false }) => new Promise(resolve => {
        const modal = App.rawModal({
            title,
            body: `<div style="font-size:13.5px;line-height:1.8">${message}</div>`,
            footer: `<button class="btn" data-cancel>إلغاء</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmLabel)}</button>`
        });
        const done = value => { modal.close(); resolve(value); };
        modal.querySelector('[data-ok]').onclick = () => done(true);
        modal.querySelector('[data-cancel]').onclick = () => done(false);
    });

    // ───────────── النماذج ─────────────
    function fieldHtml(field, values) {
        if (field.type === 'section') return `<div class="form-section"><h4>${field.icon ? App.icon(field.icon) : ''}${escapeHtml(field.label)}</h4></div>`;
        if (field.type === 'html') return `<div class="${field.full !== false ? 'full' : ''}">${field.html}</div>`;
        const value = values[field.key] !== undefined && values[field.key] !== null ? values[field.key] : (field.default !== undefined ? field.default : '');
        const required = field.required ? 'required' : '';
        const cls = field.full ? 'full' : '';
        const help = field.help ? `<div class="help">${escapeHtml(field.help)}</div>` : '';
        if (field.type === 'checkbox') {
            return `<div class="field checkbox ${cls}"><input type="checkbox" id="f_${field.key}" name="${field.key}" ${value ? 'checked' : ''} ${field.disabled ? 'disabled' : ''}><label for="f_${field.key}">${escapeHtml(field.label)}</label></div>`;
        }
        if (field.type === 'checks') {
            const selected = Array.isArray(value) ? value.map(String) : String(value || '').split(',').filter(Boolean);
            return `<div class="field ${cls}"><label>${escapeHtml(field.label)}</label><div class="checks">${(field.options || []).map(opt => `<label><input type="checkbox" name="${field.key}" value="${escapeHtml(opt.value)}" ${selected.includes(String(opt.value)) ? 'checked' : ''}>${escapeHtml(opt.label)}</label>`).join('')}</div>${help}</div>`;
        }
        if (field.type === 'select') {
            const options = (field.options || []).map(opt => {
                const optValue = typeof opt === 'object' ? opt.value : opt;
                const optLabel = typeof opt === 'object' ? opt.label : opt;
                return `<option value="${escapeHtml(optValue)}" ${String(optValue) === String(value) ? 'selected' : ''}>${escapeHtml(optLabel)}</option>`;
            }).join('');
            return `<div class="field ${cls}"><label for="f_${field.key}">${escapeHtml(field.label)}${field.required ? ' *' : ''}</label><select id="f_${field.key}" name="${field.key}" ${required} ${field.disabled ? 'disabled' : ''}>${field.placeholder ? `<option value="">${escapeHtml(field.placeholder)}</option>` : ''}${options}</select>${help}</div>`;
        }
        if (field.type === 'textarea') {
            return `<div class="field ${cls}"><label for="f_${field.key}">${escapeHtml(field.label)}</label><textarea id="f_${field.key}" name="${field.key}" rows="${field.rows || 3}" placeholder="${escapeHtml(field.placeholder || '')}" ${required}>${escapeHtml(value)}</textarea>${help}</div>`;
        }
        return `<div class="field ${cls}"><label for="f_${field.key}">${escapeHtml(field.label)}${field.required ? ' *' : ''}</label><input id="f_${field.key}" name="${field.key}" type="${field.type || 'text'}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || '')}" ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''} ${field.step !== undefined ? `step="${field.step}"` : ''} ${required} ${field.disabled ? 'disabled' : ''}>${help}</div>`;
    }

    App.formModal = ({ title, fields = [], values = {}, submitLabel = 'حفظ', size = '', onSubmit, footerExtra = '', onOpen, dismissable = true, showCancel = true }) => {
        const body = `<form id="modalForm" class="form-grid">${fields.map(f => fieldHtml(f, values)).join('')}<div class="full" id="modalFormError" style="color:var(--danger);font-size:12.5px;display:none"></div></form>`;
        const modal = App.rawModal({
            title, body, size, dismissable,
            footer: `${footerExtra}<button class="btn btn-primary" id="modalSubmit">${escapeHtml(submitLabel)}</button>${showCancel ? '<button class="btn" data-close>إلغاء</button>' : ''}`,
            onOpen: (root, close) => {
                const form = root.querySelector('#modalForm');
                const errorEl = root.querySelector('#modalFormError');
                const submitBtn = root.querySelector('#modalSubmit');
                if (onOpen) onOpen(root, close, form);
                const submit = async () => {
                    const data = {};
                    for (const field of fields) {
                        if (field.type === 'section' || field.type === 'html' || !field.key) continue;
                        if (field.type === 'checkbox') data[field.key] = !!form.querySelector(`[name="${field.key}"]`)?.checked;
                        else if (field.type === 'checks') data[field.key] = Array.from(form.querySelectorAll(`[name="${field.key}"]:checked`)).map(el => el.value);
                        else {
                            const el = form.querySelector(`[name="${field.key}"]`);
                            data[field.key] = el ? el.value : '';
                            if (field.type === 'number' && data[field.key] !== '') data[field.key] = parseFloat(data[field.key]);
                        }
                    }
                    const missing = fields.filter(f => f.required && f.type !== 'section' && f.type !== 'html' && f.type !== 'checkbox' && f.type !== 'checks' && !String(data[f.key] ?? '').trim());
                    if (missing.length) {
                        errorEl.textContent = `الحقول المطلوبة: ${missing.map(f => f.label).join('، ')}`;
                        errorEl.style.display = 'block';
                        return;
                    }
                    errorEl.style.display = 'none';
                    submitBtn.disabled = true;
                    try {
                        await onSubmit(data, { close, root, form });
                    } catch (err) {
                        errorEl.textContent = err.message || 'تعذر الحفظ';
                        errorEl.style.display = 'block';
                    } finally {
                        submitBtn.disabled = false;
                    }
                };
                form.addEventListener('submit', e => { e.preventDefault(); submit(); });
                submitBtn.onclick = e => { e.preventDefault(); submit(); };
            }
        });
        return modal;
    };

    // ───────────── صور من ملفات الجهاز أو رابط ─────────────
    App.imageField = ({ key, label, value = '', help = '', maxWidth = 900, wide = false, placeholder = 'https://example.com/image.png' }) => {
        const src = String(value || '');
        const isData = src.startsWith('data:');
        return `<div class="field full">
            <label>${escapeHtml(label || '')}</label>
            <div class="img-field" data-imgfield="${escapeHtml(key)}">
                <div class="img-preview ${wide ? 'is-wide' : ''}" data-preview>${src ? `<img src="${escapeHtml(src)}" alt="">` : '<span class="small muted">لا توجد صورة</span>'}</div>
                <div class="img-controls">
                    <div class="row" style="gap:8px">
                        <button type="button" class="btn btn-sm" data-pick>${App.icon('upload')} رفع من الملفات</button>
                        <button type="button" class="btn btn-sm" data-clear>${App.icon('x')} إزالة</button>
                    </div>
                    <div class="field" style="margin:10px 0 0">
                        <label style="font-size:11.5px">أو رابط الصورة</label>
                        <input data-url value="${isData ? '' : escapeHtml(src)}" placeholder="${escapeHtml(placeholder)}">
                    </div>
                    <div class="help" data-size></div>
                    <input type="file" accept="image/*" data-file class="hidden">
                    <input type="hidden" data-value value="${escapeHtml(src)}">
                </div>
            </div>
            ${help ? `<div class="help">${escapeHtml(help)}</div>` : ''}
        </div>`;
    };

    App.bindImageField = (root, key, options = {}) => {
        const box = root && root.querySelector(`[data-imgfield="${key}"]`);
        if (!box) return;
        const maxWidth = options.maxWidth || 900;
        const preview = box.querySelector('[data-preview]');
        const urlInput = box.querySelector('[data-url]');
        const fileInput = box.querySelector('[data-file]');
        const hidden = box.querySelector('[data-value]');
        const sizeLabel = box.querySelector('[data-size]');
        const render = src => {
            const value = String(src || '');
            if (hidden) hidden.value = value;
            if (preview) preview.innerHTML = value ? `<img src="${escapeHtml(value)}" alt="">` : '<span class="small muted">لا توجد صورة</span>';
            if (sizeLabel) sizeLabel.textContent = value.startsWith('data:') ? `حجم الصورة المرفوعة ≈ ${Math.round(value.length / 1365)} KB` : '';
            if (options.onChange) options.onChange(value);
        };
        box.querySelector('[data-pick]').onclick = () => fileInput.click();
        box.querySelector('[data-clear]').onclick = () => { if (urlInput) urlInput.value = ''; render(''); };
        if (urlInput) urlInput.onchange = () => render(urlInput.value.trim());
        if (fileInput) fileInput.onchange = async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            try {
                const dataUrl = await App.readImageFile(file, maxWidth);
                if (urlInput) urlInput.value = '';
                render(dataUrl);
            } catch (err) { App.toast(err.message, 'error'); }
            fileInput.value = '';
        };
        render(hidden ? hidden.value : (urlInput ? urlInput.value : ''));
    };

    App.imageFieldValue = (root, key) => {
        const input = root && root.querySelector(`[data-imgfield="${key}"] [data-value]`);
        return input ? input.value : '';
    };

    App.readImageFile = (file, maxWidth = 900) => new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) return reject(new Error('الملف المحدد ليس صورة'));
        if (file.size > 8 * 1024 * 1024) return reject(new Error('حجم الصورة كبير — الحد الأقصى 8 ميجابايت'));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('تعذر قراءة الملف'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('تعذر معالجة الصورة'));
            img.onload = () => {
                const ratio = Math.min(1, maxWidth / (img.width || maxWidth));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round((img.width || maxWidth) * ratio));
                canvas.height = Math.max(1, Math.round((img.height || maxWidth) * ratio));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                const keepAlpha = /png|webp|svg|gif/.test(file.type);
                resolve(keepAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });

    // ───────────── الجداول ─────────────
    App.table = ({ columns = [], rows = [], actions, footer, empty, rowClass, onRowClick }) => {
        if (!rows.length) {
            return `<div class="empty">${App.icon('file')}<div>${escapeHtml(empty || 'لا توجد بيانات لعرضها')}</div></div>`;
        }
        const head = columns.map(c => `<th class="${c.align === 'left' ? 'num' : ''}" ${c.width ? `style="width:${c.width}"` : ''}>${escapeHtml(c.label)}</th>`).join('');
        const body = rows.map((row, index) => {
            const cells = columns.map(c => {
                const content = c.render ? c.render(row, index) : escapeHtml(row[c.key] === undefined || row[c.key] === null ? '' : row[c.key]);
                return `<td class="${c.align === 'left' ? 'num' : ''} ${c.class || ''}">${content}</td>`;
            }).join('');
            const actionList = typeof actions === 'function' ? actions(row, index) : actions;
            const actionsHtml = actionList && actionList.length
                ? `<td class="no-print"><div class="actions-cell">${actionList.map(a => a.html ? a.html : `<button class="btn btn-icon btn-sm ${a.class || ''}" title="${escapeHtml(a.title || '')}" data-action="${escapeHtml(a.action || '')}" data-id="${escapeHtml(row.id || '')}">${App.icon(a.icon || 'more')}</button>`).join('')}</div></td>`
                : (actions ? '<td></td>' : '');
            return `<tr data-id="${escapeHtml(row.id || '')}" class="${rowClass ? rowClass(row) : ''}">${cells}${actionsHtml}</tr>`;
        }).join('');
        const foot = footer ? `<tfoot><tr>${footer.map(c => `<td class="${c.align === 'left' ? 'num' : ''}">${c.content}</td>`).join('')}</tr></tfoot>` : '';
        const table = `<div class="table-wrap"><table class="data"><thead><tr>${head}${actions ? '<th class="no-print"></th>' : ''}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
        if (onRowClick) {
            setTimeout(() => {
                document.querySelectorAll('#view tbody tr[data-id]').forEach(tr => {
                    if (tr.dataset.rowBound) return;
                    tr.dataset.rowBound = '1';
                    tr.style.cursor = 'pointer';
                    tr.addEventListener('click', e => {
                        if (e.target.closest('button')) return;
                        onRowClick(tr.dataset.id);
                    });
                });
            }, 0);
        }
        return table;
    };

    App.bindActions = handlers => {
        App._tableActions = handlers;
        setTimeout(() => {
            document.querySelectorAll('[data-action]').forEach(btn => {
                if (btn.dataset.bound) return;
                btn.dataset.bound = '1';
                btn.addEventListener('click', () => {
                    const handler = handlers[btn.dataset.action];
                    if (handler) handler(btn.dataset.id);
                });
            });
        }, 0);
    };

    // ───────────── شارات ─────────────
    const STATUS = {
        present: ['حاضر', 'success'], late: ['متأخر', 'warning'], absent: ['غائب', 'danger'],
        leave: ['إجازة', 'info'], half_day: ['نصف يوم', 'warning'], missing_punch: ['بصمة ناقصة', 'danger'],
        weekend: ['عطلة أسبوعية', ''], holiday: ['عطلة رسمية', 'purple'], remote: ['عمل عن بعد', 'info'],
        future: ['لم يحن', ''], not_tracked: ['غير مُتتبع', ''],
        draft: ['مسودة', ''], approved: ['معتمد', 'success'], paid: ['مدفوع', 'success'],
        pending: ['معلّق', 'warning'], rejected: ['مرفوض', 'danger'], cancelled: ['ملغي', ''],
        active: ['نشط', 'success'], terminated: ['منتهي', 'danger'], closed: ['مغلق', ''], open: ['مفتوح', 'info'],
        calculated: ['محسوبة', 'info'], posted: ['مُرحّل', 'success'], inactive: ['غير نشط', ''],
        accrual: ['استحقاق', 'success'], used: ['مستخدم', 'warning'], adjustment: ['تسوية', 'info'],
        late_conversion: ['تحويل تأخير', 'purple'], carry: ['ترحيل', 'info'], entitlement: ['استحقاق سنوي', 'success'],
        carry_over: ['مرحّل', 'info'], cancel: ['إلغاء', 'danger']
    };
    App.badge = (status, labelOverride) => {
        const entry = STATUS[status] || [status || '—', ''];
        return `<span class="badge ${entry[1]}">${escapeHtml(labelOverride || entry[0])}</span>`;
    };
    App.statusLabel = status => (STATUS[status] || [status || '—'])[0];

    // ───────────── خيارات ─────────────
    App.branchName = id => ((App.state.data.branches || []).find(b => b.id === id) || {}).name || '—';
    App.deptName = id => ((App.state.data.departments || []).find(d => d.id === id) || {}).name || '—';
    App.shiftName = id => ((App.state.data.workShifts || []).find(s => s.id === id) || {}).name || '—';
    App.leaveTypeName = id => ((App.state.data.leaveTypes || []).find(t => t.id === id) || {}).name || '—';
    App.employeeById = id => (App.state.data.employees || []).find(e => e.id === id) || {};
    App.employeeName = id => App.employeeById(id).name || '—';

    App.options = {
        branches: () => (App.state.data.branches || []).map(b => ({ value: b.id, label: b.name })),
        departments: (branchId) => (App.state.data.departments || []).filter(d => !branchId || !d.branchId || d.branchId === branchId).map(d => ({ value: d.id, label: d.name })),
        employees: (branchId) => (App.state.data.employees || []).filter(e => !branchId || e.branchId === branchId).filter(e => e.status !== 'terminated').map(e => ({ value: e.id, label: `${e.employeeNumber ? e.employeeNumber + ' — ' : ''}${e.name}` })),
        leaves: () => (App.state.data.leaveTypes || []).map(t => ({ value: t.id, label: t.name })),
        shifts: () => (App.state.data.workShifts || []).map(s => ({ value: s.id, label: s.name })),
        grades: () => (App.state.data.jobGrades || []).map(g => ({ value: g.id, label: g.name })),
        allowances: () => (App.state.data.allowanceTypes || []).map(a => ({ value: a.id, label: a.name })),
        deductions: () => (App.state.data.deductionTypes || []).map(d => ({ value: d.id, label: d.name }))
    };

    App.can = (module, action = 'view') => {
        const user = App.state.user;
        if (!user) return false;
        if (user.role === 'admin') return true;
        const levels = { none: 0, view: 1, add: 2, edit: 3, delete: 4, all: 5 };
        const level = (App.state.permissions || {})[module] || 'none';
        return (levels[level] || 0) >= (levels[action] || 0);
    };

    // ───────────── التوجيه والقائمة ─────────────
    App.registerModule = (name, module) => { App.modules[name] = module; };
    App.registerRoutes = routes => { App.routes = App.routes.concat(routes); };

    // ───────────── تبويبات العمل ─────────────
    App.tabs = [];
    App.loadTabs = () => {
        try {
            const raw = JSON.parse(sessionStorage.getItem('tageep_tabs') || '[]');
            if (Array.isArray(raw)) App.tabs = raw.filter(t => t && t.path);
        } catch (_) { App.tabs = []; }
    };
    App.saveTabs = () => { try { sessionStorage.setItem('tageep_tabs', JSON.stringify(App.tabs)); } catch (_) {} };
    App.openTab = route => {
        if (!route || !route.path) return;
        const existing = App.tabs.find(t => t.path === route.path);
        if (existing) existing.label = route.label;
        else App.tabs.push({ path: route.path, label: route.label });
        App.activeTab = route.path;
        App.saveTabs();
        App.renderTabs();
    };
    App.renderTabs = () => {
        const bar = document.getElementById('tabsBar');
        if (!bar) return;
        const accessible = App.routes.filter(r => !r.hidden && (!r.permission || App.can(r.permission, 'view')));
        App.tabs = App.tabs.filter(t => accessible.some(r => r.path === t.path));
        if (!App.tabs.length) {
            const first = accessible.find(r => r.path === 'dashboard') || accessible[0];
            if (first) App.tabs.push({ path: first.path, label: first.label });
        }
        bar.innerHTML = App.tabs.map(t => `<div class="tab-item ${t.path === App.activeTab ? 'active' : ''}" data-tab="${escapeHtml(t.path)}" role="tab" tabindex="0">
            <span class="tab-label">${escapeHtml(t.label || t.path)}</span>
            <button type="button" class="tab-close" data-close-tab="${escapeHtml(t.path)}" aria-label="إغلاق">×</button>
        </div>`).join('');
        bar.querySelectorAll('.tab-item').forEach(el => {
            el.addEventListener('click', () => App.navigate('/' + el.dataset.tab));
            el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); App.navigate('/' + el.dataset.tab); } });
        });
        bar.querySelectorAll('[data-close-tab]').forEach(btn => btn.addEventListener('click', e => {
            e.stopPropagation();
            App.closeTab(btn.dataset.closeTab);
        }));
    };
    App.closeTab = path => {
        const index = App.tabs.findIndex(t => t.path === path);
        if (index < 0) return;
        const wasActive = App.activeTab === path;
        App.tabs.splice(index, 1);
        if (!App.tabs.length) App.tabs.push({ path: 'dashboard', label: 'لوحة المعلومات' });
        App.saveTabs();
        if (wasActive) {
            const next = App.tabs[Math.max(0, index - 1)] || App.tabs[0];
            App.navigate('/' + next.path);
        } else {
            App.renderTabs();
        }
    };

    // ───────────── ألوان وحساب التباين ─────────────
    const hexToRgb = value => {
        let hex = String(value || '').trim().replace(/^#/, '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
        return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    };
    const relativeLuminance = rgb => {
        const channel = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
    };
    const mixColor = (rgb, target, weight) => `rgb(${Math.round(rgb.r + (target - rgb.r) * weight)}, ${Math.round(rgb.g + (target - rgb.g) * weight)}, ${Math.round(rgb.b + (target - rgb.b) * weight)})`;
    App.contrastColor = (hex, light = '#ffffff', dark = '#0b1526') => {
        const rgb = hexToRgb(hex);
        if (!rgb) return light;
        return relativeLuminance(rgb) > 0.45 ? dark : light;
    };

    App.applyTheme = settings => {
        const s = settings || (App.state.data && App.state.data.settings) || {};
        const root = document.documentElement;
        if (s.themeColor) {
            root.style.setProperty('--brand', s.themeColor);
            const brandRgb = hexToRgb(s.themeColor);
            if (brandRgb) root.style.setProperty('--brand-dark', mixColor(brandRgb, 0, 0.18));
        }
        const sidebar = s.sidebarColor || '#0b1526';
        root.style.setProperty('--sidebar-bg', sidebar);
        const rgb = hexToRgb(sidebar) || { r: 11, g: 21, b: 38 };
        // قائمة فاتحة نحتاج نصًا غامقًا، وقائمة غامقة نحتاج نصًا فاتحًا
        const lightSidebar = relativeLuminance(rgb) > 0.42;
        const ink = lightSidebar ? '11, 21, 38' : '241, 245, 249';
        root.style.setProperty('--sidebar-fg', `rgb(${ink})`);
        root.style.setProperty('--sidebar-fg-strong', lightSidebar ? '#0b1526' : '#ffffff');
        root.style.setProperty('--sidebar-fg-soft', `rgba(${ink}, .84)`);
        root.style.setProperty('--sidebar-fg-dim', `rgba(${ink}, .58)`);
        root.style.setProperty('--sidebar-line', lightSidebar ? 'rgba(11, 21, 38, .14)' : 'rgba(255, 255, 255, .09)');
        root.style.setProperty('--sidebar-hover', lightSidebar ? 'rgba(11, 21, 38, .07)' : 'rgba(255, 255, 255, .08)');
        root.style.setProperty('--sidebar-bg-2', mixColor(rgb, lightSidebar ? 255 : 0, lightSidebar ? 0.12 : 0.22));
        root.style.setProperty('--sidebar-bg-3', mixColor(rgb, lightSidebar ? 255 : 0, lightSidebar ? 0.22 : 0.38));
    };

    App.navigate = hash => {
        if (location.hash === '#' + hash) App.route();
        else location.hash = hash;
    };

    App.route = async () => {
        const hash = (location.hash || '#/dashboard').replace(/^#\/?/, '');
        const [pathPart, ...rest] = hash.split('/');
        const accessible = App.routes.filter(r => !r.permission || App.can(r.permission, 'view'));
        const route = App.routes.find(r => r.path === pathPart)
            || accessible.find(r => r.path === 'dashboard')
            || accessible[0] || App.routes[0];
        if (!route) return;
        App.currentRoute = route;
        App.openTab(route);
        const module = App.modules[route.module];
        const view = document.getElementById('view');
        document.getElementById('pageTitle').textContent = route.label;
        document.getElementById('pageSubtitle').textContent = route.subtitle || '';
        document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.path === route.path));
        document.getElementById('sidebar').classList.remove('open');
        if (!module) { view.innerHTML = `<div class="empty">الوحدة غير متاحة</div>`; return; }
        if (route.permission && !App.can(route.permission, 'view')) {
            view.innerHTML = `<div class="alert danger">${App.icon('lock')}<div>لا تملك صلاحية الوصول إلى هذه الوحدة. تواصل مع مدير النظام.</div></div>`;
            return;
        }
        view.innerHTML = `<div class="empty"><div class="spinner" style="border-color:var(--line);border-top-color:var(--brand)"></div></div>`;
        try {
            await module.render(view, { params: rest, route });
        } catch (err) {
            view.innerHTML = `<div class="alert danger">${App.icon('alert')}<div>${escapeHtml(err.message)}</div></div>`;
        }
    };

    App.renderNav = () => {
        const nav = document.getElementById('nav');
        const groups = [];
        for (const route of App.routes) {
            if (route.hidden) continue;
            if (route.permission && !App.can(route.permission, 'view')) continue;
            const group = route.group || 'العمل';
            let entry = groups.find(g => g.name === group);
            if (!entry) { entry = { name: group, routes: [] }; groups.push(entry); }
            entry.routes.push(route);
        }
        nav.innerHTML = groups.map(group => `
            <div class="nav-label">${escapeHtml(group.name)}</div>
            ${group.routes.map(route => `<button class="nav-item" data-path="${route.path}">${App.icon(route.icon)}<span>${escapeHtml(route.label)}</span>${route.badge ? `<span class="badge-dot">${route.badge}</span>` : ''}</button>`).join('')}
        `).join('');
        nav.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => App.navigate('/' + btn.dataset.path)));
    };

    // ───────────── البيانات ─────────────
    App.loadBootstrap = async () => {
        const data = await App.get('/bootstrap');
        App.state.data = data;
        App.state.user = data.user;
        App.state.permissions = data.permissions || {};
        const user = data.user;
        document.getElementById('brandCompany').textContent = (data.settings && data.settings.companyName) || 'Tageep HRMS';
        const brandMark = document.querySelector('#sidebar .brand-mark');
        if (brandMark) {
            const brandLogo = (data.settings || {}).logo || '';
            brandMark.innerHTML = brandLogo ? `<img src="${escapeHtml(brandLogo)}" alt="">` : 'T';
        }
        document.getElementById('userNameLabel').textContent = user.name;
        document.getElementById('userRoleLabel').textContent = user.roleLabel || user.role;
        document.getElementById('userAvatar').textContent = App.initials(user.name);
        App.applyTheme(data.settings);
        const dbBadge = document.getElementById('dbBadge');
        const dbType = { sqlite: 'SQLite محلي', mssql: 'SQL Server', mysql: 'MySQL', json: 'ملف JSON' }[(data.db || {}).type] || (data.db || {}).type;
        dbBadge.textContent = `قاعدة البيانات: ${dbType}${(data.db || {}).encryptAtRest ? ' • مشفّرة' : ''}`;
        App.updateNotifDot();
        return data;
    };

    App.refresh = async (options = {}) => {
        await App.loadBootstrap();
        App.renderNav();
        if (options.rerender !== false) App.route();
    };

    App.updateNotifDot = () => {
        const unread = ((App.state.data.notifications || []).filter(n => !n.read)).length;
        const dot = document.getElementById('notifDot');
        if (dot) dot.classList.toggle('hidden', unread === 0);
    };

    // ───────────── الإشعارات ─────────────
    App.renderNotifications = () => {
        const list = document.getElementById('notifList');
        const items = App.state.data.notifications || [];
        if (!items.length) {
            list.innerHTML = `<div class="notif-empty">${App.icon('bell')}<div style="margin-top:6px">لا توجد إشعارات</div></div>`;
            return;
        }
        list.innerHTML = items.map(n => `
            <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${escapeHtml(n.id)}" data-link="${escapeHtml(n.link || '')}">
                <div class="notif-icon ${escapeHtml(n.severity || 'info')}">${App.icon(n.severity === 'danger' ? 'alert' : n.severity === 'warning' ? 'clock' : n.type === 'leave_request' ? 'palmtree' : 'bell')}</div>
                <div style="flex:1">
                    <strong>${escapeHtml(n.title || '')}</strong>
                    <p>${escapeHtml(n.message || '')}</p>
                    <span class="small muted">${App.dateTime(n.createdAt)}</span>
                </div>
            </div>`).join('');
        list.querySelectorAll('.notif-item').forEach(item => {
            item.addEventListener('click', async () => {
                try { await App.post(`/notifications/${item.dataset.id}/read`); } catch (_) {}
                const notif = (App.state.data.notifications || []).find(n => n.id === item.dataset.id);
                if (notif) notif.read = true;
                App.updateNotifDot();
                document.getElementById('notifPanel').classList.add('hidden');
                if (item.dataset.link) App.navigate(item.dataset.link.replace(/^#/, ''));
                App.route();
            });
        });
    };

    App.toggleNotifications = async () => {
        const panel = document.getElementById('notifPanel');
        const hidden = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !hidden);
        if (hidden) {
            try { await App.post('/notifications/scan'); await App.loadBootstrap(); App.renderNav(); } catch (_) {}
            App.renderNotifications();
        }
    };

    // ───────────── الطباعة والتصدير ─────────────
    App.print = ({ title, subtitle = '', html, landscape = false }) => {
        const settings = App.state.data.settings || {};
        const paper = settings.printerPaperSize || 'A4';
        const fontSize = Math.min(24, Math.max(7, App.num(settings.printFontSize, 12) || 12));
        const fontFamily = settings.printFontFamily || '"Segoe UI", Tahoma, sans-serif';
        const banner = settings.printHeaderImage || '';
        const logo = settings.logo || '';
        const company = settings.companyName || 'Tageep HRMS';
        const meta = [
            `تاريخ الطباعة: ${App.date(App.today())}`,
            settings.taxNumber ? `الرقم الضريبي: ${settings.taxNumber}` : '',
            settings.crNumber ? `السجل التجاري: ${settings.crNumber}` : '',
            settings.phone ? `هاتف: ${settings.phone}` : '',
            settings.email ? settings.email : ''
        ].filter(Boolean);
        const logoHtml = logo
            ? `<img class="ph-logo" src="${escapeHtml(logo)}" alt="">`
            : `<div class="ph-mark">T</div>`;
        const headerHtml = banner
            ? `<img class="print-banner" src="${escapeHtml(banner)}" alt="${escapeHtml(company)}">`
            : `<div class="print-head">
                    <div class="ph-brand">${logoHtml}<div><h1>${escapeHtml(company)}</h1>${settings.companyNameEn ? `<div class="ph-en">${escapeHtml(settings.companyNameEn)}</div>` : ''}</div></div>
                    <div class="ph-meta">${meta.map(escapeHtml).join('<br>')}</div>
                </div>`;
        const doc = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
            <link rel="stylesheet" href="/assets/app.css?v=3.0.5">
            <style>
                *{box-sizing:border-box}
                body{background:#fff;color:#0f172a;margin:0;padding:8px 4px;font-family:${fontFamily};font-size:${fontSize}px;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
                .print-banner{display:block;width:100%;height:auto;margin:0 0 10px}
                .print-head{display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:2px solid #0d9488;padding-bottom:10px;margin-bottom:10px}
                .ph-brand{display:flex;gap:10px;align-items:center}
                .ph-logo{height:${Math.round(fontSize * 4.2)}px;max-width:190px;object-fit:contain}
                .ph-mark{width:${Math.round(fontSize * 3.6)}px;height:${Math.round(fontSize * 3.6)}px;border-radius:10px;background:#0d9488;color:#fff;display:grid;place-items:center;font-weight:800;font-size:${Math.round(fontSize * 1.5)}px}
                .print-head h1{font-size:${fontSize + 7}px;margin:0;color:#0f766e}
                .ph-en{font-size:${Math.max(9, fontSize - 2)}px;color:#475569;direction:ltr;text-align:right}
                .ph-meta{font-size:${Math.max(8, fontSize - 2)}px;color:#334155;line-height:1.7;text-align:left}
                .print-title{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;border-bottom:1px solid #64748b;padding-bottom:6px;margin-bottom:12px}
                .print-title h2{font-size:${fontSize + 4}px;margin:0;flex:1}
                .print-title .ph-meta{white-space:nowrap}
                .print-sign{display:flex;justify-content:space-between;margin-top:34px;font-size:${Math.max(8, fontSize - 1)}px;color:#334155}
                .print-foot{margin-top:16px;font-size:${Math.max(7.5, fontSize - 2.5)}px;color:#475569;text-align:center;border-top:1px dashed #94a3b8;padding-top:6px}
                table{width:100%;border-collapse:collapse}
                table.data{font-size:${Math.max(8, fontSize - 1)}px}
                table.data th, table.data td{border:1px solid #000 !important;padding:5px 6px;vertical-align:middle}
                table.data th{background:#e2e8f0 !important;color:#000 !important;font-weight:700;text-align:right;position:static}
                table.data td{text-align:right}
                table.data .num{text-align:left}
                table.data tr{page-break-inside:avoid}
                table.data thead{display:table-header-group}
                .print-area{display:block !important}
                @page{size:${paper} ${landscape ? 'landscape' : 'portrait'};margin:8mm}
            </style></head><body>
            ${headerHtml}
            <div class="print-title"><h2>${escapeHtml(title)}${subtitle ? `<span style="font-size:${Math.max(9, fontSize)}px;font-weight:400;color:#334155"> — ${escapeHtml(subtitle)}</span>` : ''}</h2><div class="ph-meta">${escapeHtml(App.date(App.today()))}</div></div>
            ${html}
            <div class="print-sign"><span>توقيع الموارد البشرية: ____________________</span><span>توقيع الإدارة: ____________________</span></div>
            <div class="print-foot">${escapeHtml(settings.payslipFooterNote || '')}${settings.payslipFooterNote ? ' — ' : ''}تم إنشاء هذا المستند آليًا بواسطة Tageep HRMS</div>
            </body></html>`;
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;border:0';
        document.body.appendChild(frame);
        const docFrame = frame.contentWindow.document;
        docFrame.open(); docFrame.write(doc); docFrame.close();
        setTimeout(() => {
            try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) {}
            setTimeout(() => frame.remove(), 1500);
        }, 350);
    };

    App.printTable = ({ title, subtitle, columns, rows, landscape }) => {
        const html = `<table class="data"><thead><tr>${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r) : escapeHtml(r[c.key] === undefined || r[c.key] === null ? '' : r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        App.print({ title, subtitle, html, landscape });
    };

    App.exportCsv = (filename, columns, rows) => {
        const escapeCsv = value => `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
        const lines = [columns.map(c => escapeCsv(c.label)).join(',')];
        for (const row of rows) lines.push(columns.map(c => escapeCsv(c.raw ? c.raw(row) : row[c.key])).join(','));
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

    // ───────────── الرسوم البيانية ─────────────
    App.barChart = (series, keys) => {
        const width = 760; const height = 220; const padding = { top: 14, right: 10, bottom: 26, left: 34 };
        const max = Math.max(1, ...series.flatMap(s => keys.map(k => App.num(s[k.key]))));
        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;
        const groupW = chartW / Math.max(series.length, 1);
        const barW = Math.max(3, Math.min(14, (groupW - 8) / keys.length));
        let bars = '';
        series.forEach((item, i) => {
            const gx = padding.left + i * groupW + 4;
            keys.forEach((key, j) => {
                const value = App.num(item[key.key]);
                const h = (value / max) * chartH;
                bars += `<rect x="${gx + j * (barW + 2)}" y="${padding.top + chartH - h}" width="${barW}" height="${h}" rx="3" fill="${key.color}"><title>${escapeHtml(item.label)} — ${escapeHtml(key.label)}: ${value}</title></rect>`;
            });
            if (series.length <= 16 || i % 2 === 0) {
                bars += `<text x="${gx + (groupW - 8) / 2}" y="${height - 8}" font-size="9.5" fill="#94a3b8" text-anchor="middle">${escapeHtml(item.label)}</text>`;
            }
        });
        const grid = [0, 0.5, 1].map(f => `<line x1="${padding.left}" x2="${width - padding.right}" y1="${padding.top + chartH * (1 - f)}" y2="${padding.top + chartH * (1 - f)}" stroke="#e2e8f0" stroke-dasharray="3 4"/><text x="${padding.left - 6}" y="${padding.top + chartH * (1 - f) + 3}" font-size="9.5" fill="#94a3b8" text-anchor="end">${Math.round(max * f)}</text>`).join('');
        return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="height:220px">${grid}${bars}</svg>
            <div class="chart-legend">${keys.map(k => `<span><i style="background:${k.color}"></i>${escapeHtml(k.label)}</span>`).join('')}</div>`;
    };

    App.lineChart = (points, color = '#0d9488') => {
        const width = 620; const height = 190; const padding = { top: 16, right: 10, bottom: 24, left: 42 };
        if (!points.length) return '<div class="empty">لا توجد بيانات</div>';
        const max = Math.max(1, ...points.map(p => App.num(p.value)));
        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;
        const step = points.length > 1 ? chartW / (points.length - 1) : 0;
        const coords = points.map((p, i) => [padding.left + i * step, padding.top + chartH - (App.num(p.value) / max) * chartH]);
        const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
        const area = `${path} L${coords[coords.length - 1][0]},${padding.top + chartH} L${coords[0][0]},${padding.top + chartH} Z`;
        return `<svg class="chart" viewBox="0 0 ${width} ${height}" style="height:190px">
            <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".25"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
            <path d="${area}" fill="url(#lg)"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
            ${coords.map((c, i) => `<circle cx="${c[0]}" cy="${c[1]}" r="3" fill="#fff" stroke="${color}" stroke-width="2"><title>${escapeHtml(points[i].label)}: ${App.numFmt(points[i].value)}</title></circle>`).join('')}
            ${points.map((p, i) => `<text x="${coords[i][0]}" y="${height - 6}" font-size="9.5" fill="#94a3b8" text-anchor="middle">${escapeHtml(p.label)}</text>`).join('')}
        </svg>`;
    };

    App.hBars = (items, color = '#0d9488') => {
        if (!items.length) return '<div class="empty">لا توجد بيانات</div>';
        const max = Math.max(1, ...items.map(i => App.num(i.value)));
        return `<div class="bars">${items.map(item => `<div class="bar-row"><span class="nowrap" style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(item.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${(App.num(item.value) / max) * 100}%;background:${color}"></div></div><span class="val">${App.numFmt(item.value, item.digits || 0)}</span></div>`).join('')}</div>`;
    };

    // ───────────── الجلسة ─────────────
    App.logout = async (silent = false) => {
        if (!silent) { try { await App.post('/auth/logout'); } catch (_) {} }
        App.token = '';
        localStorage.removeItem('tageep_token');
        App.tabs = [];
        try { sessionStorage.removeItem('tageep_tabs'); } catch (_) {}
        document.getElementById('shell').classList.add('hidden');
        document.getElementById('auth').classList.remove('hidden');
        document.getElementById('loginForm').classList.remove('hidden');
        document.getElementById('setupForm').classList.add('hidden');
        document.getElementById('authTitle').textContent = 'تسجيل الدخول';
        document.getElementById('authSub').textContent = 'أدخل بيانات حسابك للوصول إلى النظام';
        document.getElementById('loginPassword').value = '';
    };

    App.showChangePassword = (forced = false) => {
        App.formModal({
            title: forced ? 'يجب تغيير كلمة المرور قبل المتابعة' : 'تغيير كلمة المرور',
            dismissable: !forced,
            showCancel: !forced,
            fields: [
                { key: 'currentPassword', label: 'كلمة المرور الحالية', type: 'password', required: true },
                { key: 'newPassword', label: 'كلمة المرور الجديدة', type: 'password', required: true, help: '8 أحرف على الأقل وتحتوي رقمًا' },
                { key: 'confirm', label: 'تأكيد كلمة المرور', type: 'password', required: true, full: true }
            ],
            submitLabel: 'تحديث كلمة المرور',
            onSubmit: async values => {
                if (values.newPassword !== values.confirm) throw new Error('كلمتا المرور غير متطابقتين');
                await App.post('/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
                App.toast('تم تحديث كلمة المرور، سجّل الدخول من جديد');
                setTimeout(() => App.logout(true), 1200);
            }
        });
    };

    // ───────────── البحث السريع ─────────────
    App.quickSearch = async query => {
        if (!query || query.trim().length < 2) return;
        try {
            const result = await App.get('/collections/employees?limit=20&search=' + encodeURIComponent(query.trim()));
            const rows = result.data || [];
            App.rawModal({
                title: 'نتائج البحث',
                body: rows.length ? `<div style="display:flex;flex-direction:column;gap:6px">${rows.map(e => `
                    <button class="btn" style="justify-content:flex-start;text-align:right" data-emp="${escapeHtml(e.id)}">
                        <span class="avatar" style="width:28px;height:28px;font-size:10px">${escapeHtml(App.initials(e.name))}</span>
                        <span style="flex:1"><strong>${escapeHtml(e.name)}</strong><br><span class="small muted">${escapeHtml(e.employeeNumber || '')} • ${escapeHtml(App.deptName(e.departmentId))}</span></span>
                        ${App.badge(e.status === 'terminated' ? 'terminated' : 'active')}
                    </button>`).join('')}</div>` : '<div class="empty">لا توجد نتائج مطابقة</div>'
            });
            document.querySelectorAll('[data-emp]').forEach(btn => btn.addEventListener('click', () => {
                App.closeModal();
                App.navigate(`/employees/${btn.dataset.emp}`);
            }));
        } catch (err) { App.toast(err.message, 'error'); }
    };

    // ───────────── بوابة الترخيص ─────────────
    function showLicenseGate(status) {
        App.license = status || {};
        document.getElementById('boot').classList.add('hidden');
        document.getElementById('auth').classList.add('hidden');
        document.getElementById('shell').classList.add('hidden');
        document.getElementById('licenseSerial').textContent = status.machineId || '—';
        document.getElementById('licenseHint').textContent = status.message || '';
        document.getElementById('licenseGate').classList.remove('hidden');
    }
    App.showLicenseGate = showLicenseGate;

    async function ensureLicense() {
        try {
            const status = await App.get('/license/status');
            App.license = status;
            if (status.required && !status.licensed) { showLicenseGate(status); return false; }
            if (status.licensed && status.mode === 'licensed' && status.type !== 'permanent' && status.daysLeft !== null && status.daysLeft <= 15) {
                App.toast(`تنبيه: ينتهي ترخيص النظام بعد ${status.daysLeft} يوم — يرجى التجديد`, 'warning');
            }
            return true;
        } catch (_) {
            return true;
        }
    }
    App.ensureLicense = ensureLicense;

    // ───────────── بدء التشغيل ─────────────
    App.start = async () => {
        // السمة
        if (localStorage.getItem('tageep_theme') === 'dark') document.body.classList.add('dark');
        if (!(await ensureLicense())) return;
        document.getElementById('authFeatures').innerHTML = [
            ['fingerprint', 'معالجة البصمات والتأخيرات'], ['palmtree', 'إجازات واستحقاق تلقائي'],
            ['wallet', 'رواتب مرنة وكشوف ذكية'], ['chart', 'تقارير قابلة للتخصيص'],
            ['users', 'فروع وأقسام متعددة'], ['shield', 'تشفير ونسخ احتياطي آمن']
        ].map(([icon, label]) => `<div class="auth-feature">${App.icon(icon)}<span>${label}</span></div>`).join('');

        document.getElementById('authError').classList.remove('show');
        try {
            const setup = await App.get('/auth/setup-status');
            if (setup.setupRequired) {
                document.getElementById('setupForm').classList.remove('hidden');
                document.getElementById('loginForm').classList.add('hidden');
                document.getElementById('authTitle').textContent = 'إعداد النظام';
                document.getElementById('authSub').textContent = 'أنشئ حساب مدير النظام للبدء';
                document.getElementById('setupCompany').value = setup.companyName && setup.companyName !== 'الشركة' ? setup.companyName : '';
            }
        } catch (err) {
            showAuthError(err.message);
        }

        if (App.token) {
            try {
                await App.loadBootstrap();
                await showApp();
                return;
            } catch (err) {
                App.token = '';
                localStorage.removeItem('tageep_token');
            }
        }
        document.getElementById('boot').classList.add('hidden');
        document.getElementById('auth').classList.remove('hidden');
    };

    async function showApp() {
        document.getElementById('boot').classList.add('hidden');
        document.getElementById('auth').classList.add('hidden');
        document.getElementById('shell').classList.remove('hidden');
        if (localStorage.getItem('tageep_sidebar_collapsed') === '1') document.getElementById('shell').classList.add('collapsed');
        App.loadTabs();
        App.renderNav();
        await App.route();
    }
    App.showApp = showApp;

    function showAuthError(message) {
        const el = document.getElementById('authError');
        el.textContent = message;
        el.classList.add('show');
    }
    App.showAuthError = showAuthError;

    // ربط الشاشات
    document.addEventListener('DOMContentLoaded', () => {
        const licenseCopy = document.getElementById('licenseCopy');
        if (licenseCopy) licenseCopy.addEventListener('click', async () => {
            const serial = document.getElementById('licenseSerial').textContent;
            try { await navigator.clipboard.writeText(serial); App.toast('تم نسخ الرقم التسلسلي'); }
            catch (_) { App.toast('تعذر النسخ التلقائي — انسخ الرقم يدويًا', 'warning'); }
        });
        const licenseActivate = document.getElementById('licenseActivate');
        if (licenseActivate) licenseActivate.addEventListener('click', async () => {
            const errorEl = document.getElementById('licenseError');
            errorEl.classList.remove('show');
            const key = document.getElementById('licenseKey').value.trim();
            if (!key) { errorEl.textContent = 'ألصق مفتاح الترخيص أولًا'; errorEl.classList.add('show'); return; }
            licenseActivate.disabled = true;
            try {
                await App.post('/license/activate', { key });
                App.toast('تم تفعيل الترخيص بنجاح');
                setTimeout(() => location.reload(), 700);
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.classList.add('show');
            } finally { licenseActivate.disabled = false; }
        });
        document.getElementById('loginForm').addEventListener('submit', async e => {
            e.preventDefault();
            showAuthError('');
            const btn = document.getElementById('loginBtn');
            btn.disabled = true;
            try {
                const result = await App.post('/auth/login', {
                    username: document.getElementById('loginUsername').value.trim(),
                    password: document.getElementById('loginPassword').value
                });
                App.token = result.token;
                localStorage.setItem('tageep_token', result.token);
                await App.loadBootstrap();
                await showApp();
                if (result.mustChangePassword) {
                    App.toast('يرجى تغيير كلمة المرور الافتراضية', 'warning');
                    setTimeout(() => App.showChangePassword(true), 500);
                }
            } catch (err) {
                showAuthError(err.message);
            } finally { btn.disabled = false; }
        });

        document.getElementById('setupForm').addEventListener('submit', async e => {
            e.preventDefault();
            showAuthError('');
            const btn = document.getElementById('setupBtn');
            btn.disabled = true;
            try {
                const result = await App.post('/auth/setup', {
                    companyName: document.getElementById('setupCompany').value.trim(),
                    name: document.getElementById('setupName').value.trim(),
                    username: document.getElementById('setupUsername').value.trim(),
                    password: document.getElementById('setupPassword').value
                });
                App.token = result.token;
                localStorage.setItem('tageep_token', result.token);
                await App.loadBootstrap();
                await showApp();
            } catch (err) {
                showAuthError(err.message);
            } finally { btn.disabled = false; }
        });

        document.getElementById('notifBtn').addEventListener('click', App.toggleNotifications);
        document.getElementById('readAllBtn').addEventListener('click', async () => {
            await App.post('/notifications/read-all');
            await App.loadBootstrap();
            App.renderNotifications();
            App.updateNotifDot();
        });
        document.getElementById('scanNotifBtn').addEventListener('click', async () => {
            try {
                const result = await App.post('/notifications/scan');
                await App.loadBootstrap();
                App.renderNotifications();
                App.updateNotifDot();
                App.toast('تم فحص الإشعارات الذكية');
            } catch (err) { App.toast(err.message, 'error'); }
        });
        document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
        document.getElementById('collapseBtn').addEventListener('click', () => {
            const shell = document.getElementById('shell');
            shell.classList.toggle('collapsed');
            localStorage.setItem('tageep_sidebar_collapsed', shell.classList.contains('collapsed') ? '1' : '0');
        });
        document.getElementById('themeBtn').addEventListener('click', () => {
            document.body.classList.toggle('dark');
            localStorage.setItem('tageep_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
        });
        document.getElementById('userChip').addEventListener('click', () => {
            const user = App.state.user || {};
            App.rawModal({
                title: 'الحساب الشخصي',
                body: `<div class="info-list">
                    <div><span>الاسم</span><strong>${escapeHtml(user.name)}</strong></div>
                    <div><span>اسم الدخول</span><strong>${escapeHtml(user.username || '—')}</strong></div>
                    <div><span>الدور</span><strong>${escapeHtml(user.roleLabel || user.role)}</strong></div>
                    <div><span>الفرع</span><strong>${escapeHtml(App.branchName(user.branchId))}</strong></div>
                    <div><span>آخر دخول</span><strong>${user.lastLoginAt ? App.dateTime(user.lastLoginAt) : '—'}</strong></div>
                </div>`,
                footer: `<button class="btn" id="accountPassword">${App.icon('key')} تغيير كلمة المرور</button><button class="btn btn-danger" id="accountLogout">${App.icon('logout')} تسجيل الخروج</button>`
            });
            document.getElementById('accountPassword').onclick = () => { App.closeModal(); App.showChangePassword(); };
            document.getElementById('accountLogout').onclick = async () => { App.closeModal(); await App.logout(); };
        });
        document.getElementById('globalSearch').addEventListener('keydown', e => {
            if (e.key === 'Enter') { App.quickSearch(e.target.value); }
        });
        document.addEventListener('click', e => {
            const panel = document.getElementById('notifPanel');
            if (!panel.classList.contains('hidden') && !e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) {
                panel.classList.add('hidden');
            }
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && App.modalStack.length) App.closeModal();
        });
        window.addEventListener('hashchange', App.route);
        App.start();
    });
})();
