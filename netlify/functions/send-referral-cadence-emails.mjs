/**
 * AgencyPro — Referral Partner 90-Day Cadence Emails
 * Netlify Scheduled Function — fires daily at 9:00 AM Central (15:00 UTC)
 *
 * Sends the Week 3/6/9/12 emails from whichever 90-day cadence applies to
 * the partner's type — REFERRAL_REALTOR_CADENCE (Realtor/Mortgage Lender),
 * REFERRAL_ROOFER_CADENCE (Roofer), or REFERRAL_BUSINESS_BANKER_CADENCE
 * (Business Banker) in index.html, content mirrored here as
 * REALTOR_CADENCE/ROOFER_CADENCE/BUSINESS_BANKER_CADENCE keyed by each
 * task's cadenceType field.
 * Sends from the assigned producer's own mailbox on the verified
 * youragentonthego.com domain. When the Week 12 (appreciation) email
 * sends, this also creates the next cycle's 12 tasks (same cadenceType)
 * so the cadence repeats indefinitely for as long as the partner stays active.
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 */

const DEFAULT_FROM_NAME  = 'Jason Allen';
const DEFAULT_FROM_EMAIL = 'jason@youragentonthego.com';

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
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
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
async function firestoreCreateTask(projectId, apiKey, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/tasks?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });
  if (!res.ok) throw new Error(`Firestore create task failed: ${res.status} ${await res.text()}`);
}

// ── HELPERS ───────────────────────────────────────────────────────────
function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── 90-DAY CADENCES (mirror REFERRAL_REALTOR_CADENCE / REFERRAL_ROOFER_CADENCE in index.html) ──
const REALTOR_CADENCE = [
  { week: 1,  channel: 'text' },
  { week: 2,  channel: 'call' },
  { week: 3,  channel: 'email',
    subject: 'Three Insurance Issues That Can Delay a Closing',
    body: (fn, pl) => `Hi ${fn},\n\nOne of the easiest ways to keep a transaction on schedule is to identify potential insurance issues early.\n\n• Roof condition or age\n• Prior claims\n• Replacement cost concerns\n\nIf you ever have a property that raises questions, send me the address before your client submits an offer. We're happy to review it and identify potential insurance concerns upfront.\n\nThank you for trusting Allen Insurance Agency as a resource.\n\n${pl}\nAllen Insurance Agency` },
  { week: 4,  channel: 'text' },
  { week: 5,  channel: 'call' },
  { week: 6,  channel: 'email',
    subject: 'Helping Buyers Avoid Last-Minute Insurance Surprises',
    body: (fn, pl) => `Hi ${fn},\n\nEncouraging buyers to think about insurance earlier in the process can reduce stress before closing.\n\nA quick insurance review before the option period ends can help identify issues with older roofs, prior claims, replacement costs, vacant homes, and unique property features.\n\nSend us the address anytime—we're happy to help.\n\n${pl}\nAllen Insurance Agency` },
  { week: 7,  channel: 'text' },
  { week: 8,  channel: 'call' },
  { week: 9,  channel: 'email',
    subject: 'A Quick Home Maintenance Tip You Can Share with Clients',
    body: (fn, pl) => `Hi ${fn},\n\nHere's a simple tip you can share with homeowners: clean gutters, trim trees away from the roof, check for plumbing leaks, and service the HVAC system regularly. Preventative maintenance helps reduce claims.\n\nFeel free to forward this to clients.\n\n${pl}\nAllen Insurance Agency` },
  { week: 10, channel: 'text' },
  { week: 11, channel: 'call' },
  { week: 12, channel: 'email',
    subject: 'Thank You for Your Partnership',
    body: (fn, pl) => `Hi ${fn},\n\nI just wanted to say thank you for your partnership. We appreciate the opportunity to work alongside you and help make your transactions smoother through responsive communication and dependable advice.\n\nIf there's ever anything we can do better to support your business, I'd love your feedback.\n\nThank you!\n\n${pl}\nAllen Insurance Agency` },
];

const ROOFER_CADENCE = [
  { week: 1,  channel: 'text' },
  { week: 2,  channel: 'call' },
  { week: 3,  channel: 'email',
    subject: 'Helping Homeowners Before the Claim',
    body: (fn, pl) => `Hi ${fn},\n\nOne of the best ways we can work together is by helping homeowners understand their coverage before a claim is filed. If you ever have someone with questions about deductibles, replacement cost, or the claims process, feel free to connect us.\n\nThanks for your partnership!\n\n${pl}\nAllen Insurance Agency` },
  { week: 4,  channel: 'text' },
  { week: 5,  channel: 'call' },
  { week: 6,  channel: 'email',
    subject: 'Seasonal Roof Maintenance Tips',
    body: (fn, pl) => `Hi ${fn},\n\nWe're sharing seasonal home maintenance tips with our clients. If you have a favorite roof checklist, we'd love to feature it and recommend your company.\n\n${pl}\nAllen Insurance Agency` },
  { week: 7,  channel: 'text' },
  { week: 8,  channel: 'call' },
  { week: 9,  channel: 'email',
    subject: 'Preparing Homeowners for Storm Season',
    body: (fn, pl) => `Hi ${fn},\n\nLet's help homeowners prepare before storms arrive. We can even co-host a homeowner education event or create a joint checklist.\n\n${pl}\nAllen Insurance Agency` },
  { week: 10, channel: 'text' },
  { week: 11, channel: 'call' },
  { week: 12, channel: 'email',
    subject: 'Thank You for Your Partnership',
    body: (fn, pl) => `Hi ${fn},\n\nThank you for trusting Allen Insurance Agency as a partner. We appreciate your professionalism and look forward to helping many more homeowners together.\n\n${pl}\nAllen Insurance Agency` },
];

const BUSINESS_BANKER_CADENCE = [
  { week: 1,  channel: 'text' },
  { week: 2,  channel: 'call' },
  { week: 3,  channel: 'email',
    subject: 'Helping Business Clients Avoid Insurance Surprises',
    body: (fn, pl) => `Hi ${fn},\n\nWe can review business insurance before financing, expansions, or property purchases to help identify coverage gaps before they become problems. Feel free to connect us anytime.\n\n${pl}\nAllen Insurance Agency` },
  { week: 4,  channel: 'text' },
  { week: 5,  channel: 'call' },
  { week: 6,  channel: 'email',
    subject: 'Common Coverage Gaps for Business Owners',
    body: (fn, pl) => `Hi ${fn},\n\nMany business owners overlook cyber liability, umbrella coverage, and business income protection. We'd be happy to review any client's policy.\n\n${pl}\nAllen Insurance Agency` },
  { week: 7,  channel: 'text' },
  { week: 8,  channel: 'call' },
  { week: 9,  channel: 'email',
    subject: 'Insurance Reviews for Growing Businesses',
    body: (fn, pl) => `Hi ${fn},\n\nGrowing businesses often need coverage updates for payroll, vehicles, inventory, or new locations. We'd be glad to review their policies.\n\n${pl}\nAllen Insurance Agency` },
  { week: 10, channel: 'text' },
  { week: 11, channel: 'call' },
  { week: 12, channel: 'email',
    subject: 'Thank You for Your Partnership',
    body: (fn, pl) => `Hi ${fn},\n\nThank you for your continued partnership. We appreciate the trust you place in Allen Insurance Agency and look forward to helping your clients.\n\n${pl}\nAllen Insurance Agency` },
];

const CADENCES = { realtor: REALTOR_CADENCE, roofer: ROOFER_CADENCE, businessBanker: BUSINESS_BANKER_CADENCE };

function wrapHtml(bodyText) {
  const bodyHtml = bodyText.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
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
  console.log('[send-referral-cadence-emails] Starting...');

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_WEB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!projectId || !apiKey) throw new Error('Missing Firebase env vars');
  if (!resendKey)            throw new Error('Missing RESEND_API_KEY');

  const [tasks, partners, producers] = await Promise.all([
    firestoreGet(projectId, apiKey, 'tasks'),
    firestoreGet(projectId, apiKey, 'referralPartners'),
    firestoreGet(projectId, apiKey, 'producers'),
  ]);

  const today = getTodayCST();
  const due = tasks.filter(t =>
    t.type === 'referral-partner-cadence' &&
    t.autoSend === true &&
    !t.done &&
    (t.due || '') <= today
  );

  console.log(`[send-referral-cadence-emails] ${due.length} email(s) due (today=${today})`);

  let sent = 0, skipped = 0, failed = 0, cyclesRestarted = 0;

  for (const task of due) {
    const partner = partners.find(p => p.id === task.partnerId);
    const toEmail = partner?.email;
    if (!toEmail) {
      console.log(`[send-referral-cadence-emails] SKIP task ${task.id} — partner ${task.partnerId} has no email on file`);
      skipped++;
      continue;
    }

    const cadence = CADENCES[task.cadenceType];
    const step = cadence && cadence.find(c => c.week === task.week);
    if (!step || step.channel !== 'email') {
      console.log(`[send-referral-cadence-emails] SKIP task ${task.id} — week ${task.week} (cadenceType=${task.cadenceType}) is not a recognized email step`);
      skipped++;
      continue;
    }

    const firstName = (partner.name || task.partnerName || '').split(' ')[0] || 'there';
    const producer   = producers.find(p => p.id === task.agentId);
    const fromName   = producer?.name  || DEFAULT_FROM_NAME;
    const fromEmail  = producer?.email || DEFAULT_FROM_EMAIL;
    if (producer && !producer.email) {
      console.log(`[send-referral-cadence-emails] WARNING producer ${producer.name} (${producer.id}) has no email set — falling back to ${DEFAULT_FROM_EMAIL}`);
    }

    const text = step.body(firstName, fromName);
    const html = wrapHtml(text);

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
          subject: step.subject,
          text,
          html,
        }),
      });
      const sendData = await sendRes.json();
      if (!sendRes.ok) throw new Error(JSON.stringify(sendData));

      await firestoreMarkDone(projectId, apiKey, task.id);
      console.log(`[send-referral-cadence-emails] SENT task ${task.id} (week ${task.week}) to ${toEmail} from ${fromEmail} — id: ${sendData.id}`);
      sent++;

      // Week 12 (the last email of the cycle) — spin up the next cycle so the cadence repeats.
      if (task.week === 12) {
        const nextAnchor = addDays(task.cadenceAnchor, 84); // 12 weeks x 7 days
        const nextCycle = (task.cycle || 1) + 1;
        for (const c of cadence) {
          const dueDate = addDays(nextAnchor, 5 + (c.week - 1) * 7);
          await firestoreCreateTask(projectId, apiKey, {
            text: `${c.channel === 'email' ? '📧' : c.channel === 'call' ? '📞' : '💬'} Week ${c.week} — ${firstName}${partner.company ? ' (' + partner.company + ')' : ''}`,
            due: dueDate,
            priority: c.channel === 'text' ? 'high' : c.channel === 'call' ? 'high' : (c.week === 12 ? 'high' : 'medium'),
            agentId: task.agentId || '',
            done: false,
            partnerId: task.partnerId,
            partnerName: partner.name,
            touchpointType: c.channel,
            type: 'referral-partner-cadence',
            cadenceType: task.cadenceType,
            week: c.week,
            cycle: nextCycle,
            cadenceAnchor: nextAnchor,
            autoSend: c.channel === 'email',
          });
        }
        console.log(`[send-referral-cadence-emails] Restarted cadence for partner ${task.partnerId} — cycle ${nextCycle}, anchor ${nextAnchor}`);
        cyclesRestarted++;
      }
    } catch (err) {
      console.error(`[send-referral-cadence-emails] FAILED task ${task.id}: ${err.message}`);
      failed++;
    }
  }

  const summary = `Sent: ${sent}, Skipped (no email): ${skipped}, Failed: ${failed}, Cycles restarted: ${cyclesRestarted}`;
  console.log(`[send-referral-cadence-emails] Done. ${summary}`);
  return new Response(summary, { status: 200 });
}
