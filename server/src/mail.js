'use strict';
/*
 * E-mail fra HolyMoly (bekræft e-mail, nulstil adgangskode, invitationer, licensbestillinger).
 *
 *   SMTP_URL   fx smtps://bruger:kode@smtp.simply.com:465  (eller smtp://...:587 med STARTTLS)
 *   MAIL_FROM  fx "HolyMoly <noreply@holymoly.dk>"
 *
 * Uden SMTP_URL skrives mailen i serverens log og i data/outbox/ (til test og lokal udvikling) – den sendes ikke.
 */
const fs = require('node:fs');
const path = require('node:path');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Enkel, pæn HTML-mail: overskrift, afsnit og én knap. Al tekst escapes. */
function render({ title, lines = [], button, after = [] }) {
  const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#16181d">${esc(t)}</p>`;
  const btn = button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#2f5bea;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:#6b7280">Virker knappen ikke, så kopiér adressen: <br><span style="word-break:break-all">${esc(button.url)}</span></p>` : '';
  const html = `<!doctype html><html lang="da"><body style="margin:0;background:#f4f5f7;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:28px 16px">
<div style="font-weight:700;font-size:20px;margin-bottom:16px;color:#16181d">HolyMoly</div>
<div style="background:#fff;border-radius:12px;padding:24px">
<h1 style="font-size:19px;margin:0 0 14px;color:#16181d">${esc(title)}</h1>
${lines.map(p).join('\n')}${btn}${after.map(p).join('\n')}
</div>
<p style="font-size:12px;color:#6b7280;margin-top:16px">Du får denne mail, fordi nogen brugte din e-mail på HolyMoly. Var det ikke dig, kan du se bort fra den.</p>
</div></body></html>`;
  const text = [title, '', ...lines, ...(button ? ['', button.label + ': ' + button.url] : []), ...(after.length ? ['', ...after] : [])].join('\n');
  return { html, text };
}

function createMailer({ smtpUrl, from, dataDir, log, send }) {
  const outbox = path.join(dataDir, 'outbox');
  let transport = null;
  if (!send && smtpUrl) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport(smtpUrl);
  }
  return {
    enabled: !!(send || transport),
    /** Sender en mail. Fejler aldrig for kalderen (en mail-fejl må ikke vælte et login) – men logges. */
    async send({ to, subject, title, lines, button, after }) {
      const { html, text } = render({ title: title || subject, lines, button, after });
      const msg = { from: from || 'HolyMoly <noreply@holymoly.dk>', to, subject, text, html };
      try {
        if (send) return await send(msg);
        if (transport) { await transport.sendMail(msg); return; }
        fs.mkdirSync(outbox, { recursive: true });
        const f = path.join(outbox, `${Date.now()}-${String(to).replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
        fs.writeFileSync(f, `Til: ${to}\nEmne: ${subject}\n\n${text}\n`);
        log(`E-mail (ikke sendt – SMTP_URL mangler) til ${to}: ${subject}${button ? ' – ' + button.url : ''}`);
      } catch (e) {
        log('Kunne ikke sende e-mail til', to, e.message);
      }
    },
  };
}

module.exports = { createMailer, render };
