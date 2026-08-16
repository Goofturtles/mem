// Local file ingestion. Runs in the page (options/dashboard), never the
// service worker, because file pickers and drag-drop are DOM-only.
//
// Supported now: .txt, .md, .html/.htm
// Stubbed: .pdf (drop pdf.js into vendor/pdfjs to enable), .docx (planned).

import { inExtension } from './env.js';
import { ingest } from './ingest.js';

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'mdown', 'mdx', 'rst', 'log', 'csv', 'tsv']);
const HTML_EXT = new Set(['html', 'htm']);
const JSON_EXT = new Set(['json']);
const PDF_EXT = new Set(['pdf']);
const DOCX_EXT = new Set(['docx']);

function extOf(name) {
  const m = (name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function fileUrl(file) {
  // Stable identifier per file path + size + mtime so re-importing updates the same memory.
  const stem = `${file.name}|${file.size}|${file.lastModified}`;
  return `mem-file://${encodeURIComponent(stem)}`;
}

async function readText(file) {
  return await file.text();
}

async function readHtml(file) {
  const html = await file.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, nav, footer, aside, [hidden]').forEach((el) => el.remove());
  const title = doc.querySelector('title')?.textContent?.trim() || file.name;
  const blocks = doc.querySelectorAll('p, h1, h2, h3, h4, h5, li, blockquote, pre, code');
  const text = blocks.length > 0
    ? Array.from(blocks).map((b) => b.textContent.trim()).filter(Boolean).join('\n\n')
    : (doc.body?.textContent || '').trim();
  return { title, text };
}

async function readPdf(file) {
  // PDF.js is large (~1.5 MB); we don't bundle by default. The user can drop
  // pdf.min.js + pdf.worker.min.js into extension/vendor/pdfjs/ and reload to
  // enable PDF ingestion.
  const pdfjs = globalThis.pdfjsLib;
  if (!pdfjs) {
    throw new Error('PDF support not enabled. See vendor/pdfjs/README.md to install pdf.js.');
  }
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(' '));
  }
  return { title: file.name.replace(/\.pdf$/i, ''), text: pages.join('\n\n') };
}

export async function parseFile(file) {
  const ext = extOf(file.name);

  if (JSON_EXT.has(ext)) {
    // A mem export file — caller should route to the importer instead.
    return { kind: 'export', file };
  }

  if (TEXT_EXT.has(ext)) {
    const text = await readText(file);
    return {
      kind: 'memory',
      payload: {
        url: fileUrl(file),
        title: file.name,
        text,
        excerpt: text.slice(0, 240),
        siteName: 'Local file',
        sourceKind: 'file',
        sourceLabel: 'File',
        mime: file.type || `text/${ext}`,
        extra: { name: file.name, size: file.size, lastModified: file.lastModified },
      },
    };
  }

  if (HTML_EXT.has(ext)) {
    const { title, text } = await readHtml(file);
    return {
      kind: 'memory',
      payload: {
        url: fileUrl(file),
        title,
        text,
        excerpt: text.slice(0, 240),
        siteName: 'Local file',
        sourceKind: 'file',
        sourceLabel: 'File',
        mime: 'text/html',
        extra: { name: file.name, size: file.size, lastModified: file.lastModified },
      },
    };
  }

  if (PDF_EXT.has(ext)) {
    const { title, text } = await readPdf(file);
    return {
      kind: 'memory',
      payload: {
        url: fileUrl(file),
        title,
        text,
        excerpt: text.slice(0, 240),
        siteName: 'PDF',
        sourceKind: 'file',
        sourceLabel: 'PDF',
        mime: 'application/pdf',
        extra: { name: file.name, size: file.size, lastModified: file.lastModified },
      },
    };
  }

  if (DOCX_EXT.has(ext)) {
    throw new Error('.docx support coming soon. For now export the doc as PDF or paste contents into a .txt.');
  }

  throw new Error(`Unsupported file type: .${ext}`);
}

// High-level: parse a FileList, send the parsed payloads to the background
// service worker for ingestion. Reports per-file progress via onProgress.
export async function ingestFiles(files, { onProgress } = {}) {
  const list = Array.from(files);
  const payloads = [];
  const exportFiles = [];
  const errors = [];

  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    onProgress?.({ stage: 'parse', index: i, total: list.length, name: f.name });
    try {
      const r = await parseFile(f);
      if (r.kind === 'export') exportFiles.push(r.file);
      else payloads.push(r.payload);
    } catch (e) {
      errors.push({ name: f.name, error: e.message });
    }
  }

  let results = [];
  if (payloads.length > 0) {
    onProgress?.({ stage: 'ingest', total: payloads.length });
    if (inExtension && chrome.runtime?.sendMessage) {
      // Extension context: hand off to the service worker so the badge / state
      // flow goes through the same place as web saves.
      const res = await chrome.runtime.sendMessage({ type: 'ingest-files', files: payloads });
      results = res?.results || [];
    } else {
      // Preview / page context: no service worker, ingest directly here.
      for (const p of payloads) {
        try {
          const m = await ingest(p);
          results.push({ ok: true, id: m.id, title: m.title });
        } catch (e) {
          results.push({ ok: false, error: e.message, title: p.title });
        }
      }
    }
  }

  return { results, errors, exportFiles };
}

// Reads files parsed for service-worker side (currently unused; the worker can't
// touch File objects — kept here for symmetry / future test fixtures).
export { parseFile as parseFileForTest };
