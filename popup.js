/* global chrome */
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const parseBtn = document.getElementById('parse');
const aiParseBtn = document.getElementById('ai-parse');
const fillBtn = document.getElementById('fill');
const proBtn = document.getElementById('pro');
const transcriptEl = document.getElementById('transcript');
const kvEl = document.getElementById('kv');
const statusEl = document.getElementById('status');

let recognition;
let listening = false;

function setStatus(msg) { statusEl.textContent = msg || ''; }

function ensureSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('SpeechRecognition not supported in this browser.');
    return null;
  }
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.lang = 'en-US';
  rec.interimResults = true;
  return rec;
}

startBtn.onclick = () => {
  if (listening) return;
  recognition = ensureSpeech();
  if (!recognition) return;

  transcriptEl.value = '';
  setStatus('Listening… speak field:value pairs.');

  recognition.onresult = (e) => {
    let tmp = '';
    for (let i = e.resultIndex; i < e.results.length; i++) tmp += e.results[i][0].transcript;
    transcriptEl.value = tmp.trim();
  };
  recognition.onerror = (e) => setStatus('Speech error: ' + e.error);
  recognition.onend = () => { listening = false; startBtn.disabled = false; stopBtn.disabled = true; setStatus('Stopped.'); };

  recognition.start();
  listening = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
};

stopBtn.onclick = () => { if (recognition && listening) recognition.stop(); };

parseBtn.onclick = () => {
  const text = transcriptEl.value.trim();
  const map = transcriptToMap(text);
  kvEl.value = JSON.stringify(map, null, 2);
  setStatus('Parsed to map (local).');
};

aiParseBtn.onclick = async () => {
  const text = transcriptEl.value.trim();
  if (!text) return setStatus('Nothing to parse.');
  setStatus('Parsing with AI…');
  try {
    const obj = await aiParseTranscript(text);
    kvEl.value = JSON.stringify(obj, null, 2);
    setStatus('Parsed to map (OpenAI).');
  } catch (e) {
    console.warn(e);
    setStatus('AI parse failed. Using local parse might help.');
  }
};

proBtn.onclick = async () => {
  const text = transcriptEl.value.trim();
  if (!text) return setStatus('Nothing to professionalize.');
  const { professionalized, source } = await professionalizeText(text);
  transcriptEl.value = professionalized;
  setStatus('Professionalized via ' + source + '.');
};

fillBtn.onclick = async () => {
  let obj = {};
  try { obj = JSON.parse(kvEl.value || '{}'); } catch {
    return setStatus('Invalid JSON in Parsed Field Map.');
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: 'FILL_FIELDS', payload: obj });
  setStatus('Attempted to fill fields on page.');
};

// ----------------- Helpers -----------------
function transcriptToMap(text) {
  // Simple offline parser: "Field: Value" or "Set FIELD to VALUE"
  const parts = text.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const p of parts) {
    const m = p.match(/^\s*(?:set\s+)?([^:]+?)\s*(?::| to )\s*(.+)$/i);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

async function getApiKey() {
  return new Promise(resolve => chrome.storage.sync.get(['OPENAI_API_KEY'], d => resolve(d.OPENAI_API_KEY)));
}

async function openaiChat(messages, model = "gpt-4o-mini", temperature = 0.2) {
  const key = await getApiKey();
  if (!key) throw new Error('No OpenAI API key set in Options.');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature })
  });
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content from OpenAI.');
  return content.trim();
}

// AI parsing: returns a JS object
async function aiParseTranscript(text) {
  const sys = `You convert a messy spoken transcript about filling a form into a clean JSON map of {fieldName: value}.
- Preserve factual content.
- Normalize numbers (e.g., '$5,000' -> '$5,000'; '5k' -> '$5,000').
- Keep dates legible (e.g., 'Nov 2, 2025').
- If multiple values are present for a checkbox/radio group, output a comma-separated string.
- Do not invent fields; only use what the user said.`;

  const user = `Transcript:
"""${text}"""

Return ONLY JSON (no backticks, no commentary).`;

  const out = await openaiChat([{ role: 'system', content: sys }, { role: 'user', content: user }]);
  // Try to parse JSON. If it fails, fall back to local parse.
  try {
    return JSON.parse(out);
  } catch {
    return transcriptToMap(text);
  }
}

async function professionalizeText(text) {
  const key = await getApiKey();
  if (!key) {
    // Local heuristic fallback
    const cleaned = text
      .replace(/\s+/g, ' ')
      .replace(/\b(i|im|i'm)\b/gi, 'I')
      .replace(/\bok\b/gi, 'okay')
      .replace(/\bgonna\b/gi, 'going to')
      .trim();
    const sentences = cleaned.split(/([.?!])\s+/).reduce((acc, seg) => {
      if (!seg) return acc;
      if (/[.?!]/.test(seg)) { acc[acc.length - 1] += seg + ' '; }
      else { acc.push(seg.charAt(0).toUpperCase() + seg.slice(1)); }
      return acc;
    }, []).join(' ').trim();
    return { professionalized: sentences, source: 'local rules' };
  }

  const prompt = `Rewrite the following content into a concise, polished, professional tone for a remodeling proposal/contract. Improve grammar and clarity without changing facts:\n---\n${text}`;
  try {
    const out = await openaiChat([{ role: 'user', content: prompt }], "gpt-4o-mini", 0.2);
    return { professionalized: out, source: 'OpenAI' };
  } catch (e) {
    console.warn('OpenAI error', e);
    return { professionalized: text, source: 'fallback (unchanged)' };
  }
}
