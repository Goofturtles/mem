// YouTube scan. Note: YouTube *watch history* is no longer available via API
// (Google removed it ~2016 — it's Takeout-only). What IS accessible:
//   • Liked Videos playlist (LL)
//   • Watch Later playlist (WL)  — actually no longer accessible via API either, omitted
//   • The user's own playlists
//   • Subscriptions
//
// We index Liked Videos + the user's own playlists. That captures the
// "things you cared about" signal that "watch history" used to.

import { googleAuthHeader } from './drive.js';
import { ingestBatch } from './ingest.js';

const YT_API = 'https://www.googleapis.com/youtube/v3';

async function ytGet(path, params) {
  const auth = await googleAuthHeader();
  const url = `${YT_API}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// videos.list accepts up to 50 comma-separated IDs per call. We enrich the
// playlist-item snippets with full video descriptions from this endpoint so
// the [content] tag actually has something to say about each video, instead
// of leaving them as title-only.
async function fetchVideoDetails(videoIds) {
  const out = new Map();
  if (videoIds.length === 0) return out;
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const data = await ytGet('/videos', { part: 'snippet,contentDetails', id: batch.join(','), maxResults: '50' });
      for (const v of data.items || []) {
        out.set(v.id, {
          description: v.snippet?.description || '',
          duration: v.contentDetails?.duration || '',
          tags: v.snippet?.tags || [],
          channelTitle: v.snippet?.channelTitle || '',
        });
      }
    } catch (e) {
      console.warn('[mem] videos.list failed:', e.message);
    }
  }
  return out;
}

async function listAllItems(path, params, limit) {
  const items = [];
  let pageToken = '';
  while (items.length < limit) {
    const p = { ...params, pageToken };
    if (!pageToken) delete p.pageToken;
    const data = await ytGet(path, p);
    for (const it of data.items || []) items.push(it);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return items.slice(0, limit);
}

async function listOwnPlaylists() {
  const data = await ytGet('/playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
  return data.items || [];
}

async function listPlaylistItems(playlistId, limit = 500) {
  return listAllItems('/playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '50' }, limit);
}

function videoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export async function scanYouTube({ limit = 1500, onProgress } = {}) {
  onProgress?.({ stage: 'list' });

  // 1) Liked Videos (playlist ID = LL or LL{channelId}; the "mine"-style alias works).
  let likedItems = [];
  try {
    likedItems = await listPlaylistItems('LL', 500);
  } catch { /* may 404 for accounts with privacy settings; ignore */ }

  // 2) User's own playlists — pull each one's items up to a per-playlist cap.
  let playlists = [];
  try { playlists = await listOwnPlaylists(); } catch {}

  const own = [];
  for (const p of playlists) {
    try {
      const items = await listPlaylistItems(p.id, 250);
      for (const it of items) own.push({ ...it, _playlistTitle: p.snippet?.title || '' });
    } catch { /* skip playlists that fail */ }
  }

  const all = [...likedItems, ...own].slice(0, limit);

  // Batch-fetch real descriptions so the LLM has actual content to summarize.
  onProgress?.({ stage: 'enrich', total: all.length });
  const uniqueIds = [];
  const seenIds = new Set();
  for (const it of all) {
    const vid = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
    if (vid && !seenIds.has(vid)) { seenIds.add(vid); uniqueIds.push(vid); }
  }
  const details = await fetchVideoDetails(uniqueIds);

  onProgress?.({ stage: 'compose', total: all.length });
  const seen = new Set();
  const items = [];
  for (const it of all) {
    const videoId = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const snip = it.snippet || {};
    const detail = details.get(videoId);
    const channel = detail?.channelTitle || snip.videoOwnerChannelTitle || snip.channelTitle || '';
    const realDescription = (detail?.description || snip.description || '').trim();
    const addedToPlaylist = snip.publishedAt || '';
    const videoUploadedAt = snip.videoPublishedAt || '';
    const contextLines = [];
    if (channel) contextLines.push(`Channel: ${channel}`);
    if (detail?.duration) contextLines.push(`Duration: ${detail.duration.replace(/^PT/, '').toLowerCase()}`);
    if (realDescription) contextLines.push(realDescription.slice(0, 800));
    items.push({
      url: videoUrl(videoId),
      title: snip.title || `Video ${videoId}`,
      context: contextLines.join('\n'),
      sourceKind: 'youtube',
      sourceLabel: it._playlistTitle ? `YouTube · ${it._playlistTitle}` : 'YouTube · Liked',
      siteName: 'YouTube',
      author: channel,
      createdAt: addedToPlaylist ? Date.parse(addedToPlaylist) : Date.now(),
      publishedAt: videoUploadedAt,
      extra: {
        videoId, channel, playlist: it._playlistTitle || 'Liked',
        videoUploadedAt, duration: detail?.duration || '', tags: (detail?.tags || []).slice(0, 8),
      },
    });
  }

  return ingestBatch(items, { onProgress });
}
