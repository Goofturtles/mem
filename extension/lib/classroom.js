// Google Classroom scanner. Reuses the same OAuth token as drive/gmail/etc.
// Scopes needed (declared in manifest.json):
//   classroom.courses.readonly
//   classroom.coursework.me.readonly
//   classroom.announcements.readonly

import { authedFetch } from './drive.js';
import { ingestBatch } from './ingest.js';

const API = 'https://classroom.googleapis.com/v1';

async function listCourses() {
  const res = await authedFetch(`${API}/courses?courseStates=ACTIVE&pageSize=50`);
  if (!res.ok) throw new Error(`Classroom courses ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.courses || [];
}

async function listCourseWork(courseId, limit = 50) {
  const res = await authedFetch(`${API}/courses/${courseId}/courseWork?pageSize=${limit}&orderBy=updateTime%20desc`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.courseWork || [];
}

async function listSubmissions(courseId, courseWorkId) {
  // Returns the current user's submission for this assignment.
  const res = await authedFetch(`${API}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions?userId=me`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.studentSubmissions || [];
}

async function listAnnouncements(courseId, limit = 20) {
  const res = await authedFetch(`${API}/courses/${courseId}/announcements?pageSize=${limit}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.announcements || [];
}

function dueTimestamp(work) {
  if (!work.dueDate) return null;
  const y = work.dueDate.year;
  const m = (work.dueDate.month || 1) - 1;
  const d = work.dueDate.day || 1;
  const h = work.dueTime?.hours ?? 23;
  const min = work.dueTime?.minutes ?? 59;
  return Date.UTC(y, m, d, h, min);
}

export async function scanClassroom({ onProgress } = {}) {
  onProgress?.({ stage: 'list' });
  let courses;
  try {
    courses = await listCourses();
  } catch (e) {
    if (/403|401|404|insufficient/i.test(e.message)) {
      throw new Error('Classroom API not authorized. Make sure the Classroom API is enabled and the three classroom.* scopes are added to the OAuth consent screen.');
    }
    throw e;
  }

  const items = [];
  onProgress?.({ stage: 'fetch', total: courses.length, done: 0 });

  // Run courses in parallel — Classroom tolerates concurrent calls.
  await Promise.all(courses.map(async (course, idx) => {
    try {
      const [cw, ann] = await Promise.all([
        listCourseWork(course.id, 50),
        listAnnouncements(course.id, 20),
      ]);

      // Assignments
      for (const w of cw) {
        const due = dueTimestamp(w);
        // Determine submission state (turned-in vs not) — best-effort
        let submitted = false;
        try {
          const subs = await listSubmissions(course.id, w.id);
          submitted = subs.some((s) => s.state === 'TURNED_IN' || s.state === 'RETURNED');
        } catch { /* ignore */ }

        const lines = [];
        if (w.description) lines.push(w.description);
        lines.push(`Course: ${course.name}`);
        if (due) lines.push(`Due: ${new Date(due).toLocaleString()}`);
        if (w.maxPoints) lines.push(`Points: ${w.maxPoints}`);
        lines.push(`Status: ${submitted ? 'turned in' : 'not turned in'}`);

        items.push({
          url: w.alternateLink || `https://classroom.google.com/c/${course.id}/a/${w.id}/details`,
          title: w.title || '(untitled assignment)',
          context: lines.join('\n'),
          sourceKind: 'classroom',
          sourceLabel: w.workType === 'ASSIGNMENT' ? 'Assignment' : (w.workType || 'Coursework'),
          siteName: 'Google Classroom',
          author: course.name,
          createdAt: w.creationTime ? Date.parse(w.creationTime) : Date.now(),
          extra: {
            courseId: course.id,
            courseName: course.name,
            workId: w.id,
            due,
            workType: w.workType,
            maxPoints: w.maxPoints,
            submitted,
          },
        });
      }

      // Announcements
      for (const a of ann) {
        const text = (a.text || '').trim();
        const title = text ? text.split('\n')[0].slice(0, 100) : 'Announcement';
        items.push({
          url: a.alternateLink || `https://classroom.google.com/c/${course.id}/p/${a.id}/details`,
          title,
          context: `${text}\nCourse: ${course.name}`,
          sourceKind: 'classroom',
          sourceLabel: 'Announcement',
          siteName: 'Google Classroom',
          author: course.name,
          createdAt: a.creationTime ? Date.parse(a.creationTime) : Date.now(),
          extra: {
            courseId: course.id,
            courseName: course.name,
            announcementId: a.id,
          },
        });
      }
    } catch (e) {
      console.warn(`[mem] classroom course ${course.id} failed:`, e.message);
    }
    onProgress?.({ stage: 'fetch', total: courses.length, done: idx + 1 });
  }));

  return ingestBatch(items, { onProgress });
}
