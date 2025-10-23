/* global chrome */
let SR = {
  rec: null,
  listening: false,
  interim: '',
  final: ''
};

function ensureSpeech() {
  const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SRClass) throw new Error('SpeechRecognition not supported in this browser.');
  const rec = new SRClass();
  rec.continuous = true;
  rec.lang = 'en-US';
  rec.interimResults = true;
  return rec;
}

async function requestMicOnce() {
  // Prompt for mic explicitly to avoid popup/permission flakiness
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    throw new Error('Microphone permission denied or unavailable.');
  }
}

async function startListening() {
  if (SR.listening) return;
  await requestMicOnce();

  SR.rec = ensureSpeech();
  SR.interim = '';
  SR.final = '';

  SR.rec.onresult = (e) => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      txt += res[0].transcript;
      if (res.isFinal) {
        SR.final += res[0].transcript + ' ';
        SR.interim = '';
      } else {
        SR.interim = txt;
      }
    }
    chrome.runtime.sendMessage({
      type: 'SR_UPDATE',
      payload: {
        interim: SR.interim.trim(),
        final: SR.final.trim()
      }
    });
  };

  SR.rec.onerror = (e) => {
    chrome.runtime.sendMessage({ type: 'SR_ERROR', payload: { message: e.error || String(e) } });
    stopListening();
  };

  SR.rec.onend = () => {
    SR.listening = false;
    chrome.runtime.sendMessage({ type: 'SR_STATE', payload: { listening: false } });
  };

  SR.rec.start();
  SR.listening = true;
  chrome.runtime.sendMessage({ type: 'SR_STATE', payload: { listening: true } });
}

function stopListening() {
  try { SR.rec && SR.rec.stop && SR.rec.stop(); } catch {}
  SR.listening = false;
}

// -------- Existing fill code (unchanged) --------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type === 'FILL_FIELDS') {
    try {
      await fillFields(msg.payload || {});
      sendResponse({ ok: true });
    } catch (e) {
      console.error(e);
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  if (msg?.type === 'SR_START') {
    startListening().catch(err => chrome.runtime.sendMessage({ type: 'SR_ERROR', payload: { message: err.message } }));
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'SR_STOP') {
    stopListening();
    sendResponse({ ok: true });
    return true;
  }
});

// ---- Autofill functions from previous content.js ----
async function fillFields(map) {
  const fields = indexFields();
  for (const [key, rawVal] of Object.entries(map)) {
    const val = String(rawVal).trim();
    const target = bestFieldMatch(fields, key);
    if (!target) continue;
    await applyValue(target, val);
  }
}

function indexFields() {
  const nodes = Array.from(document.querySelectorAll('input, select, textarea'));
  const labels = new Map();
  document.querySelectorAll('label[for]').forEach(l => labels.set(l.getAttribute('for'), textFromNode(l)));

  return nodes.map(el => {
    const id = el.id || '';
    const type = (el.type || el.tagName).toLowerCase();
    const name = el.name || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const aria = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    const lbl = labels.get(id) || closestLabelText(el);

    return {
      el, type, name, id,
      label: lbl,
      scoreKeys: [
        lbl, placeholder, aria, title, name, id,
        guessPrettyName(name || id)
      ].filter(Boolean).join(' | ')
    };
  });
}

function guessPrettyName(s) {
  if (!s) return '';
  return s
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function textFromNode(n) {
  return (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
}

function closestLabelText(el) {
  const wrapLabel = el.closest('label');
  if (wrapLabel) return textFromNode(wrapLabel);
  const ariaId = el.getAttribute('aria-labelledby');
  if (ariaId) {
    const s = ariaId.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(textFromNode).join(' ');
    if (s) return s;
  }
  const parent = el.closest('div, section, td, th, li, p') || el.parentElement;
  if (!parent) return '';
  const prev = parent.querySelector('label') || parent.querySelector('span, strong, b, p, h1, h2, h3, h4');
  return prev ? textFromNode(prev) : '';
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}

function bestFieldMatch(fields, spokenKey) {
  const target = norm(spokenKey);
  let best = null;
  let bestScore = 0;
  for (const f of fields) {
    const s = similarity(f.scoreKeys, target) * 0.7 + similarity(f.label, target) * 0.3;
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return bestScore >= 0.25 ? best : null;
}

async function applyValue(f, value) {
  const el = f.el;
  const tag = el.tagName.toLowerCase();
  const type = (el.type || '').toLowerCase();

  if (tag === 'textarea' || (tag === 'input' && ['text','email','tel','url','number','search','date','datetime-local'].includes(type))) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    const wants = value.split(/[,;]+/).map(v => norm(v));
    const group = findGroup(el);
    const candidates = group.length ? group : [el];
    for (const c of candidates) {
      const lab = closestLabelText(c) || c.value || c.name || '';
      const nlab = norm(lab);
      const nval = norm(c.value);
      const shouldCheck = wants.some(w => w && (nlab.includes(w) || nval.includes(w)));
      if (shouldCheck) {
        c.click();
        await sleep(20);
      }
    }
    return;
  }

  if (tag === 'select') {
    const sel = el;
    const want = norm(value);
    let bestIdx = -1, bestScore = 0;
    for (let i=0; i<sel.options.length; i++) {
      const opt = sel.options[i];
      const s = Math.max(similarity(opt.text, want), similarity(opt.value, want));
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      sel.selectedIndex = bestIdx;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }

  if (el.isContentEditable) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);
    return;
  }
}

function findGroup(el) {
  if (!(el instanceof HTMLInputElement)) return [];
  if (el.type !== 'radio' && el.type !== 'checkbox') return [];
  const name = el.name;
  if (!name) return [];
  return Array.from(document.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(name)}"]`));
}
