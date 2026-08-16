import * as store from './lib/storage.js';
import * as index from './lib/index.js';
import { search, recallStreaming, invalidateAnswerCache, relatedTo } from './lib/search.js';
import { Conversation } from './lib/conversation.js';
import { dailySummaryScope, buildDailySummary, buildDailyNarrativeText } from './lib/dailySummary.js';
import { TTSController } from './lib/tts.js';
import { inExtension, getSetting, setSetting, removeSetting, openOptions as goOptions } from './lib/env.js';
import * as ai from './lib/ai.js';
import * as local from './lib/local.js';
import { ingestFiles } from './lib/files.js';
import * as episodes from './lib/episodes.js';
import * as entities from './lib/entities.js';
import * as openloops from './lib/openloops.js';
import * as resurfaceMod from './lib/resurface.js';
import * as reminders from './lib/reminders.js';

const $ = (id) => document.getElementById(id);

const searchInput = $('search');
const recallBtn = $('recall-btn');
const suggestions = $('suggestions');
const cards = $('cards');
const heroIntro = $('hero-intro');
const heroProvider = $('hero-provider');
const heroProviderName = $('hero-provider-name');
const heroProviderSwitch = $('hero-provider-switch');
const onboardEl = $('onboard');
const paneKey = $('pane-key');
const paneScan = $('pane-scan');
const paneReady = $('pane-ready');
const paneInstall = $('pane-install');
const scanOptions = $('scan-options');
const scanStart = $('scan-start');
const scanSkip = $('scan-skip');
const scanProgress = $('scan-progress');
const scanRows = $('scan-rows');
const scanSummary = $('scan-summary');
const scanGoogleNote = $('scan-google-note');
const scanOpenSettings = $('scan-open-settings');
const scanBanner = $('scan-banner');
const scanBannerText = $('scan-banner-text');
const onboardKeyForm = $('onboard-key-form');
const onboardKeyInput = $('onboard-key');
const onboardKeySave = $('onboard-key-save');
const onboardKeyStatus = $('onboard-key-status');
const onboardGetKey = $('onboard-get-key');
const onboardDemo = $('onboard-demo');
const onboardLocal = $('onboard-local');
const localState = $('local-state');
const localEnable = $('local-enable');
const localDownload = $('local-download');
const localProgress = $('local-progress');
const localBar = $('local-bar');
const providerSegment = $('provider-segment');
const readyDemo = $('ready-demo');
const installDemo = $('install-demo');
const readyOpenSettings = $('ready-open-settings');
const dropOverlay = $('drop-overlay');
const toastEl = $('toast');
const resultsTitle = $('results-title');
const resultsCount = $('results-count');
const viewAction = $('view-action');
const threadSection = $('thread-section');
const threadEl = $('thread');
const threadNew = $('thread-new');
const clearAnswer = $('clear-answer');
const openOptions = $('open-options');
const surfaces = $('surfaces');

const overlay = $('detail-overlay');
const detailClose = $('detail-close');
const detailMeta = $('detail-meta');
const detailTitle = $('detail-title');
const detailTags = $('detail-tags');
const detailSummary = $('detail-summary');
const detailFacts = $('detail-facts');
const detailSelection = $('detail-selection');
const detailSelectionSection = $('detail-selection-section');
const detailLink = $('detail-link');
const detailDelete = $('detail-delete');
const detailDeepen = $('detail-deepen');
const detailDeepenHint = $('detail-deepen-hint');
const detailEpisodeSection = $('detail-episode-section');
const detailEpisode = $('detail-episode');
const detailRelatedSection = $('detail-related-section');
const detailRelated = $('detail-related');

const tts = new TTSController();
const conversation = new Conversation();

let currentMemoryId = null;
let currentView = 'recent';
let entityKind = '';

// The index keeps its ordinal table in module state and persists it whole, so
// two contexts that both write it clobber each other. Inside the extension
// the service worker owns writes and this page only reads; mutations are sent
// to the worker instead. Standalone (the localhost preview) there is no
// worker, so the page is the only context and may write directly.
if (inExtension && chrome.runtime?.sendMessage) index.setReadOnly(true);

/**
 * Run a mutation in the writer context.
 *
 * Inside the extension the service worker owns every write — not only index
 * writes. `cancelReminder` is the sharp example: it deletes a memory, whose
 * removeDoc throws under read-only and is swallowed by a surrounding catch,
 * leaving the record gone but its ordinal alive so a deleted memory keeps
 * scoring in BM25. Standalone there is no worker, so the fallback runs here.
 */
async function callWorker(msg, fallback) {
  if (!inExtension || !chrome.runtime?.sendMessage) return fallback();
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || `${msg.type} failed`);
  index._reset();
  invalidateCaches();
  return res;
}

/** Ask the worker to perform a mutation, then refresh this page's view of it. */
async function mutate(msg) {
  if (!inExtension || !chrome.runtime?.sendMessage) return null;
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.ok) {
    // The worker changed the index; drop our cached copy so the next read
    // reloads from storage.
    index._reset();
    invalidateCaches();
  }
  return res;
}

// The old dashboard kept every memory in a page-level array so live search
// could filter it. Retrieval now runs against the index, so nothing here
// holds the corpus — only the handful of records currently on screen.
let narrativeCache = { sig: null, text: '', at: 0 };
function invalidateCaches() {
  narrativeCache = { sig: null, text: '', at: 0 };
  invalidateAnswerCache();
}

// ---------- helpers ----------

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.floor(f / 60)}m`;
    if (f < 86400) return `in ${Math.floor(f / 3600)}h`;
    return `in ${Math.floor(f / 86400)}d`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Only http(s) may reach an href. Memory URLs aren't all self-generated —
 * the LifeOS bridge and approved external extensions can write them — so a
 * stored `javascript:` URL would run in the extension page's own privileged
 * context if it were ever clicked.
 */
function safeHref(url) {
  try {
    const u = new URL(String(url), location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch {
    return null;
  }
}

function sourceLabel(m) {
  if (m.sourceKind === 'drive') return m.sourceLabel ? `Drive · ${m.sourceLabel}` : 'Google Drive';
  if (m.sourceKind === 'file') return m.sourceLabel || 'Local file';
  if (m.sourceKind === 'gmail') return 'Email';
  if (m.sourceKind === 'youtube') return m.sourceLabel || 'YouTube';
  if (m.sourceKind === 'calendar') return 'Calendar';
  if (m.sourceKind === 'classroom') return m.sourceLabel || 'Classroom';
  if (m.sourceKind === 'reminder') return 'Reminder';
  if (m.sourceKind === 'history') return `History · ${hostOf(m.url)}`;
  if (m.sourceKind === 'bookmark') return `Bookmark · ${hostOf(m.url)}`;
  return hostOf(m.url) || m.siteName || '';
}

function faviconHtml(m) {
  if (!m.favicon) return '';
  const img = document.createElement('img');
  img.className = 'favicon';
  img.src = m.favicon;
  img.alt = '';
  img.addEventListener('error', () => { img.style.display = 'none'; });
  return img;
}

function renderCard(hit) {
  const m = hit.memory || hit;
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = m.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const fav = faviconHtml(m);
  if (fav) meta.appendChild(fav);
  meta.insertAdjacentHTML('beforeend',
    `<span class="site">${escHtml(sourceLabel(m))}</span>
     <span class="dot-sep">·</span>
     <span>${escHtml(timeAgo(m.createdAt))}</span>`);
  card.appendChild(meta);

  card.insertAdjacentHTML('beforeend', `
    <div class="card-title">${escHtml(m.title)}</div>
    <div class="card-summary">${escHtml(m.summary)}</div>
    <div class="card-tags">${(m.tags || []).slice(0, 5).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>
  `);

  // When retrieval matched a passage rather than the whole document, show
  // that passage — it's the reason this result is here.
  if (hit.evidence && hit.evidence.length > 40) {
    const ev = document.createElement('div');
    ev.className = 'card-evidence';
    ev.textContent = hit.evidence.slice(0, 240);
    card.appendChild(ev);
  }

  const open = () => openDetail(m);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

function renderCards(results) {
  cards.innerHTML = '';
  if (results.length === 0) {
    resultsCount.textContent = '0';
    return;
  }
  resultsCount.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
  for (const r of results) cards.appendChild(renderCard(r));
}

function toast(msg, kind = '') {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

// ---------- views ----------

const PANELS = {
  episodes: $('panel-episodes'),
  people: $('panel-people'),
  loops: $('panel-loops'),
  resurface: $('panel-resurface'),
  reminders: $('panel-reminders'),
};

function setView(view) {
  currentView = view;
  for (const btn of surfaces.querySelectorAll('.surface-tab')) {
    const on = btn.dataset.view === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  cards.classList.toggle('hidden', view !== 'recent');
  for (const [k, el] of Object.entries(PANELS)) el.classList.toggle('hidden', k !== view);
  viewAction.classList.add('hidden');

  if (view === 'recent') { resultsTitle.textContent = 'Recent memories'; showRecent(); }
  else if (view === 'episodes') renderEpisodes();
  else if (view === 'people') renderPeople();
  else if (view === 'loops') renderLoops();
  else if (view === 'resurface') renderResurface();
  else if (view === 'reminders') renderReminders();
}

surfaces.addEventListener('click', (e) => {
  const btn = e.target.closest('.surface-tab');
  if (btn) setView(btn.dataset.view);
});

// ---------- recent ----------

async function showRecent() {
  const items = await store.recent(50);
  if (items.length === 0) {
    await showOnboarding();
    cards.innerHTML = '';
    resultsCount.textContent = '';
    return;
  }
  onboardEl.classList.add('hidden');
  resultsTitle.textContent = 'Recent memories';
  renderCards(items.map((m) => ({ memory: m })));
}

// ---------- sessions ----------

async function renderEpisodes() {
  resultsTitle.textContent = 'Sessions';
  const list = $('episode-list');
  const note = $('episodes-note');
  list.innerHTML = '';
  let eps = await episodes.listEpisodes({ limit: 40 });

  if (eps.length === 0) {
    note.textContent = 'No sessions yet. mem groups your activity into work sessions once there is enough of it — or rebuild them now.';
    viewAction.textContent = 'Build sessions';
    viewAction.classList.remove('hidden');
    viewAction.onclick = async () => {
      viewAction.textContent = 'Building…';
      const res = await callWorker({ type: 'episodes-rebuild' }, () => episodes.rebuildEpisodes());
      toast(`${res.episodes} sessions reconstructed.`, 'ok');
      renderEpisodes();
    };
    resultsCount.textContent = '0';
    return;
  }

  note.textContent = 'Your activity, grouped into the stretches of work it actually belonged to — split on idle gaps and on changes of subject.';
  resultsCount.textContent = `${eps.length} session${eps.length === 1 ? '' : 's'}`;
  viewAction.textContent = 'Name these with AI';
  viewAction.classList.remove('hidden');
  viewAction.onclick = async () => {
    const unnamed = eps.filter((e) => !e.named).slice(0, 8).map((e) => e.id);
    if (unnamed.length === 0) { toast('Every visible session already has a name.'); return; }
    viewAction.textContent = 'Naming…';
    await callWorker({ type: 'episodes-name', ids: unnamed }, () => episodes.nameEpisodes(unnamed));
    renderEpisodes();
  };

  for (const ep of eps) {
    const el = document.createElement('div');
    el.className = 'episode';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const start = new Date(ep.startedAt);
    const mins = Math.max(1, Math.round(ep.durationMs / 60000));
    const dur = mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
    el.innerHTML = `
      <div class="ep-head">
        <span class="ep-title">${escHtml(ep.title)}</span>
        ${ep.named ? '' : '<span class="ep-auto" title="Named from its contents, without a model call">auto</span>'}
      </div>
      <div class="ep-meta">${escHtml(start.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${dur} · ${ep.count} item${ep.count === 1 ? '' : 's'}</div>
      ${ep.gist ? `<div class="ep-gist">${escHtml(ep.gist)}</div>` : ''}
      <div class="ep-tags">${(ep.topTags || []).slice(0, 4).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>`;
    const open = () => openEpisode(ep.id);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    list.appendChild(el);
  }
}

async function openEpisode(id) {
  const full = await episodes.getEpisode(id);
  if (!full) return;
  setView('recent');
  resultsTitle.textContent = full.episode.title;
  resultsCount.textContent = `${full.memories.length} item${full.memories.length === 1 ? '' : 's'}`;
  renderCards(full.memories.map((m) => ({ memory: m })));
  viewAction.textContent = 'Back to sessions';
  viewAction.classList.remove('hidden');
  viewAction.onclick = () => setView('episodes');
}

// ---------- people & topics ----------

$('kind-filter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  entityKind = chip.dataset.kind || '';
  for (const c of $('kind-filter').querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  renderPeople();
});

async function renderPeople() {
  resultsTitle.textContent = 'People & topics';
  const grid = $('entity-grid');
  const note = $('people-note');
  grid.innerHTML = '';
  const list = await entities.topEntities({ kind: entityKind || null, limit: 60, minCount: 2 });

  if (list.length === 0) {
    note.textContent = 'No graph yet. mem links people, organisations and topics across email, calendar, documents and pages — build it now (this runs locally and costs nothing).';
    viewAction.textContent = 'Build the graph';
    viewAction.classList.remove('hidden');
    viewAction.onclick = async () => {
      viewAction.textContent = 'Building…';
      const res = await callWorker({ type: 'entities-rebuild' }, () => entities.rebuildAll());
      toast(`${res.entities} people and topics linked.`, 'ok');
      renderPeople();
    };
    resultsCount.textContent = '0';
    return;
  }

  note.textContent = 'Everything mem has seen, grouped by who and what it was about — across every source at once.';
  resultsCount.textContent = `${list.length}`;
  viewAction.textContent = 'Rebuild';
  viewAction.classList.remove('hidden');
  viewAction.onclick = async () => {
    viewAction.textContent = 'Rebuilding…';
    await callWorker({ type: 'entities-rebuild' }, () => entities.rebuildAll());
    renderPeople();
  };

  for (const ent of list) {
    const el = document.createElement('button');
    el.className = 'entity';
    el.innerHTML = `
      <span class="ent-kind ${escHtml(ent.kind)}">${escHtml(ent.kind)}</span>
      <span class="ent-name">${escHtml(ent.name)}</span>
      <span class="ent-count">${ent.count}</span>`;
    el.addEventListener('click', () => openEntity(ent.id));
    grid.appendChild(el);
  }
}

async function openEntity(id) {
  const res = await entities.entityTimeline(id);
  if (!res) return;
  setView('recent');
  resultsTitle.textContent = res.entity.name;
  resultsCount.textContent = `${res.memories.length} mention${res.memories.length === 1 ? '' : 's'}`;
  renderCards(res.memories.map((m) => ({ memory: m })));
  viewAction.textContent = 'Back to people & topics';
  viewAction.classList.remove('hidden');
  viewAction.onclick = () => setView('people');
}

// ---------- unfinished ----------

async function renderLoops() {
  resultsTitle.textContent = 'Unfinished';
  const list = $('loop-list');
  const note = $('loops-note');
  list.innerHTML = '';
  const loops = await openloops.findOpenLoops({ limit: 30 });
  updateBadge('loops-badge', loops.length);

  if (loops.length === 0) {
    note.textContent = "Nothing looks unfinished. mem flags assignments you haven't turned in, messages that asked something and never got an answer, and long pages you started and left.";
    resultsCount.textContent = '0';
    return;
  }
  note.textContent = "Things you started and didn't finish. Your browser history records that you visited a page; it has no idea whether you were done with it.";
  resultsCount.textContent = `${loops.length}`;

  for (const loop of loops) {
    const el = document.createElement('div');
    el.className = `loop urgency-${loop.urgency > 0.8 ? 'high' : loop.urgency > 0.45 ? 'mid' : 'low'}`;
    el.innerHTML = `
      <div class="loop-label">${escHtml(loop.label)}</div>
      <div class="loop-body">
        <div class="loop-title"></div>
        <div class="loop-reason">${escHtml(loop.reason)}</div>
      </div>
      <button class="link small loop-dismiss">Dismiss</button>`;
    el.querySelector('.loop-title').textContent = loop.memory.title;
    el.querySelector('.loop-title').addEventListener('click', () => openDetail(loop.memory));
    el.querySelector('.loop-dismiss').addEventListener('click', async () => {
      await callWorker({ type: 'openloops-dismiss', id: loop.id }, () => openloops.dismiss(loop.id));
      el.remove();
      updateBadge('loops-badge', list.children.length);
    });
    list.appendChild(el);
  }
}

// ---------- resurface ----------

async function renderResurface() {
  resultsTitle.textContent = 'Resurface';
  const list = $('resurface-list');
  const note = $('resurface-note');
  const connList = $('connection-list');
  const connH = $('connections-h');
  list.innerHTML = '';
  connList.innerHTML = '';

  const due = await resurfaceMod.dueForResurface({ limit: 8 });
  note.textContent = due.length
    ? 'Things you read long enough ago to be slipping, weighted by how much you seemed to care about them at the time.'
    : "Nothing is due to resurface. mem brings things back when they're far enough gone to be worth a second look, but not so far that they're already lost.";
  resultsCount.textContent = `${due.length}`;

  for (const item of due) {
    const el = document.createElement('div');
    el.className = 'resurface-item';
    el.innerHTML = `
      <div class="rs-title"></div>
      <div class="rs-reason">${escHtml(item.reason)}</div>
      <div class="rs-bar" title="Estimated retention"><span style="width:${Math.round(item.retention * 100)}%"></span></div>`;
    el.querySelector('.rs-title').textContent = item.memory.title;
    el.addEventListener('click', async () => {
      const full = await store.get(item.memory.id);
      if (full) openDetail(full);
    });
    list.appendChild(el);
  }
  if (due.length) {
    viewAction.textContent = 'Mark all as seen';
    viewAction.classList.remove('hidden');
    viewAction.onclick = async () => {
      const ids = due.map((d) => d.memory.id);
      await callWorker({ type: 'resurface-mark', ids }, () => resurfaceMod.markResurfaced(ids));
      toast('Marked as seen — these will rest for a month.', 'ok');
      renderResurface();
    };
  }

  const connections = await resurfaceMod.findConnections({ limit: 6 });
  connH.classList.toggle('hidden', connections.length === 0);
  for (const c of connections) {
    const el = document.createElement('div');
    el.className = 'connection';
    el.innerHTML = `
      <div class="conn-pair">
        <button class="conn-side recent"></button>
        <span class="conn-link">↔</span>
        <button class="conn-side older"></button>
      </div>
      <div class="conn-reason">${escHtml(c.reason)}</div>`;
    el.querySelector('.recent').textContent = c.recent.title;
    el.querySelector('.older').textContent = c.older.title;
    el.querySelector('.recent').addEventListener('click', () => openDetail(c.recent));
    el.querySelector('.older').addEventListener('click', () => openDetail(c.older));
    connList.appendChild(el);
  }
}

// ---------- reminders ----------

async function renderReminders() {
  resultsTitle.textContent = 'Reminders';
  const list = $('reminder-list');
  const note = $('reminders-note');
  list.innerHTML = '';
  const items = await reminders.listReminders();
  updateBadge('reminders-badge', items.length);

  if (items.length === 0) {
    note.textContent = 'No reminders set. When someone gives you a deadline in a conversation, mem can spot it and offer to remind you — turn that on per site in Settings, or select any text and use "Remind me about this…" from the right-click menu.';
    resultsCount.textContent = '0';
    return;
  }
  note.textContent = 'Commitments mem caught in your conversations.';
  resultsCount.textContent = `${items.length}`;

  for (const r of items) {
    const el = document.createElement('div');
    el.className = 'reminder';
    const when = new Date(r.at);
    el.innerHTML = `
      <div class="rem-body">
        <div class="rem-what"></div>
        <div class="rem-when">${escHtml(when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${escHtml(reminders.describeWhen(r.at))}</div>
        ${r.sourceTitle ? `<div class="rem-src">from ${escHtml(r.sourceTitle)}</div>` : ''}
      </div>
      <button class="link small rem-cancel">Cancel</button>`;
    el.querySelector('.rem-what').textContent = r.what;
    el.querySelector('.rem-cancel').addEventListener('click', async () => {
      await callWorker({ type: 'reminder-cancel', id: r.id }, () => reminders.cancelReminder(r.id));
      el.remove();
      updateBadge('reminders-badge', list.children.length);
    });
    list.appendChild(el);
  }
}

function updateBadge(id, n) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle('hidden', n === 0);
}

async function refreshBadges() {
  try {
    const [loops, rems] = await Promise.all([
      openloops.openLoopCounts(),
      reminders.upcomingCount(),
    ]);
    updateBadge('loops-badge', loops.total);
    updateBadge('reminders-badge', rems);
  } catch { /* badges are decoration */ }
}

// ---------- conversation ----------

function newTurnEl(question) {
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `
    <div class="turn-q"></div>
    <div class="turn-rewrite hidden"></div>
    <div class="turn-a">
      <div class="answer-header">
        <div class="answer-label"><div class="pulse"></div><span class="label-text">Recalling…</span></div>
        <div class="answer-actions">
          <button class="icon-btn tts" title="Read aloud" aria-label="Read aloud">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          </button>
        </div>
      </div>
      <div class="answer-body"></div>
    </div>`;
  turn.querySelector('.turn-q').textContent = question;
  threadEl.appendChild(turn);
  threadSection.classList.remove('hidden');
  turn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return {
    turn,
    rewrite: turn.querySelector('.turn-rewrite'),
    label: turn.querySelector('.label-text'),
    body: turn.querySelector('.answer-body'),
    card: turn.querySelector('.turn-a'),
    ttsBtn: turn.querySelector('.tts'),
  };
}

function renderAnswerWithCitations(text, memories) {
  return escHtml(text).replace(/\[#(\d+)\]/g, (_m, n) => {
    const mem = memories[parseInt(n, 10) - 1];
    if (!mem) return `[#${n}]`;
    return `<span class="cite" role="button" tabindex="0" data-id="${escHtml(mem.id)}" title="${escHtml(mem.title)}">#${n}</span>`;
  });
}

threadEl.addEventListener('click', (e) => {
  const cite = e.target.closest('.cite');
  if (!cite) return;
  const card = cards.querySelector(`.card[data-id="${CSS.escape(cite.dataset.id)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlight');
    setTimeout(() => card.classList.remove('highlight'), 1600);
  }
});

async function runRecall(q) {
  q = q.trim();
  if (!q || recallBtn.disabled) return;
  heroIntro?.classList.add('hidden');
  recallBtn.disabled = true;
  setView('recent');

  // Daily summary keeps its own dedicated path — it's a written recap of a
  // day, not a question about the corpus.
  const dsScope = dailySummaryScope(q);
  if (dsScope) {
    await runDailySummary(q, dsScope);
    recallBtn.disabled = false;
    return;
  }

  const ui = newTurnEl(q);

  try {
    let memoriesRef = [];
    const { answer, memories, hits, synthesisFailed, synthesisError } = await conversation.ask(q, {
      limit: 6,
      onRewritten: (rq) => {
        ui.rewrite.textContent = `searched for: ${rq}`;
        ui.rewrite.classList.remove('hidden');
      },
      onMemories: (mems) => {
        memoriesRef = mems;
        resultsTitle.textContent = 'Sources';
      },
      onToken: (_d, acc) => {
        ui.body.innerHTML = renderAnswerWithCitations(acc, memoriesRef);
      },
    });

    renderCards(hits);

    if (synthesisFailed) {
      // Retrieval worked; only the writing step failed. Say exactly that,
      // rather than labelling an error string as the recalled answer.
      ui.label.textContent = 'Found the sources';
      ui.card.classList.add('done');
      ui.body.innerHTML = `Retrieval found ${memories.length} relevant memor${memories.length === 1 ? 'y' : 'ies'}, listed below — but writing an answer failed: ${escHtml(synthesisError || 'unknown error')}`
        + `<div class="answer-footer">Search is local and always works. Only the written answer needs a model.</div>`;
    } else if (!answer) {
      ui.label.textContent = 'No matches';
      ui.body.textContent = 'Nothing in your memory matches that yet.';
    } else {
      ui.label.textContent = 'Recalled';
      ui.card.classList.add('done');
      const titleOnly = memories.filter((m) => m.lightweight || !m.summary || m.summary === m.title).length;
      const withContent = memories.length - titleOnly;
      const passages = hits.filter((h) => h.evidence).length;
      const bits = [`Based on ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}`];
      if (titleOnly > 0) bits.push(`${withContent} with content, ${titleOnly} title-only`);
      if (passages > 0) bits.push(`${passages} matched on a specific passage`);
      if (hits[0]?.semanticSkipped) bits.push(`text-only search — ${hits[0].semanticSkipped}`);
      ui.body.innerHTML = renderAnswerWithCitations(answer, memories)
        + `<div class="answer-footer">${escHtml(bits.join(' · '))}</div>`;
    }
    wireTurnTts(ui);
  } catch (e) {
    if (e.code === 'NO_API_KEY' || /No\s.*key/i.test(e.message)) {
      ui.label.textContent = 'No AI available';
      ui.body.innerHTML = `Search worked — the sources are below. For a written answer, turn on on-device AI or add a free Gemini key in <button class="link inline" id="err-settings">Settings</button>.`;
      $('err-settings')?.addEventListener('click', (ev) => { ev.preventDefault(); goOptions(); });
      if (e.hits) renderCards(e.hits);
    } else if (e.code === 'RATE_LIMIT') {
      const name = ai.PROVIDER[e.provider]?.name || 'Your AI provider';
      ui.label.textContent = 'Rate limited';
      ui.body.innerHTML = `<strong>${escHtml(name)}</strong> hit its rate limit. Wait about a minute, or switch to on-device AI in <button class="link inline" id="err-settings-2">Settings</button> — that has no quota.<br><br>Your search results are still below; those are local.`;
      $('err-settings-2')?.addEventListener('click', (ev) => { ev.preventDefault(); goOptions(); });
      if (e.hits) renderCards(e.hits);
    } else {
      ui.label.textContent = 'Error';
      ui.body.textContent = e.message;
    }
  } finally {
    recallBtn.disabled = false;
    searchInput.value = '';
    searchInput.placeholder = conversation.isEmpty ? 'Anything you’ve ever read' : 'Ask a follow-up…';
  }
}

function wireTurnTts(ui) {
  if (!tts.available()) { ui.ttsBtn.style.display = 'none'; return; }
  ui.ttsBtn.addEventListener('click', () => {
    if (tts.state === 'speaking') { tts.stop(); return; }
    tts.speak(ui.body.innerHTML);
  });
}

async function runDailySummary(q, dsScope) {
  const ui = newTurnEl(q);
  const summary = await buildDailySummary({ daysAgo: dsScope.daysAgo });
  const sigParts = [];
  for (const g of Object.values(summary.groups)) for (const m of g) sigParts.push(m.id);
  const sig = summary.dayLabel + '|' + sigParts.sort().join(',');

  ui.label.textContent = summary.dayLabel;
  ui.card.classList.add('done');
  ui.body.innerHTML = `<div class="ds-narrative"></div>`;
  const narrativeEl = ui.body.querySelector('.ds-narrative');

  // Deterministic prose first, so there is always something to read even
  // with no model available at all.
  narrativeEl.textContent = buildDailyNarrativeText(summary);
  cards.innerHTML = '';
  resultsTitle.textContent = 'That day';
  const dayMems = Object.values(summary.groups).flat();
  renderCards(dayMems.map((m) => ({ memory: m })));

  if (summary.totalToday === 0 && summary.upcomingCount === 0) return;
  if (narrativeCache.sig === sig && Date.now() - narrativeCache.at < 5 * 60 * 1000) {
    narrativeEl.textContent = narrativeCache.text;
    return;
  }

  try {
    const text = await ai.dailyNarrativeStreaming(summary, {
      onToken: (_d, acc) => { narrativeEl.textContent = acc; },
    });
    narrativeCache = { sig, text, at: Date.now() };
  } catch (e) {
    const hint = document.createElement('p');
    hint.className = 'ds-hint';
    hint.textContent = e.code === 'NO_API_KEY'
      ? 'The summary above was written locally. Turn on on-device AI or add a key in Settings for a richer one.'
      : `AI summary unavailable (${e.message}). The local summary above still stands.`;
    ui.body.appendChild(hint);
  }
  wireTurnTts(ui);
}

threadNew.addEventListener('click', () => {
  conversation.reset();
  threadEl.innerHTML = '';
  threadSection.classList.add('hidden');
  searchInput.placeholder = 'Anything you’ve ever read';
  searchInput.focus();
});

clearAnswer.addEventListener('click', () => {
  tts.stop();
  threadSection.classList.add('hidden');
});

// ---------- live search ----------

let liveToken = 0;
async function runLiveSearch(q) {
  const token = ++liveToken;
  if (!q.trim()) {
    if (currentView === 'recent') await showRecent();
    return;
  }
  setView('recent');
  const results = await search(q, { limit: 12, lexicalOnly: true, evidence: false });
  if (token !== liveToken) return;
  resultsTitle.textContent = 'Matches';
  renderCards(results);
}

let searchDebounce = 0;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runLiveSearch(searchInput.value), 220);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runRecall(searchInput.value); }
  else if (e.key === 'Escape') { searchInput.value = ''; showRecent(); }
});
recallBtn.addEventListener('click', () => runRecall(searchInput.value));

// ---------- detail ----------

async function openDetail(m) {
  currentMemoryId = m.id;
  detailMeta.innerHTML = '';
  const fav = faviconHtml(m);
  if (fav) detailMeta.appendChild(fav);
  detailMeta.insertAdjacentHTML('beforeend', `
    <span>${escHtml(sourceLabel(m))}</span>
    <span class="dot-sep">·</span>
    <span>${escHtml(timeAgo(m.createdAt))}</span>
    ${m.author ? `<span class="dot-sep">·</span><span>${escHtml(m.author)}</span>` : ''}`);

  detailTitle.textContent = m.title;
  detailTags.innerHTML = (m.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
  detailSummary.textContent = m.summary || '—';
  detailFacts.innerHTML = (m.keyFacts || []).map((f) => `<li>${escHtml(f)}</li>`).join('') || '<li>—</li>';

  if (m.selection) {
    detailSelectionSection.style.display = '';
    detailSelection.textContent = m.selection;
  } else {
    detailSelectionSection.style.display = 'none';
  }

  const isTitleOnly = !!m.lightweight || !m.summary || m.summary === m.title;
  const isFetchable = /^https?:/i.test(m.url || '') && !['gmail', 'calendar', 'classroom', 'youtube', 'reminder'].includes(m.sourceKind);
  detailDeepen.hidden = !(isTitleOnly && isFetchable);
  detailDeepenHint.hidden = detailDeepen.hidden;
  detailDeepen.disabled = false;
  detailDeepen.textContent = 'Deepen this';

  const href = safeHref(m.url);
  if (href) {
    detailLink.href = href;
    detailLink.hidden = false;
  } else {
    // Notes, reminders and imported records have no navigable original.
    detailLink.removeAttribute('href');
    detailLink.hidden = true;
  }

  overlay.classList.remove('hidden');
  detailClose.focus();

  // Session and related links load after the overlay is up so opening stays
  // instant.
  detailEpisodeSection.classList.add('hidden');
  detailRelatedSection.classList.add('hidden');
  if (m.episodeId) {
    const ep = await store.episodeGet(m.episodeId);
    if (ep) {
      detailEpisode.textContent = `${ep.title} · ${ep.count} items`;
      detailEpisode.onclick = () => { overlay.classList.add('hidden'); openEpisode(ep.id); };
      detailEpisodeSection.classList.remove('hidden');
    }
  }
  try {
    const rel = await relatedTo(m.id, { limit: 4 });
    if (rel.length) {
      detailRelated.innerHTML = '';
      for (const r of rel) {
        const b = document.createElement('button');
        b.className = 'related-item';
        b.textContent = r.memory.title;
        b.addEventListener('click', () => openDetail(r.memory));
        detailRelated.appendChild(b);
      }
      detailRelatedSection.classList.remove('hidden');
    }
  } catch { /* related is a bonus */ }
}

detailDeepen?.addEventListener('click', async () => {
  if (!currentMemoryId) return;
  if (!inExtension || !chrome.runtime?.sendMessage) {
    toast('Deepening only works in the installed extension.', 'err');
    return;
  }
  detailDeepen.disabled = true;
  detailDeepen.textContent = 'Fetching page…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'deepen-memory', id: currentMemoryId });
    if (!res?.ok) throw new Error(res?.error || 'Deepen failed');
    invalidateCaches();
    toast('Deepened — now summarized from the full page.', 'ok');
    openDetail(res.memory);
    showRecent();
  } catch (e) {
    detailDeepen.disabled = false;
    detailDeepen.textContent = 'Deepen this';
    toast(e.message || 'Could not deepen.', 'err');
  }
});

detailClose.addEventListener('click', () => overlay.classList.add('hidden'));
overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) overlay.classList.add('hidden');
});
detailDelete.addEventListener('click', async () => {
  if (!currentMemoryId) return;
  if (!confirm('Forget this memory?')) return;
  const id = currentMemoryId;
  if (inExtension && chrome.runtime?.sendMessage) {
    const res = await mutate({ type: 'forget-memory', id });
    if (!res?.ok) { toast(res?.error || 'Could not forget that memory.', 'err'); return; }
  } else {
    await store.remove(id);
    invalidateCaches();
  }
  overlay.classList.add('hidden');
  currentMemoryId = null;
  setView(currentView);
});

// ---------- provider / onboarding ----------

async function refreshHeroProvider() {
  try {
    const provider = await ai.effectiveProvider();
    heroProviderName.textContent = ai.PROVIDER[provider]?.name || provider;
    heroProvider.hidden = false;
  } catch {
    heroProvider.hidden = true;
  }
}

heroProviderSwitch?.addEventListener('click', (e) => { e.preventDefault(); goOptions(); });
openOptions.addEventListener('click', (e) => { e.preventDefault(); goOptions(); });
readyOpenSettings?.addEventListener('click', (e) => { e.preventDefault(); goOptions(); });
scanOpenSettings?.addEventListener('click', (e) => { e.preventDefault(); goOptions(); });

async function showOnboarding() {
  paneKey.hidden = true;
  paneScan.hidden = true;
  paneReady.hidden = true;
  paneInstall.hidden = true;

  const [openaiKey, geminiKey, legacy, firstScanCompleted, provider] = await Promise.all([
    getSetting('openaiKey'), getSetting('geminiKey'), getSetting('apiKey'),
    getSetting('firstScanCompleted'), ai.currentProvider(),
  ]);
  const usable = !!(openaiKey || geminiKey || legacy) || provider === 'local';

  if (!inExtension) paneInstall.hidden = false;
  else if (!usable) { paneKey.hidden = false; await syncProviderUI(); }
  else if (!firstScanCompleted) paneScan.hidden = false;
  else paneReady.hidden = false;
  onboardEl.classList.remove('hidden');
}

async function syncProviderUI() {
  const provider = (await ai.currentProvider()) || 'gemini';
  for (const b of providerSegment.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b.dataset.provider === provider);
  }
  const meta = ai.PROVIDER[provider];
  const isLocal = provider === 'local';
  onboardKeyForm.classList.toggle('hidden', isLocal);
  onboardLocal.classList.toggle('hidden', !isLocal);
  onboardGetKey.parentElement.style.display = isLocal ? 'none' : '';
  if (!isLocal) {
    onboardKeyInput.placeholder = meta.placeholder;
    onboardGetKey.href = meta.getKeyUrl;
    setOnboardStatus(meta.cost);
  } else {
    setOnboardStatus(meta.cost);
    await refreshLocalState();
  }
}

async function refreshLocalState() {
  const st = await local.status();
  localEnable.hidden = true;
  localDownload.hidden = true;
  if (!st.supported) {
    localState.textContent = "This browser doesn't have built-in AI. It needs Chrome 138 or later on desktop. Pick Gemini or OpenAI instead — Gemini's free tier is enough for personal use.";
    return;
  }
  if (st.ready) {
    localState.textContent = 'Built-in AI is ready. mem will summarize and answer entirely on this device — no key, no network, no quota. Semantic search is text-based in this mode, which is weaker than a cloud embedding but works offline.';
    localEnable.hidden = false;
    return;
  }
  if (st.needsDownload) {
    localState.textContent = 'Chrome can run the model on this device, but it needs downloading first (about 2GB, once).';
    localDownload.hidden = false;
    return;
  }
  localState.textContent = 'Built-in AI is not available on this device. Pick Gemini or OpenAI instead.';
}

localDownload?.addEventListener('click', async () => {
  localDownload.disabled = true;
  localProgress.classList.remove('hidden');
  try {
    await local.prepare({
      onProgress: ({ loaded, total }) => {
        localBar.style.width = `${Math.round((loaded / (total || 1)) * 100)}%`;
      },
    });
    await refreshLocalState();
  } catch (e) {
    localState.textContent = e.message;
  } finally {
    localDownload.disabled = false;
    localProgress.classList.add('hidden');
  }
});

localEnable?.addEventListener('click', async () => {
  await ai.switchProvider('local');
  await setSetting('firstScanCompleted', await getSetting('firstScanCompleted'));
  toast('On-device AI enabled. Nothing leaves this machine.', 'ok');
  await refreshHeroProvider();
  await showOnboarding();
});

providerSegment?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  await ai.switchProvider(btn.dataset.provider);
  await syncProviderUI();
  await refreshHeroProvider();
});

function setOnboardStatus(msg, kind = '') {
  onboardKeyStatus.textContent = msg;
  onboardKeyStatus.className = 'onboard-status' + (kind ? ' ' + kind : '');
}

onboardKeyForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = onboardKeyInput.value.trim();
  const provider = (await ai.currentProvider()) || 'gemini';
  const meta = ai.PROVIDER[provider];
  if (!key) { setOnboardStatus('Paste a key first.', 'err'); return; }
  if (!key.startsWith(meta.keyPrefix)) {
    setOnboardStatus(`That doesn't look like a ${meta.name} key — it should start with ${meta.keyPrefix}.`, 'err');
    return;
  }
  onboardKeySave.disabled = true;
  setOnboardStatus('Saving and testing…');
  try {
    await setSetting(provider === 'openai' ? 'openaiKey' : 'geminiKey', key);
    await ai.testKey({ provider, key });
    setOnboardStatus('Connected.', 'ok');
    toast(`${meta.name} connected.`, 'ok');
    onboardKeyInput.value = '';
    await refreshHeroProvider();
    setTimeout(showOnboarding, 700);
  } catch (err) {
    await removeSetting(provider === 'openai' ? 'openaiKey' : 'geminiKey');
    setOnboardStatus(err.message.replace(/^(OpenAI|Gemini)[^:]*:\s*/, ''), 'err');
  } finally {
    onboardKeySave.disabled = false;
  }
});

// ---------- suggestions ----------

async function renderSuggestions() {
  const items = await store.recent(200);
  suggestions.innerHTML = '';

  if (items.length === 0) {
    for (const ex of ['What was I just doing?', 'What did I read this week?', 'Summarize everything I learned today']) {
      addSuggestion(ex);
    }
    return;
  }

  const byKind = new Map();
  const tagCounts = new Map();
  for (const m of items) {
    byKind.set(m.sourceKind || 'web', (byKind.get(m.sourceKind || 'web') || 0) + 1);
    for (const t of (m.tags || [])) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .filter(([t]) => t.length > 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

  const candidates = ['Give me a daily summary', 'What was I just doing?'];
  if (byKind.get('classroom')) candidates.push('What assignments are due?');
  if (byKind.get('history') || byKind.get('web')) candidates.push('What did I read this week?');
  if (byKind.get('gmail')) candidates.push('Any important emails I should reply to?');
  if (byKind.get('calendar')) candidates.push("What's on my calendar today?");
  if (byKind.get('youtube')) candidates.push('What videos have I liked recently?');
  if (byKind.get('drive')) candidates.push('What did I write in my Drive recently?');
  for (const t of topTags) candidates.push(`What did I learn about ${t}?`);

  const seen = new Set();
  let n = 0;
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    addSuggestion(c);
    if (++n >= 5) break;
  }
}

function addSuggestion(text) {
  const el = document.createElement('button');
  el.className = 'suggestion';
  el.textContent = text;
  el.addEventListener('click', () => { searchInput.value = text; runRecall(text); });
  suggestions.appendChild(el);
}

// ---------- scan progress ----------

const SCAN_SOURCE_LABELS = {
  history: 'Browser history', bookmarks: 'Bookmarks', drive: 'Google Drive',
  gmail: 'Gmail', youtube: 'YouTube', calendar: 'Calendar', classroom: 'Google Classroom',
};

scanOptions?.addEventListener('change', () => {
  const googleChecked = scanOptions.querySelectorAll('.google input:checked').length > 0;
  scanGoogleNote.classList.toggle('hidden', !googleChecked);
});

scanStart?.addEventListener('click', async () => {
  const checked = [...scanOptions.querySelectorAll('input:checked')].map((i) => i.dataset.source);
  if (checked.length === 0) { toast('Pick at least one source to index.', 'err'); return; }
  if (!inExtension || !chrome.runtime?.sendMessage) { toast('Indexing only runs in the installed extension.', 'err'); return; }
  scanStart.disabled = true;
  scanOptions.querySelectorAll('input').forEach((i) => { i.disabled = true; });
  scanProgress.classList.remove('hidden');
  renderScanRows(checked.map((id) => ({ id, label: SCAN_SOURCE_LABELS[id], status: 'pending' })), { added: 0, errors: 0 }, true);
  const res = await chrome.runtime.sendMessage({ type: 'scan-start', sources: checked });
  if (!res?.ok) {
    toast(res?.error || 'Could not start scan.', 'err');
    scanStart.disabled = false;
    scanOptions.querySelectorAll('input').forEach((i) => { i.disabled = false; });
  }
});

scanSkip?.addEventListener('click', async () => {
  await setSetting('firstScanCompleted', true);
  await showOnboarding();
  toast('Skipped. You can index later from Settings.', 'ok');
});

function renderScanRows(sources, totals, running) {
  scanRows.innerHTML = '';
  for (const s of sources) {
    const row = document.createElement('div');
    row.className = `scan-row ${s.status}`;
    const countText = s.status === 'done' ? `${s.added || 0} indexed`
      : s.status === 'running' ? (typeof s.done === 'number' && typeof s.total === 'number' ? `${s.done} / ${s.total}` : 'working…')
      : s.status === 'error' ? (s.error?.slice(0, 50) || 'failed') : '';
    row.innerHTML = `<div class="icon"></div><div class="label">${escHtml(s.label || s.id)}</div><div class="count">${escHtml(countText)}</div>`;
    scanRows.appendChild(row);
  }
  scanSummary.textContent = running
    ? 'Indexing — you can close this tab and it keeps running.'
    : `${totals.added.toLocaleString()} things remembered.`;
  scanSummary.className = running ? 'scan-summary' : 'scan-summary done';
}

function applyScanBanner(state) {
  if (!state?.running) {
    scanBanner.classList.add('hidden');
    recallBtn.disabled = false;
    recallBtn.title = '';
    return;
  }
  scanBanner.classList.remove('hidden');
  const inflight = state.sources.find((s) => s.status === 'running');
  const done = state.sources.filter((s) => s.status === 'done').length;
  scanBannerText.textContent = inflight
    ? `Indexing ${inflight.label.toLowerCase()}… ${done} of ${state.sources.length} sources done · ${state.totals.added.toLocaleString()} remembered`
    : `Indexing… ${done} of ${state.sources.length} done · ${state.totals.added.toLocaleString()} remembered`;
  recallBtn.disabled = true;
  recallBtn.title = 'Available when indexing finishes.';
}

if (inExtension && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'index-changed') {
      // The worker mutated the index. Drop our read-only copy so the next
      // query reloads it rather than answering from a stale ordinal table.
      index._reset();
      invalidateCaches();
      return;
    }
    if (msg?.type !== 'scan-progress') return;
    applyScanBanner(msg.state);
    if (!paneScan.hidden) renderScanRows(msg.state.sources, msg.state.totals, msg.state.running);
    if (!msg.state.running && msg.state.finishedAt) {
      invalidateCaches();
      setTimeout(async () => {
        await showOnboarding();
        await showRecent();
        await renderSuggestions();
        await refreshBadges();
      }, 1200);
    }
  });
}

async function pollInitialScan() {
  if (!inExtension || !chrome.runtime?.sendMessage) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'scan-status' });
    if (res?.ok && res.state) applyScanBanner(res.state);
  } catch { /* worker asleep */ }
}

// ---------- demo ----------

const DEMO_MEMORIES = [
  {
    title: 'Perovskite stability under operational stress',
    url: 'https://www.nature.com/articles/perovskite-stability-2024',
    summary: 'Perovskite solar cells reach record efficiency but degrade rapidly under heat, moisture, and UV. New encapsulation strategies and Cs/FA mixed-cation chemistries extend operational lifetime past 1,000 hours.',
    tags: ['perovskite solar cells', 'material stability', 'photovoltaics', 'encapsulation'],
    keyFacts: [
      'Heat above 60°C is the primary degradation driver, not light alone.',
      'Mixed cesium-formamidinium cations suppress ion migration.',
      'Modern encapsulation gets T80 lifetimes past 1,000 hours.',
    ],
    contentType: 'paper', sourceKind: 'web', siteName: 'Nature', author: 'Smith et al.', ageHours: 96,
  },
  {
    title: 'Why spaced repetition beats cramming',
    url: 'https://andymatuschak.org/spaced-repetition',
    summary: 'Spaced repetition reviews material at expanding intervals, exploiting the spacing effect to consolidate memory more durably than massed practice. Anki and SuperMemo automate interval scheduling.',
    tags: ['learning', 'spaced repetition', 'memory', 'study habits'],
    keyFacts: [
      'The spacing effect is among the most robust findings in cognitive science.',
      'Effortful retrieval at intervals activates consolidation.',
      'Difficulty estimation drives interval growth in SM-2 and FSRS.',
    ],
    contentType: 'article', sourceKind: 'web', siteName: 'andymatuschak.org', ageHours: 1,
  },
  {
    title: 'Bio Unit 3 — Cell Respiration (lecture notes)',
    url: 'https://drive.google.com/file/d/demo-bio-unit-3/view',
    summary: 'Glycolysis converts glucose to pyruvate in the cytoplasm; the Krebs cycle in the mitochondrial matrix produces NADH and FADH2; oxidative phosphorylation uses them to drive ATP synthase. Net ATP per glucose is roughly 30-32.',
    tags: ['cell respiration', 'biology', 'mitochondria', 'ATP'],
    keyFacts: [
      'Glycolysis nets 2 ATP and 2 NADH per glucose.',
      'The proton gradient across the inner membrane drives ATP synthase.',
      'Cyanide blocks Complex IV; rotenone blocks Complex I.',
    ],
    contentType: 'reference', sourceKind: 'drive', sourceLabel: 'Doc', siteName: 'Google Drive', author: 'Mr. Patel', ageHours: 2,
  },
  {
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    summary: 'The transformer architecture replaces recurrence and convolutions with self-attention, enabling massive parallelism and capturing long-range dependencies. Multi-head attention lets the model attend to multiple subspaces at once.',
    tags: ['transformers', 'self-attention', 'deep learning', 'language models'],
    keyFacts: [
      'Self-attention scales quadratically with sequence length.',
      'Positional encodings inject order information.',
      'Multi-head attention captures different relational patterns in parallel.',
    ],
    contentType: 'paper', sourceKind: 'web', siteName: 'arxiv.org', author: 'Vaswani et al.', ageHours: 6,
  },
  {
    title: 'Re: project meeting Thursday 3pm',
    url: 'https://mail.google.com/mail/u/0/#inbox/demo-thread',
    summary: 'Jamie Chen confirmed the project meeting moves to Thursday at 3pm in the Bio lab, and asked you to bring your unit 3 notes plus the cell respiration model.',
    tags: ['project', 'meeting', 'biology'],
    keyFacts: ['Thursday 3pm, Bio lab.', 'Bring unit 3 notes and the respiration model.'],
    contentType: 'discussion', sourceKind: 'gmail', sourceLabel: 'Email', siteName: 'Gmail', author: 'Jamie Chen', ageHours: 4,
  },
];

async function seedDemo() {
  // Writes to the index, so it belongs to the worker when there is one.
  if (inExtension && chrome.runtime?.sendMessage) {
    const res = await mutate({ type: 'seed-demo', memories: DEMO_MEMORIES });
    toast(res?.ok ? `${res.added} demo memories loaded.` : (res?.error || 'Could not load the demo.'), res?.ok ? 'ok' : 'err');
    onboardEl.classList.add('hidden');
    await showRecent();
    await renderSuggestions();
    return;
  }
  const now = Date.now();
  let added = 0;
  for (const d of DEMO_MEMORIES) {
    const id = await store.urlId(d.url);
    if (await store.get(id)) continue;
    const createdAt = now - Math.round(d.ageHours * 3600 * 1000);
    const body = [d.summary, ...(d.keyFacts || [])].join('\n\n');
    const memory = {
      id, url: d.url, title: d.title,
      excerpt: d.summary.slice(0, 200), text: body, selection: '',
      favicon: '', author: d.author || '', siteName: d.siteName || '', publishedAt: '',
      summary: d.summary, tags: d.tags, keyFacts: d.keyFacts, contentType: d.contentType,
      sourceKind: d.sourceKind, sourceLabel: d.sourceLabel || '', mime: '', extra: null,
      createdAt, updatedAt: createdAt,
    };
    await store.put(memory);
    // Embed through the normal path so the demo exercises real retrieval
    // rather than the random vectors the old demo used, which made every
    // similarity score meaningless.
    let vec = null, space = null;
    try {
      const res = await ai.embedOne([d.title, d.summary, d.tags.join(', '), body].join('\n\n'));
      vec = res.vector; space = res.space;
    } catch { /* lexical-only demo is still a working demo */ }
    await index.addDoc({
      id, vec, space, createdAt,
      chunks: vec ? [{ text: body, start: 0, vec }] : [],
      tokensText: [d.title, d.summary, d.tags.join(' '), body].join('\n'),
    });
    added++;
  }
  await index.flush();
  invalidateCaches();
  toast(added > 0 ? `${added} demo memories loaded.` : 'Demo already loaded.', 'ok');
  onboardEl.classList.add('hidden');
  await showRecent();
  await renderSuggestions();
}

onboardDemo?.addEventListener('click', (e) => { e.preventDefault(); seedDemo(); });
readyDemo?.addEventListener('click', (e) => { e.preventDefault(); seedDemo(); });
installDemo?.addEventListener('click', (e) => { e.preventDefault(); seedDemo(); });

// ---------- drag & drop ----------

let dragDepth = 0;
const isFileDrag = (e) => {
  const t = e.dataTransfer?.types;
  return t && (t.includes ? t.includes('Files') : Array.from(t).includes('Files'));
};

document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('active');
});
document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('active');
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('active');
  const files = e.dataTransfer?.files;
  if (files?.length) await ingestDroppedFiles(files);
});

async function ingestDroppedFiles(files) {
  toast(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  try {
    const { results, errors, exportFiles } = await ingestFiles(files);
    for (const f of exportFiles) {
      try {
        // Import rewrites the whole index, so the worker performs it.
        if (inExtension && chrome.runtime?.sendMessage) {
          const res = await mutate({ type: 'import-memories', json: await f.text() });
          if (!res?.ok) throw new Error(res?.error || 'Import failed');
          results.push({ ok: true, title: `${res.count} memories restored from export` });
        } else {
          const n = await store.importAll(await f.text());
          results.push({ ok: true, title: `${n} memories restored from export` });
        }
      } catch (e2) { errors.push({ name: f.name, error: e2.message }); }
    }
    const okCount = results.filter((r) => r.ok).length;
    const errCount = (results.length - okCount) + errors.length;
    let msg = okCount > 0 ? `${okCount} added to memory` : 'No memories added.';
    if (errCount > 0) msg += ` · ${errCount} failed`;
    toast(msg, errCount === 0 ? 'ok' : (okCount > 0 ? '' : 'err'));
    invalidateCaches();
    onboardEl.classList.add('hidden');
    await showRecent();
    await renderSuggestions();
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

window.addEventListener('beforeunload', () => tts.stop());

// ---------- init ----------

async function init() {
  try {
    // Standalone only. Inside the extension the worker owns migration —
    // running it from both contexts raced two full index rebuilds against
    // each other, and each one starts by clearing shards and postings.
    if (!inExtension || !chrome.runtime?.sendMessage) {
      await store.migrateIfNeeded();
    }
    await refreshHeroProvider();
    const q = new URL(location.href).searchParams.get('q');
    if (q) {
      searchInput.value = q;
      runRecall(q);
    } else {
      await showRecent();
    }
    await renderSuggestions();
    await refreshBadges();
    pollInitialScan();
    searchInput.focus();
  } catch (e) {
    console.error('[mem] dashboard init failed:', e);
    toast('Something went wrong starting up: ' + e.message, 'err');
  }
}

init();
