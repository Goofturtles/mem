// Calendar scan — pulls events from the user's primary calendar in a window
// around today (past 90 days, next 30 days).

import { googleAuthHeader } from './drive.js';
import { ingestBatch } from './ingest.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';

export async function scanCalendar({ pastDays = 90, futureDays = 30, limit = 1000, onProgress } = {}) {
  onProgress?.({ stage: 'list' });
  const auth = await googleAuthHeader();
  const timeMin = new Date(Date.now() - pastDays * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000).toISOString();

  const all = [];
  let pageToken = '';
  while (all.length < limit) {
    const params = new URLSearchParams({
      timeMin, timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${CAL_API}/calendars/primary/events?${params.toString()}`, { headers: auth });
    if (!res.ok) throw new Error(`Calendar ${res.status}`);
    const data = await res.json();
    for (const e of data.items || []) all.push(e);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const items = all.slice(0, limit).map((e) => {
    const start = e.start?.dateTime || e.start?.date || '';
    const date = start ? Date.parse(start) : Date.now();
    const attendees = (e.attendees || []).map((a) => a.email).filter(Boolean).slice(0, 8).join(', ');
    return {
      url: e.htmlLink || `https://calendar.google.com/calendar/u/0/r/eventedit/${e.id}`,
      title: e.summary || '(untitled event)',
      context: [
        e.description || '',
        e.location ? `Location: ${e.location}` : '',
        attendees ? `Attendees: ${attendees}` : '',
        start ? `When: ${start}` : '',
      ].filter(Boolean).join('\n'),
      sourceKind: 'calendar',
      sourceLabel: 'Event',
      siteName: 'Calendar',
      author: e.organizer?.email || '',
      createdAt: date,
      extra: { eventId: e.id, location: e.location || '', attendees },
    };
  });

  return ingestBatch(items, { onProgress });
}
