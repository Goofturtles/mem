// Popup as Spotlight: live search + streaming recall, never leaves your tab.

import * as store from './lib/storage.js';
import * as index from './lib/index.js';
import { search, recallStreaming } from './lib/search.js';
import * as ai from './lib/ai.js';
import { isDailySummaryQuery, dailySummaryScope, buildDailySummary, buildDailyNarrativeText } from './lib/dailySummary.js';
import { inExtension, openOptions as goOptions, openDashboard as goDashboard } from './lib/env.js';

// The worker owns index writes. The popup only searches, but load() can
// itself become a writer: finding an interrupted-rebuild marker triggers a
// full local reindex, which would race the worker's own recovery — both
// start by clearing shards and postings.
if (inExtension && chrome.runtime?.sendMessage) index.setReadOnly(true);

const $ = (id) => document.getElementById(id);

const searchInput = $('search');
const resultsEl = $('results');
const emptyEl = $('empty');
const answerSection = $('answer-section');
const answerBody = $('answer-body');
const answerLabel = $('answer-label');
const answerCard = answerSection;
const resultCount = $('result-count');
const totalCount = $('count');
const openOptions = $('open-options');
const openDashboard = $('open-dashboard');
const saveCurrent = $('save-current');
const scanStrip = $('scan-strip');
const scanStripText = $('scan-strip-text');
const startersEl = $('starters');
const toastEl = $('toast');

let rows = []; // current search results
let selected = 0;
let activeStream = null; // AbortController if any

// ---------- helpers ----------

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function sourceLabel(m) {
  if (m.sourceKind === 'drive') return m.sourceLabel ? `Drive · ${m.sourceLabel}` : 'Drive';
  if (m.sourceKind === 'file') return m.sourceLabel || 'File';
  if (m.sourceKind === 'gmail') return 'Email';
  if (m.sourceKind === 'youtube') return m.sourceLabel || 'YouTube';
  if (m.sourceKind === 'calendar') return 'Calendar';
  if (m.sourceKind === 'history') return 'History';
  if (m.sourceKind === 'bookmark') return 'Bookmark';
  return hostOf(m.url);
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

function renderRows(hits) {
  rows = hits;
  selected = 0;
  resultsEl.innerHTML = '';
  resultCount.textContent = hits.length ? `${hits.length}` : '';
  if (hits.length === 0) {
    showEmpty();
    return;
  }
  emptyEl.classList.add('hidden');
  resultsEl.style.display = '';
  hits.forEach((hit, idx) => {
    const m = hit.memory || hit;
    const row = document.createElement('div');
    row.className = 'row' + (idx === 0 ? ' selected' : '');
    row.dataset.url = m.url;
    row.dataset.id = m.id;
    row.dataset.idx = idx;
    row.innerHTML = `
      <div class="row-fav">${m.favicon ? `<img src="${escHtml(m.favicon)}" onerror="this.parentNode.innerHTML=''" />` : ''}</div>
      <div class="row-body">
        <div class="row-title">${escHtml(m.title)}</div>
        <div class="row-summary">${escHtml(m.summary || m.excerpt || '')}</div>
      </div>
      <div class="row-source">${escHtml(sourceLabel(m))} · ${timeAgo(m.createdAt)}</div>
    `;
    row.addEventListener('click', () => openRow(idx));
    row.addEventListener('mouseenter', () => setSelected(idx));
    resultsEl.appendChild(row);
  });
}

function showEmpty() {
  resultsEl.innerHTML = '';
  emptyEl.classList.remove('hidden');
}

function setSelected(idx) {
  if (idx < 0 || idx >= rows.length) return;
  selected = idx;
  [...resultsEl.querySelectorAll('.row')].forEach((r, i) => r.classList.toggle('selected', i === idx));
  const el = resultsEl.querySelectorAll('.row')[idx];
  el?.scrollIntoView({ block: 'nearest' });
}

function openRow(idx) {
  const hit = rows[idx];
  if (!hit) return;
  const url = hit.memory?.url || hit.url;
  if (!url) return;
  if (inExtension && chrome.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  if (typeof window.close === 'function') window.close();
}

// ---------- search ----------

let searchDebounce = 0;
async function runLiveSearch(q) {
  if (!q.trim()) {
    const recent = await store.recent(20);
    renderRows(recent.map((m) => ({ memory: m, score: 0, semantic: 0, lexical: 0 })));
    return;
  }
  // lexicalOnly avoids the embed call per keystroke — saves quota and
  // keeps typing snappy.
  const hits = await search(q, { limit: 20, lexicalOnly: true });
  renderRows(hits);
}

searchInput.addEventListener('input', () => {
  hideAnswer();
  // Hide the starter chips once user is actively typing.
  startersEl.classList.toggle('hidden', !!searchInput.value.trim());
  if (activeStream) { try { activeStream.abort(); } catch {} activeStream = null; }
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runLiveSearch(searchInput.value), 160);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSelected(Math.min(selected + 1, rows.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSelected(Math.max(selected - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      // explicit "open selected" with modifier
      openRow(selected);
      return;
    }
    const q = searchInput.value.trim();
    if (!q) {
      openRow(selected);
      return;
    }
    runRecall(q);
  } else if (e.key === 'ArrowRight' && rows.length > 0) {
    // open selected in new tab
    const sel = window.getSelection?.()?.toString() || '';
    if (sel || searchInput.selectionStart < searchInput.value.length) return; // let cursor move
    e.preventDefault();
    openRow(selected);
  } else if (e.key === 'Escape') {
    if (answerSection.classList.contains('hidden')) {
      window.close?.();
    } else {
      hideAnswer();
    }
  }
});

// ---------- recall (streaming, inline in popup) ----------

function hideAnswer() {
  answerSection.classList.add('hidden');
  answerCard.classList.remove('done');
  answerBody.innerHTML = '';
}

async function runRecall(q) {
  hideAnswer();
  startersEl.classList.add('hidden');
  answerSection.classList.remove('hidden');
  answerLabel.textContent = 'Recalling';
  answerBody.textContent = '';

  const n = await store.count();
  if (n === 0) {
    answerLabel.textContent = 'No memory yet';
    answerBody.innerHTML = `Nothing's indexed yet. <button class="link inline" id="popup-open-options">Open the dashboard</button> to start a scan.`;
    document.getElementById('popup-open-options')?.addEventListener('click', (e) => { e.preventDefault(); goDashboard(); window.close?.(); });
    answerCard.classList.add('done');
    return;
  }

  // Daily summary path — always renders text first. Cards live under a
  // collapsed "Sources" toggle below. Handles today AND yesterday.
  const dsScope = dailySummaryScope(q);
  if (dsScope) {
    const all = await store.all();
    const summary = await buildDailySummary({ memories: all, daysAgo: dsScope.daysAgo });
    answerLabel.textContent = summary.dayLabel;
    answerCard.classList.add('done');
    const baseline = buildDailyNarrativeText(summary);
    answerBody.innerHTML = `
      <div class="ds-narrative" id="popup-ds-narrative">${escHtml(baseline)}</div>
      <details class="ds-details" id="popup-ds-details">
        <summary class="ds-details-summary">Show sources (${summary.totalToday + summary.upcomingCount})</summary>
        ${renderPopupSummary(summary)}
      </details>
    `;
    const narrativeEl = document.getElementById('popup-ds-narrative');
    answerBody.querySelectorAll('.ds-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        const m = all.find((x) => x.id === id);
        if (m?.url) {
          if (inExtension && chrome.tabs?.create) chrome.tabs.create({ url: m.url });
          else window.open(m.url, '_blank', 'noopener,noreferrer');
        }
      });
    });
    // Try to layer the AI narrative if a key is set.
    try {
      await ai.dailyNarrativeStreaming(summary, {
        onToken: (_d, acc) => {
          narrativeEl.textContent = acc;
          narrativeEl.scrollTop = narrativeEl.scrollHeight;
        },
      });
    } catch {
      // baseline text already shown; silently keep it
    }
    return;
  }

  let memoriesRef = [];
  const controller = new AbortController();
  activeStream = controller;

  try {
    const { answer, memories } = await recallStreaming(q, {
      limit: 6,
      signal: controller.signal,
      onToken: (_d, acc) => {
        answerBody.innerHTML = renderAnswer(acc, memoriesRef);
        answerBody.scrollTop = answerBody.scrollHeight;
      },
      onMemoriesResolved: (m) => { memoriesRef = m; },
    });
    if (!answer) {
      answerLabel.textContent = 'No matches';
      answerBody.textContent = 'Nothing in your memory matches that yet.';
      return;
    }
    answerLabel.textContent = 'Recalled';
    answerCard.classList.add('done');
    answerBody.innerHTML = renderAnswer(answer, memories);
  } catch (e) {
    if (e.name === 'AbortError') return; // user typed more
    if (e.code === 'NO_API_KEY' || /No\s.*key/i.test(e.message)) {
      answerLabel.textContent = 'No AI key';
      answerBody.innerHTML = `Search works — see results below. Add a free Gemini key in <button class="link inline" id="popup-open-settings">Settings</button> to get a synthesized answer.`;
      document.getElementById('popup-open-settings')?.addEventListener('click', (ev) => { ev.preventDefault(); goOptions(); window.close?.(); });
    } else if (e.code === 'RATE_LIMIT' || e.status === 429 || /\b429\b|rate limit/i.test(e.message)) {
      const which = e.provider || await ai.currentProvider();
      const name = ai.PROVIDER[which]?.name || 'AI provider';
      const otherName = which === 'openai' ? 'Gemini' : 'OpenAI';
      answerLabel.textContent = `Rate limit · ${name}`;
      answerBody.innerHTML = `<strong>${name}</strong> hit its per-minute cap. Wait 60s and retry, or <button class="link inline" id="popup-open-settings-2">switch to ${otherName}</button>.`;
      document.getElementById('popup-open-settings-2')?.addEventListener('click', (ev) => { ev.preventDefault(); goOptions(); window.close?.(); });
    } else {
      answerLabel.textContent = 'Error';
      answerBody.textContent = e.message;
    }
  } finally {
    if (activeStream === controller) activeStream = null;
  }
}

function renderPopupSummary(summary) {
  const { groups, totalToday, upcomingCount, humanRelative } = summary;
  const sections = [
    { key: 'read', label: 'Read' },
    { key: 'watched', label: 'Watched' },
    { key: 'toDo', label: 'To complete' },
    { key: 'communicated', label: 'Communications' },
    { key: 'classroom', label: 'Classroom' },
    { key: 'other', label: 'Other' },
  ];
  const blocks = sections
    .filter((s) => (groups[s.key] || []).length > 0)
    .map((s) => {
      const rows = groups[s.key].slice(0, 4).map((m) => {
        const due = m.extra?.due;
        const time = due && due > Date.now() ? humanRelative(due) : humanRelative(m.createdAt);
        return `<li class="ds-row" data-id="${escHtml(m.id)}">
          <span class="ds-title">${escHtml(m.title)}</span>
          <span class="ds-meta">${escHtml(time)}</span>
        </li>`;
      }).join('');
      const more = groups[s.key].length > 4 ? `<li class="ds-more">+${groups[s.key].length - 4} more</li>` : '';
      return `<section class="ds-section">
        <h4 class="ds-h">${s.label}<span class="ds-count">${groups[s.key].length}</span></h4>
        <ul class="ds-list">${rows}${more}</ul>
      </section>`;
    }).join('');
  const intro = totalToday === 0
    ? `<p class="ds-intro">No activity yet today.</p>`
    : `<p class="ds-intro">${totalToday} item${totalToday === 1 ? '' : 's'} today${upcomingCount > 0 ? ` · ${upcomingCount} coming up` : ''}.</p>`;
  return `<div class="daily-summary">${intro}${blocks}</div>`;
}

function renderAnswer(text, memories) {
  return escHtml(text).replace(/\[#(\d+)\]/g, (_m, n) => {
    const idx = parseInt(n, 10) - 1;
    const mem = memories[idx];
    if (!mem) return `[#${n}]`;
    return `<span class="cite" data-url="${escHtml(mem.url)}" title="${escHtml(mem.title)}">#${n}</span>`;
  });
}

answerBody.addEventListener('click', (e) => {
  const cite = e.target.closest('.cite');
  if (!cite) return;
  const url = cite.dataset.url;
  if (!url) return;
  if (inExtension && chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener,noreferrer');
});

// ---------- save current tab ----------

saveCurrent?.addEventListener('click', async () => {
  if (!inExtension || !chrome.runtime?.sendMessage) {
    toast('Saving works in the installed extension.', 'err');
    return;
  }
  saveCurrent.disabled = true;
  saveCurrent.textContent = 'Saving…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'save-active-tab' });
    if (!res?.ok) throw new Error(res?.error || 'Save failed');
    toast('Saved.', 'ok');
    runLiveSearch(searchInput.value);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    saveCurrent.disabled = false;
    saveCurrent.textContent = 'Save page';
  }
});

// ---------- nav ----------

openOptions.addEventListener('click', () => { goOptions(); window.close?.(); });
openDashboard?.addEventListener('click', () => { goDashboard(); window.close?.(); });

// ---------- scan banner ----------

async function refreshScan() {
  if (!inExtension || !chrome.runtime?.sendMessage) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'scan-status' });
    applyScanState(res?.state);
  } catch {}
}

function applyScanState(state) {
  if (!state || !state.running) { scanStrip.classList.add('hidden'); return; }
  scanStrip.classList.remove('hidden');
  const inflight = state.sources.find((s) => s.status === 'running');
  const done = state.sources.filter((s) => s.status === 'done').length;
  const total = state.sources.length;
  const added = state.totals.added.toLocaleString();
  scanStripText.textContent = inflight
    ? `Indexing ${inflight.label.toLowerCase()} · ${done}/${total} done · ${added} so far`
    : `Indexing · ${done}/${total} done · ${added} so far`;
}

if (inExtension && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'scan-progress') applyScanState(msg.state);
  });
}

// ---------- init ----------

async function renderStarters() {
  const items = await store.recent(200);
  startersEl.innerHTML = '';
  if (items.length === 0) {
    for (const t of ['Daily summary', 'What was I just doing?']) addStarter(t);
    return;
  }
  const byKind = new Map();
  for (const m of items) byKind.set(m.sourceKind, (byKind.get(m.sourceKind) || 0) + 1);
  const candidates = ['Daily summary', 'What was I just doing?'];
  if (byKind.get('classroom')) candidates.push('What assignments are due?');
  if (byKind.get('calendar')) candidates.push("What's on my calendar?");
  if (byKind.get('gmail')) candidates.push('Recent emails');
  if (byKind.get('youtube')) candidates.push('Videos I liked');
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    addStarter(c);
    if (seen.size >= 4) break;
  }
}

function addStarter(text) {
  const el = document.createElement('button');
  el.className = 'starter';
  el.type = 'button';
  el.textContent = text;
  el.addEventListener('click', () => {
    searchInput.value = text;
    runRecall(text);
  });
  startersEl.appendChild(el);
}

async function refreshPopupProvider() {
  const chip = document.getElementById('popup-provider');
  const nameEl = document.getElementById('popup-provider-name');
  if (!chip || !nameEl) return;
  try {
    const provider = await ai.currentProvider();
    const keyName = provider === 'openai' ? 'openaiKey' : 'geminiKey';
    const env = await import('./lib/env.js');
    const key = await env.getSetting(keyName) || (provider === 'openai' ? await env.getSetting('apiKey') : null);
    if (!key) { chip.hidden = true; return; }
    nameEl.textContent = ai.PROVIDER[provider]?.name || provider;
    chip.hidden = false;
  } catch {
    chip.hidden = true;
  }
}

async function init() {
  searchInput.focus();
  const n = await store.count();
  totalCount.textContent = n ? `${n} memor${n === 1 ? 'y' : 'ies'}` : '';
  await Promise.all([runLiveSearch(''), renderStarters(), refreshPopupProvider()]);
  refreshScan();
}

init();
