/**
 * AgencyPro — Daily KPI Report
 * Netlify Scheduled Function — fires daily at 5:00 PM Central (23:00 UTC)
 *
 * Environment variables required:
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 *   REPORT_FROM_EMAIL     → onboarding@resend.dev  (use this until you verify a domain)
 *   REPORT_TO_EMAIL       → jallen1@farmersagent.com
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
const fmtDol = n   => '$' + Number(n || 0).toLocaleString('en-US');
const fmtDt  = iso => { if (!iso) return '—'; const [y,m,d] = iso.split('-'); return `${m}/${d}/${y}`; };
const pad    = (s, w, r = false) => { const str = String(s ?? ''); return r ? str.padStart(w) : str.padEnd(w); };
const ln     = (n, ch = '-') => ch.repeat(n);

function getTodayCST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
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
  e.setHours(23,59,59,999);
  return { periodStart:s, periodEnd:e, label:`${fmt(s)} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}` };
}

const polCount  = l => (l.quotes&&l.quotes.length) ? l.quotes.length : 1;
const expandQ   = l => {
  const name = `${l.firstName||''} ${l.lastName||''}`.trim();
  if (l.quotes&&l.quotes.length) return l.quotes.map(q=>({name,agentId:l.agentId,line:q.line||l.line||'Other',premium:q.premium||0}));
  return [{name,agentId:l.agentId,line:l.line||'Other',premium:l.premium||0}];
};

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[daily-kpi-report] Starting...');

  const projectId  = process.env.FIREBASE_PROJECT_ID;
  const apiKey     = process.env.FIREBASE_WEB_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const fromEmail  = process.env.REPORT_FROM_EMAIL || 'onboarding@resend.dev';
  const toEmail    = process.env.REPORT_TO_EMAIL   || 'jallen1@farmersagent.com';

  if (!projectId || !apiKey)  throw new Error('Missing Firebase env vars');
  if (!resendKey)             throw new Error('Missing RESEND_API_KEY');

  const [leads, producers] = await Promise.all([
    firestoreGet(projectId, apiKey, 'leads'),
    firestoreGet(projectId, apiKey, 'producers'),
  ]);

  const getProd = id => producers.find(p=>p.id===id)?.name || 'Unassigned';
  const today   = getTodayCST();
  const folio   = getFolioPeriod(today);

  // ── TODAY ──
  const tqLeads = leads.filter(l => l.quotedDate === today);
  const tqRows  = tqLeads.flatMap(expandQ);
  const tcLeads = leads.filter(l => l.status==='Closed Won' && !(l.customerType==='existing'&&!l.crossSellRef) && (l.closedDate||'')===today);
  const tPol    = tcLeads.reduce((s,l)=>s+polCount(l),0);
  const tPrem   = tcLeads.reduce((s,l)=>s+Number(l.premium||0),0);

  // ── FOLIO ──
  const fqLeads = leads.filter(l => {
    if (l.quotedDate) { const qd=new Date(l.quotedDate+'T00:00:00'); return qd>=folio.periodStart&&qd<=folio.periodEnd; }
    if (['Quoted','Closed Won','Quote Not Closed','Closed Lost'].includes(l.status)) {
      const ld=new Date((l.date||'')+'T00:00:00'); return ld>=folio.periodStart&&ld<=folio.periodEnd;
    }
    return false;
  });
  const fqRows  = fqLeads.flatMap(expandQ);
  const fcLeads = leads.filter(l => {
    if (l.status!=='Closed Won'||(l.customerType==='existing'&&!l.crossSellRef)) return false;
    const d=new Date((l.closedDate||l.date||'')+'T00:00:00');
    return d>=folio.periodStart&&d<=folio.periodEnd;
  });
  const fPol  = fcLeads.reduce((s,l)=>s+polCount(l),0);
  const fPrem = fcLeads.reduce((s,l)=>s+Number(l.premium||0),0);

  // ── PRODUCER STATS ──
  const prod = {};
  const ens  = n => { if(!prod[n]) prod[n]={qT:0,polT:0,premT:0,qF:0,polF:0,premF:0}; };
  tqRows.forEach(q  =>{const n=getProd(q.agentId);ens(n);prod[n].qT++;});
  tcLeads.forEach(l =>{const n=getProd(l.agentId);ens(n);prod[n].polT+=polCount(l);prod[n].premT+=Number(l.premium||0);});
  fqRows.forEach(q  =>{const n=getProd(q.agentId);ens(n);prod[n].qF++;});
  fcLeads.forEach(l =>{const n=getProd(l.agentId);ens(n);prod[n].polF+=polCount(l);prod[n].premF+=Number(l.premium||0);});

  // ── PLAIN TEXT ──
  let txt = `ALLEN INSURANCE AGENCY\nDaily KPI Report — ${fmtDt(today)}\nFolio: ${folio.label}\n${'='.repeat(60)}\n\n`;
  txt += `TODAY\n${ln(60)}\nQuotes:    ${String(tqRows.length).padStart(6)}\nPolicies:  ${String(tPol).padStart(6)}\nPremium:   ${fmtDol(tPrem).padStart(10)}\n\n`;
  txt += `FOLIO TO DATE\n${ln(60)}\nQuotes:    ${String(fqRows.length).padStart(6)}\nPolicies:  ${String(fPol).padStart(6)}\nPremium:   ${fmtDol(fPrem).padStart(10)}\n\n`;
  txt += `PRODUCER BREAKDOWN\n${ln(60)}\n`;
  const col=[18,7,8,10,7,8,10];
  txt += pad('Producer',col[0])+pad('Q-Day',col[1],true)+pad('Pol-Day',col[2],true)+pad('Prem-Day',col[3],true)+pad('Q-Folio',col[4],true)+pad('P-Folio',col[5],true)+pad('$-Folio',col[6],true)+'\n'+ln(60)+'\n';
  Object.entries(prod).sort().forEach(([n,d])=>{
    txt+=pad(n.slice(0,17),col[0])+pad(d.qT,col[1],true)+pad(d.polT,col[2],true)+pad(fmtDol(d.premT),col[3],true)+pad(d.qF,col[4],true)+pad(d.polF,col[5],true)+pad(fmtDol(d.premF),col[6],true)+'\n';
  });
  txt+=ln(60)+'\n'+pad('TOTAL',col[0])+pad(tqRows.length,col[1],true)+pad(tPol,col[2],true)+pad(fmtDol(tPrem),col[3],true)+pad(fqRows.length,col[4],true)+pad(fPol,col[5],true)+pad(fmtDol(fPrem),col[6],true)+'\n\n';
  txt+=`QUOTES TODAY (${tqRows.length})\n${ln(60)}\n`;
  if(tqRows.length){txt+=pad('Customer',24)+pad('Line',16)+'Producer\n'+ln(60)+'\n';tqRows.forEach(q=>{txt+=pad(q.name.slice(0,23),24)+pad((q.line||'—').slice(0,15),16)+getProd(q.agentId)+'\n';});}else{txt+='No quotes today.\n';}
  txt+=`\nPOLICIES SOLD TODAY (${tPol})\n${ln(60)}\n`;
  if(tcLeads.length){txt+=pad('Customer',22)+pad('Line',12)+pad('Premium',10)+'Producer\n'+ln(60)+'\n';tcLeads.forEach(l=>{const pols=(l.quotes&&l.quotes.length)?l.quotes:[{line:l.line,premium:l.premium}];pols.forEach(q=>{txt+=pad(`${l.firstName||''} ${l.lastName||''}`.trim().slice(0,21),22)+pad((q.line||'—').slice(0,11),12)+pad(fmtDol(q.premium||l.premium||0),10)+getProd(l.agentId)+'\n';});});}else{txt+='No policies sold today.\n';}
  txt+=`\n${'='.repeat(60)}\nSent by AgencyPro CRM — Allen Insurance Agency, Colleyville TX\n`;

  // ── HTML ──
  const pRows = Object.entries(prod).sort().map(([n,d])=>`<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${n}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.qT}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.polT}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${fmtDol(d.premT)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${d.qF}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${d.polF}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${fmtDol(d.premF)}</td>
  </tr>`).join('')||'<tr><td colspan="7" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No activity today</td></tr>';

  const qRows = tqRows.length
    ? tqRows.map(q=>`<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.name}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.line}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${getProd(q.agentId)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No quotes today</td></tr>';

  const cRows = tcLeads.length
    ? tcLeads.flatMap(l=>{const pols=(l.quotes&&l.quotes.length)?l.quotes:[{line:l.line,premium:l.premium}];return pols.map(q=>`<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${l.firstName||''} ${l.lastName||''}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.line||l.line||'—'}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#22c55e">${fmtDol(q.premium||l.premium||0)}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${getProd(l.agentId)}</td></tr>`);}).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No policies sold today</td></tr>';

  const html = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:680px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:28px 32px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:26px;font-weight:800;margin-bottom:4px">Daily KPI Report</div>
    <div style="color:#94a3b8;font-size:13px">${fmtDt(today)} &nbsp;·&nbsp; Folio: ${folio.label}</div>
  </div>
  <div style="display:flex;gap:12px;margin-bottom:20px">
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #0ea5a0">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Quotes Today</div>
      <div style="font-size:36px;font-weight:900;color:#0ea5a0;line-height:1.1;margin:6px 0 2px">${tqRows.length}</div>
      <div style="font-size:11px;color:#94a3b8">individual lines</div>
    </div>
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #22c55e">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Policies Sold</div>
      <div style="font-size:36px;font-weight:900;color:#22c55e;line-height:1.1;margin:6px 0 2px">${tPol}</div>
      <div style="font-size:11px;color:#94a3b8">closed won today</div>
    </div>
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #C47A2A">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Premium Sold</div>
      <div style="font-size:28px;font-weight:900;color:#C47A2A;line-height:1.1;margin:6px 0 2px">${fmtDol(tPrem)}</div>
      <div style="font-size:11px;color:#94a3b8">new business today</div>
    </div>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px;display:flex;justify-content:space-between;align-items:center">
      <span style="color:#fff;font-size:14px;font-weight:700">Producer Breakdown</span>
      <span style="color:#94a3b8;font-size:11px">Today &nbsp;·&nbsp; Folio to date</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:9px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Quotes<br><span style="font-weight:400;color:#94a3b8">Today</span></th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Policies<br><span style="font-weight:400;color:#94a3b8">Today</span></th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Premium<br><span style="font-weight:400;color:#94a3b8">Today</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Quotes<br><span style="font-weight:400">Folio</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Policies<br><span style="font-weight:400">Folio</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Premium<br><span style="font-weight:400">Folio</span></th>
      </tr></thead>
      <tbody>${pRows}</tbody>
      <tfoot><tr style="background:#f8fafc;font-weight:700;font-size:12px">
        <td style="padding:10px 12px;border-top:2px solid #e2e8f0">Total</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${tqRows.length}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${tPol}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${fmtDol(tPrem)}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fqRows.length}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fPol}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fmtDol(fPrem)}</td>
      </tr></tfoot>
    </table>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px"><span style="color:#fff;font-size:14px;font-weight:700">Quotes Entered Today</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Customer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Line</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
      </tr></thead>
      <tbody>${qRows}</tbody>
    </table>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:20px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px"><span style="color:#fff;font-size:14px;font-weight:700">Policies Sold Today</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Customer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Line</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Premium</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
      </tr></thead>
      <tbody>${cRows}</tbody>
    </table>
  </div>
  <div style="text-align:center;color:#94a3b8;font-size:11px;padding:8px 0 16px">
    Sent automatically at 5:00 PM Central &nbsp;·&nbsp; AgencyPro CRM &nbsp;·&nbsp; Allen Insurance Agency &nbsp;·&nbsp; Colleyville, TX
  </div>
</div></body></html>`;

  // ── SEND VIA RESEND ──
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from:    `AgencyPro CRM <${fromEmail}>`,
      to:      [toEmail],
      subject: `AgencyPro Daily KPI Report — ${fmtDt(today)}`,
      text:    txt,
      html,
    }),
  });

  const sendData = await sendRes.json();
  if (!sendRes.ok) throw new Error(`Resend error: ${JSON.stringify(sendData)}`);

  console.log(`[daily-kpi-report] Sent to ${toEmail} — id: ${sendData.id}`);
  return new Response('OK', { status: 200 });
}
