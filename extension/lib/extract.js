// Page content extractor — pure function that runs in the target tab via
// chrome.scripting.executeScript({ func: extractPageContent }).
//
// MUST be fully self-contained (no imports, no closures over external vars,
// no `this`). Chrome serializes the source and runs it in the page context.

export function extractPageContent() {
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
    const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, li, blockquote, pre, code, td, th, figcaption, dt, dd');
    if (blocks.length > 0) {
      return Array.from(blocks).map((b) => b.innerText.trim()).filter(Boolean).join('\n\n');
    }
    return (root.innerText || '').trim();
  }
  function pickContainer() {
    const candidates = [
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('[role=main]'),
      document.querySelector('#content, #main, #article, .content, .article, .post, .entry, .markdown-body'),
    ].filter(Boolean);
    if (candidates.length > 0) return candidates[0];

    let best = null, bestScore = 0;
    const divs = document.querySelectorAll('div, section');
    for (const d of divs) {
      const t = (d.innerText || '').trim();
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
  const selection = (window.getSelection?.()?.toString() || '').trim();
  const title = document.title || getMeta('og:title') || getMeta('twitter:title') || location.hostname;
  const excerpt = getMeta('description') || getMeta('og:description') || getMeta('twitter:description') || text.slice(0, 240);

  return {
    url: location.href,
    title: title.trim().slice(0, 300),
    excerpt: excerpt.trim().slice(0, 500),
    text: text.slice(0, 60000),
    selection: selection.slice(0, 5000),
    favicon: favicon(),
    author: getMeta('author') || getMeta('article:author') || '',
    siteName: getMeta('og:site_name') || location.hostname,
    publishedAt: getMeta('article:published_time') || getMeta('og:updated_time') || '',
    capturedAt: Date.now(),
    lang: document.documentElement.lang || '',
  };
}
