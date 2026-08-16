import * as store from './lib/storage.js';
import * as index from './lib/index.js';
import * as ai from './lib/ai.js';
import * as local from './lib/local.js';
import * as reminders from './lib/reminders.js';
import { ingestFiles } from './lib/files.js';
import { setClientId } from './lib/drive.js';
import { inExtension, getSetting, setSetting } from './lib/env.js';

const $ = (id) => document.getElementById(id);

// The service worker owns index writes; see index.setReadOnly. Without this,
// importing a backup from Settings would flush this page's stale ordinal
// table over the worker's — the exact corruption the ownership rule exists to
// prevent. Standalone (no worker) this page is the only context and may write.
if (inExtension && chrome.runtime?.sendMessage) index.setReadOnly(true);

const apiKey = $('api-key');
const reveal = $('reveal');
const saveKey = $('save-key');
const testKey = $('test-key');
const keyStatus = $('key-status');

const autoCapture = $('auto-capture');
const blocklist = $('blocklist');
const savePrefs = $('save-prefs');
const prefsStatus = $('prefs-status');

const memCount = $('mem-count');
const memSize = $('mem-size');
const exportBtn = $('export');
const importBtn = $('import');
const importFile = $('import-file');
const clearBtn = $('clear');
const dataStatus = $('data-status');

const pickFiles = $('pick-files');
const filesInput = $('files-input');
const filesStatus = $('files-status');

const driveConnect = $('drive-connect');
const driveDisconnect = $('drive-disconnect');
const driveStatusEl = $('drive-status');
const driveSync = $('drive-sync');
const driveSyncStatus = $('drive-sync-status');
const driveSetupDetails = $('drive-setup-details');

/** Send a message to the worker and throw if it reports failure. */
async function sendOrThrow(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || `${msg.type} failed`);
  return res;
}

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}

function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshStats() {
  // Uses the lightweight projection — pulling every record's full text just
  // to add up its length was itself the most expensive thing on this page.
  const items = await store.allLite();
  memCount.textContent = items.length;
  let bytes = 0;
  for (const m of items) {
    bytes += (m.textLength || 0) + (m.summary?.length || 0) + (m.title?.length || 0);
  }
  // Vectors live in the index now, not on the records.
  try {
    const idx = await index.stats();
    bytes += idx.memoryBytes || 0;
  } catch { /* index may not be built yet */ }
  memSize.textContent = bytesHuman(bytes);
}

const providerSegment = $('provider-segment');
const providerCost = $('provider-cost');
const getKeyLink = $('get-key-link');

async function init() {
  const [legacyKey, openaiKey, geminiKey, aiProvider, ac, bl] = await Promise.all([
    getSetting('apiKey'),
    getSetting('openaiKey'),
    getSetting('geminiKey'),
    getSetting('aiProvider'),
    getSetting('autoCapture'),
    getSetting('blocklist'),
  ]);

  // Migrate legacy apiKey → openaiKey once.
  if (legacyKey && !openaiKey) await setSetting('openaiKey', legacyKey);

  const provider = aiProvider || 'gemini';
  if (!aiProvider) await setSetting('aiProvider', provider);
  applyProviderUI(provider, { openaiKey: openaiKey || legacyKey || '', geminiKey: geminiKey || '' });

  autoCapture.checked = !!ac;
  blocklist.value = Array.isArray(bl) ? bl.join('\n') : '';
  refreshStats();
  refreshDriveStatus();
}

function applyProviderUI(provider, keys) {
  const meta = ai.PROVIDER[provider];
  [...providerSegment.querySelectorAll('.seg-btn')].forEach((b) => {
    b.classList.toggle('active', b.dataset.provider === provider);
  });
  apiKey.placeholder = meta.placeholder;
  apiKey.value = (provider === 'openai' ? keys?.openaiKey : keys?.geminiKey) ?? '';
  providerCost.textContent = meta.cost;
  getKeyLink.href = meta.getKeyUrl;
  getKeyLink.textContent = meta.getKeyUrl.replace(/^https?:\/\//, '');
  const nameEl = document.getElementById('active-provider-name');
  if (nameEl) nameEl.textContent = meta.name;
}

async function readBothKeys() {
  const [openaiKey, geminiKey] = await Promise.all([getSetting('openaiKey'), getSetting('geminiKey')]);
  return { openaiKey: openaiKey || '', geminiKey: geminiKey || '' };
}

providerSegment?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const newProvider = btn.dataset.provider;
  const targetMeta = ai.PROVIDER[newProvider];
  setStatus(keyStatus, `Switching to ${targetMeta.name}…`);

  await ai.switchProvider(newProvider);

  // READ BACK from storage to verify the write actually landed.
  const actual = await ai.currentProvider();
  if (actual !== newProvider) {
    setStatus(keyStatus, `Switch failed — still on ${ai.PROVIDER[actual].name}.`, 'err');
    applyProviderUI(actual, await readBothKeys());
    return;
  }

  applyProviderUI(actual, await readBothKeys());
  // Loud confirmation. Goes green on success.
  setStatus(keyStatus, `Now using ${targetMeta.name}.`, 'ok');
});

reveal.addEventListener('click', () => {
  apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
});

saveKey.addEventListener('click', async () => {
  const k = apiKey.value.trim();
  const provider = (await ai.currentProvider()) || 'gemini';
  const meta = ai.PROVIDER[provider];
  if (!k) { setStatus(keyStatus, 'Paste a key first.', 'err'); return; }
  if (!k.startsWith(meta.keyPrefix)) {
    setStatus(keyStatus, `That doesn't look like a ${meta.name} key — should start with ${meta.keyPrefix}.`, 'err');
    return;
  }
  const keyName = provider === 'openai' ? 'openaiKey' : 'geminiKey';
  await setSetting(keyName, k);
  setStatus(keyStatus, 'Saved.', 'ok');
});

testKey.addEventListener('click', async () => {
  setStatus(keyStatus, 'Testing…');
  const provider = (await ai.currentProvider()) || 'gemini';
  const k = apiKey.value.trim();
  try {
    if (k) {
      await ai.testKey({ provider, key: k });
    } else {
      await ai.testKey();
    }
    setStatus(keyStatus, 'Connection OK.', 'ok');
  } catch (e) {
    setStatus(keyStatus, e.message.replace(/^(OpenAI|Gemini)[^:]*:\s*/, ''), 'err');
  }
});

savePrefs.addEventListener('click', async () => {
  const bl = blocklist.value.split('\n').map((s) => s.trim()).filter(Boolean);
  await setSetting('autoCapture', autoCapture.checked);
  await setSetting('blocklist', bl);
  setStatus(prefsStatus, 'Preferences saved.', 'ok');
});

exportBtn.addEventListener('click', async () => {
  setStatus(dataStatus, 'Preparing export…');
  const json = await store.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mem-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  setStatus(dataStatus, 'Exported.', 'ok');
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus(dataStatus, 'Importing…');
  try {
    const text = await file.text();
    // Import rewrites the index, and this page is read-only inside the
    // extension — the worker performs it. Doing it here was the original
    // last-writer-wins corruption on the restore-from-backup path.
    let n;
    if (inExtension && chrome.runtime?.sendMessage) {
      const res = await chrome.runtime.sendMessage({ type: 'import-memories', json: text });
      if (!res?.ok) throw new Error(res?.error || 'Import failed');
      n = res.count;
      index._reset();
    } else {
      n = await store.importAll(text);
    }
    setStatus(dataStatus, `Imported ${n} memories.`, 'ok');
    refreshStats();
  } catch (err) {
    setStatus(dataStatus, `Import failed: ${err.message}`, 'err');
  }
  importFile.value = '';
});

clearBtn.addEventListener('click', async () => {
  const sure = confirm('Erase ALL stored memories? This cannot be undone.');
  if (!sure) return;
  const reallySure = confirm('Really erase everything? Export first if you might want it back.');
  if (!reallySure) return;
  // Routed through the worker so its in-memory ordinal table is dropped too;
  // otherwise the worker would flush the old table back on the next capture.
  if (inExtension && chrome.runtime?.sendMessage) {
    const res = await chrome.runtime.sendMessage({ type: 'erase-everything' });
    if (!res?.ok) { setStatus(dataStatus, res?.error || 'Could not erase.', 'err'); return; }
    index._reset();
  } else {
    await store.clear();
  }
  setStatus(dataStatus, 'All memories erased.', 'ok');
  refreshStats();
});

// ---------- Files ----------

pickFiles.addEventListener('click', () => filesInput.click());

filesInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  setStatus(filesStatus, `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
  pickFiles.disabled = true;
  try {
    const { results, errors, exportFiles } = await ingestFiles(files, {
      onProgress: (p) => {
        if (p.stage === 'parse') setStatus(filesStatus, `Reading ${p.name}…`);
        else if (p.stage === 'ingest') setStatus(filesStatus, `Summarizing ${p.total}…`);
      },
    });
    // If the user picked a mem export JSON, route it to the importer instead.
    for (const f of exportFiles) {
      try {
        const n = inExtension && chrome.runtime?.sendMessage
          ? (await sendOrThrow({ type: 'import-memories', json: await f.text() })).count
          : await store.importAll(await f.text());
        results.push({ ok: true, title: `${n} memories imported` });
      } catch (e2) {
        errors.push({ name: f.name, error: e2.message });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    const errCount = (results.length - okCount) + errors.length;
    let msg = `${okCount} imported`;
    if (errCount > 0) msg += ` · ${errCount} failed`;
    setStatus(filesStatus, msg, errCount === 0 ? 'ok' : 'err');
    refreshStats();
  } catch (err) {
    setStatus(filesStatus, err.message, 'err');
  } finally {
    pickFiles.disabled = false;
    filesInput.value = '';
  }
});

// ---------- Drive ----------

async function refreshDriveStatus() {
  if (!inExtension || !chrome.runtime?.sendMessage) {
    driveStatusEl.textContent = 'Open this page from the installed extension to connect Google.';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'drive-status' });
  if (!res?.ok) return;
  if (res.connected) {
    driveStatusEl.textContent = res.email ? `Connected as ${res.email}` : 'Connected';
    driveStatusEl.className = 'status ok';
    driveConnect.hidden = true;
    driveDisconnect.hidden = false;
    driveSync.hidden = false;
    if (res.lastSync) {
      const ago = Math.max(1, Math.round((Date.now() - res.lastSync) / 60000));
      driveSyncStatus.textContent = `Last sync ${ago}m ago`;
    }
  } else {
    driveStatusEl.textContent = 'Not connected.';
    driveStatusEl.className = 'status';
    driveConnect.hidden = false;
    driveDisconnect.hidden = true;
    driveSync.hidden = true;
  }
}

driveConnect.addEventListener('click', async () => {
  setStatus(driveStatusEl, 'Asking Google…');
  driveConnect.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'drive-connect' });
    if (!res?.ok) {
      const msg = res?.error || 'Connect failed';
      setStatus(driveStatusEl, msg, 'err');
      // Open the setup walkthrough automatically when client_id isn't configured
      if (res?.code === 'OAUTH_NOT_CONFIGURED' || /client_id|OAuth/i.test(msg)) {
        if (driveSetupDetails) driveSetupDetails.open = true;
      }
      return;
    }
    refreshDriveStatus();
  } finally {
    driveConnect.disabled = false;
  }
});

driveDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect Google? Already-imported memories stay; future syncs stop until you reconnect.')) return;
  await chrome.runtime.sendMessage({ type: 'drive-disconnect' });
  refreshDriveStatus();
});

driveSync.addEventListener('click', async () => {
  setStatus(driveSyncStatus, 'Syncing…');
  driveSync.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'drive-sync', limit: 25 });
    if (!res?.ok) {
      setStatus(driveSyncStatus, res?.error || 'Sync failed', 'err');
      return;
    }
    let msg = `${res.imported} imported · ${res.skipped} skipped`;
    if (res.errors?.length) msg += ` · ${res.errors.length} errors`;
    setStatus(driveSyncStatus, msg, res.errors?.length ? 'err' : 'ok');
    refreshStats();
    refreshDriveStatus();
  } finally {
    driveSync.disabled = false;
  }
});

// ============================================================
//  v2 settings: on-device AI, reminder watching, deepening,
//  ambient behaviour, and cross-extension access control.
// ============================================================

const keyBlock = $('key-block');
const localBlock = $('local-block');
const localStateEl = $('local-state');
const localDownload = $('local-download');
const localStatus = $('local-status');
const localFallback = $('local-fallback');

const watchOrigins = $('watch-origins');
const saveWatch = $('save-watch');
const addCommon = $('add-common');
const watchStatus = $('watch-status');
const reminderList = $('reminder-list');

const coverageFill = $('coverage-fill');
const coverageText = $('coverage-text');
const deepenEnabled = $('deepen-enabled');
const deepenNow = $('deepen-now');
const deepenStatus = $('deepen-status');

const ambientRelated = $('ambient-related');
const ambientEngagement = $('ambient-engagement');
const saveAmbient = $('save-ambient');
const ambientStatus = $('ambient-status');

const externalPending = $('external-pending');
const externalAllowed = $('external-allowed');

// The most common messaging surfaces, offered as a convenience. Adding them
// is still an explicit action — nothing here is on unless the user says so.
const COMMON_CHAT_ORIGINS = [
  'https://discord.com',
  'https://app.slack.com',
  'https://web.whatsapp.com',
  'https://teams.microsoft.com',
  'https://www.messenger.com',
  'https://web.telegram.org',
  'https://mail.google.com',
];

// ---------- provider block ----------

/** Show the key fields or the on-device block depending on the provider. */
async function syncProviderBlocks() {
  const provider = (await ai.currentProvider()) || 'gemini';
  const isLocal = provider === 'local';
  if (keyBlock) keyBlock.hidden = isLocal;
  if (localBlock) localBlock.hidden = !isLocal;
  if (isLocal) await refreshLocalState();
}

async function refreshLocalState() {
  if (!localStateEl) return;
  const st = await local.status();
  localDownload.hidden = true;
  if (!st.supported) {
    localStateEl.textContent = "This browser has no built-in AI. It needs Chrome 138 or later on desktop — pick Gemini or OpenAI instead.";
    return;
  }
  if (st.ready) {
    localStateEl.textContent = 'Built-in AI is ready. Summarizing and answering run on this machine.';
    return;
  }
  if (st.needsDownload) {
    localStateEl.textContent = 'Chrome can run the model here, but it has to be downloaded first (about 2GB, once).';
    localDownload.hidden = false;
    return;
  }
  localStateEl.textContent = 'Built-in AI is unavailable on this device.';
}

localDownload?.addEventListener('click', async () => {
  localDownload.disabled = true;
  setStatus(localStatus, 'Downloading…');
  try {
    await local.prepare({
      onProgress: ({ loaded, total }) => {
        setStatus(localStatus, `${Math.round((loaded / (total || 1)) * 100)}%`);
      },
    });
    setStatus(localStatus, 'Ready', 'ok');
    await refreshLocalState();
  } catch (e) {
    setStatus(localStatus, e.message, 'err');
  } finally {
    localDownload.disabled = false;
  }
});

localFallback?.addEventListener('change', async () => {
  await setSetting('localFallback', localFallback.checked);
  setStatus(keyStatus, localFallback.checked ? 'Fallback on' : 'Fallback off', 'ok');
});

// ---------- reminder watching ----------

async function refreshWatchOrigins() {
  const list = (await getSetting('commitmentOrigins')) || [];
  watchOrigins.value = list.join('\n');
}

saveWatch?.addEventListener('click', async () => {
  const list = watchOrigins.value
    .split('\n')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // Normalise to an origin, since that is what the content script compares
  // against. A pasted full URL would otherwise silently never match.
  const cleaned = [];
  const rejected = [];
  for (const raw of list) {
    try {
      const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
      cleaned.push(u.origin);
    } catch {
      rejected.push(raw);
    }
  }
  await setSetting('commitmentOrigins', [...new Set(cleaned)]);
  watchOrigins.value = [...new Set(cleaned)].join('\n');
  setStatus(watchStatus, rejected.length
    ? `Saved. Skipped ${rejected.length} unreadable line${rejected.length === 1 ? '' : 's'}.`
    : `Watching ${cleaned.length} site${cleaned.length === 1 ? '' : 's'}. Reload those tabs.`,
    rejected.length ? 'err' : 'ok');
});

addCommon?.addEventListener('click', async () => {
  const existing = watchOrigins.value.split('\n').map((s) => s.trim()).filter(Boolean);
  watchOrigins.value = [...new Set([...existing, ...COMMON_CHAT_ORIGINS])].join('\n');
  setStatus(watchStatus, 'Added — press Save sites to confirm.');
});

async function refreshReminders() {
  if (!reminderList) return;
  const items = await reminders.listReminders();
  reminderList.innerHTML = '';
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint small';
    p.textContent = 'None set.';
    reminderList.appendChild(p);
    return;
  }
  for (const r of items) {
    const row = document.createElement('div');
    row.className = 'mini-row';
    const label = document.createElement('span');
    label.className = 'mini-label';
    label.textContent = `${r.what} — ${reminders.describeWhen(r.at)}`;
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'Cancel';
    btn.addEventListener('click', async () => {
      // Routed: cancelReminder deletes a memory, and removeDoc throws under
      // read-only — a throw this page's caller would swallow, leaving the
      // record gone but its ordinal still scoring in BM25.
      if (inExtension && chrome.runtime?.sendMessage) {
        await sendOrThrow({ type: 'reminder-cancel', id: r.id });
        index._reset();
      } else {
        await reminders.cancelReminder(r.id);
      }
      refreshReminders();
    });
    row.append(label, btn);
    reminderList.appendChild(row);
  }
}

// ---------- deepening ----------

async function refreshCoverage() {
  if (!coverageText) return;
  try {
    const [cov, state] = await Promise.all([
      import('./lib/deepen.js').then((m) => m.coverage()),
      import('./lib/deepen.js').then((m) => m.getState()),
    ]);
    const pct = Math.round(cov.pct * 100);
    if (coverageFill) coverageFill.style.width = `${pct}%`;
    coverageText.textContent = cov.total === 0
      ? 'Nothing indexed yet.'
      : `${pct}% of ${cov.total.toLocaleString()} memories have real content · ${cov.titleOnly.toLocaleString()} are title-only, ${cov.deepenable.toLocaleString()} of those can be deepened.`;
    deepenEnabled.checked = state.enabled !== false;
  } catch (e) {
    coverageText.textContent = `Could not read coverage: ${e.message}`;
  }
}

deepenEnabled?.addEventListener('change', async () => {
  const m = await import('./lib/deepen.js');
  await m.setEnabled(deepenEnabled.checked);
  setStatus(deepenStatus, deepenEnabled.checked ? 'On' : 'Off', 'ok');
});

deepenNow?.addEventListener('click', async () => {
  deepenNow.disabled = true;
  setStatus(deepenStatus, 'Deepening…');
  try {
    const res = inExtension && chrome.runtime?.sendMessage
      ? await chrome.runtime.sendMessage({ type: 'deepen-run-now', max: 5 })
      : await (await import('./lib/deepen.js')).runDeepenPass({ max: 5 });
    const deepened = res?.deepened ?? 0;
    setStatus(deepenStatus,
      deepened ? `${deepened} deepened.` : `Nothing deepened (${res?.reason || 'no candidates'}).`,
      deepened ? 'ok' : '');
    refreshCoverage();
    refreshStats();
  } catch (e) {
    setStatus(deepenStatus, e.message, 'err');
  } finally {
    deepenNow.disabled = false;
  }
});

// ---------- ambient ----------

async function refreshAmbient() {
  const [rel, eng] = await Promise.all([
    getSetting('ambientRelated'),
    getSetting('ambientEngagement'),
  ]);
  ambientRelated.checked = rel === undefined ? true : !!rel;
  ambientEngagement.checked = eng === undefined ? true : !!eng;
}

saveAmbient?.addEventListener('click', async () => {
  await setSetting('ambientRelated', ambientRelated.checked);
  await setSetting('ambientEngagement', ambientEngagement.checked);
  setStatus(ambientStatus, 'Saved. Reload open tabs to apply.', 'ok');
});

// ---------- connected extensions ----------

async function refreshExternal() {
  if (!externalPending) return;
  const allowed = (await getSetting('externalAllowlist')) || [];
  const pending = (await getSetting('externalPending')) || [];

  externalPending.innerHTML = '';
  if (pending.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint small';
    p.textContent = 'No extension is waiting for approval.';
    externalPending.appendChild(p);
  } else {
    for (const p of pending) {
      const row = document.createElement('div');
      row.className = 'mini-row';
      const label = document.createElement('span');
      label.className = 'mini-label';
      label.textContent = `${p.name || 'Unknown extension'} · ${p.id}`;
      const approve = document.createElement('button');
      approve.className = 'primary small';
      approve.textContent = 'Approve';
      approve.addEventListener('click', async () => {
        await setSetting('externalAllowlist', [...new Set([...allowed, p.id])]);
        await setSetting('externalPending', pending.filter((x) => x.id !== p.id));
        refreshExternal();
      });
      const deny = document.createElement('button');
      deny.className = 'ghost small';
      deny.textContent = 'Dismiss';
      deny.addEventListener('click', async () => {
        await setSetting('externalPending', pending.filter((x) => x.id !== p.id));
        refreshExternal();
      });
      row.append(label, approve, deny);
      externalPending.appendChild(row);
    }
  }

  externalAllowed.innerHTML = '';
  if (allowed.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint small';
    p.textContent = 'None approved.';
    externalAllowed.appendChild(p);
    return;
  }
  for (const id of allowed) {
    const row = document.createElement('div');
    row.className = 'mini-row';
    const label = document.createElement('span');
    label.className = 'mini-label';
    label.textContent = id;
    const revoke = document.createElement('button');
    revoke.className = 'ghost small';
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      await setSetting('externalAllowlist', allowed.filter((x) => x !== id));
      refreshExternal();
    });
    row.append(label, revoke);
    externalAllowed.appendChild(row);
  }
}

// ---------- boot the v2 sections ----------

providerSegment?.addEventListener('click', () => {
  // Runs after the existing handler has switched providers.
  setTimeout(syncProviderBlocks, 0);
});

async function initV2() {
  try {
    localFallback.checked = (await getSetting('localFallback')) !== false;
    await syncProviderBlocks();
    await refreshWatchOrigins();
    await refreshReminders();
    await refreshAmbient();
    await refreshCoverage();
    await refreshExternal();
  } catch (e) {
    console.error('[mem] settings init failed:', e);
  }
}

init();
initV2();
