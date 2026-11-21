'use strict';

/* ═══════════════════════════════════════════════════════════════
   دليل الاستخدام: صفحة تعرض دليل النظام داخل التطبيق.
   المحتوى ملف ثابت guide/guide.html حتى يخدم الواجهة والملف PDF
   من مصدر واحد، مع زر عودة للرئيسية وزر تنزيل PDF.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    const A = window.App;
    const GUIDE_URL = '/assets/tageephr/hrpro/assets/guide/guide.html';

    A.registerRoutes([
        {
            path: 'guide', module: 'guide', label: 'دليل الاستخدام',
            subtitle: 'شرح كل شاشات النظام وخطوات الاستخدام',
            icon: 'file', group: 'الرئيسية', hidden: true
        }
    ]);

    A.registerModule('guide', {
        render: async view => {
            view.innerHTML = `
                <div class="card" style="padding:0;overflow:hidden">
                    <iframe class="guide-frame" src="${GUIDE_URL}" title="دليل استخدام النظام"
                        style="width:100%;height:calc(100vh - 190px);min-height:520px;border:0;display:block;background:#fff"></iframe>
                </div>`;
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('guideBtn');
        if (btn) btn.addEventListener('click', () => A.navigate('/guide'));
    });
})();
