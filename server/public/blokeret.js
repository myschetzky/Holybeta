let what = location.hash.slice(1) || '';
try { what = decodeURIComponent(what); } catch (e) { /* ugyldig kodning – vis som den er */ }
document.getElementById('what').textContent = what;
