// Content extractor. Runs in the page's isolated world via
// chrome.scripting.executeScript({ func: extractPageContent }).
//
// Must be a SELF-CONTAINED function — no imports, no external references.
// Chrome serializes the function source and executes it in the page.

function extractPageContent() {
  function clone(el) { return el ? el.cloneNode(true) : null; }
  function stripJunk(root) {
    if (!root) return;
    const remove = root.querySelectorAll(
      'script, style, noscript, iframe, svg, canvas, video, audio, ' +
      'nav, footer, aside, header, ' +
      '[role=navigation], [role=banner], [role=contentinfo], [role=complementary], ' +
      '.nav, .navbar, .sidebar, .footer, .header, .menu, .cookie, .cookies, ' +
      '.advert, .ads, .ad, .promo, .share, .social, .subscribe, .newsletter, ' +
      '[aria-hidden=true], [hidden]'
    );
    remove.forEach((el) => el.remove());
  }
  function blockText(root) {
    if (!root) return '';
    // Collect block-level text with newlines so paragraphs separate cleanly.
    const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, li, blockquote, pre, code, td, th, figcaption, dt, dd');
    if (blocks.length > 0) {
      return Array.from(blocks).map((b) => b.innerText.trim()).filter(Boolean).join('\n\n');
    }
    return (root.innerText || '').trim();
  }
  function pickContainer() {
    // Prefer semantic landmarks first, fall back to density-based selection.
    const candidates = [
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('[role=main]'),
      document.querySelector('#content, #main, #article, .content, .article, .post, .entry, .markdown-body'),
    ].filter(Boolean);
    if (candidates.length > 0) return candidates[0];

    // Density fallback: find the div whose direct text content is longest.
    let best = null, bestScore = 0;
    const divs = document.querySelectorAll('div, section');
    for (const d of divs) {
      const t = (d.innerText || '').trim();
      // Penalize very link-heavy elements (nav-like).
      const links = d.querySelectorAll('a').length;
      const score = t.length - links * 50;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best || document.body;
  }
  function getMeta(name) {
    const sel = `meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`;
    const el = document.querySelector(sel);
    return el?.getAttribute('content') || '';
  }
  function favicon() {
    const link = document.querySelector('link[rel*="icon"]');
    if (link?.href) return link.href;
    try { return new URL('/favicon.ico', location.href).href; } catch { return ''; }
  }

  const container = clone(pickContainer());
  stripJunk(container);
  const text = blockText(container);

  // User selection takes precedence as a "highlight" — the user is telling us
  // exactly what mattered to them on this page.
  const selection = (window.getSelection?.()?.toString() || '').trim();

  const title = document.title || getMeta('og:title') || getMeta('twitter:title') || location.hostname;
  const excerpt = getMeta('description') || getMeta('og:description') || getMeta('twitter:description') || text.slice(0, 240);

  return {
    url: location.href,
    title: title.trim().slice(0, 300),
    excerpt: excerpt.trim().slice(0, 500),
    text: text.slice(0, 60000), // hard cap so we don't choke on huge pages
    selection: selection.slice(0, 5000),
    favicon: favicon(),
    author: getMeta('author') || getMeta('article:author') || '',
    siteName: getMeta('og:site_name') || location.hostname,
    publishedAt: getMeta('article:published_time') || getMeta('og:updated_time') || '',
    capturedAt: Date.now(),
    lang: document.documentElement.lang || '',
  };
}

// Export the function so background.js can import its source.
// (Manifest registers this file as a script that just defines the global.)
if (typeof globalThis !== 'undefined') {
  globalThis.__memExtractPageContent = extractPageContent;
}
