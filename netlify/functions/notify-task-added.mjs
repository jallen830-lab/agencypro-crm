/**
 * AgencyPro — New Task Notification
 * Netlify Function — on-demand (not scheduled), called directly from
 * index.html (saveLeadTask) right after a producer adds an ad-hoc task
 * on a lead. Looks up the task + its assigned producer, and emails the
 * producer a quick confirmation that the task was added.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 *   REPORT_FROM_EMAIL     → reports@youragentonthego.com
 */

const AGENCY_PHONE = '(817) 345-0155';

async function firestoreGetDoc(projectId, apiKey, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  return parseDoc(doc.fields || {});
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
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const projectId  = process.env.FIREBASE_PROJECT_ID;
  const apiKey     = process.env.FIREBASE_WEB_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const fromEmail  = process.env.REPORT_FROM_EMAIL || 'reports@youragentonthego.com';

  if (!projectId || !apiKey) throw new Error('Missing Firebase env vars');
  if (!resendKey)            throw new Error('Missing RESEND_API_KEY');

  let taskId;
  try {
    ({ taskId } = await req.json());
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
  if (!taskId) return new Response('Missing taskId', { status: 400 });

  const task = await firestoreGetDoc(projectId, apiKey, `tasks/${taskId}`);
  if (!task) {
    console.log(`[notify-task-added] task ${taskId} not found`);
    return new Response('Task not found', { status: 404 });
  }
  if (!task.agentId) {
    console.log(`[notify-task-added] task ${taskId} has no assigned producer — nothing to notify`);
    return new Response('No assigned producer', { status: 200 });
  }

  const producer = await firestoreGetDoc(projectId, apiKey, `producers/${task.agentId}`);
  if (!producer || !producer.email) {
    console.log(`[notify-task-added] producer ${task.agentId} not found or has no email — skipping`);
    return new Response('Producer has no email', { status: 200 });
  }

  const subject = `New Task Added${task.leadName ? ` — ${task.leadName}` : ''}`;
  const text = `A new task was added for you in AgencyPro CRM.

${task.leadName ? `Lead: ${task.leadName}\n` : ''}Task: ${task.text}
Due: ${fmtDate(task.due)}
Priority: ${task.priority || 'medium'}

Allen Insurance Agency
${AGENCY_PHONE}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:18px;font-weight:800">📝 New Task Added</div>
  </div>
  <div style="background:#fff;border-radius:10px;padding:20px;font-size:14px;line-height:1.6">
    ${task.leadName ? `<div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase">Lead</div><div style="margin-bottom:12px">${task.leadName}</div>` : ''}
    <div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase">Task</div>
    <div style="margin-bottom:12px">${task.text}</div>
    <div style="display:flex;gap:24px">
      <div><div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase">Due</div><div>${fmtDate(task.due)}</div></div>
      <div><div style="font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase">Priority</div><div style="text-transform:capitalize">${task.priority || 'medium'}</div></div>
    </div>
  </div>
</div></body></html>`;

  try {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `AgencyPro CRM <${fromEmail}>`,
        to: [producer.email],
        subject,
        text,
        html,
      }),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) throw new Error(JSON.stringify(sendData));

    console.log(`[notify-task-added] Notified ${producer.email} for task ${taskId} — id: ${sendData.id}`);
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error(`[notify-task-added] FAILED for task ${taskId}: ${err.message}`);
    return new Response('Send failed', { status: 500 });
  }
}
