// Gmail scan — pulls subject + snippet from recent messages. Lightweight,
// no bodies (would be too large). Bodies can be fetched lazily later.

import { googleAuthHeader } from './drive.js';
import { ingestBatch } from './ingest.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function pickHeader(headers, name) {
  return headers?.find?.((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

async function listMessages({ q = '', limit = 500 }) {
  const auth = await googleAuthHeader();
  const ids = [];
  let pageToken = '';
  while (ids.length < limit) {
    const params = new URLSearchParams({ maxResults: String(Math.min(500, limit - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    if (q) params.set('q', q);
    const res = await fetch(`${GMAIL_API}/messages?${params.toString()}`, { headers: auth });
    if (!res.ok) throw new Error(`Gmail list ${res.status}`);
    const data = await res.json();
    for (const m of data.messages || []) ids.push(m.id);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids;
}

async function fetchMessageMeta(id) {
  const auth = await googleAuthHeader();
  // metadata format avoids downloading the full body — keeps quota low.
  const res = await fetch(
    `${GMAIL_API}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: auth }
  );
  if (!res.ok) return null;
  return res.json();
}

export async function scanGmail({ limit = 500, onProgress } = {}) {
  onProgress?.({ stage: 'list' });
  const ids = await listMessages({ limit });

  onProgress?.({ stage: 'fetch', total: ids.length });
  const items = [];
  // Fetch in small parallel batches to stay friendly with Gmail's rate limits.
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const slice = ids.slice(i, i + CONCURRENCY);
    const msgs = await Promise.all(slice.map(fetchMessageMeta));
    for (const m of msgs) {
      if (!m) continue;
      const subject = pickHeader(m.payload?.headers, 'Subject') || '(no subject)';
      const from = pickHeader(m.payload?.headers, 'From') || '';
      const dateStr = pickHeader(m.payload?.headers, 'Date') || '';
      const date = dateStr ? Date.parse(dateStr) : (m.internalDate ? Number(m.internalDate) : Date.now());
      items.push({
        url: `https://mail.google.com/mail/u/0/#inbox/${m.id}`,
        title: subject,
        context: m.snippet || '',
        sourceKind: 'gmail',
        sourceLabel: 'Email',
        siteName: 'Gmail',
        author: from,
        createdAt: date,
        extra: { gmailId: m.id, labels: m.labelIds || [] },
      });
    }
    onProgress?.({ stage: 'fetch', total: ids.length, done: i + slice.length });
  }

  return ingestBatch(items, { onProgress });
}
