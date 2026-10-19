/**
 * AgencyPro — Daily Producer Folio Update
 * Netlify Scheduled Function — 9:00 AM Central, every day
 *
 * Emails each producer their own production for the current folio (premium +
 * policies sold) and where that stands against their folio premium goal —
 * the same numbers as the Scoreboard's Folio Goal Tracker. Sent to each
 * producer's own email on file, from REPORT_FROM_EMAIL.
 *
 * Netlify cron is UTC-only, so 9am Central is 14:00 UTC during daylight time
 * and 15:00 UTC during standard time. The schedule fires at BOTH (see
 * netlify.toml) and the handler only proceeds when it's actually 9am in
 * Central — the other firing exits immediately, so exactly one email goes out
 * year-round with no manual DST changes.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 *   REPORT_FROM_EMAIL     → reports@alleninsurancetx.com  (verified domain in Resend)
 * Optional:
 *   FOLIO_UPDATE_CC       → who's cc'd on every producer's email
 *                           (default jason@alleninsurancetx.com; not cc'd on his own)
 *   SKIP_HOUR_CHECK=1     → send regardless of the current hour (for a manual
 *                           "Run now" test from the Netlify dashboard)
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

// ── SOLD-QUOTE TRACKING (mirrors index.html's soldEntries/leadSoldEntries and
// the other report functions). A quote counts toward production the moment IT
// closes won, dated by its own closedDate. Legacy leads with no soldQuotes
// array fall back to whole-lead accounting. ──
const QUOTE_NONSOLD_STATUSES = ['closed-lost','on-hold','not-sold'];
const quoteIsSold = q => !QUOTE_NONSOLD_STATUSES.includes(q && q.status);
function leadSoldEntries(l) {
  if (Array.isArray(l.soldQuotes)) return l.soldQuotes;
  if (l.status === 'Closed Won') {
    const qs = (l.quotes && l.quotes.length) ? l.quotes.filter(quoteIsSold) : [{ line: l.line, carrier: l.carrier, premium: l.premium || 0 }];
    return qs.map(q => ({ ...q, closedDate: l.closedDate || l.date || '' }));
  }
  return [];
}
function soldEntries(leads) {
  const out = [];
  leads.forEach(l => { leadSoldEntries(l).forEach(q => out.push({ ...q, lead: l })); });
  return out;
}

// ── HELPERS ───────────────────────────────────────────────────────────
const fmtDol = n => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const fmtDt  = iso => { if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };
const esc    = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function getCentralHour() {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
  return Number(h);
}

function getFolioPeriod(today) {
  const C = {1:20,2:18,3:18,4:17,5:19,6:18,7:17,8:19,9:18,10:19,11:17,12:17};
  const d = new Date(today + 'T00:00:00');
  const m = d.getMonth()+1, day = d.getDate(), y = d.getFullYear();
  let s, e;
  if (day <= C[m]) {
    const pm = m===1?12:m-1, py = m===1?y-1:y;
    s = new Date(py, pm-1, C[pm]+1);
    e = new Date(y, m-1, C[m]);
  } else {
    s = new Date(y, m-1, C[m]+1);
    const nm = m===12?1:m+1, ny = m===12?y+1:y;
    e = new Date(ny, nm-1, C[nm]);
  }
  const fmt = dt => dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const label = `${fmt(s)} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`;
  e.setHours(23,59,59,999);
  return { periodStart:s, periodEnd:e, label };
}

// Folio goals are stored on each producer as folioGoals { "YYYY-MM-DD": amount },
// keyed by the folio START date (same as getProducerFolioGoal in index.html),
// falling back to the legacy flat `goal`.
const pad2 = n => String(n).padStart(2, '0');
const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
function getProducerFolioGoal(producer, periodStart) {
  const key = dateKey(periodStart);
  if (producer.folioGoals && producer.folioGoals[key] !== undefined) return Number(producer.folioGoals[key]);
  return Number(producer.goal || 0);
}

// Weekdays (Mon–Fri) left in the folio, counting today
function businessDaysLeft(today, periodEnd) {
  let n = 0;
  const d = new Date(today + 'T00:00:00');
  while (d <= periodEnd) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

// ── EMAIL BUILDER ─────────────────────────────────────────────────────
function buildEmail(producer, stats, folio, today) {
  const first = (producer.name || '').split(' ')[0] || 'there';
  const { premium, policies, goal, rows, daysLeft } = stats;
  const pct       = goal > 0 ? Math.round((premium / goal) * 100) : 0;
  const barPct    = Math.min(100, pct);
  const remaining = Math.max(0, goal - premium);
  const reached   = goal > 0 && premium >= goal;
  const perDay    = daysLeft > 0 ? remaining / daysLeft : remaining;

  let standing;
  if (goal <= 0)        standing = 'No folio goal is set for you yet — ask Jason to set one on the Scoreboard.';
  else if (reached)     standing = `🎉 Goal reached! You're ${fmtDol(premium - goal)} over your ${fmtDol(goal)} goal.`;
  else if (daysLeft > 0) standing = `${fmtDol(remaining)} to go — about ${fmtDol(perDay)} per business day over the ${daysLeft} business day${daysLeft===1?'':'s'} left.`;
  else                  standing = `${fmtDol(remaining)} short of goal with the folio closing.`;

  const subject = goal > 0
    ? `📊 Folio update: ${fmtDol(premium)} of ${fmtDol(goal)} (${pct}%)`
    : `📊 Folio update: ${fmtDol(premium)} written so far`;

  const text = `ALLEN INSURANCE AGENCY — Your Folio Update
${'='.repeat(60)}

Hi ${first},

Folio: ${folio.label}   (${daysLeft} business day${daysLeft===1?'':'s'} left)

Premium sold:   ${fmtDol(premium)}
Policies sold:  ${policies}
Folio goal:     ${goal > 0 ? fmtDol(goal) : 'not set'}
Progress:       ${goal > 0 ? pct + '%' : '—'}

${standing}
${rows.length ? `\nYOUR POLICIES THIS FOLIO (${rows.length})\n${'-'.repeat(60)}\n` + rows.map(r => `${fmtDt(r.closedDate)}  ${r.customer} — ${r.line} — ${fmtDol(r.premium)}`).join('\n') + '\n' : ''}
${'='.repeat(60)}
Sent by AgencyPro CRM — Allen Insurance Agency, Colleyville TX
`;

  const cell = (label, value, color) => `<td style="width:33%;background:#f8fafc;border-radius:8px;padding:12px 14px;text-align:center">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px">${label}</div>
      <div style="font-size:24px;font-weight:900;color:${color};margin-top:4px">${value}</div>
    </td>`;

  const policyRows = rows.map(r => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${fmtDt(r.closedDate)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:600">${esc(r.customer)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${esc(r.line)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;font-weight:600;color:#16a34a;text-align:right">${fmtDol(r.premium)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:22px 26px;margin-bottom:16px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:21px;font-weight:800">📊 Your Folio Update</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:2px">Folio ${folio.label} &nbsp;·&nbsp; ${daysLeft} business day${daysLeft===1?'':'s'} left</div>
  </div>
  <div style="background:#fff;border-radius:10px;padding:22px;font-size:14px;line-height:1.6">
    <p style="margin:0 0 14px">Hi ${esc(first)},</p>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 16px">
      <tr>
        ${cell('Premium Sold', fmtDol(premium), '#0ea5a0')}
        ${cell('Policies', policies, '#1B3A5C')}
        ${cell('Folio Goal', goal > 0 ? fmtDol(goal) : '—', '#C47A2A')}
      </tr>
    </table>
    ${goal > 0 ? `<div style="background:#e2e8f0;border-radius:6px;height:14px;overflow:hidden"><div style="height:14px;border-radius:6px;background:${reached ? '#22c55e' : '#0ea5a0'};width:${barPct}%"></div></div>
    <div style="font-size:12px;color:#64748b;margin:6px 0 14px;text-align:right">${pct}% of goal</div>` : ''}
    <p style="margin:0;font-size:15px;font-weight:700;color:${reached ? '#16a34a' : '#1e293b'}">${standing}</p>
    ${rows.length ? `
    <div style="margin:22px 0 6px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Your policies this folio (${rows.length})</div>
    <table style="width:100%;border-collapse:collapse">${policyRows}</table>` : `
    <p style="margin:18px 0 0;font-size:13px;color:#94a3b8">No policies sold yet this folio — today's a good day to change that.</p>`}
    <p style="margin:22px 0 0;font-size:11px;color:#94a3b8">Sent automatically every morning at 9:00 AM Central by AgencyPro CRM.</p>
  </div>
</div></body></html>`;

  return { subject, text, html };
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[send-producer-folio-update] Starting...');

  // Fires at both 14:00 and 15:00 UTC — only the one that lands on 9am Central proceeds.
  const hour = getCentralHour();
  if (hour !== 9 && process.env.SKIP_HOUR_CHECK !== '1') {
    console.log(`[send-producer-folio-update] Central hour is ${hour}, not 9 — skipping (DST double-fire guard).`);
    return new Response(`Skipped — Central hour ${hour}`, { status: 200 });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_WEB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.REPORT_FROM_EMAIL || 'reports@alleninsurancetx.com';
  // Jason is cc'd on every producer's update (skipped on his own, so he doesn't get two copies)
  const ccEmail   = process.env.FOLIO_UPDATE_CC   || 'jason@alleninsurancetx.com';

  if (!projectId || !apiKey) throw new Error('Missing Firebase env vars');
  if (!resendKey)            throw new Error('Missing RESEND_API_KEY');

  const [leads, producers] = await Promise.all([
    firestoreGet(projectId, apiKey, 'leads'),
    firestoreGet(projectId, apiKey, 'producers'),
  ]);

  const today = getTodayCST();
  const folio = getFolioPeriod(today);
  const daysLeft = businessDaysLeft(today, folio.periodEnd);

  // New business only — exclude imported existing customers (cross-sell closes still count)
  const nbLeads = leads.filter(l => !(l.customerType === 'existing' && !l.crossSellRef));
  const folioSold = soldEntries(nbLeads).filter(q => {
    if (!q.closedDate) return false;
    const d = new Date(q.closedDate + 'T00:00:00');
    return d >= folio.periodStart && d <= folio.periodEnd;
  });

  console.log(`[send-producer-folio-update] Folio ${folio.label}: ${folioSold.length} policy(ies) sold agency-wide, ${daysLeft} business day(s) left`);

  let sent = 0, skippedNoEmail = 0, failed = 0;

  for (const producer of producers) {
    if (!producer.email) {
      console.log(`[send-producer-folio-update] SKIP ${producer.name} (${producer.id}) — no email on file`);
      skippedNoEmail++;
      continue;
    }

    const mine = folioSold.filter(q => q.lead.agentId === producer.id)
      .sort((a, b) => (a.closedDate || '').localeCompare(b.closedDate || ''));
    const stats = {
      premium:  mine.reduce((s, q) => s + Number(q.premium || 0), 0),
      policies: mine.length,
      goal:     getProducerFolioGoal(producer, folio.periodStart),
      daysLeft,
      rows: mine.map(q => ({
        closedDate: q.closedDate,
        customer:   `${q.lead.firstName || ''} ${q.lead.lastName || ''}`.trim() || 'Unnamed',
        line:       q.line || q.lead.line || '—',
        premium:    q.premium || 0,
      })),
    };

    const { subject, text, html } = buildEmail(producer, stats, folio, today);

    try {
      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
        body: JSON.stringify({
          from: `AgencyPro CRM <${fromEmail}>`,
          to: [producer.email],
          ...(ccEmail && producer.email.toLowerCase() !== ccEmail.toLowerCase() ? { cc: [ccEmail] } : {}),
          subject, text, html,
        }),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(JSON.stringify(sendData));
      console.log(`[send-producer-folio-update] SENT to ${producer.email} — ${fmtDol(stats.premium)} / ${fmtDol(stats.goal)} — id: ${sendData.id}`);
      sent++;
    } catch (err) {
      console.error(`[send-producer-folio-update] FAILED ${producer.name}: ${err.message}`);
      failed++;
    }
  }

  const summary = `Sent: ${sent}, Skipped (no email): ${skippedNoEmail}, Failed: ${failed}`;
  console.log(`[send-producer-folio-update] Done. ${summary}`);
  return new Response(summary, { status: 200 });
}
