// Daily summary builder. Deterministic — no LLM call required. The dashboard
// renders this as a grouped panel: Read / Watched / To complete / Communicated
// / Classroom / Other, with "Upcoming" pulled from future calendar events and
// not-yet-due classroom assignments.
//
// AI optional: callers can pass the structured groups into an LLM afterwards
// to get a one-paragraph synthesized opener, but the structured part stands
// on its own.

import * as store from './storage.js';

// Detect queries that should trigger the daily-summary path. Returns
// { daysAgo, label } where daysAgo is 0 (today), 1 (yesterday), etc., or
// null if not a daily-summary query.
export function dailySummaryScope(q) {
  if (!q) return null;
  // Yesterday-specific phrasings (case-insensitive — "I" must match "i")
  if (/\b(yesterday'?s summary|recap of yesterday|what (did|have) i do(ne)? yesterday|brief me on yesterday|how was yesterday|summary of yesterday)\b/i.test(q)) {
    return { daysAgo: 1, label: 'yesterday' };
  }
  if (/\bwhat\s+(did|have)\s+i\s+(do|done)\b.*\byesterday\b/i.test(q) || /\byesterday\b.*\b(what|recap|summary|did i do)\b/i.test(q)) {
    return { daysAgo: 1, label: 'yesterday' };
  }
  if (/\b(daily summary|summary of (my )?day|today'?s summary|what (have|did) i do today|recap of (today|my day)|day in review|brief me on (today|my day)|how (was|is) (my )?day)\b/i.test(q)) {
    return { daysAgo: 0, label: 'today' };
  }
  return null;
}

// Back-compat — boolean check.
export function isDailySummaryQuery(q) { return !!dailySummaryScope(q); }

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function humanRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.floor(f / 60)} min`;
    if (f < 86400) return `in ${Math.floor(f / 3600)}h`;
    return `in ${Math.floor(f / 86400)}d`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function categorize(m) {
  switch (m.sourceKind) {
    case 'web':
    case 'history':
    case 'bookmark':
    case 'drive':
    case 'file':
      return 'read';
    case 'youtube':
      return 'watched';
    case 'gmail':
      return 'communicated';
    case 'calendar':
      return 'toDo';
    case 'classroom':
      return 'classroom';
    default:
      return 'other';
  }
}

export async function buildDailySummary({ memories, daysAgo = 0 } = {}) {
  const items = memories || await store.all();
  const now = Date.now();
  const target = new Date();
  target.setDate(target.getDate() - daysAgo);
  const dayStart = startOfDay(target);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const todayItems = items
    .filter((m) => m.createdAt >= dayStart && m.createdAt < dayEnd)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Future-facing list only meaningful for "today" (daysAgo === 0). For
  // historical days, "upcoming" doesn't make sense — we already know what
  // happened, including what was on the calendar that day.
  const upcoming = daysAgo === 0 ? items.filter((m) => {
    if (m.sourceKind === 'calendar' && m.createdAt > now) return true;
    if (m.sourceKind === 'classroom' && m.extra?.due && m.extra.due > now && !m.extra?.submitted) return true;
    return false;
  }).sort((a, b) => (a.extra?.due || a.createdAt) - (b.extra?.due || b.createdAt)) : [];

  const groups = { read: [], watched: [], toDo: [], communicated: [], classroom: [], other: [] };
  for (const m of todayItems) groups[categorize(m)].push(m);
  for (const u of upcoming) {
    if (u.sourceKind === 'calendar') groups.toDo.push(u);
    if (u.sourceKind === 'classroom') groups.classroom.push(u);
  }

  // Dedupe each group by id and cap at sensible per-group limits.
  const CAPS = { read: 10, watched: 6, toDo: 8, communicated: 8, classroom: 8, other: 6 };
  for (const k of Object.keys(groups)) {
    const seen = new Set();
    groups[k] = groups[k].filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    }).slice(0, CAPS[k]);
  }

  const dateLabel = new Date(dayStart).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const labelPrefix = daysAgo === 0 ? '' : daysAgo === 1 ? 'Yesterday · ' : `${daysAgo} days ago · `;
  return {
    dayLabel: labelPrefix + dateLabel,
    daysAgo,
    groups,
    totalToday: todayItems.length,
    upcomingCount: upcoming.length,
    humanRelative,
  };
}

// Quote-list helper: turn a list of memories into a comma-joined English
// fragment like 'A, B, and C'. Uses titles + optional time/author.
function joinTitles(items, { withTime = false } = {}) {
  if (items.length === 0) return '';
  const phrases = items.map((m) => {
    const t = m.title || 'untitled';
    const author = m.author ? ` by ${m.author}` : '';
    const time = withTime ? ` (${humanRelative(m.createdAt)})` : '';
    return `"${t}"${author}${time}`;
  });
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return phrases.slice(0, -1).join(', ') + ', and ' + phrases[phrases.length - 1];
}

// Time-of-day bucket label aware of which day we're describing.
// daysAgo: 0 = today → "this morning"; 1 = yesterday → "yesterday morning"; etc.
function timeBucket(ts, daysAgo = 0) {
  const h = new Date(ts).getHours();
  let part;
  if (h < 5) part = 'overnight';
  else if (h < 12) part = 'morning';
  else if (h < 17) part = 'afternoon';
  else if (h < 21) part = 'evening';
  else part = 'night';
  if (daysAgo === 0) {
    if (part === 'overnight') return 'overnight';
    if (part === 'night') return 'tonight';
    return `this ${part}`;
  }
  if (daysAgo === 1) {
    return `yesterday ${part === 'overnight' ? 'overnight' : part}`;
  }
  return `${daysAgo} days ago, ${part}`;
}

// Deterministic prose summary from the grouped data. Works without AI.
// The LLM narrative (if available) replaces this — but if it fails or the
// user has no key, this is what they see, and it's still a real summary.
export function buildDailyNarrativeText(summary) {
  const { groups, dayLabel, totalToday, upcomingCount, daysAgo = 0 } = summary;
  if (totalToday === 0 && upcomingCount === 0) {
    if (daysAgo === 0) return "Nothing's been indexed for today yet. Once mem captures some activity (or you trigger a scan), the summary will write itself.";
    if (daysAgo === 1) return "I don't have anything indexed for yesterday. mem only has what was captured at the time — turn on auto-capture or save pages as you go to fill in gaps.";
    return `I don't have anything indexed from ${daysAgo} days ago.`;
  }

  const lines = [];

  // ---- Paragraph 1: what happened today ----
  const past = [];
  // Chronological aggregation: by time bucket → activity
  const reading = groups.read || [];
  const watching = groups.watched || [];
  const emails = groups.communicated || [];
  const classroom = (groups.classroom || []).filter((m) => m.createdAt <= Date.now());
  const events = (groups.toDo || []).filter((m) => m.createdAt <= Date.now());

  if (reading.length > 0) {
    const earliest = [...reading].sort((a, b) => a.createdAt - b.createdAt)[0];
    const bucket = timeBucket(earliest.createdAt, daysAgo);
    const list = joinTitles(reading.slice(0, 4));
    past.push(`${capitalize(bucket)} you spent time on ${list}${reading.length > 4 ? `, plus ${reading.length - 4} others` : ''}.`);
  }
  if (watching.length > 0) {
    const list = joinTitles(watching.slice(0, 3));
    past.push(`You watched ${list}${watching.length > 3 ? ` and ${watching.length - 3} more` : ''}.`);
  }
  if (emails.length > 0) {
    const list = joinTitles(emails.slice(0, 3));
    past.push(`In email: ${list}${emails.length > 3 ? `, plus ${emails.length - 3} more` : ''}.`);
  }
  if (events.length > 0) {
    const list = joinTitles(events.slice(0, 3));
    past.push(`You had ${list} on the calendar.`);
  }
  if (classroom.length > 0) {
    const list = joinTitles(classroom.slice(0, 3));
    past.push(`On Classroom: ${list}.`);
  }
  if (past.length > 0) lines.push(past.join(' '));

  // ---- Paragraph 2: what's coming up ----
  const upcomingEvents = (groups.toDo || []).filter((m) => m.createdAt > Date.now() || (m.extra?.due && m.extra.due > Date.now()));
  const upcomingAssignments = (groups.classroom || []).filter((m) => m.extra?.due && m.extra.due > Date.now() && !m.extra.submitted);
  const upcomingBits = [];
  if (upcomingEvents.length > 0) {
    const phrases = upcomingEvents.slice(0, 3).map((m) => {
      const at = m.extra?.due || m.createdAt;
      return `"${m.title}" ${humanRelative(at)}`;
    });
    upcomingBits.push(`coming up you have ${joinList(phrases)}`);
  }
  if (upcomingAssignments.length > 0) {
    const phrases = upcomingAssignments.slice(0, 3).map((m) => {
      const at = m.extra.due;
      const course = m.extra?.courseName ? ` for ${m.extra.courseName}` : '';
      return `"${m.title}"${course} due ${humanRelative(at)}`;
    });
    upcomingBits.push(`assignments-wise, ${joinList(phrases)}`);
  }
  if (upcomingBits.length > 0) {
    lines.push(capitalize(upcomingBits.join(', and ')) + '.');
  }

  return lines.join('\n\n').trim();
}

function joinList(arr) {
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
