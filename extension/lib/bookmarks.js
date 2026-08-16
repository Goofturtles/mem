// Scan chrome.bookmarks into mem. Title-only embeddings.

import { ingestBatch } from './ingest.js';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function flatten(node, parents, out) {
  if (!node) return;
  if (node.url) {
    out.push({ ...node, folder: parents.join(' / ') });
    return;
  }
  const here = parents.concat(node.title ? [node.title] : []);
  for (const c of node.children || []) flatten(c, here, out);
}

export async function scanBookmarks({ onProgress } = {}) {
  if (!chrome.bookmarks?.getTree) {
    throw new Error('bookmarks permission not granted');
  }
  onProgress?.({ stage: 'list' });
  const tree = await chrome.bookmarks.getTree();
  const all = [];
  for (const root of tree) flatten(root, [], all);

  const items = all
    .filter((b) => b.url && /^https?:/i.test(b.url))
    .filter((b) => b.title && b.title.length > 1)
    .map((b) => ({
      url: b.url,
      title: b.title,
      context: b.folder || '',
      sourceKind: 'bookmark',
      sourceLabel: 'Bookmark',
      siteName: hostOf(b.url),
      createdAt: b.dateAdded || Date.now(),
      extra: { folder: b.folder },
    }));

  return ingestBatch(items, { onProgress });
}
