// mem — background service worker (Manifest V3, ES module).
//
// Owns everything that has to keep working while no page of mem is open:
// the save pipeline, the first-run scan, background deepening, episode
// stitching, reminder alarms, and the message router that the dashboard,
// popup, ambient content script, and other extensions all talk to.

import * as store from './lib/storage.js';
import * as index from './lib/index.js';
import { ingest } from './lib/ingest.js';
import { driveListAndIngest, driveConnect, driveDisconnect, driveStatus } from './lib/drive.js';
import { extractPageContent } from './lib/extract.js';
import { scanHistory } from './lib/history.js';
import { scanBookmarks } from './lib/bookmarks.js';
import { scanGmail } from './lib/gmail.js';
import { scanYouTube } from './lib/youtube.js';
import { scanCalendar } from './lib/calendar.js';
import { scanClassroom } from './lib/classroom.js';
import { deepenMemory, runDeepenPass, coverage as deepenCoverage, getState as deepenState, setEnabled as setDeepenEnabled } from './lib/deepen.js';
import * as reminders from './lib/reminders.js';
import * as episodes from './lib/episodes.js';
import * as openloops from './lib/openloops.js';
import * as resurface from './lib/resurface.js';
import * as entities from './lib/entities.js';
import { search, relatedTo } from './lib/search.js';
import { getSetting, setSetting } from './lib/env.js';

console.log('[mem] service worker loaded');

self.addEventListener('unhandledrejection', (event) => {
  console.error('[mem] unhandled rejection:', event.reason);
});

// ---------- alarms ----------

const ALARM_DEEPEN = 'mem-deepen';
const ALARM_EPISODES = 'mem-episodes';

/**
 * Create the periodic alarms, but only if they don't already exist.
 *
 * chrome.alarms.create replaces an alarm of the same name and restarts its
 * delay. The service worker wakes on every tab update, and boot() runs at
 * module scope on every wake — so creating unconditionally reset the timer
 * continuously while the user was browsing, and the background work simply
 * never ran.
 */
async function installAlarms() {
  const existing = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  // Deepening is deliberately slow. It exists to raise the share of the
  // corpus that has real content in it, and there is no hurry — spending
  // spare capacity is the point, competing with the user's own queries for
  // rate limit is not.
  if (!existing.has(ALARM_DEEPEN)) {
    await chrome.alarms.create(ALARM_DEEPEN, { delayInMinutes: 3, periodInMinutes: 30 });
  }
  if (!existing.has(ALARM_EPISODES)) {
    await chrome.alarms.create(ALARM_EPISODES, { delayInMinutes: 10, periodInMinutes: 60 });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const reminderId = reminders.reminderIdFromAlarm(alarm.name);
  if (reminderId) {
    await reminders.fireReminder(reminderId);
    return;
  }
  if (alarm.name === ALARM_DEEPEN) {
    if (scanState.running) return; // don't compete with a first-run scan
    try {
      const res = await runDeepenPass({ max: 4 });
      if (res.deepened) console.log(`[mem] background deepen: ${res.deepened} upgraded`);
    } catch (e) {
      console.warn('[mem] deepen pass failed:', e.message);
    }
    return;
  }
  if (alarm.name === ALARM_EPISODES) {
    try { await episodes.assignRecent(); } catch (e) { console.warn('[mem] episode pass failed:', e.message); }
  }
});

// ---------- lifecycle ----------

// boot() is reached from three places — module scope on every worker wake,
// onInstalled, and onStartup — so it memoises. Without this, migration and
// reminder rehydration ran concurrently with themselves.
let bootPromise = null;

function boot() {
  if (!bootPromise) bootPromise = doBoot();
  return bootPromise;
}

async function doBoot() {
  try {
    await store.migrateIfNeeded({
      onProgress: (p) => { if (p.stage === 'index' && p.done) console.log(`[mem] migrating: ${p.done}/${p.total}`); },
    });
  } catch (e) {
    console.error('[mem] migration failed:', e);
  }

  // Repair anything a killed worker left half-indexed — the only thing
  // standing between a crash during a large scan and permanently
  // unsearchable memories.
  //
  // Gated on a cheap count comparison. reconcile() forces a full index load
  // (every shard: ~76MB of Int8 at 50k memories), and boot() runs on every
  // worker wake, which during normal browsing is constant. Comparing the
  // record count against the live ordinal count is one IDB count() and
  // catches every divergence this is meant to repair.
  try {
    const [records, stats] = await Promise.all([store.count(), index.stats()]);
    if (records !== stats.docs) {
      console.log(`[mem] index drift detected (${records} memories, ${stats.docs} indexed) — reconciling`);
      const res = await index.reconcile();
      console.log(`[mem] reconciled: ${res.orphans} re-indexed, ${res.stale} stale ordinals retired`);
    }
  } catch (e) {
    console.warn('[mem] reconcile check failed:', e.message);
  }

  try { await reminders.rehydrate(); } catch (e) { console.warn('[mem] reminder rehydrate failed:', e.message); }
  try { await installAlarms(); } catch (e) { console.warn('[mem] alarm setup failed:', e.message); }
}

chrome.runtime.onStartup.addListener(boot);

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'mem-save-page', title: 'Save this page to mem', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'mem-save-selection', title: 'Save selection to mem', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'mem-remind-selection', title: 'Remind me about this…', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'mem-open-dashboard', title: 'Open mem dashboard', contexts: ['action'] });
  } catch (e) {
    console.error('[mem] context menu setup failed:', e);
  }

  await boot();

  if (details.reason === 'install') {
    const { firstScanCompleted } = await chrome.storage.local.get('firstScanCompleted');
    if (!firstScanCompleted) {
      console.log('[mem] first install — auto-starting history + bookmarks scan');
      runFirstScan(['history', 'bookmarks']);
    }
  }
});

// Also run on worker wake-up, since onStartup only fires on browser launch.
boot();

// ---------- commands ----------

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'save-page') {
    const tab = await activeTab();
    if (tab) saveTab(tab);
  } else if (cmd === 'open-dashboard') {
    openDashboard();
  }
});

// ---------- context menu ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'mem-save-page' && tab) {
    saveTab(tab);
  } else if (info.menuItemId === 'mem-save-selection' && tab) {
    saveTab(tab);
  } else if (info.menuItemId === 'mem-remind-selection' && tab) {
    // The user selected the text themselves, so no per-site opt-in applies.
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'ambient-prompt-selection', text: info.selectionText || '' });
    } catch {
      await setBadge(tab.id, '!', '#ff453a');
    }
  } else if (info.menuItemId === 'mem-open-dashboard') {
    openDashboard();
  }
});

// ---------- external-extension access control ----------
//
// This used to accept anything: externally_connectable listed "*", and every
// bridge handler ran without checking who was calling. Any extension the user
// had installed could read the entire memory store, and write to it. Now the
// manifest still permits the connection — it has to, or an unknown id could
// never ask — but each sender has to be approved once, from Settings.

const EXTERNAL_ALLOW_KEY = 'externalAllowlist';
const EXTERNAL_PENDING_KEY = 'externalPending';

async function isExternalAllowed(id) {
  if (!id) return false;
  const list = (await getSetting(EXTERNAL_ALLOW_KEY)) || [];
  return list.includes(id);
}

async function notePendingExternal(id, name) {
  const pending = (await getSetting(EXTERNAL_PENDING_KEY)) || [];
  if (pending.some((p) => p.id === id)) return;
  pending.push({ id, name: name || '', at: Date.now() });
  await setSetting(EXTERNAL_PENDING_KEY, pending.slice(-20));
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const out = await handleMessage(msg, sender);
      sendResponse(out);
    } catch (e) {
      console.error('[mem] message handler error:', e);
      sendResponse({ ok: false, error: e.message, code: e.code });
    }
  })();
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    // ----- saving -----
    case 'save-active-tab': {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: 'No active tab' };
      return { ok: true, memory: await saveTab(tab) };
    }
    case 'check-saved': {
      const m = await store.getByUrl(msg.url);
      return { ok: true, saved: !!m, memory: m || null };
    }
    case 'open-dashboard':
      openDashboard(msg.query);
      return { ok: true };
    case 'open-options':
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'ingest-files': {
      // Files are read to text in the options page — a service worker can't
      // open a file picker — so we receive parsed payloads here.
      const results = [];
      for (const payload of msg.files || []) {
        try {
          const m = await ingest(payload);
          results.push({ ok: true, id: m.id, title: m.title });
        } catch (e) {
          results.push({ ok: false, error: e.message, title: payload.title });
        }
      }
      return { ok: true, results };
    }

    // ----- Drive -----
    case 'drive-status': return { ok: true, ...(await driveStatus()) };
    case 'drive-connect': return { ok: true, ...(await driveConnect()) };
    case 'drive-disconnect': await driveDisconnect(); return { ok: true };
    case 'drive-sync': return { ok: true, ...(await driveListAndIngest({ limit: msg.limit || 25 })) };

    // ----- deepening -----
    case 'deepen-memory':
      return { ok: true, memory: await deepenMemory(msg.id) };
    case 'deepen-status':
      return { ok: true, coverage: await deepenCoverage(), state: await deepenState() };
    case 'deepen-set-enabled':
      return { ok: true, enabled: await setDeepenEnabled(msg.enabled) };
    case 'deepen-run-now':
      return { ok: true, ...(await runDeepenPass({ max: msg.max || 5 })) };

    // ----- scanning -----
    case 'scan-status':
      return { ok: true, state: scanState };
    case 'scan-start':
      if (scanState.running) return { ok: false, error: 'Scan already in progress.' };
      runFirstScan(msg.sources || ['history', 'bookmarks']);
      return { ok: true, started: true };

    // ----- index (the worker is the only writer; see index.setReadOnly) -----
    case 'index-stats':
      return { ok: true, stats: await index.stats() };
    case 'forget-memory':
      await store.remove(msg.id);
      broadcastIndexChanged();
      return { ok: true };
    case 'import-memories': {
      const count = await store.importAll(msg.json);
      broadcastIndexChanged();
      return { ok: true, count };
    }
    case 'seed-demo': {
      const added = await seedDemo(msg.memories || []);
      broadcastIndexChanged();
      return { ok: true, added };
    }
    case 'index-reconcile':
      return { ok: true, ...(await index.reconcile()) };
    case 'erase-everything':
      await store.clear();
      // Drop the worker's own in-memory table too, or it would be flushed
      // back over the empty stores on the next capture.
      index._reset();
      broadcastIndexChanged();
      return { ok: true };

    // ----- the surfaces that make mem more than a search box -----
    case 'episodes-list':
      return { ok: true, episodes: await episodes.listEpisodes({ limit: msg.limit || 40 }) };
    case 'episode-get':
      return { ok: true, ...(await episodes.getEpisode(msg.id) || {}) };
    case 'episodes-rebuild':
      return { ok: true, ...(await episodes.rebuildEpisodes({ gapMinutes: msg.gapMinutes })) };
    case 'episodes-name':
      return { ok: true, named: await episodes.nameEpisodes(msg.ids || []) };

    case 'openloops-list':
      return { ok: true, loops: stripLoops(await openloops.findOpenLoops({ limit: msg.limit || 25 })) };
    case 'openloops-dismiss':
      await openloops.dismiss(msg.id);
      return { ok: true };

    case 'resurface-due':
      return { ok: true, items: await resurface.dueForResurface({ limit: msg.limit || 6 }) };
    case 'resurface-mark':
      return { ok: true, marked: await resurface.markResurfaced(msg.ids || []) };
    case 'connections-find':
      return { ok: true, connections: await resurface.findConnections({ limit: msg.limit || 8 }) };

    case 'entities-top':
      return { ok: true, entities: await entities.topEntities({ kind: msg.kind, limit: msg.limit || 40 }) };
    case 'entity-timeline':
      return { ok: true, ...(await entities.entityTimeline(msg.id) || {}) };
    case 'entities-rebuild':
      return { ok: true, ...(await entities.rebuildAll()) };

    case 'related-to':
      return { ok: true, related: await relatedTo(msg.id, { limit: msg.limit || 5 }) };

    // ----- reminders -----
    case 'reminders-list':
      return { ok: true, reminders: await reminders.listReminders({ includeFired: !!msg.includeFired }) };
    case 'create-reminder': {
      const r = await reminders.createReminder({
        what: msg.what,
        at: msg.at,
        snippet: msg.snippet,
        sourceUrl: msg.sourceUrl,
        sourceTitle: msg.sourceTitle,
        origin: msg.origin,
      });
      return { ok: true, reminder: r };
    }
    case 'reminder-cancel':
      return { ok: true, cancelled: await reminders.cancelReminder(msg.id) };
    case 'reminder-snooze':
      return { ok: true, reminder: await reminders.snoozeReminder(msg.id, msg.ms) };

    // ----- ambient content script -----
    case 'ambient-config': {
      const [related, engagement, watchList, declined] = await Promise.all([
        getSetting('ambientRelated'),
        getSetting('ambientEngagement'),
        getSetting('commitmentOrigins'),
        getSetting('commitmentDeclined'),
      ]);
      const watching = Array.isArray(watchList) && watchList.includes(msg.origin);
      return {
        ok: true,
        config: {
          related: related === undefined ? true : !!related,
          engagement: engagement === undefined ? true : !!engagement,
          // Watching a conversation is opt-in per site and off by default.
          commitments: watching,
          // Whether to offer. Off once the user has either accepted or
          // explicitly declined this site — being asked twice is worse than
          // never being asked.
          offerWatch: !watching && !(Array.isArray(declined) && declined.includes(msg.origin)),
        },
      };
    }
    case 'commitment-watch-decline': {
      const list = (await getSetting('commitmentDeclined')) || [];
      await setSetting('commitmentDeclined', [...new Set([...list, msg.origin])]);
      return { ok: true };
    }
    case 'ambient-related': {
      // Lexical-only, so noticing a related memory costs no API call and no
      // page content leaves the tab — just the title.
      const hits = await search(msg.title, { limit: 4, lexicalOnly: true, evidence: false, diversify: true });
      const items = hits
        .filter((h) => h.memory && h.memory.url !== msg.url && h.lexical > 0.12)
        .slice(0, 3)
        .map((h) => ({
          id: h.memory.id,
          title: h.memory.title,
          url: h.memory.url,
          summary: (h.memory.summary || '').slice(0, 120),
          when: relativeDay(h.memory.createdAt),
        }));
      return { ok: true, items };
    }
    case 'ambient-engagement': {
      // Two numbers on an existing record. Creates nothing — if the page was
      // never saved there is nothing to annotate.
      const m = await store.getByUrl(msg.url);
      if (!m) return { ok: true, stored: false };
      m.extra = { ...(m.extra || {}), dwellMs: Math.round(msg.dwellMs), scrollPct: msg.scrollPct };
      await store.put(m);
      return { ok: true, stored: true };
    }
    case 'commitment-watch-set': {
      const list = (await getSetting('commitmentOrigins')) || [];
      const next = msg.enabled
        ? [...new Set([...list, msg.origin])]
        : list.filter((o) => o !== msg.origin);
      await setSetting('commitmentOrigins', next);
      return { ok: true, origins: next };
    }

    // ----- external access control (asked by the options page) -----
    case 'external-list':
      return {
        ok: true,
        allowed: (await getSetting(EXTERNAL_ALLOW_KEY)) || [],
        pending: (await getSetting(EXTERNAL_PENDING_KEY)) || [],
      };
    case 'external-approve': {
      const list = (await getSetting(EXTERNAL_ALLOW_KEY)) || [];
      await setSetting(EXTERNAL_ALLOW_KEY, [...new Set([...list, msg.id])]);
      const pending = ((await getSetting(EXTERNAL_PENDING_KEY)) || []).filter((p) => p.id !== msg.id);
      await setSetting(EXTERNAL_PENDING_KEY, pending);
      return { ok: true };
    }
    case 'external-revoke': {
      const list = (await getSetting(EXTERNAL_ALLOW_KEY)) || [];
      await setSetting(EXTERNAL_ALLOW_KEY, list.filter((x) => x !== msg.id));
      return { ok: true };
    }

    // ----- LifeOS page bridge (same-origin content script) -----
    case 'bridge-list-memories':
    case 'bridge-search-memories':
    case 'bridge-save-memory':
    case 'bridge-delete-memory':
      return bridgeHandler(msg);

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/**
 * Tell open pages the index changed so they drop their cached copy. They read
 * the index directly for speed; without this they would keep answering from a
 * stale ordinal table until reloaded.
 */
function broadcastIndexChanged() {
  chrome.runtime.sendMessage({ type: 'index-changed' }).catch(() => {});
}

// Auto-capture writes constantly, and a dashboard left open would otherwise
// answer "nothing matches that" for pages captured minutes ago. Debounced so
// a burst of captures produces one broadcast rather than dozens.
let captureBroadcastTimer = null;
function broadcastIndexChangedSoon() {
  if (captureBroadcastTimer) return;
  captureBroadcastTimer = setTimeout(() => {
    captureBroadcastTimer = null;
    broadcastIndexChanged();
  }, 3000);
}

/**
 * Seed demo memories. Lives here rather than in the dashboard because it
 * writes to the index, and only the worker may do that.
 */
async function seedDemo(demos) {
  const now = Date.now();
  let added = 0;
  for (const d of demos) {
    const id = await store.urlId(d.url);
    if (await store.get(id)) continue;
    const createdAt = now - Math.round((d.ageHours || 1) * 3600 * 1000);
    const body = [d.summary, ...(d.keyFacts || [])].join('\n\n');
    await store.put({
      id, url: d.url, title: d.title,
      excerpt: (d.summary || '').slice(0, 200), text: body, selection: '',
      favicon: '', author: d.author || '', siteName: d.siteName || '', publishedAt: '',
      summary: d.summary, tags: d.tags || [], keyFacts: d.keyFacts || [],
      contentType: d.contentType || 'article',
      sourceKind: d.sourceKind || 'web', sourceLabel: d.sourceLabel || '',
      mime: '', extra: null, createdAt, updatedAt: createdAt,
    });
    // Embed through the normal path so the demo exercises real retrieval
    // rather than random vectors.
    let vec = null;
    let space = null;
    try {
      const res = await aiEmbedOne([d.title, d.summary, (d.tags || []).join(', '), body].join('\n\n'));
      vec = res.vector;
      space = res.space;
    } catch { /* lexical-only is still a working demo */ }
    await index.addDoc({
      id, vec, space, createdAt,
      chunks: vec ? [{ text: body, start: 0, vec }] : [],
      tokensText: [d.title, d.summary, (d.tags || []).join(' '), body].filter(Boolean).join('\n'),
    });
    added++;
  }
  await index.flush();
  return added;
}

async function aiEmbedOne(text) {
  const ai = await import('./lib/ai.js');
  return ai.embedOne(text);
}

/** Open loops carry full memory records; the UI only needs a summary. */
function stripLoops(loops) {
  return loops.map((l) => ({
    id: l.id, kind: l.kind, label: l.label, reason: l.reason,
    urgency: l.urgency, dueAt: l.dueAt,
    memory: {
      id: l.memory.id, title: l.memory.title, url: l.memory.url,
      siteName: l.memory.siteName, sourceKind: l.memory.sourceKind,
      createdAt: l.memory.createdAt, favicon: l.memory.favicon,
    },
  }));
}

function relativeDay(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// ---------- bridge handlers ----------

async function bridgeHandler(msg) {
  if (msg.type === 'bridge-list-memories') {
    const limit = Math.min(500, Math.max(1, Number(msg.limit) || 200));
    return { ok: true, data: (await store.recent(limit)).map(toLifeOSShape) };
  }
  if (msg.type === 'bridge-search-memories') {
    const limit = Math.min(200, Math.max(1, Number(msg.limit) || 50));
    const q = String(msg.q || '').trim();
    if (!q) return { ok: true, data: (await store.recent(limit)).map(toLifeOSShape) };
    // Uses the real index rather than a substring scan over the 500 most
    // recent records, so bridged search matches what mem's own search finds.
    const hits = await search(q, { limit, lexicalOnly: true, evidence: false });
    return { ok: true, data: hits.map((h) => toLifeOSShape(h.memory)) };
  }
  if (msg.type === 'bridge-save-memory') {
    const title = String(msg.title || '').slice(0, 300);
    const url = String(msg.url || '').slice(0, 2000);
    if (!title && !url) return { ok: false, error: 'title or url required' };
    const body = String(msg.summary || msg.text || title || '');

    // Routed through the real pipeline when there's enough text, so a bridged
    // memory is chunked, embedded and indexed like any other. The old path
    // wrote a bare record with mismatched field names and no vector, which
    // made bridged memories invisible to semantic search.
    if (body.trim().length >= 40) {
      const m = await ingest({
        url: url || `mem-note://${Date.now()}`,
        title: title || url,
        text: body,
        excerpt: body.slice(0, 240),
        sourceKind: url ? 'web' : 'note',
        sourceLabel: 'LifeOS',
        siteName: 'LifeOS',
      });
      return { ok: true, data: toLifeOSShape(m) };
    }

    const id = url ? await store.urlId(url) : `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const memory = {
      id, url, title: title || url,
      summary: body, text: body, excerpt: body.slice(0, 240),
      tags: (msg.tags || []).filter(Boolean).slice(0, 16),
      keyFacts: [], contentType: 'other',
      sourceKind: url ? 'web' : 'note', sourceLabel: 'LifeOS', siteName: 'LifeOS',
      selection: '', favicon: '', author: '', publishedAt: '', mime: '', extra: null,
      createdAt: now, updatedAt: now, lightweight: true,
    };
    await store.put(memory);
    await index.addDoc({
      id, vec: null, space: null, createdAt: now, chunks: [],
      tokensText: [memory.title, body, (memory.tags || []).join(' ')].filter(Boolean).join('\n'),
    });
    await index.flush();
    return { ok: true, data: toLifeOSShape(memory) };
  }
  if (msg.type === 'bridge-delete-memory') {
    const id = String(msg.id || '');
    if (!id) return { ok: false, error: 'id required' };
    await store.remove(id);
    return { ok: true, data: { id } };
  }
  return { ok: false, error: 'unknown bridge message' };
}

// ---------- cross-extension bridge ----------

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!(await isExternalAllowed(sender.id))) {
        await notePendingExternal(sender.id, msg?.appName);
        sendResponse({
          ok: false,
          code: 'NOT_AUTHORIZED',
          error: 'This extension is not authorized to access mem. Approve it in mem Settings → Connected extensions.',
        });
        return;
      }
      sendResponse(await bridgeHandler(msg));
    } catch (e) {
      console.error('[mem] external message error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ---------- web page save ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Focus an existing dashboard tab instead of piling up a new one every time
 * the shortcut is pressed.
 */
async function openDashboard(query) {
  const base = chrome.runtime.getURL('dashboard.html');
  const url = query ? `${base}?q=${encodeURIComponent(query)}` : base;
  try {
    const tabs = await chrome.tabs.query({ url: base + '*' });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true, ...(query ? { url } : {}) });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch { /* fall through to creating one */ }
  chrome.tabs.create({ url });
}

function isCapturable(url) {
  if (!url) return false;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') || url.startsWith('about:') ||
      url.startsWith('file://')) return false;
  return true;
}

async function setBadge(tabId, text, color = '#888') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color, tabId });
    await chrome.action.setBadgeText({ text, tabId });
    if (text) {
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 2500);
    }
  } catch { /* tab may have closed */ }
}

async function saveTab(tab) {
  if (!isCapturable(tab.url)) {
    throw new Error('This page cannot be captured (browser internal page).');
  }
  await setBadge(tab.id, '…', '#888');
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });
    const extracted = results?.[0]?.result;
    if (!extracted) throw new Error('Failed to extract page content.');

    const memory = await ingest({
      ...extracted,
      sourceKind: 'web',
      sourceLabel: extracted.siteName || '',
    });
    await setBadge(tab.id, '✓', '#30d158');
    // Keep the newest episode current without waiting for the hourly pass.
    episodes.assignRecent().catch(() => {});
    // Tell any open dashboard its read-only copy of the index is behind.
    broadcastIndexChangedSoon();
    return memory;
  } catch (e) {
    await setBadge(tab.id, '!', '#ff453a');
    throw e;
  }
}

// ---------- first-install scan ----------

let scanState = { running: false, sources: [], totals: { added: 0, errors: 0 }, startedAt: 0, finishedAt: 0 };

function broadcastScan() {
  chrome.runtime.sendMessage({ type: 'scan-progress', state: scanState }).catch(() => {});
}

const SCAN_RUNNERS = {
  history: ({ onProgress }) => scanHistory({ days: 180, max: 5000, onProgress }),
  bookmarks: ({ onProgress }) => scanBookmarks({ onProgress }),
  drive: () => driveListAndIngest({ limit: 200 }).then((r) => ({ added: r.imported, skipped: r.skipped })),
  gmail: ({ onProgress }) => scanGmail({ limit: 500, onProgress }),
  youtube: ({ onProgress }) => scanYouTube({ limit: 1500, onProgress }),
  calendar: ({ onProgress }) => scanCalendar({ pastDays: 180, futureDays: 30, limit: 1000, onProgress }),
  classroom: ({ onProgress }) => scanClassroom({ onProgress }),
};

const SOURCE_LABELS = {
  history: 'Browser history',
  bookmarks: 'Bookmarks',
  drive: 'Google Drive',
  gmail: 'Gmail',
  youtube: 'YouTube',
  calendar: 'Calendar',
  classroom: 'Google Classroom',
};

async function runFirstScan(sourceIds) {
  scanState = {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    sources: sourceIds.map((id) => ({ id, label: SOURCE_LABELS[id] || id, status: 'pending', stage: '', added: 0, error: '' })),
    totals: { added: 0, errors: 0 },
  };
  broadcastScan();

  await Promise.all(scanState.sources.map(async (slot) => {
    if (!SCAN_RUNNERS[slot.id]) {
      slot.status = 'error';
      slot.error = `Unknown source: ${slot.id}`;
      scanState.totals.errors++;
      broadcastScan();
      return;
    }
    slot.status = 'running';
    broadcastScan();
    try {
      const result = await SCAN_RUNNERS[slot.id]({
        onProgress: (p) => {
          slot.stage = p.stage || '';
          if (typeof p.total === 'number') slot.total = p.total;
          if (typeof p.done === 'number') slot.done = p.done;
          broadcastScan();
        },
      });
      slot.status = 'done';
      slot.added = result?.added || 0;
      scanState.totals.added += slot.added;
    } catch (e) {
      slot.status = 'error';
      slot.error = e.message;
      scanState.totals.errors++;
      console.error(`[mem] scan ${slot.id} failed:`, e);
    }
    broadcastScan();
  }));

  scanState.running = false;
  scanState.finishedAt = Date.now();
  await chrome.storage.local.set({ firstScanCompleted: true, firstScanFinishedAt: Date.now() });
  broadcastScan();

  // A fresh corpus has no episodes or entity graph until they're built, and
  // both are local and free, so there's no reason to make the user ask.
  try { await episodes.rebuildEpisodes(); } catch (e) { console.warn('[mem] episode build failed:', e.message); }
  try { await entities.rebuildAll(); } catch (e) { console.warn('[mem] entity build failed:', e.message); }
  broadcastScan();
}

// ---------- auto-capture ----------
//
// A single sequential queue with a minimum gap. When many tabs finish loading
// at once, captures are processed one at a time so auto-capture can't torch
// the provider's per-minute quota during heavy browsing.

const recentlyCaptured = new Map();
const captureQueue = [];
let captureWorking = false;
const CAPTURE_MIN_GAP_MS = 2500;
let lastCaptureAt = 0;

async function captureWorker() {
  if (captureWorking) return;
  captureWorking = true;
  while (captureQueue.length > 0) {
    const tab = captureQueue.shift();
    let stillThere = null;
    try { stillThere = await chrome.tabs.get(tab.id); } catch { /* closed */ }
    if (!stillThere || !isCapturable(stillThere.url)) continue;

    const gap = Date.now() - lastCaptureAt;
    if (gap < CAPTURE_MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, CAPTURE_MIN_GAP_MS - gap));
    }
    try {
      await saveTab(stillThere);
    } catch (e) {
      console.warn('[mem] auto-capture failed:', e.message);
    }
    lastCaptureAt = Date.now();
  }
  captureWorking = false;
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== 'complete') return;
  if (!tab.url || !isCapturable(tab.url)) return;

  const { autoCapture, blocklist } = await chrome.storage.local.get(['autoCapture', 'blocklist']);
  if (!autoCapture) return;

  const blocked = (blocklist || []).some((d) => {
    try { return new URL(tab.url).hostname.endsWith(d.trim()); } catch { return false; }
  });
  if (blocked) return;

  const last = recentlyCaptured.get(tab.url);
  if (last && Date.now() - last < 10 * 60 * 1000) return;
  recentlyCaptured.set(tab.url, Date.now());
  if (recentlyCaptured.size > 500) {
    // Bounded: drop the oldest half rather than growing without limit.
    const entries = [...recentlyCaptured.entries()].sort((a, b) => b[1] - a[1]);
    recentlyCaptured.clear();
    for (const [k, v] of entries.slice(0, 250)) recentlyCaptured.set(k, v);
  }

  captureQueue.push(tab);
  captureWorker();
});

// ---------- notification clicks ----------

chrome.notifications?.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('mem-rem-')) return;
  const id = notificationId.slice('mem-rem-'.length);
  const list = await reminders.listReminders({ includeFired: true });
  const r = list.find((x) => x.id === id);
  if (r?.sourceUrl && /^https?:/.test(r.sourceUrl)) {
    chrome.tabs.create({ url: r.sourceUrl });
  } else {
    openDashboard();
  }
  chrome.notifications.clear(notificationId);
});

// ---------- shapes ----------

function toLifeOSShape(m) {
  return {
    id: m.id,
    title: m.title || m.url || 'Untitled',
    url: m.url || '',
    summary: m.summary || m.excerpt || '',
    tags: Array.isArray(m.tags) ? m.tags : [],
    source: m.sourceKind || m.source || 'page',
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString(),
  };
}
