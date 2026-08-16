// Commitment detection: spotting a time and an obligation in a line of text.
//
// This runs on messages in whatever conversation the user is having — Discord,
// Slack, WhatsApp Web, Teams, Messenger, a forum thread, a support chat. Two
// design constraints follow directly from that:
//
//   It has to be local. Message text is about as private as text gets, so
//   detection is pure string work with no model call and no network. Nothing
//   is sent anywhere unless the user clicks "remind me", and even then only
//   the line they chose.
//
//   It has to be quiet. A detector that fires on ordinary conversation is
//   worse than no detector, because every false positive is an interruption
//   during a conversation. So a match needs *both* a concrete time reference
//   and an obligation cue, and the confidence score is used to suppress
//   anything marginal.
//
// This module has no imports on purpose: content scripts load it directly via
// dynamic import from web-accessible resources, and keeping it dependency-free
// means that stays a single fetch.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};

// Default hour when a day is named without a time. Deliberately not 00:00 —
// "the meeting is Thursday" means during Thursday, not the instant it starts.
const DEFAULT_HOUR = 9;
const PART_OF_DAY = {
  morning: 9, noon: 12, afternoon: 14, evening: 19, night: 20, tonight: 20, midnight: 0,
};

/**
 * Obligation cues, grouped by how strongly they imply something is owed.
 * Grouping matters: "deadline" is much better evidence than "dinner".
 */
const CUES_STRONG = [
  "don'?t forget", 'dont forget', 'remember to', 'remind me', 'make sure', 'be sure to',
  'deadline', 'due', 'submit', 'submission', 'turn (?:it )?in', 'hand (?:it )?in', 'rsvp',
  'you need to', 'you have to', 'we need to', 'i need you to', 'make sure you',
  'cut ?off', 'last chance', 'expires', 'closes', 'closing', 'ends', 'ending',
];
const CUES_MEDIUM = [
  'meeting', 'meet', 'call', 'appointment', 'interview', 'session', 'standup',
  'practice', 'rehearsal', 'shift', 'class', 'lecture', 'lab', 'exam', 'midterm',
  'final', 'finals', 'test', 'quiz', 'presentation', 'demo', 'review',
  'reservation', 'booked', 'scheduled', 'starts', 'starting', 'begins',
  'tryout', 'audition', 'game', 'match', 'tournament', 'flight', 'train', 'bus',
  'pickup', 'pick up', 'drop off', 'deliver', 'assignment', 'homework',
  'project', 'essay', 'paper', 'application', 'apply', 'register',
  'registration', 'hackathon', 'competition', 'contest', 'workshop',
  'conference', 'ceremony', 'recital', 'performance', 'appointment',
  'doctor', 'dentist', 'checkup', 'ticket', 'tickets',
];
const CUES_WEAK = [
  'can you', 'could you', 'please', 'send me', 'bring', 'party', 'dinner',
  'lunch', 'breakfast', 'coffee', 'concert', 'birthday', 'wedding',
  'let me know', 'see you', 'meet up', 'hang out', 'going to', 'gonna',
];

function buildCueRe(list) {
  return new RegExp(`\\b(${list.join('|')})\\b`, 'i');
}
const RE_STRONG = buildCueRe(CUES_STRONG);
const RE_MEDIUM = buildCueRe(CUES_MEDIUM);
const RE_WEAK = buildCueRe(CUES_WEAK);

// ---------- time parsing ----------

function atTime(base, hour, minute) {
  const d = new Date(base);
  d.setHours(hour, minute || 0, 0, 0);
  return d.getTime();
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Parse a clock time like "3pm", "3:30 pm", "15:00", "noon". */
function parseClock(text) {
  const lc = text.toLowerCase();

  const named = lc.match(/\b(noon|midnight)\b/);
  if (named) return { hour: named[1] === 'noon' ? 12 : 0, minute: 0, source: named[1] };

  // 3pm / 3:30pm / 3.30 pm
  let m = lc.match(/\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const pm = m[3].startsWith('p');
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    return { hour, minute, source: m[0] };
  }

  // 24-hour: 15:00, 09:30. Requires the colon so bare numbers aren't times.
  m = lc.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10), source: m[0] };

  // "at 5" — only with the preposition, otherwise every number is a time.
  m = lc.match(/\bat\s+(1[0-2]|[1-9])\b(?!\s*[:.]?\d)/);
  if (m) {
    let hour = parseInt(m[1], 10);
    // Bare "at 8" in conversation almost always means the waking-hours one.
    if (hour < 8) hour += 12;
    return { hour, minute: 0, source: m[0], vague: true };
  }

  const part = lc.match(/\b(morning|afternoon|evening|tonight|night)\b/);
  if (part) return { hour: PART_OF_DAY[part[1]], minute: 0, source: part[1], vague: true };

  return null;
}

/**
 * Parse a date reference. Returns { day, text, explicit } where `day` is the
 * timestamp of the start of the referenced day.
 */
function parseDay(text, now) {
  const lc = text.toLowerCase();

  // People do not type "tomorrow" in a chat. Missing these abbreviations was
  // the difference between catching a real deadline and staying silent — the
  // message that exposed it was "hackathon ending tmrw at 12pm".
  if (/\bday after (?:tomorrow|tmrw|tmr|tmw)\b/.test(lc)) {
    return { day: startOfDay(now + 2 * DAY), text: 'day after tomorrow', explicit: true };
  }
  if (/\b(?:tomorrow|tmrw|tmrrw|tmr|tmw|tmo|2moro|2morrow|tomo)\b/.test(lc)) {
    return { day: startOfDay(now + DAY), text: 'tomorrow', explicit: true };
  }
  if (/\b(?:tonight|tonite|2nite)\b/.test(lc)) {
    return { day: startOfDay(now), text: 'tonight', explicit: true };
  }
  if (/\b(today|this (?:morning|afternoon|evening|arvo))\b/.test(lc)) {
    return { day: startOfDay(now), text: lc.match(/\b(today|this (?:morning|afternoon|evening|arvo))\b/)[1], explicit: true };
  }
  // "end of day" style deadlines.
  if (/\b(?:eod|end of (?:the )?day)\b/.test(lc)) {
    return { day: startOfDay(now), text: 'end of day', explicit: true, defaultHour: 17 };
  }
  if (/\b(?:eow|end of (?:the )?week)\b/.test(lc)) {
    const dow = (new Date(now).getDay() + 6) % 7; // Monday = 0
    return { day: startOfDay(now + (4 - dow) * DAY), text: 'end of the week', explicit: true, defaultHour: 17 };
  }

  // ISO or numeric date: 2026-03-05, 3/5, 05/03
  let m = lc.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return { day: startOfDay(d.getTime()), text: m[0], explicit: true };
  }
  m = lc.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const month = Number(m[1]) - 1;
    const dayNum = Number(m[2]);
    let year = m[3] ? Number(m[3]) : new Date(now).getFullYear();
    if (year < 100) year += 2000;
    if (month <= 11 && dayNum <= 31) {
      let ts = startOfDay(new Date(year, month, dayNum).getTime());
      // A bare month/day that has already passed means next year.
      if (!m[3] && ts < startOfDay(now)) ts = startOfDay(new Date(year + 1, month, dayNum).getTime());
      return { day: ts, text: m[0], explicit: true };
    }
  }

  // "March 5" / "5 March" / "Mar 5th"
  const monthNames = Object.keys(MONTHS).join('|');
  m = lc.match(new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (!m) m = lc.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\b`));
  if (m) {
    const monthKey = MONTHS[m[1]] !== undefined ? m[1] : m[2];
    const dayNum = Number(MONTHS[m[1]] !== undefined ? m[2] : m[1]);
    const month = MONTHS[monthKey];
    const year = new Date(now).getFullYear();
    let ts = startOfDay(new Date(year, month, dayNum).getTime());
    if (ts < startOfDay(now)) ts = startOfDay(new Date(year + 1, month, dayNum).getTime());
    return { day: ts, text: m[0], explicit: true };
  }

  // Weekday, optionally qualified by this/next.
  const wdNames = Object.keys(WEEKDAYS).join('|');
  m = lc.match(new RegExp(`\\b(this|next|on)?\\s*(${wdNames})\\b`));
  if (m) {
    const target = WEEKDAYS[m[2]];
    const today = new Date(now).getDay();
    let delta = (target - today + 7) % 7;
    // A weekday named without a qualifier means the next one, not today.
    if (delta === 0) delta = 7;
    if (m[1] === 'next' && delta < 7) delta += 7;
    return { day: startOfDay(now + delta * DAY), text: m[0].trim(), explicit: true };
  }

  if (/\bthis weekend\b/.test(lc)) {
    const today = new Date(now).getDay();
    const delta = (6 - today + 7) % 7 || 7;
    return { day: startOfDay(now + delta * DAY), text: 'this weekend', explicit: true };
  }
  if (/\bnext week\b/.test(lc)) {
    return { day: startOfDay(now + 7 * DAY), text: 'next week', explicit: false };
  }

  return null;
}

/** "in 20 minutes", "in 2 hours", "in 3 days". */
function parseRelative(text, now) {
  const m = text.toLowerCase().match(/\bin\s+(a|an|\d{1,3})\s*(min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks)\b/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
  const unit = m[2];
  const ms = /^min/.test(unit) ? n * MIN
    : /^h/.test(unit) ? n * HOUR
    : /^d/.test(unit) ? n * DAY
    : n * 7 * DAY;
  return { at: now + ms, text: m[0], explicit: true };
}

/**
 * Resolve any time reference in `text` to a timestamp.
 * Returns { at, whenText, explicit } or null.
 */
export function parseWhen(text, now = Date.now()) {
  const relative = parseRelative(text, now);
  // "in 2 hours" is as deliberate as naming a weekday, so it counts as
  // naming a day for the purposes of standing in for a cue word.
  if (relative) return { at: relative.at, whenText: relative.text, explicit: true, namesADay: true };

  const day = parseDay(text, now);
  const clock = parseClock(text);

  if (day) {
    const hour = clock ? clock.hour : (day.defaultHour ?? PART_OF_DAY[day.text] ?? DEFAULT_HOUR);
    const minute = clock ? clock.minute : 0;
    // No roll-forward here. When someone writes "today at 9am" it means
    // today, even if 9am has gone — the right response to that is to
    // recognise it as past and stay quiet, not to invent tomorrow. Bare clock
    // times with no day attached are the only case where "next occurrence" is
    // the intended reading, and that is handled below.
    const at = atTime(day.day, hour, minute);
    return {
      at,
      whenText: clock ? `${day.text} at ${formatClock(hour, minute)}` : day.text,
      explicit: day.explicit,
      namesADay: true,
    };
  }

  if (clock) {
    // A bare clock time means the next occurrence of it.
    let at = atTime(now, clock.hour, clock.minute);
    if (at <= now) at += DAY;
    return { at, whenText: formatClock(clock.hour, clock.minute), explicit: !clock.vague, namesADay: false };
  }

  return null;
}

function formatClock(hour, minute) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  return minute ? `${h12}:${String(minute).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}

// ---------- commitment detection ----------

// Lines that look like a time but carry no obligation, or are obviously not
// addressed to anyone: timestamps, scores, version numbers, code.
const NOISE = /^\s*(https?:\/\/|[\[\{<]|\d+[-–]\d+\s*$)/;

/**
 * Decide whether a message contains something worth offering to remind about.
 *
 * Returns null, or:
 *   { what, at, whenText, confidence, cue, snippet }
 *
 * Requires both a time reference and an obligation cue. Either alone is far
 * too common in ordinary conversation to act on.
 */
export function detectCommitment(text, { now = Date.now(), minConfidence = 0.45 } = {}) {
  const raw = (text || '').trim();
  if (raw.length < 8 || raw.length > 600) return null;
  if (NOISE.test(raw)) return null;

  const when = parseWhen(raw, now);
  if (!when) return null;

  // Something already past is a fact, not a commitment. A small grace window
  // absorbs clock skew and messages read moments after they were sent.
  if (when.at < now - 5 * MIN) return null;
  // Beyond a year out is almost always a false parse.
  if (when.at > now + 365 * DAY) return null;

  let confidence = 0;
  let cue = null;

  const strong = raw.match(RE_STRONG);
  const medium = raw.match(RE_MEDIUM);
  const weak = raw.match(RE_WEAK);
  if (strong) { confidence += 0.55; cue = strong[1]; }
  else if (medium) { confidence += 0.40; cue = medium[1]; }
  else if (weak) { confidence += 0.24; cue = weak[1]; }
  else if (when.namesADay) {
    // Naming a specific future day is itself the signal. Requiring a cue word
    // as well meant real messages went unnoticed — "hackathon ending tmrw at
    // 12pm" has an unmistakable deadline and not one word from any cue list,
    // because no list can cover what people actually do with their time.
    //
    // A bare clock with no day ("the 3pm showing was great") still needs a
    // cue: it's far more often narration than commitment.
    confidence += 0.34;
    cue = when.whenText;
  } else {
    return null;
  }

  if (when.explicit) confidence += 0.25;
  // A named date and a clock time together is the strongest possible signal.
  if (/\d/.test(when.whenText) && when.whenText.includes('at')) confidence += 0.12;
  // Addressed to the reader.
  if (/\b(you|your|u|ur)\b/i.test(raw)) confidence += 0.1;
  // Deadline framing.
  if (/\b(by|before|due|no later than)\b/i.test(raw)) confidence += 0.1;
  // Questions are usually proposals, not commitments yet.
  if (/\?\s*$/.test(raw)) confidence -= 0.15;
  // Hedged plans. Weighted heavily enough to overcome a named day on its own:
  // "I might go to the game on saturday" has a day, a time-ish cue and no
  // commitment whatsoever, and interrupting someone over it is exactly the
  // failure that makes a detector like this worth switching off.
  if (/\b(maybe|might|probably|possibly|thinking about|considering|not sure|if i|if we|might be)\b/i.test(raw)) {
    confidence -= 0.35;
  }

  confidence = Math.max(0, Math.min(1, confidence));
  if (confidence < minConfidence) return null;

  return {
    what: summarise(raw, when.whenText),
    at: when.at,
    whenText: when.whenText,
    confidence,
    cue,
    snippet: raw.slice(0, 300),
  };
}

/**
 * A short label for the reminder. Keeps the user's own words — a paraphrase
 * would be less recognisable than the sentence they actually read.
 */
function summarise(text, whenText) {
  let s = text.replace(/\s+/g, ' ').trim();
  // Strip a leading name prefix like "Jamie: " that most chat DOMs include.
  s = s.replace(/^[A-Z][\w .'-]{0,28}:\s+/, '');
  if (s.length <= 90) return s;
  // Prefer the clause containing the time reference.
  const parts = s.split(/(?<=[.!?])\s+/);
  const key = whenText.split(/\s+/)[0];
  const withTime = parts.find((p) => p.toLowerCase().includes(key.toLowerCase()));
  const chosen = withTime || parts[0] || s;
  if (chosen.length <= 90) return chosen.trim();
  const cut = chosen.lastIndexOf(' ', 90);
  return chosen.slice(0, cut > 40 ? cut : 90).trim() + '…';
}

/** Human-readable countdown, used in the prompt and the reminder list. */
export function describeWhen(at, now = Date.now()) {
  const d = at - now;
  if (d < 0) return 'now';
  if (d < HOUR) return `in ${Math.max(1, Math.round(d / MIN))} min`;
  if (d < DAY) {
    const h = Math.round(d / HOUR);
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const days = Math.round(d / DAY);
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days} days`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
