// Reminders — the scheduling half of commitment detection.
//
// commitments.js decides whether a line of text contains something worth
// remembering. This module owns what happens after the user says yes: it
// stores the reminder, arms a chrome alarm, fires a notification, and files
// the whole thing as a memory so it turns up later in ordinary recall
// ("what am I supposed to do this week").
//
// Reminders live in the meta store rather than their own object store —
// there are tens of them, not thousands, and keeping them in one record
// makes list, reschedule and prune a single read-modify-write.

import * as store from './storage.js';
import { describeWhen } from './commitments.js';

const KEY = 'reminders';
const ALARM_PREFIX = 'mem-reminder-';

// The reminder list is one meta record updated read-modify-write, so two
// overlapping updates would lose one. Serialising every mutation through a
// promise chain costs nothing at this scale and makes losing a reminder —
// which is a user obligation, not a cache entry — impossible within a
// context.
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  // Keep the chain alive after a rejection so one failure can't wedge it.
  writeChain = next.catch(() => {});
  return next;
}

// Fired reminders are kept for a while so the dashboard can show what just
// happened, then pruned.
const KEEP_FIRED_MS = 7 * 24 * 60 * 60 * 1000;

function newId() {
  return `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function readAll() {
  return (await store.metaGet(KEY, [])) || [];
}

async function writeAll(list) {
  await store.metaSet(KEY, list);
  return list;
}

/**
 * Schedule a reminder.
 *
 * `source` carries where it came from — the page and the original line — so
 * the notification can say "from your Discord conversation" and the user can
 * jump back to the context rather than seeing a decontextualised alert.
 */
export async function createReminder(input) {
  return serialize(() => doCreateReminder(input));
}

async function doCreateReminder({ what, at, sourceUrl = '', sourceTitle = '', snippet = '', origin = '' }) {
  if (!what || !at) throw new Error('A reminder needs text and a time.');
  if (at < Date.now() - 60000) throw new Error('That time has already passed.');

  const list = await readAll();

  // Same text at the same minute is the same reminder. The observer can see
  // one message several times as a chat re-renders, and three identical
  // alerts would be worse than none.
  const bucket = Math.round(at / 60000);
  const dup = list.find((r) => !r.firedAt && Math.round(r.at / 60000) === bucket && r.what === what);
  if (dup) return dup;

  const reminder = {
    id: newId(),
    what: String(what).slice(0, 200),
    at,
    createdAt: Date.now(),
    firedAt: 0,
    sourceUrl, sourceTitle, origin,
    snippet: String(snippet).slice(0, 400),
  };
  list.push(reminder);
  await writeAll(list);
  await arm(reminder);
  await fileAsMemory(reminder);
  return reminder;
}

async function arm(reminder) {
  if (typeof chrome === 'undefined' || !chrome.alarms) return;
  try {
    await chrome.alarms.create(ALARM_PREFIX + reminder.id, { when: reminder.at });
  } catch (e) {
    console.warn('[mem] could not arm reminder alarm:', e.message);
  }
}

/**
 * File the reminder as a memory too, so it is findable through ordinary
 * recall rather than living in a separate silo the user has to remember to
 * check. Written directly rather than through ingest() — there is no page to
 * summarize and no reason to spend a model call on one line of text.
 */
async function fileAsMemory(reminder) {
  try {
    const id = `reminder:${reminder.id}`;
    const when = new Date(reminder.at);
    const text = [
      reminder.what,
      reminder.snippet && reminder.snippet !== reminder.what ? reminder.snippet : '',
      `Scheduled for ${when.toLocaleString()}.`,
      reminder.sourceTitle ? `From ${reminder.sourceTitle}.` : '',
    ].filter(Boolean).join('\n');

    const memory = {
      id,
      url: reminder.sourceUrl || `mem-reminder://${reminder.id}`,
      title: reminder.what,
      summary: text,
      text,
      excerpt: reminder.snippet.slice(0, 240),
      tags: ['reminder'],
      keyFacts: [],
      contentType: 'reference',
      sourceKind: 'reminder',
      sourceLabel: 'Reminder',
      siteName: reminder.origin || 'Reminder',
      author: '',
      favicon: '',
      selection: '',
      publishedAt: '',
      mime: '',
      // Dated when it was captured, not when it fires. Dating it forward
      // pinned every pending reminder above real memories in "Recent" —
      // recent() walks the createdAt index descending — and excluded them
      // from "today" and "this week" windows. The due time lives in
      // extra.due, which is what the daily summary and open loops read.
      createdAt: reminder.createdAt,
      updatedAt: Date.now(),
      extra: { reminderId: reminder.id, due: reminder.at, setAt: reminder.createdAt },
    };
    await store.put(memory);

    const index = await import('./index.js');
    const ai = await import('./ai.js');
    let vec = null;
    let space = null;
    try {
      const res = await ai.embedOne(`${reminder.what}\n${text}`);
      vec = res.vector;
      space = res.space;
    } catch { /* lexical-only is fine for a one-line reminder */ }

    await index.addDoc({
      id, vec, space, createdAt: memory.createdAt,
      chunks: vec ? [{ text, start: 0, vec }] : [],
      tokensText: `${reminder.what}\n${text}`,
    });
    await index.flush();
  } catch (e) {
    // Filing is a convenience; the reminder itself must still work.
    console.warn('[mem] could not file reminder as a memory:', e.message);
  }
}

/** Show the notification for a fired reminder and mark it done. */
export async function fireReminder(id) {
  return serialize(() => doFireReminder(id));
}

async function doFireReminder(id) {
  const list = await readAll();
  const r = list.find((x) => x.id === id);
  if (!r || r.firedAt) return null;

  r.firedAt = Date.now();
  await writeAll(list);

  if (typeof chrome !== 'undefined' && chrome.notifications) {
    try {
      await chrome.notifications.create(`mem-rem-${r.id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: r.what.slice(0, 100),
        message: r.sourceTitle ? `From ${r.sourceTitle}` : 'Reminder from mem',
        contextMessage: r.origin || undefined,
        priority: 2,
        requireInteraction: false,
      });
    } catch (e) {
      // Icons are optional in this extension, and a missing iconUrl rejects
      // the whole call — retry without it rather than losing the reminder.
      try {
        await chrome.notifications.create(`mem-rem-${r.id}`, {
          type: 'basic',
          iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          title: r.what.slice(0, 100),
          message: r.sourceTitle ? `From ${r.sourceTitle}` : 'Reminder from mem',
          priority: 2,
        });
      } catch (e2) {
        console.warn('[mem] notification failed:', e2.message);
      }
    }
  }
  return r;
}

export async function listReminders({ includeFired = false } = {}) {
  const list = await readAll();
  const out = includeFired ? list : list.filter((r) => !r.firedAt);
  return out.sort((a, b) => a.at - b.at);
}

export async function upcomingCount() {
  return (await listReminders()).length;
}

export async function cancelReminder(id) {
  return serialize(() => doCancelReminder(id));
}

async function doCancelReminder(id) {
  const list = await readAll();
  const next = list.filter((r) => r.id !== id);
  await writeAll(next);
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    try { await chrome.alarms.clear(ALARM_PREFIX + id); } catch { /* already gone */ }
  }
  // A missing record is fine — the reminder may never have been filed. A
  // read-only violation is not: it means this context deleted the record but
  // could not retire the ordinal, leaving a deleted memory scoring in BM25.
  try {
    await store.remove(`reminder:${id}`);
  } catch (e) {
    if (/read-only/i.test(e.message)) throw e;
  }
  return list.length !== next.length;
}

export async function snoozeReminder(id, ms = 10 * 60 * 1000) {
  return serialize(() => doSnoozeReminder(id, ms));
}

async function doSnoozeReminder(id, ms) {
  const list = await readAll();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.at = Date.now() + ms;
  r.firedAt = 0;
  await writeAll(list);
  await arm(r);
  return r;
}

/**
 * Re-arm everything on service-worker startup, and drop stale entries.
 *
 * Chrome alarms survive a worker restart but not an extension update or a
 * browser that was closed across the scheduled time, so anything already due
 * fires immediately and the rest is rescheduled.
 */
export async function rehydrate() {
  return serialize(() => doRehydrate());
}

async function doRehydrate() {
  const list = await readAll();
  const now = Date.now();
  const keep = [];
  const overdue = [];

  for (const r of list) {
    if (r.firedAt && now - r.firedAt > KEEP_FIRED_MS) continue; // prune
    keep.push(r);
    if (r.firedAt) continue;
    if (r.at <= now) overdue.push(r);
    else await arm(r);
  }

  if (keep.length !== list.length) await writeAll(keep);
  // doFireReminder, not fireReminder: the public wrapper takes the same
  // serialisation lock this function already holds, so calling it here waits
  // on a chain link that only settles when this function returns. That
  // deadlock is silent and total — boot() never resolves, so installAlarms()
  // never runs, and because the reminder stays overdue every later wake
  // deadlocks the same way.
  for (const r of overdue) await doFireReminder(r.id);
  return { armed: keep.filter((r) => !r.firedAt).length, fired: overdue.length };
}

/** Whether an alarm name belongs to us, and which reminder it is. */
export function reminderIdFromAlarm(name) {
  return name && name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

export { describeWhen, ALARM_PREFIX };
