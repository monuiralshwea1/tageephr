'use strict';
/* إقلاع التطبيق — يعتمد على النواة والوحدات المحمّلة قبله */
window.addEventListener('load', () => {
    if (!window.App) return;
    // في حال لم تُحمّل النواة بعد DOMContentLoaded
    if (!document.getElementById('shell').classList.contains('hidden')) return;
});
