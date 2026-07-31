/**
 * AgencyPro — Daily Task Digest
 * Netlify Scheduled Function — fires daily at 7:00 AM Central (13:00 UTC)
 *
 * Sends each producer a personal email listing their open tasks that are
 * due today or overdue (same set the Tasks tab's "Open" filter shows),
 * from their own mailbox on the verified youragentonthego.com domain.
 * Runs before the 9am auto-send emails, so autoSend:true tasks due today
 * are flagged as "sends automatically this morning" rather than "sent."
 * Skips producers with zero open tasks — no empty inbox noise.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 */

const AGENCY_PHONE = '(817) 345-0155';
const SYSTEM_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'reports@youragentonthego.com';

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
function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

const TYPE_LABELS = {
  'quoted-followup':          'Quoted Follow-Up',
  'permits-followup':         'Permits Follow-Up',
  'remarketing-touchpoint':   'Remarketing',
  'referral-partner-cadence': 'Referral Partner',
  'referral-partner-sequence':'Referral Partner',
  'referral-thankyou':        'Referral Thank-You',
  'lead-task':                'Lead Task',
};
function taskCategory(t) {
  return TYPE_LABELS[t.type] || 'General Task';
}

// ── EMAIL BUILDER ────────────────────────────────────────────────────
function buildDigest(producerFirstName, today, tasks) {
  const overdue = tasks.filter(t => t.due < today);
  const dueToday = tasks.filter(t => t.due >= today);
  const count = tasks.length;

  const rowText = t => {
    const dueTag = t.due < today ? `OVERDUE (was due ${fmtDate(t.due)})` : 'Due Today';
    const autoNote = t.autoSend
      ? (t.due < today ? ' [AUTO-SEND OVERDUE — check lead has an email on file]' : ' [auto-sends this morning — no action needed]')
      : '';
    return `- [${dueTag}] (${taskCategory(t)}) ${t.text}${autoNote}`;
  };

  const text = `ALLEN INSURANCE AGENCY — Your Tasks Today
${'='.repeat(60)}

Hi ${producerFirstName},

You have ${count} open task${count === 1 ? '' : 's'} due today or overdue.

${overdue.length ? `OVERDUE (${overdue.length})\n${'-'.repeat(60)}\n${overdue.map(rowText).join('\n')}\n\n` : ''}${dueToday.length ? `DUE TODAY (${dueToday.length})\n${'-'.repeat(60)}\n${dueToday.map(rowText).join('\n')}\n\n` : ''}${'='.repeat(60)}
Sent by AgencyPro CRM — Allen Insurance Agency, Colleyville TX
${AGENCY_PHONE}`;

  const rowHtml = t => {
    const isOverdue = t.due < today;
    const dueBadge = isOverdue
      ? `<span style="background:#fee2e2;color:#ef4444;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">⚠️ OVERDUE — was due ${fmtDate(t.due)}</span>`
      : `<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">📅 Due Today</span>`;
    const autoBadge = t.autoSend
      ? (isOverdue
          ? `<span style="background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;margin-left:6px">🤖 auto-send overdue — check lead email</span>`
          : `<span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;margin-left:6px">🤖 auto-sends this morning</span>`)
      : '';
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0">
        <div style="font-size:13px;color:#1e293b;margin-bottom:6px">${t.text}</div>
        <div>${dueBadge}${autoBadge} <span style="font-size:11px;color:#94a3b8;margin-left:6px">${taskCategory(t)}</span></div>
      </td>
    </tr>`;
  };

  const bodyHtml = `
    <p>Hi ${producerFirstName},</p>
    <p style="font-size:16px;font-weight:800;color:#ef4444">🔴 You have ${count} open task${count === 1 ? '' : 's'} due today or overdue.</p>
    ${overdue.length ? `
    <div style="margin:18px 0 8px;font-size:12px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.5px">Overdue (${overdue.length})</div>
    <table style="width:100%;border-collapse:collapse">${overdue.map(rowHtml).join('')}</table>` : ''}
    ${dueToday.length ? `
    <div style="margin:18px 0 8px;font-size:12px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:.5px">Due Today (${dueToday.length})</div>
    <table style="width:100%;border-collapse:collapse">${dueToday.map(rowHtml).join('')}</table>` : ''}
    <p style="margin-top:20px;font-size:12px;color:#94a3b8">Sent automatically every morning by AgencyPro CRM.</p>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:20px;font-weight:800">🔴 Your Tasks Today</div>
  </div>
  <div style="background:#fff;border-radius:10px;padding:24px;font-size:14px;line-height:1.6">${bodyHtml}</div>
</div></body></html>`;

  const subject = overdue.length
    ? `🔴 ${count} Open Tasks (${overdue.length} Overdue) — ${fmtDate(today)}`
    : `⏰ ${count} Task${count === 1 ? '' : 's'} Due Today — ${fmtDate(today)}`;

  return { subject, text, html };
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[send-daily-task-digest] Starting...');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_WEB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!projectId || !apiKey) throw new Error('Missing Firebase env vars');
  if (!resendKey)            throw new Error('Missing RESEND_API_KEY');

  const [tasks, producers] = await Promise.all([
    firestoreGet(projectId, apiKey, 'tasks'),
    firestoreGet(projectId, apiKey, 'producers'),
  ]);

  const today = getTodayCST();
  const open = tasks.filter(t => !t.done && t.agentId && (t.due || '') <= today);

  console.log(`[send-daily-task-digest] ${open.length} open task(s) due today or overdue (today=${today})`);

  let sent = 0, skippedEmpty = 0, skippedNoEmail = 0, failed = 0;

  for (const producer of producers) {
    const producerTasks = open.filter(t => t.agentId === producer.id)
      .sort((a, b) => (a.due || '').localeCompare(b.due || ''));

    if (!producerTasks.length) { skippedEmpty++; continue; }

    if (!producer.email) {
      console.log(`[send-daily-task-digest] SKIP producer ${producer.name} (${producer.id}) — no email on file`);
      skippedNoEmail++;
      continue;
    }

    const firstName = (producer.name || '').split(' ')[0] || 'there';
    const { subject, text, html } = buildDigest(firstName, today, producerTasks);

    try {
      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: `AgencyPro CRM <${SYSTEM_FROM_EMAIL}>`,
          to: [producer.email],
          subject,
          text,
          html,
          headers: { 'Importance': 'high', 'X-Priority': '1' },
        }),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(JSON.stringify(sendData));

      console.log(`[send-daily-task-digest] SENT to ${producer.email} — ${producerTasks.length} task(s) — id: ${sendData.id}`);
      sent++;
    } catch (err) {
      console.error(`[send-daily-task-digest] FAILED producer ${producer.id}: ${err.message}`);
      failed++;
    }
  }

  const summary = `Sent: ${sent}, Skipped (empty): ${skippedEmpty}, Skipped (no email): ${skippedNoEmail}, Failed: ${failed}`;
  console.log(`[send-daily-task-digest] Done. ${summary}`);
  return new Response(summary, { status: 200 });
}
