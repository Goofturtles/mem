// Google integration — Drive, Gmail, YouTube, Calendar.
//
// Auth uses chrome.identity.getAuthToken, which works against the user's
// signed-in Google account in the browser. The manifest's oauth2 block
// declares the client_id + scopes. There is one configuration step:
//
//   1. Make a Google Cloud project (console.cloud.google.com).
//   2. Enable Drive API (+ Gmail / YouTube / Calendar APIs as desired).
//   3. OAuth consent screen → External, add yourself as test user.
//   4. Credentials → OAuth client ID → "Chrome App" type. Application ID =
//      the extension ID shown at chrome://extensions.
//   5. Replace YOUR_GOOGLE_OAUTH_CLIENT_ID in manifest.json with the resulting
//      client_id, then reload the extension.
//
// After that, mem can silently obtain tokens via chrome.identity. No more
// pasting client IDs in UI, no more redirect-URI fiddling.

import { ingest } from './ingest.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Promise-wrap chrome.identity.getAuthToken (it's still callback-only in MV3).
function getAuthToken({ interactive } = { interactive: false }) {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!token) return reject(new Error('No token returned.'));
        resolve(token);
      });
    } catch (e) { reject(e); }
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    try { chrome.identity.removeCachedAuthToken({ token }, () => resolve()); }
    catch { resolve(); }
  });
}

export async function driveStatus() {
  const { driveEmail, driveLastSync } = await chrome.storage.local.get(['driveEmail', 'driveLastSync']);
  // Probe silently — getAuthToken({interactive:false}) only succeeds if the
  // user has already authorized this extension.
  let connected = false;
  try {
    await getAuthToken({ interactive: false });
    connected = true;
  } catch { /* not connected — expected on first run */ }
  return {
    connected,
    clientIdSet: true, // client_id now lives in manifest, not user-input
    email: driveEmail || '',
    lastSync: driveLastSync || 0,
  };
}

export async function driveConnect() {
  let token;
  try {
    token = await getAuthToken({ interactive: true });
  } catch (e) {
    // Common cause: manifest oauth2.client_id is still the placeholder, or
    // the Chrome OAuth client isn't authorized for this extension ID.
    if (/OAuth2|bad client/i.test(e.message)) {
      const friendly = new Error('Google sign-in failed — make sure your OAuth client_id is set in manifest.json and that this extension ID is authorized in Google Cloud.');
      friendly.code = 'OAUTH_NOT_CONFIGURED';
      throw friendly;
    }
    throw e;
  }
  // Get user email for display.
  let email = '';
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    email = me?.email || '';
  } catch { /* not critical */ }
  await chrome.storage.local.set({ driveEmail: email });
  return { connected: true, email };
}

export async function driveDisconnect() {
  try {
    const token = await getAuthToken({ interactive: false }).catch(() => null);
    if (token) {
      // Revoke server-side + remove from local cache.
      try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch {}
      await removeCachedAuthToken(token);
    }
  } catch { /* best effort */ }
  await chrome.storage.local.remove(['driveEmail']);
  if (chrome.identity.clearAllCachedAuthTokens) {
    try { chrome.identity.clearAllCachedAuthTokens(); } catch {}
  }
}

// Used by drive/gmail/youtube/calendar scanners. Retries once on 401 by
// invalidating the cached token (so chrome.identity refetches it fresh).
async function authHeader({ retry = true } = {}) {
  try {
    const token = await getAuthToken({ interactive: false });
    return { Authorization: `Bearer ${token}` };
  } catch (e) {
    const err = new Error('Google account not connected. Click Connect Google in Settings.');
    err.code = 'GOOGLE_NOT_CONNECTED';
    throw err;
  }
}

// Wraps a fetch to detect 401s and force token refresh transparently.
async function authedFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), ...(await authHeader()) };
  let res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    const stale = headers.Authorization?.replace(/^Bearer\s+/, '');
    if (stale) await removeCachedAuthToken(stale);
    const fresh = { ...(opts.headers || {}), ...(await authHeader()) };
    res = await fetch(url, { ...opts, headers: fresh });
  }
  return res;
}

// Shared by gmail.js / youtube.js / calendar.js.
export { authHeader as googleAuthHeader, authedFetch };

// Pick which Drive file types we know how to ingest as text.
const EXPORTABLE = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const RAW_TEXT = new Set(['text/plain', 'text/markdown', 'text/html']);

function kindFromMime(mime) {
  if (mime === 'application/vnd.google-apps.document') return 'Doc';
  if (mime === 'application/vnd.google-apps.presentation') return 'Slides';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'Sheet';
  if (mime === 'text/plain') return 'Text';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'text/html') return 'HTML';
  if (mime === 'application/pdf') return 'PDF';
  return 'File';
}

async function listFiles({ limit = 25 } = {}) {
  const params = new URLSearchParams({
    orderBy: 'viewedByMeTime desc',
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink,iconLink,owners(displayName,emailAddress))',
    q: "trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation' or mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'text/html')",
  });
  const res = await authedFetch(`${DRIVE_API}/files?${params.toString()}`);
  if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.files || [];
}

async function fetchText(file) {
  if (EXPORTABLE[file.mimeType]) {
    const exportMime = EXPORTABLE[file.mimeType];
    const url = `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = await authedFetch(url);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return await res.text();
  }
  if (RAW_TEXT.has(file.mimeType)) {
    const url = `${DRIVE_API}/files/${file.id}?alt=media`;
    const res = await authedFetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return await res.text();
  }
  throw new Error(`Unsupported Drive type: ${file.mimeType}`);
}

export async function driveListAndIngest({ limit = 25 } = {}) {
  const files = await listFiles({ limit });
  const summary = { listed: files.length, imported: 0, skipped: 0, errors: [] };

  for (const file of files) {
    try {
      const text = await fetchText(file);
      if (!text || text.trim().length < 40) {
        summary.skipped++;
        continue;
      }
      const owner = file.owners?.[0]?.displayName || '';
      await ingest({
        url: `https://drive.google.com/file/d/${file.id}/view`,
        title: file.name,
        text,
        excerpt: text.slice(0, 240),
        siteName: 'Google Drive',
        author: owner,
        favicon: file.iconLink || '',
        publishedAt: file.modifiedTime || '',
        sourceKind: 'drive',
        sourceLabel: kindFromMime(file.mimeType),
        mime: file.mimeType,
        extra: {
          driveId: file.id,
          webViewLink: file.webViewLink,
          viewedByMeTime: file.viewedByMeTime,
        },
      });
      summary.imported++;
    } catch (e) {
      summary.errors.push({ name: file.name, error: e.message });
    }
  }

  await chrome.storage.local.set({ driveLastSync: Date.now() });
  return summary;
}

// Stub for backwards compat — client_id lives in manifest now.
export async function setClientId() { /* no-op */ }
