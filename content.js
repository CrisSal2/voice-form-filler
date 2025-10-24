/* global chrome */
// --- Voice status + mic handling from our stable version ---
let SR = { rec: null, listening: false, interim: '', final: '' };

const UI = (() => {
  let box;
  function ensure() {
    if (box) return box;
    box = document.createElement('div');
    box.style.cssText = `
      position: fixed; z-index: 2147483647; right: 12px; bottom: 12px;
      background: rgba(0,0,0,.75); color: #fff; padding: 8px 10px;
      border-radius: 10px; font: 12px/1.4 system-ui, Arial; max-width: 360px;
      box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: none;`;
    box.id = '__vff_status';
    document.documentElement.appendChild(box);
    return box;
  }
  return { set: (m)=>ensure().textContent=m, clear: ()=>{ if (box) box.textContent=''; } };
})();

function restrictedPage() {
  const u = location.href;
  return u.startsWith('chrome://') || u.startsWith('chrome-extension://') ||
         u.startsWith('edge://') || u.startsWith('about:');
}

function ensureSpeech() {
  const C = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!C) throw new Error('SpeechRecognition not supported in this browser.');
  const rec = new C(); rec.continuous = true; rec.lang = 'en-US'; rec.interimResults = true;
  return rec;
}

async function requestMicOnce() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    const name = e && e.name ? e.name : '';
    throw new Error('Microphone permission error: ' + (name || e.message || e));
  }
}

async function startListening() {
  if (restrictedPage()) { const msg='Restricted page; use a normal https:// page.'; UI.set(msg);
    chrome.runtime.sendMessage({ type:'SR_ERROR', payload:{ message: msg }});
    chrome.runtime.sendMessage({ type:'SR_STATE', payload:{ listening:false }}); return; }
  if (SR.listening) { UI.set('Already listening…'); chrome.runtime.sendMessage({ type:'SR_STATE', payload:{ listening:true }}); return; }

  UI.set('Requesting microphone…');
  await requestMicOnce();

  let rec; try { rec = ensureSpeech(); } catch(e){ UI.set(e.message); chrome.runtime.sendMessage({ type:'SR_ERROR', payload:{ message: e.message }}); return; }

  SR.rec = rec; SR.interim=''; SR.final='';
  SR.rec.onresult = (e) => {
    let interimChunk=''; for (let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i]; interimChunk+=r[0].transcript; if (r.isFinal){ SR.final+=r[0].transcript+' '; SR.interim=''; } else { SR.interim=interimChunk; }
    }
    const interim=SR.interim.trim(), final=SR.final.trim();
    UI.set((final?final+' ':'') + (interim?'…'+interim:'')); chrome.runtime.sendMessage({ type:'SR_UPDATE', payload:{ interim, final }});
  };
  SR.rec.onerror = (e)=>{ const msg='Speech error: '+(e.error||e.message||e); UI.set(msg); chrome.runtime.sendMessage({ type:'SR_ERROR', payload:{ message: msg }}); stopListening(); };
  SR.rec.onend   = ()=>{ SR.listening=false; UI.set('Stopped.'); chrome.runtime.sendMessage({ type:'SR_STATE', payload:{ listening:false }}); };

  try { SR.rec.start(); SR.listening=true; UI.set('Listening… speak field:value pairs.'); chrome.runtime.sendMessage({ type:'SR_STATE', payload:{ listening:true }}); }
  catch(e){ UI.set('Failed to start recognition: '+(e.message||e)); chrome.runtime.sendMessage({ type:'SR_ERROR', payload:{ message: e.message||String(e) }}); }
}
function stopListening(){ try{ SR.rec && SR.rec.stop && SR.rec.stop(); }catch{} SR.listening=false; }

// --- Messaging (mic + fill) ---
chrome.runtime.onMessage.addListener(async (msg,_sender,sendResponse)=>{
  if (msg?.type==='SR_START'){ startListening().catch(()=>{}); sendResponse({ok:true}); return true; }
  if (msg?.type==='SR_STOP'){ stopListening(); UI.set('Stopped.'); sendResponse({ok:true}); return true; }
  if (msg?.type==='FILL_FIELDS'){ try{ await fillForThisJotform(msg.payload||{}); sendResponse({ok:true}); } catch(e){ console.error(e); sendResponse({ok:false,error:e.message}); } return true; }
});

// ===================================================================
//                 JOTFORM-SPECIFIC “FORM PROFILE”
// URL we’re targeting: https://form.jotform.com/51527382823962
// We match question blocks by their visible label text, then fill the
// inputs contained in the same block. This is robust to ID changes.
// ===================================================================

// Helpers to find JotForm question blocks
function allQuestions(){
  // JotForm uses .form-line / .jf-form / [data-type], but we’ll be resilient:
  const qs = Array.from(document.querySelectorAll('.form-line, .jf-question, [data-type][data-qid]'));
  return qs.length ? qs : Array.from(document.querySelectorAll('li[id^="id_"], div[id^="id_"]'));
}
function qLabelText(q){
  const lbl = q.querySelector('.form-label, .jf-field-label, label');
  return (lbl?.innerText || lbl?.textContent || '').replace(/\s+/g,' ').trim();
}
function hasText(hay, needle){
  hay = (hay||'').toLowerCase(); needle = (needle||'').toLowerCase();
  return hay.includes(needle);
}
function findQuestionByLabelIncludes(substr){
  const L = substr.toLowerCase();
  return allQuestions().find(q => hasText(qLabelText(q), L));
}
function findAllByLabelIncludes(substr){
  const L = substr.toLowerCase();
  return allQuestions().filter(q => hasText(qLabelText(q), L));
}

// Generic applicators inside a question block
function setTextLike(q, value){
  const t = q.querySelector('textarea, input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="date"]');
  if (!t) return false;
  t.focus(); t.value = value;
  t.dispatchEvent(new Event('input', {bubbles:true})); t.dispatchEvent(new Event('change', {bubbles:true}));
  return true;
}
function setDateYMD(q, value){
  // Accept “Nov 2, 2025” or “2025-11-02” etc.; let browser/HTML5 handle partials
  const inp = q.querySelector('input[type="date"]');
  if (inp){ inp.value = value; inp.dispatchEvent(new Event('change',{bubbles:true})); return true; }
  // JotForm’s 3-part date (month/day/year) widgets:
  const m = q.querySelector('select[name*="month"], input[name*="month"]');
  const d = q.querySelector('select[name*="day"], input[name*="day"]');
  const y = q.querySelector('select[name*="year"], input[name*="year"]');
  if (m && d && y){
    const dt = new Date(value); if (!isNaN(dt)){
      m.value = (dt.getMonth()+1).toString(); d.value = dt.getDate().toString(); y.value = dt.getFullYear().toString();
      [m,d,y].forEach(el=>el.dispatchEvent(new Event('change',{bubbles:true}))); return true;
    }
  }
  return false;
}
function clickOptions(q, wants){ // for checkbox/radio/select
  const norms = wants.map(v=>norm(v));
  // Radios/checkboxes
  const boxes = Array.from(q.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
  if (boxes.length){
    for (const b of boxes){
      const lab = (closestOptionLabel(b) || b.value || '').toLowerCase();
      const should = norms.some(w => lab.includes(w));
      if (should && !b.checked){ b.click(); }
      if (!should && b.type==='radio' && b.checked){ /* leave radio unchanged */ }
    }
    return true;
  }
  // Select
  const sel = q.querySelector('select');
  if (sel){
    let bestIdx=-1, best=0;
    for (let i=0;i<sel.options.length;i++){
      const o=sel.options[i]; const s = similarity(o.text, norms[0]||'');
      if (s>best){ best=s; bestIdx=i; }
    }
    if (bestIdx>=0){ sel.selectedIndex=bestIdx; sel.dispatchEvent(new Event('change',{bubbles:true})); }
    return true;
  }
  return false;
}
function closestOptionLabel(input){
  const id=input.id;
  if (id){ const l=document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) return l.textContent.trim(); }
  const w=input.closest('label'); if (w) return w.textContent.trim();
  const row=input.closest('.form-line, .jf-question'); if (row){ const txt=row.textContent; return txt?txt.trim():''; }
  return '';
}
function norm(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function similarity(a,b){
  const A=new Set(norm(a).split(' ').filter(Boolean));
  const B=new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size||!B.size) return 0; let inter=0; for (const w of A) if (B.has(w)) inter++; return inter/Math.max(A.size,B.size);
}

// Field-specific helpers (JotForm composites)
function setFullName(q, value){
  // Expect: "Jane Homeowner" or "Jane Q. Homeowner"
  const parts = value.split(/\s+/).filter(Boolean);
  const first = q.querySelector('input[name*="first"], input[id*="first"]');
  const last  = q.querySelector('input[name*="last"], input[id*="last"]');
  if (first && last){
    first.value = parts.length>1 ? parts.slice(0,-1).join(' ') : value;
    last.value  = parts.length>1 ? parts.slice(-1).join(' ') : '';
    [first,last].forEach(el=>{ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
    return true;
  }
  return setTextLike(q, value);
}

function setPhone(q, value){
  // Accept "(714) 555-0123" / "714-555-0123" / "7145550123"
  const ds = String(value).replace(/\D+/g,'');
  const area = q.querySelector('input[name*="area"], input[id*="area"]');
  const num  = q.querySelector('input[name*="phone"], input[id*="phone"], input[name*="number"]');
  if (ds.length>=10 && area && num){
    area.value = ds.slice(0,3); num.value = ds.slice(3,10);
    [area,num].forEach(el=>{ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
    return true;
  }
  return setTextLike(q, value);
}

function setAddress(q, value){
  // “123 Main St, Irvine, CA 92618” or multi-line. Try to map Street/City/State/Zip/Country.
  const street1 = q.querySelector('input[name*="addr"], input[id*="addr"], input[name*="street"]');
  const street2 = q.querySelector('input[name*="addr2"], input[id*="addr2"]');
  const city    = q.querySelector('input[name*="city"], input[id*="city"]');
  const state   = q.querySelector('input[name*="state"], input[id*="state"]');
  const zip     = q.querySelector('input[name*="zip"], input[id*="zip"], input[name*="postal"]');
  const country = q.querySelector('select[name*="country"], select[id*="country"]');

  // naive parse: split by commas
  const segs = value.split(',').map(s=>s.trim());
  if (segs.length>=3){
    if (street1) street1.value = segs[0];
    if (city)    city.value    = segs[1];
    const stZip = segs[2].split(/\s+/);
    if (state) state.value = stZip[0] || '';
    if (zip)   zip.value   = stZip[1] || '';
  } else if (street1){ street1.value = value; }

  [street1,street2,city,state,zip].filter(Boolean).forEach(el=>{ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });

  if (country && segs[3]) {
    // fuzzy country select
    let bestIdx=-1,best=0; const want=norm(segs[3]);
    for (let i=0;i<country.options.length;i++){
      const o=country.options[i]; const s = Math.max(similarity(o.text, want), similarity(o.value, want));
      if (s>best){ best=s; bestIdx=i; }
    }
    if (bestIdx>=0){ country.selectedIndex = bestIdx; country.dispatchEvent(new Event('change',{bubbles:true})); }
  }
  return true;
}

// ------------------- PROFILE MAP -------------------
/*
Speak things like:
  Date: Nov 2, 2025
  Full Name: Jane Homeowner
  Address: 123 Main St, Irvine, CA 92618, United States
  Phone1: 714-555-0123; Phone2: 949-555-9876; E-mail: jane@example.com
  General Description of Project: remove soffits, quartz counters, LED cans; make it professional
  Electrical budget included by A Plus: Up to $5,000
  Demolition: Cabinets, Back splash
  Appliances to keep: Fridge, Range, Microwave
*/
const PROFILE = [
  // Contact info
  { key: /^(date|form date)$/i,                 labelContains: 'Date',                  apply: (q,v)=> setDateYMD(q, v) },
  { key: /^full\s*name$/i,                      labelContains: 'Full Name',             apply: (q,v)=> setFullName(q, v) },
  { key: /^address$/i,                          labelContains: 'Address',               apply: (q,v)=> setAddress(q, v) },
  { key: /^phone\s*1$/i,                        labelContains: 'Phone1',                apply: (q,v)=> setPhone(q, v) },
  { key: /^phone\s*2$/i,                        labelContains: 'Phone2',                apply: (q,v)=> setPhone(q, v) },
  { key: /^(email|e-?mail)$/i,                  labelContains: 'E-mail',                apply: (q,v)=> setTextLike(q, v) },

  // General description / year built
  { key: /^general description/i,               labelContains: 'GENERAL DESCRIPTION OF PROJECT', apply: (q,v)=> setTextLike(q, v) }, // textarea
  { key: /(year\s*home\s*was\s*built|year built)/i, labelContains: 'Year Home was Built', apply: (q,v)=> setTextLike(q, v) },

  // Electrical (budget + details)
  { key: /^electrical budget/i,                 labelContains: 'Electrical budget included by A Plus', apply: (q,v)=> clickOptions(q, [v]) }, // Up to $3k/$4k/$5k/Not included
  { key: /^electrical details?/i,               labelContains: 'Electrical Details',    apply: (q,v)=> setTextLike(q, v) },

  // Demolition & appliances
  { key: /^demolition$/i,                       labelContains: 'Demolition:',           apply: (q,v)=> clickOptions(q, v.split(/[,;]+/)) },
  { key: /^appliances to keep$/i,               labelContains: 'Appliances to keep',    apply: (q,v)=> clickOptions(q, v.split(/[,;]+/)) },

  // “Prep Work”, “Rental Equipment”, dumpsters, etc. (you can dictate comma-separated lists)
  { key: /^prep work$/i,                        labelContains: 'Prep Work:',            apply: (q,v)=> clickOptions(q, v.split(/[,;]+/)) },
  { key: /^rental equipment$/i,                 labelContains: 'RENTAL EQUIPMENT',      apply: (q,v)=> clickOptions(q, v.split(/[,;]+/)) },
  { key: /^other rental equipment$/i,           labelContains: 'Other Rental Equipment',apply: (q,v)=> setTextLike(q, v) },
  { key: /^initial dumpster$/i,                 labelContains: 'INITIAL DUMPSTER',      apply: (q,v)=> setTextLike(q, v) },
  { key: /^dumpster cont'?d$/i,                 labelContains: 'Dumpster Cont\'d',      apply: (q,v)=> clickOptions(q, [v]) }, // e.g., A Plus / Home Owner / Not Applicable

  // You can continue adding sections like “HVAC”, “FRAMING”, “PERMIT FEES”, etc., same pattern.
];

// Core fill for this JotForm
async function fillForThisJotform(map){
  // If we’re not on the JotForm page, fall back to generic
  if (!/form\.jotform\.com\/51527382823962/.test(location.href)) { return fillFieldsGeneric(map); }

  for (const [spokenKey, rawVal] of Object.entries(map)) {
    const val = String(rawVal).trim();
    const prof = PROFILE.find(p => p.key.test(spokenKey));
    if (!prof) continue;

    // Prefer the first matching question whose label contains our configured text
    const q = findQuestionByLabelIncludes(prof.labelContains);
    if (!q) continue;
    try { prof.apply(q, val); } catch(e) { console.warn('Apply failed for', spokenKey, e); }
  }
}

// ------------- Generic fallback (kept from earlier) -------------
async function fillFieldsGeneric(map) {
  const fields = indexFields();
  for (const [key, rawVal] of Object.entries(map)) {
    const val = String(rawVal).trim();
    const target = bestFieldMatch(fields, key);
    if (!target) continue;
    await applyValue(target, val);
  }
}

function indexFields(){
  const nodes = Array.from(document.querySelectorAll('input, select, textarea'));
  const labels = new Map(); document.querySelectorAll('label[for]').forEach(l => labels.set(l.getAttribute('for'), textFromNode(l)));
  return nodes.map(el => {
    const id = el.id || ''; const type = (el.type || el.tagName).toLowerCase();
    const name = el.name || ''; const placeholder = el.getAttribute('placeholder') || '';
    const aria = el.getAttribute('aria-label') || ''; const title = el.getAttribute('title') || '';
    const lbl = labels.get(id) || closestLabelText(el);
    return { el, type, name, id, label: lbl, scoreKeys: [lbl, placeholder, aria, title, name, id, guessPrettyName(name||id)].filter(Boolean).join(' | ') };
  });
}
function guessPrettyName(s){ return (s||'').replace(/[_\-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim(); }
function textFromNode(n){ return (n?.innerText || n?.textContent || '').replace(/\s+/g,' ').trim(); }
function closestLabelText(el){
  const wrapLabel = el.closest('label'); if (wrapLabel) return textFromNode(wrapLabel);
  const ariaId = el.getAttribute('aria-labelledby');
  if (ariaId){ const s = ariaId.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(textFromNode).join(' '); if (s) return s; }
  const parent = el.closest('div, section, li, td, th, p') || el.parentElement; if (!parent) return '';
  const prev = parent.querySelector('label') || parent.querySelector('span, strong, b, p, h1, h2, h3, h4'); return prev ? textFromNode(prev) : '';
}
function norm2(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function similarity(a,b){ const A=new Set(norm2(a).split(' ').filter(Boolean)); const B=new Set(norm2(b).split(' ').filter(Boolean)); if (!A.size||!B.size) return 0; let inter=0; for (const w of A) if (B.has(w)) inter++; return inter/Math.max(A.size,B.size); }
function bestFieldMatch(fields, spokenKey){
  const target = norm2(spokenKey); let best=null, bestScore=0;
  for (const f of fields){ const s = similarity(f.scoreKeys, target)*0.7 + similarity(f.label, target)*0.3; if (s>bestScore){ bestScore=s; best=f; } }
  return bestScore >= 0.25 ? best : null;
}
async function applyValue(f, value){
  const el=f.el, tag=el.tagName.toLowerCase(), type=(el.type||'').toLowerCase();
  if (tag==='textarea' || (tag==='input' && ['text','email','tel','url','number','search','date','datetime-local'].includes(type))){
    el.focus(); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return;
  }
  if (tag==='input' && (type==='checkbox'||type==='radio')){
    const wants = value.split(/[,;]+/).map(v=>norm2(v)); const group = findGroup(el); const candidates = group.length?group:[el];
    for (const c of candidates){ const lab = closestOptionLabel(c)||c.value||c.name||''; const nlab=norm2(lab), nval=norm2(c.value);
      const should = wants.some(w=> w && (nlab.includes(w)||nval.includes(w))); if (should){ c.click(); await new Promise(r=>setTimeout(r,20)); } }
    return;
  }
  if (tag==='select'){
    const sel=el; const want=norm2(value); let bestIdx=-1, best=0;
    for (let i=0;i<sel.options.length;i++){ const opt=sel.options[i]; const s=Math.max(similarity(opt.text, want), similarity(opt.value, want)); if (s>best){ best=s; bestIdx=i; } }
    if (bestIdx>=0){ sel.selectedIndex=bestIdx; sel.dispatchEvent(new Event('change',{bubbles:true})); } return;
  }
  if (el.isContentEditable){ el.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); return; }
}
function findGroup(el){ if (!(el instanceof HTMLInputElement)) return []; if (!['radio','checkbox'].includes(el.type)) return []; const name=el.name; if (!name) return []; return Array.from(document.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(name)}"]`)); }
function closestOptionLabel(input){
  const id=input.id; if (id){ const l=document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l) return l.textContent.trim(); }
  const w=input.closest('label'); if (w) return w.textContent.trim();
  const row=input.closest('.form-line, .jf-question'); if (row){ const txt=row.textContent; return txt?txt.trim():''; }
  return '';
}
// ================================================================
