/**
 * AgencyPro — Quoted Follow-Up Auto-Emails
 * Netlify Scheduled Function — fires daily at 9:00 AM Central (15:00 UTC)
 *
 * Sends the Day 3 "value" and Day 10 "last attempt" follow-up emails for
 * Quoted leads automatically, from the assigned producer's own mailbox on
 * the verified youragentonthego.com domain. Each task is created by
 * createQuotedFollowUpTasks() in index.html with taskType:'email' and
 * autoSend:true — this function finds ones due today, sends via Resend,
 * and marks them done so they drop off the open task list.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 */

const DEFAULT_FROM_NAME  = 'Jason Allen';
const DEFAULT_FROM_EMAIL = 'jason@youragentonthego.com';
const AGENCY_PHONE = '(817) 345-0155';

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
async function firestoreMarkDone(projectId, apiKey, taskId) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tasks/${taskId}?updateMask.fieldPaths=done&updateMask.fieldPaths=autoSentAt&key=${apiKey}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        done: { booleanValue: true },
        autoSentAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore update task ${taskId} failed: ${res.status} ${await res.text()}`);
}

// ── HELPERS ───────────────────────────────────────────────────────────
function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ── EMAIL TEMPLATES (generic — first name + sending producer only) ────
function buildEmail(sequenceDay, firstName, producerName) {
  if (sequenceDay === 10) {
    const subject = 'Still Here If You Need Us';
    const text = `Hi ${firstName},

I don't want to keep bothering you, so this will be my last check-in on your insurance quote for now.

If you're still interested or have any questions, I'm happy to help — just reply to this email or give us a call anytime.

Either way, thanks for considering Allen Insurance Agency!

${producerName}
Allen Insurance Agency
${AGENCY_PHONE}`;
    const bodyHtml = `
      <p>Hi ${firstName},</p>
      <p>I don't want to keep bothering you, so this will be my last check-in on your insurance quote for now.</p>
      <p>If you're still interested or have any questions, I'm happy to help — just reply to this email or give us a call anytime.</p>
      <p>Either way, thanks for considering Allen Insurance Agency!</p>
      <p>${producerName}<br>Allen Insurance Agency<br>${AGENCY_PHONE}</p>`;
    return { subject, text, bodyHtml };
  }
  // default: Day 3
  const subject = 'Following Up on Your Insurance Quote';
  const text = `Hi ${firstName},

I wanted to follow up and make sure you received the insurance quote we put together for you.

If you have any questions at all, I'm happy to help — just reply to this email or give us a call.

Looking forward to hearing from you!

${producerName}
Allen Insurance Agency
${AGENCY_PHONE}`;
  const bodyHtml = `
    <p>Hi ${firstName},</p>
    <p>I wanted to follow up and make sure you received the insurance quote we put together for you.</p>
    <p>If you have any questions at all, I'm happy to help — just reply to this email or give us a call.</p>
    <p>Looking forward to hearing from you!</p>
    <p>${producerName}<br>Allen Insurance Agency<br>${AGENCY_PHONE}</p>`;
  return { subject, text, bodyHtml };
}

function wrapHtml(bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px">Allen Insurance Agency</div>
  </div>
  <div style="background:#fff;border-radius:10px;padding:24px;font-size:14px;line-height:1.6">${bodyHtml}</div>
</div></body></html>`;
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[send-quoted-followup-emails] Starting...');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_WEB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!projectId || !apiKey) throw new Error('Missing Firebase env vars');
  if (!resendKey)            throw new Error('Missing RESEND_API_KEY');

  const [tasks, leads, producers] = await Promise.all([
    firestoreGet(projectId, apiKey, 'tasks'),
    firestoreGet(projectId, apiKey, 'leads'),
    firestoreGet(projectId, apiKey, 'producers'),
  ]);

  const today = getTodayCST();
  const due = tasks.filter(t =>
    t.type === 'quoted-followup' &&
    t.taskType === 'email' &&
    t.autoSend === true &&
    !t.done &&
    (t.due || '') <= today
  );

  console.log(`[send-quoted-followup-emails] ${due.length} email(s) due (today=${today})`);

  let sent = 0, skipped = 0, failed = 0;

  for (const task of due) {
    const lead = leads.find(l => l.id === task.leadId);
    const toEmail = lead?.email;
    if (!toEmail) {
      console.log(`[send-quoted-followup-emails] SKIP task ${task.id} — lead ${task.leadId} has no email on file`);
      skipped++;
      continue;
    }

    const firstName = lead.firstName || (task.leadName || '').split(' ')[0] || 'there';
    const producer   = producers.find(p => p.id === task.agentId);
    const fromName   = producer?.name  || DEFAULT_FROM_NAME;
    const fromEmail  = producer?.email || DEFAULT_FROM_EMAIL;
    if (producer && !producer.email) {
      console.log(`[send-quoted-followup-emails] WARNING producer ${producer.name} (${producer.id}) has no email set — falling back to ${DEFAULT_FROM_EMAIL}`);
    }

    const { subject, text, bodyHtml } = buildEmail(task.sequenceDay, firstName, fromName);
    const html = wrapHtml(bodyHtml);

    try {
      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [toEmail],
          subject,
          text,
          html,
        }),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(JSON.stringify(sendData));

      await firestoreMarkDone(projectId, apiKey, task.id);
      console.log(`[send-quoted-followup-emails] SENT task ${task.id} (day ${task.sequenceDay}) to ${toEmail} from ${fromEmail} — id: ${sendData.id}`);
      sent++;
    } catch (err) {
      console.error(`[send-quoted-followup-emails] FAILED task ${task.id}: ${err.message}`);
      failed++;
    }
  }

  const summary = `Sent: ${sent}, Skipped (no email): ${skipped}, Failed: ${failed}`;
  console.log(`[send-quoted-followup-emails] Done. ${summary}`);
  return new Response(summary, { status: 200 });
}
