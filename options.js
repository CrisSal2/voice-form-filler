/* global chrome */
const keyEl = document.getElementById('key');
const statusEl = document.getElementById('status');

function setStatus(t){ statusEl.textContent = t || ''; }

chrome.storage.sync.get(['OPENAI_API_KEY'], ({ OPENAI_API_KEY }) => {
  if (OPENAI_API_KEY) keyEl.value = OPENAI_API_KEY;
});

document.getElementById('save').onclick = () => {
  chrome.storage.sync.set({ OPENAI_API_KEY: keyEl.value.trim() }, () => setStatus('Saved!'));
};

document.getElementById('clear').onclick = () => {
  chrome.storage.sync.remove(['OPENAI_API_KEY'], () => { keyEl.value = ''; setStatus('Cleared.'); });
};
