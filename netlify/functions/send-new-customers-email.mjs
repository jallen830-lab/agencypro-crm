/**
 * AgencyPro — Daily New Customers Email
 * Netlify Scheduled Function — fires daily at 5:00 PM Central (23:00 UTC),
 * same slot as daily-kpi-report.mjs
 *
 * Sends Lindsay (marketing) a simple list of that day's new customers —
 * name and email only, nothing else — so she can follow up (welcome
 * emails, review requests, etc.). Skips sending on days with zero new
 * customers, no empty-inbox noise.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 *   REPORT_FROM_EMAIL     → reports@alleninsurancetx.com  (verified domain in Resend)
 *   LINDSAY_EMAIL         → lindsay1.jallen1@farmersagency.com
 */

// ── FIRESTORE REST API ────────────────────────────────────────────────
async function firestoreGet(projectId, apiKey, collection) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?key=${apiKey}&pageSize=2000`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Firestore ${collection} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.documents || []).map(doc => ({
    id: doc.name.split('/').pop(),
    ...parseDoc(doc.fields || {})
  }));
}
function parseDoc(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = parseVal(v);
  return out;
}
function parseVal(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue    !== undefined) return null;
  if (v.arrayValue)  return (v.arrayValue.values || []).map(parseVal);
  if (v.mapValue)    return parseDoc(v.mapValue.fields || {});
  return null;
}

// ── HELPERS ───────────────────────────────────────────────────────────
const fmtDt = iso => { if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };

function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// A closed-won lead counts as a "new customer" here the same way every
// other report defines it — excludes existing-customer file conversions
// (those are already customers, not new ones).
const isNewCustomerClose = l =>
  l.status === 'Closed Won' && !(l.customerType === 'existing' && !l.crossSellRef);

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[send-new-customers-email] Starting...');

  const projectId  = process.env.FIREBASE_PROJECT_ID;
  const apiKey     = process.env.FIREBASE_WEB_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const fromEmail  = process.env.REPORT_FROM_EMAIL || 'reports@alleninsurancetx.com';
  const toEmail    = process.env.LINDSAY_EMAIL     || 'lindsay1.jallen1@farmersagency.com';

  if (!projectId || !apiKey)  throw new Error('Missing Firebase env vars');
  if (!resendKey)             throw new Error('Missing RESEND_API_KEY');

  const leads = await firestoreGet(projectId, apiKey, 'leads');
  const today = getTodayCST();

  const newCustomers = leads
    .filter(l => isNewCustomerClose(l) && (l.closedDate || '') === today)
    .map(l => ({ name: `${l.firstName||''} ${l.lastName||''}`.trim() || 'Unnamed', email: l.email || '' }));

  console.log(`[send-new-customers-email] ${newCustomers.length} new customer(s) closed today (${today})`);

  if (!newCustomers.length) {
    console.log('[send-new-customers-email] Nothing to send today — skipping.');
    return new Response('Skipped — no new customers today', { status: 200 });
  }

  const count = newCustomers.length;

  const text = `ALLEN INSURANCE AGENCY — New Customers Today (${fmtDt(today)})\n${'='.repeat(60)}\n\n` +
    newCustomers.map(c => `${c.name} — ${c.email || 'no email on file'}`).join('\n') +
    `\n\n${'='.repeat(60)}\nSent by AgencyPro CRM — Allen Insurance Agency, Colleyville TX\n`;

  const rows = newCustomers.map(c => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${c.name}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${c.email || '<span style="color:#94a3b8;font-style:italic">No email on file</span>'}</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:24px 28px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:22px;font-weight:800">🎉 ${count} New Customer${count===1?'':'s'} Today</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:2px">${fmtDt(today)}</div>
  </div>
  <div style="background:#fff;border-radius:10px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Customer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Email</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="text-align:center;color:#94a3b8;font-size:11px;padding:16px 0 8px">
    Sent automatically at 5:00 PM Central &nbsp;·&nbsp; AgencyPro CRM &nbsp;·&nbsp; Allen Insurance Agency
  </div>
</div></body></html>`;

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from:    `AgencyPro CRM <${fromEmail}>`,
      to:      [toEmail],
      subject: `🎉 ${count} New Customer${count===1?'':'s'} Today — ${fmtDt(today)}`,
      text,
      html,
    }),
  });

  const sendData = await sendRes.json();
  if (!sendRes.ok) throw new Error(`Resend error: ${JSON.stringify(sendData)}`);

  console.log(`[send-new-customers-email] Sent to ${toEmail} — ${count} customer(s) — id: ${sendData.id}`);
  return new Response('OK', { status: 200 });
}
