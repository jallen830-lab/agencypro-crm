/**
 * AgencyPro — Weekly KPI Report
 * Netlify Scheduled Function — fires Friday at 5:00 PM Central (23:00 UTC), same slot as the daily report
 *
 * Environment variables required (shared with daily-kpi-report.mjs):
 *   FIREBASE_PROJECT_ID   → agencypro-crm
 *   FIREBASE_WEB_API_KEY  → AIzaSyBlo5vw62iKEAdqcg3xEY7TwvdPze10VcM
 *   RESEND_API_KEY        → from resend.com (starts with re_)
 *   REPORT_FROM_EMAIL     → reports@alleninsurancetx.com  (verified domain in Resend)
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
async function firestoreGetDoc(projectId, apiKey, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const doc = await res.json();
  return parseDoc(doc.fields || {});
}

// ── AGENCY GOALS (mirrors the Scoreboard's Agency Goals card) ─────────
const PL_SPECIALTY_LINES = ['Auto','Home','Umbrella','Specialty','Wind/Hail Buydown','Bundle'];
const isFarmersCarrier = carrier => String(carrier||'').toLowerCase().includes('farmers');
const isPersonalLinesCarrier = carrier => {
  const c = String(carrier||'').toLowerCase();
  return c.includes('farmers') || c.includes('bristol west') || c.includes('bw') || c.includes('foremost');
};
function calcAgencyGoals(fcLeads, primeTargets) {
  const counts = { plSpecialty: 0, lifeIP: 0, biNB: 0 };
  fcLeads.forEach(l => {
    const quotes = (l.quotes && l.quotes.length) ? l.quotes : [{ line: l.line, carrier: l.carrier }];
    quotes.forEach(q => {
      if (q.status === 'not-sold') return;
      const line = q.line || l.line;
      if (line === 'Life') { if (isFarmersCarrier(q.carrier)) counts.lifeIP++; }
      else if (line === 'Commercial') { if (isFarmersCarrier(q.carrier)) counts.biNB++; }
      else if (PL_SPECIALTY_LINES.includes(line)) { if (isPersonalLinesCarrier(q.carrier)) counts.plSpecialty++; }
    });
  });
  const t = primeTargets || {};
  return [
    { label: 'PL & Specialty NB', actual: counts.plSpecialty, target: Number(t.plSpecialtyNB) || 0 },
    { label: 'Life I&P',          actual: counts.lifeIP,      target: Number(t.lifeIP) || 0 },
    { label: 'BI NB',             actual: counts.biNB,        target: Number(t.biNB) || 0 },
  ];
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

// Monday → today (run day, normally Friday) — the work week to date
function getWeekPeriod(today) {
  const d = new Date(today + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun,1=Mon,...6=Sat
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  const s = new Date(d); s.setDate(d.getDate() - diffToMonday);
  const e = new Date(d); e.setHours(23,59,59,999);
  const fmt = dt => dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  return { weekStart:s, weekEnd:e, label:`${fmt(s)} – ${e.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}` };
}

const polCount  = l => (l.quotes&&l.quotes.length) ? l.quotes.length : 1;
const expandQ   = l => {
  const name = `${l.firstName||''} ${l.lastName||''}`.trim();
  if (l.quotes&&l.quotes.length) return l.quotes.map(q=>({name,agentId:l.agentId,line:q.line||l.line||'Other',premium:q.premium||0,date:l.quotedDate}));
  return [{name,agentId:l.agentId,line:l.line||'Other',premium:l.premium||0,date:l.quotedDate}];
};

// ── MAIN ──────────────────────────────────────────────────────────────
export default async function handler() {
  console.log('[weekly-kpi-report] Starting...');

  const projectId  = process.env.FIREBASE_PROJECT_ID;
  const apiKey     = process.env.FIREBASE_WEB_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const fromEmail  = process.env.REPORT_FROM_EMAIL || 'reports@alleninsurancetx.com';
  const toEmail    = process.env.REPORT_TO_EMAIL   || 'jallen1@farmersagent.com';

  if (!projectId || !apiKey)  throw new Error('Missing Firebase env vars');
  if (!resendKey)             throw new Error('Missing RESEND_API_KEY');

  const [leads, producers, settings] = await Promise.all([
    firestoreGet(projectId, apiKey, 'leads'),
    firestoreGet(projectId, apiKey, 'producers'),
    firestoreGetDoc(projectId, apiKey, 'settings/agency'),
  ]);

  const getProd = id => producers.find(p=>p.id===id)?.name || 'Unassigned';
  const today   = getTodayCST();
  const folio   = getFolioPeriod(today);
  const week    = getWeekPeriod(today);

  // ── THIS WEEK ──
  const wqLeads = leads.filter(l => {
    if (!l.quotedDate) return false;
    const qd = new Date(l.quotedDate+'T00:00:00');
    return qd>=week.weekStart && qd<=week.weekEnd;
  });
  const wqRows  = wqLeads.flatMap(expandQ);
  const wcLeads = leads.filter(l => {
    if (l.status!=='Closed Won'||(l.customerType==='existing'&&!l.crossSellRef)) return false;
    const d=new Date((l.closedDate||l.date||'')+'T00:00:00');
    return d>=week.weekStart&&d<=week.weekEnd;
  });
  const wPol    = wcLeads.reduce((s,l)=>s+polCount(l),0);
  const wPrem   = wcLeads.reduce((s,l)=>s+Number(l.premium||0),0);

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

  // ── AGENCY GOALS ──
  const agencyGoals = calcAgencyGoals(fcLeads, settings?.primeTargets);

  // ── PRODUCER STATS ──
  const prod = {};
  const ens  = n => { if(!prod[n]) prod[n]={qW:0,polW:0,premW:0,qF:0,polF:0,premF:0}; };
  wqRows.forEach(q  =>{const n=getProd(q.agentId);ens(n);prod[n].qW++;});
  wcLeads.forEach(l =>{const n=getProd(l.agentId);ens(n);prod[n].polW+=polCount(l);prod[n].premW+=Number(l.premium||0);});
  fqRows.forEach(q  =>{const n=getProd(q.agentId);ens(n);prod[n].qF++;});
  fcLeads.forEach(l =>{const n=getProd(l.agentId);ens(n);prod[n].polF+=polCount(l);prod[n].premF+=Number(l.premium||0);});

  // ── PLAIN TEXT ──
  let txt = `ALLEN INSURANCE AGENCY\nWeekly KPI Report — Week of ${week.label}\nFolio: ${folio.label}\n${'='.repeat(60)}\n\n`;
  txt += `THIS WEEK\n${ln(60)}\nQuotes:    ${String(wqRows.length).padStart(6)}\nPolicies:  ${String(wPol).padStart(6)}\nPremium:   ${fmtDol(wPrem).padStart(10)}\n\n`;
  txt += `FOLIO TO DATE\n${ln(60)}\nQuotes:    ${String(fqRows.length).padStart(6)}\nPolicies:  ${String(fPol).padStart(6)}\nPremium:   ${fmtDol(fPrem).padStart(10)}\n\n`;
  txt += `AGENCY GOALS — THIS FOLIO (Farmers/BW/Foremost)\n${ln(60)}\n`;
  agencyGoals.forEach(g=>{
    const pct = g.target>0 ? Math.round((g.actual/g.target)*100) : 0;
    txt += pad(g.label, 20) + pad(`${g.actual} / ${g.target}`, 10) + `${pct}%\n`;
  });
  txt += '\n';
  txt += `PRODUCER BREAKDOWN\n${ln(60)}\n`;
  const col=[18,7,8,10,7,8,10];
  txt += pad('Producer',col[0])+pad('Q-Wk',col[1],true)+pad('Pol-Wk',col[2],true)+pad('Prem-Wk',col[3],true)+pad('Q-Folio',col[4],true)+pad('P-Folio',col[5],true)+pad('$-Folio',col[6],true)+'\n'+ln(60)+'\n';
  Object.entries(prod).sort().forEach(([n,d])=>{
    txt+=pad(n.slice(0,17),col[0])+pad(d.qW,col[1],true)+pad(d.polW,col[2],true)+pad(fmtDol(d.premW),col[3],true)+pad(d.qF,col[4],true)+pad(d.polF,col[5],true)+pad(fmtDol(d.premF),col[6],true)+'\n';
  });
  txt+=ln(60)+'\n'+pad('TOTAL',col[0])+pad(wqRows.length,col[1],true)+pad(wPol,col[2],true)+pad(fmtDol(wPrem),col[3],true)+pad(fqRows.length,col[4],true)+pad(fPol,col[5],true)+pad(fmtDol(fPrem),col[6],true)+'\n\n';
  txt+=`QUOTES THIS WEEK (${wqRows.length})\n${ln(60)}\n`;
  if(wqRows.length){txt+=pad('Customer',22)+pad('Line',14)+pad('Producer',16)+'Date\n'+ln(60)+'\n';wqRows.forEach(q=>{txt+=pad(q.name.slice(0,21),22)+pad((q.line||'—').slice(0,13),14)+pad(getProd(q.agentId).slice(0,15),16)+fmtDt(q.date)+'\n';});}else{txt+='No quotes this week.\n';}
  txt+=`\nPOLICIES SOLD THIS WEEK (${wPol})\n${ln(60)}\n`;
  if(wcLeads.length){txt+=pad('Customer',20)+pad('Line',12)+pad('Premium',10)+pad('Producer',16)+'Date\n'+ln(60)+'\n';wcLeads.forEach(l=>{const pols=(l.quotes&&l.quotes.length)?l.quotes:[{line:l.line,premium:l.premium}];pols.forEach(q=>{txt+=pad(`${l.firstName||''} ${l.lastName||''}`.trim().slice(0,19),20)+pad((q.line||'—').slice(0,11),12)+pad(fmtDol(q.premium||l.premium||0),10)+pad(getProd(l.agentId).slice(0,15),16)+fmtDt(l.closedDate||l.date)+'\n';});});}else{txt+='No policies sold this week.\n';}
  txt+=`\n${'='.repeat(60)}\nSent by AgencyPro CRM — Allen Insurance Agency, Colleyville TX\n`;

  // ── HTML ──
  const pRows = Object.entries(prod).sort().map(([n,d])=>`<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600">${n}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.qW}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${d.polW}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center">${fmtDol(d.premW)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${d.qF}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${d.polF}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#0ea5a0">${fmtDol(d.premF)}</td>
  </tr>`).join('')||'<tr><td colspan="7" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No activity this week</td></tr>';

  const qRows = wqRows.length
    ? wqRows.map(q=>`<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.name}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.line}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${getProd(q.agentId)}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${fmtDt(q.date)}</td></tr>`).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No quotes this week</td></tr>';

  const cRows = wcLeads.length
    ? wcLeads.flatMap(l=>{const pols=(l.quotes&&l.quotes.length)?l.quotes:[{line:l.line,premium:l.premium}];return pols.map(q=>`<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${l.firstName||''} ${l.lastName||''}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${q.line||l.line||'—'}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#22c55e">${fmtDol(q.premium||l.premium||0)}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${getProd(l.agentId)}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0">${fmtDt(l.closedDate||l.date)}</td></tr>`);}).join('')
    : '<tr><td colspan="5" style="padding:12px;color:#94a3b8;text-align:center;font-style:italic">No policies sold this week</td></tr>';

  const html = `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:0;background:#f1f5f9">
<div style="max-width:680px;margin:0 auto;padding:24px 16px">
  <div style="background:linear-gradient(135deg,#1B3A5C,#2d5a8e);border-radius:12px;padding:28px 32px;margin-bottom:20px">
    <div style="color:#C47A2A;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">Allen Insurance Agency</div>
    <div style="color:#fff;font-size:26px;font-weight:800;margin-bottom:4px">Weekly KPI Report</div>
    <div style="color:#94a3b8;font-size:13px">Week of ${week.label} &nbsp;·&nbsp; Folio: ${folio.label}</div>
  </div>
  <div style="display:flex;gap:12px;margin-bottom:20px">
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #0ea5a0">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Quotes This Week</div>
      <div style="font-size:36px;font-weight:900;color:#0ea5a0;line-height:1.1;margin:6px 0 2px">${wqRows.length}</div>
      <div style="font-size:11px;color:#94a3b8">individual lines</div>
    </div>
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #22c55e">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Policies Sold</div>
      <div style="font-size:36px;font-weight:900;color:#22c55e;line-height:1.1;margin:6px 0 2px">${wPol}</div>
      <div style="font-size:11px;color:#94a3b8">closed won this week</div>
    </div>
    <div style="flex:1;background:#fff;border-radius:10px;padding:18px;border-top:4px solid #C47A2A">
      <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase">Premium Sold</div>
      <div style="font-size:28px;font-weight:900;color:#C47A2A;line-height:1.1;margin:6px 0 2px">${fmtDol(wPrem)}</div>
      <div style="font-size:11px;color:#94a3b8">new business this week</div>
    </div>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px"><span style="color:#fff;font-size:14px;font-weight:700">🎯 Agency Goals — This Folio</span></div>
    <div style="padding:16px;display:flex;gap:10px">
      ${agencyGoals.map(g=>{
        const pct = g.target>0 ? Math.min(100,Math.round((g.actual/g.target)*100)) : 0;
        return `<div style="flex:1;background:#f8fafc;border-radius:8px;padding:10px 12px">
          <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px">${g.label}</div>
          <div style="font-size:17px;font-weight:800;color:#1e293b;margin-bottom:6px">${g.actual} <span style="font-size:12px;font-weight:400;color:#94a3b8">/ ${g.target}</span></div>
          <div style="background:#e2e8f0;border-radius:3px;height:6px;overflow:hidden">
            <div style="height:6px;border-radius:3px;background:#0ea5a0;width:${pct}%"></div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px;display:flex;justify-content:space-between;align-items:center">
      <span style="color:#fff;font-size:14px;font-weight:700">Producer Breakdown</span>
      <span style="color:#94a3b8;font-size:11px">This week &nbsp;·&nbsp; Folio to date</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:9px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Quotes<br><span style="font-weight:400;color:#94a3b8">This Wk</span></th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Policies<br><span style="font-weight:400;color:#94a3b8">This Wk</span></th>
        <th style="padding:9px 12px;text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Premium<br><span style="font-weight:400;color:#94a3b8">This Wk</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Quotes<br><span style="font-weight:400">Folio</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Policies<br><span style="font-weight:400">Folio</span></th>
        <th style="padding:9px 12px;text-align:center;color:#0ea5a0;font-size:11px;border-bottom:1px solid #e2e8f0">Premium<br><span style="font-weight:400">Folio</span></th>
      </tr></thead>
      <tbody>${pRows}</tbody>
      <tfoot><tr style="background:#f8fafc;font-weight:700;font-size:12px">
        <td style="padding:10px 12px;border-top:2px solid #e2e8f0">Total</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${wqRows.length}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${wPol}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0">${fmtDol(wPrem)}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fqRows.length}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fPol}</td>
        <td style="padding:10px 12px;text-align:center;border-top:2px solid #e2e8f0;color:#0ea5a0">${fmtDol(fPrem)}</td>
      </tr></tfoot>
    </table>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px"><span style="color:#fff;font-size:14px;font-weight:700">Quotes Entered This Week</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Customer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Line</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Date</th>
      </tr></thead>
      <tbody>${qRows}</tbody>
    </table>
  </div>
  <div style="background:#fff;border-radius:10px;margin-bottom:20px;overflow:hidden">
    <div style="background:#1B3A5C;padding:14px 20px"><span style="color:#fff;font-size:14px;font-weight:700">Policies Sold This Week</span></div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Customer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Line</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Premium</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Producer</th>
        <th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px;border-bottom:1px solid #e2e8f0">Date</th>
      </tr></thead>
      <tbody>${cRows}</tbody>
    </table>
  </div>
  <div style="text-align:center;color:#94a3b8;font-size:11px;padding:8px 0 16px">
    Sent automatically Friday at 5:00 PM Central &nbsp;·&nbsp; AgencyPro CRM &nbsp;·&nbsp; Allen Insurance Agency &nbsp;·&nbsp; Colleyville, TX
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
      subject: `AgencyPro Weekly KPI Report — Week of ${week.label}`,
      text:    txt,
      html,
    }),
  });

  const sendData = await sendRes.json();
  if (!sendRes.ok) throw new Error(`Resend error: ${JSON.stringify(sendData)}`);

  console.log(`[weekly-kpi-report] Sent to ${toEmail} — id: ${sendData.id}`);
  return new Response('OK', { status: 200 });
}
