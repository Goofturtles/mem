// Scan chrome.history into mem. Title-only embeddings.
// Triggered by the first-install flow.

import { ingestBatch } from './ingest.js';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const JUNK_DOMAINS = new Set([
  'localhost', 'newtab', 'google.com', 'duckduckgo.com', 'bing.com',
]);
const JUNK_PATH = /\/(login|signin|signup|logout|verify|otp|2fa|search|results)\b/i;

function shouldIndex(item) {
  if (!item.url || !item.title) return false;
  if (item.title.length < 4) return false;
  if (!/^https?:/i.test(item.url)) return false;
  const host = hostOf(item.url);
  if (!host) return false;
  if (JUNK_DOMAINS.has(host)) return false;
  if (JUNK_PATH.test(item.url)) return false;
  return true;
}

export async function scanHistory({ days = 90, max = 5000, onProgress } = {}) {
  if (!chrome.history?.search) {
    throw new Error('history permission not granted');
  }
  onProgress?.({ stage: 'list' });
  const items = await chrome.history.search({
    text: '',
    startTime: Date.now() - days * 24 * 60 * 60 * 1000,
    maxResults: max,
  });

  const seenUrls = new Set();
  const fresh = [];
  for (const h of items) {
    if (!shouldIndex(h)) continue;
    if (seenUrls.has(h.url)) continue;
    seenUrls.add(h.url);
    fresh.push({
      url: h.url,
      title: h.title,
      context: '',
      sourceKind: 'history',
      sourceLabel: 'History',
      siteName: hostOf(h.url),
      createdAt: h.lastVisitTime || Date.now(),
      extra: { visitCount: h.visitCount, typedCount: h.typedCount },
    });
  }

  return ingestBatch(fresh, { onProgress });
}
