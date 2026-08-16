// Ambient layer — the part of mem that runs on the page you're actually on.
//
// Three jobs, in increasing order of how carefully they have to behave:
//
//   1. Engagement signals. How long you stayed and how far you scrolled.
//      Two numbers, no content, and they're what make "you started this and
//      never finished it" answerable at all.
//
//   2. Related memories. A small pill that appears only when something you
//      saved before genuinely relates to the page you're on. The check costs
//      nothing — the service worker runs a lexical lookup on the title, so no
//      embedding call and no page content leaves the tab.
//
//   3. Commitment watching. On messaging sites you've opted in to, watches
//      for messages that contain both a time and an obligation and offers to
//      set a reminder. Detection is pure local string work; nothing is sent
//      anywhere unless you click "Remind me", and then only the one line.
//
// This is a classic content script — content_scripts can't be ES modules — so
// the detector is pulled in with a dynamic import from web-accessible
// resources rather than being duplicated here.

(() => {
  if (window.__memAmbientLoaded) return;
  window.__memAmbientLoaded = true;

  const ORIGIN = location.origin;
  const START = Date.now();

  let config = { related: true, commitments: false, engagement: true };
  let commitmentsMod = null;
  let ui = null;

  // ---------- shadow-root UI ----------

  // Everything renders inside a shadow root so no host page styling can
  // reach it and, just as importantly, mem's styling can't disturb the page.
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = '__mem_ambient';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483600;right:0;bottom:0;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
        .stack {
          position: fixed; right: 16px; bottom: 16px;
          display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
          max-width: min(360px, calc(100vw - 32px));
        }
        .card {
          background: rgba(255,255,255,0.86);
          -webkit-backdrop-filter: saturate(180%) blur(20px);
          backdrop-filter: saturate(180%) blur(20px);
          color: #1d1d1f;
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 14px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.16);
          padding: 12px 13px;
          width: 100%;
          animation: rise .22s cubic-bezier(.2,.7,.3,1) both;
        }
        @media (prefers-color-scheme: dark) {
          .card { background: rgba(28,28,30,0.86); color: #f2f2f4; border-color: rgba(255,255,255,0.1); }
          .sub { color: #a1a1a6 !important; }
          .quote { background: rgba(255,255,255,0.06) !important; }
          .ghost { color: #a1a1a6 !important; }
          .item { border-color: rgba(255,255,255,0.08) !important; }
        }
        @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
        .row { display: flex; align-items: baseline; gap: 8px; }
        .eyebrow {
          font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
          color: #0071e3; flex: 1;
        }
        .close {
          all: unset; cursor: pointer; color: #86868b; font-size: 15px; line-height: 1;
          padding: 2px 4px; border-radius: 6px;
        }
        .close:hover { color: inherit; }
        .close:focus-visible { outline: 2px solid #0071e3; outline-offset: 1px; }
        .title { font-size: 13.5px; font-weight: 600; line-height: 1.35; margin: 5px 0 2px; }
        .sub { font-size: 12px; color: #6e6e73; line-height: 1.45; }
        .quote {
          font-size: 12px; line-height: 1.45; margin: 7px 0 0; padding: 7px 9px;
          background: rgba(0,0,0,0.04); border-radius: 8px;
          max-height: 74px; overflow: hidden;
        }
        .actions { display: flex; gap: 7px; margin-top: 10px; }
        button.act {
          all: unset; cursor: pointer; font-size: 12.5px; font-weight: 600;
          padding: 6px 13px; border-radius: 980px; background: #0071e3; color: #fff;
          line-height: 1.35;
        }
        button.act:hover { background: #0077ed; }
        button.act:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        button.ghost {
          all: unset; cursor: pointer; font-size: 12.5px; font-weight: 500;
          padding: 6px 11px; border-radius: 980px; color: #6e6e73; line-height: 1.35;
        }
        button.ghost:hover { color: inherit; }
        button.ghost:focus-visible { outline: 2px solid #0071e3; outline-offset: 1px; }
        .pill {
          all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px;
          background: rgba(255,255,255,0.88);
          -webkit-backdrop-filter: saturate(180%) blur(20px);
          backdrop-filter: saturate(180%) blur(20px);
          color: #1d1d1f; border: 1px solid rgba(0,0,0,0.08);
          border-radius: 980px; padding: 7px 13px; font-size: 12.5px; font-weight: 550;
          box-shadow: 0 4px 18px rgba(0,0,0,0.14); line-height: 1.4;
        }
        @media (prefers-color-scheme: dark) {
          .pill { background: rgba(28,28,30,0.88); color: #f2f2f4; border-color: rgba(255,255,255,0.1); }
        }
        .pill:hover { transform: translateY(-1px); }
        .pill:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #0071e3; flex: none; }
        .item { display: block; padding: 7px 0; border-top: 1px solid rgba(0,0,0,0.07); text-decoration: none; color: inherit; cursor: pointer; }
        .item:first-of-type { border-top: 0; }
        .item-t { font-size: 12.5px; font-weight: 600; line-height: 1.35; }
        .item-s { font-size: 11.5px; color: #6e6e73; margin-top: 2px; line-height: 1.4;
                  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      </style>
      <div class="stack" role="region" aria-label="mem"></div>`;
    (document.body || document.documentElement).appendChild(host);
    ui = { host, root, stack: root.querySelector('.stack') };
    return ui;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /**
   * Only http(s) URLs may reach an href. Memory URLs are not all
   * self-generated — they arrive from the LifeOS page bridge and from
   * approved external extensions — so a stored `javascript:` URL would
   * otherwise execute in the *host page's* context when clicked, from a link
   * mem injected. Anything else renders as inert text.
   */
  function safeHref(url) {
    try {
      const u = new URL(String(url), location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch {
      return null;
    }
  }

  function dismiss(el) {
    el.remove();
    if (ui && ui.stack.children.length === 0) {
      ui.host.remove();
      ui = null;
    }
  }

  // ---------- 1. engagement ----------

  let maxScroll = 0;
  let activeMs = 0;
  let lastTick = Date.now();
  let visible = document.visibilityState === 'visible';

  function trackScroll() {
    const doc = document.documentElement;
    const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight);
    const pct = scrollable <= 1 ? 1 : Math.min(1, (window.scrollY + window.innerHeight) / doc.scrollHeight);
    if (pct > maxScroll) maxScroll = pct;
  }

  function tick() {
    const now = Date.now();
    // Only count time the tab was actually in front. A page left open in a
    // background tab for six hours was not read for six hours, and treating
    // it as engagement would poison every signal built on top of it.
    if (visible) activeMs += now - lastTick;
    lastTick = now;
  }

  function reportEngagement() {
    tick();
    if (!config.engagement) return;
    if (activeMs < 4000) return;             // too brief to mean anything
    send({
      type: 'ambient-engagement',
      url: location.href,
      dwellMs: activeMs,
      scrollPct: Number(maxScroll.toFixed(3)),
    });
  }

  // ---------- 2. related memories ----------

  async function checkRelated() {
    if (!config.related) return;
    const title = (document.title || '').trim();
    if (title.length < 8) return;
    const res = await send({ type: 'ambient-related', url: location.href, title });
    if (!res || !res.ok || !res.items || res.items.length === 0) return;
    showRelatedPill(res.items);
  }

  function showRelatedPill(items) {
    const { stack } = ensureUI();
    const card = document.createElement('div');
    const n = items.length;
    card.innerHTML = `
      <button class="pill" aria-expanded="false">
        <span class="dot"></span>
        <span>You've saved ${n} related thing${n === 1 ? '' : 's'}</span>
      </button>`;
    const pill = card.querySelector('.pill');

    pill.addEventListener('click', () => {
      card.innerHTML = `
        <div class="card" role="dialog" aria-label="Related memories">
          <div class="row">
            <span class="eyebrow">From your memory</span>
            <button class="close" aria-label="Dismiss">✕</button>
          </div>
          <div class="items"></div>
        </div>`;
      const list = card.querySelector('.items');
      for (const it of items) {
        const href = safeHref(it.url);
        // A non-navigable memory (a note, a reminder) still renders — just
        // not as a link.
        const a = document.createElement(href ? 'a' : 'div');
        a.className = 'item';
        if (href) {
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
        const t = document.createElement('div');
        t.className = 'item-t';
        t.textContent = it.title || '';
        const s = document.createElement('div');
        s.className = 'item-s';
        s.textContent = it.summary ? `${it.when} · ${it.summary}` : (it.when || '');
        a.append(t, s);
        list.appendChild(a);
      }
      card.querySelector('.close').addEventListener('click', () => dismiss(card));
    });

    stack.appendChild(card);
    // Related context is useful, not urgent — let it retire on its own.
    setTimeout(() => { if (card.querySelector('.pill')) dismiss(card); }, 25000);
  }

  // ---------- 3. commitment watching ----------

  const seenText = new Set();
  const pending = [];
  let promptsShown = 0;
  let promptOpen = false;
  let scanQueued = false;

  const MAX_PROMPTS_PER_PAGE = 8;
  const MAX_SEEN = 2000;

  function isSkippable(el) {
    const tag = el.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
           tag === 'NAV' || tag === 'HEAD' || el.id === '__mem_ambient' ||
           el.isContentEditable;
  }

  /**
   * Is this element plausibly a single message?
   *
   * Deliberately platform-agnostic: no Discord or Slack selectors, because
   * "any messaging platform" means the heuristic has to be about shape, not
   * about markup. A message is a smallish block of text that just appeared
   * and is currently on screen.
   */
  function candidateText(el) {
    if (!el || el.nodeType !== 1 || isSkippable(el)) return null;
    // Containers with many element children are threads, not messages.
    if (el.childElementCount > 12) return null;
    // textContent, not innerText: innerText forces a synchronous layout, and
    // this runs up to 60 times per idle callback on a chat page that is
    // mutating constantly. The rendered-vs-source difference doesn't matter
    // for a length check followed by a regex.
    const t = (el.textContent || '').trim();
    if (t.length < 10 || t.length > 600) return null;
    // Newly loaded scrollback sits above the viewport; live messages arrive
    // inside it. Requiring visibility is what keeps a channel's six-month
    // history from generating a burst of prompts on load.
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) return null;
    return t;
  }

  function queueScan(nodes) {
    for (const n of nodes) {
      if (n.nodeType === 3 && n.parentElement) pending.push(n.parentElement);
      else if (n.nodeType === 1) pending.push(n);
      if (pending.length > 200) break;
    }
    if (scanQueued) return;
    scanQueued = true;
    // Batched on an idle callback: a busy chat mutates constantly and this
    // must never be what makes the page feel slow.
    const run = () => { scanQueued = false; drainScan(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 400);
  }

  async function drainScan() {
    if (!config.commitments || !commitmentsMod) { pending.length = 0; return; }
    if (promptOpen || promptsShown >= MAX_PROMPTS_PER_PAGE) { pending.length = 0; return; }
    // Ignore the initial render — the first burst of nodes is the page
    // loading its history, not someone saying something to you.
    if (Date.now() - START < 2500) { pending.length = 0; return; }

    const batch = pending.splice(0, 60);
    for (const el of batch) {
      const text = candidateText(el);
      if (!text) continue;
      const key = text.slice(0, 160);
      if (seenText.has(key)) continue;
      seenText.add(key);
      if (seenText.size > MAX_SEEN) seenText.clear();

      let hit = null;
      try {
        hit = commitmentsMod.detectCommitment(text, { now: Date.now() });
      } catch { continue; }
      if (!hit) continue;

      showCommitmentPrompt(hit);
      return; // one at a time, always
    }
  }

  function showCommitmentPrompt(hit) {
    const { stack } = ensureUI();
    promptOpen = true;
    promptsShown++;

    const card = document.createElement('div');
    const when = commitmentsMod.describeWhen(hit.at);
    const exact = new Date(hit.at).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    card.innerHTML = `
      <div class="card" role="alertdialog" aria-label="Set a reminder">
        <div class="row">
          <span class="eyebrow">Looks like a reminder</span>
          <button class="close" aria-label="Dismiss">✕</button>
        </div>
        <div class="title">${esc(hit.what)}</div>
        <div class="sub">${esc(exact)} · ${esc(when)}</div>
        <div class="actions">
          <button class="act">Remind me</button>
          <button class="ghost mute">Not this one</button>
        </div>
      </div>`;

    const finish = () => { promptOpen = false; dismiss(card); };
    card.querySelector('.close').addEventListener('click', finish);
    card.querySelector('.mute').addEventListener('click', finish);
    card.querySelector('.act').addEventListener('click', async () => {
      const btn = card.querySelector('.act');
      btn.textContent = 'Setting…';
      const res = await send({
        type: 'create-reminder',
        what: hit.what,
        at: hit.at,
        snippet: hit.snippet,
        sourceUrl: location.href,
        sourceTitle: document.title.slice(0, 120),
        origin: location.hostname,
      });
      if (res && res.ok) {
        card.querySelector('.title').textContent = 'Reminder set';
        card.querySelector('.sub').textContent = `${exact} · ${when}`;
        card.querySelector('.actions').remove();
        setTimeout(finish, 2400);
      } else {
        btn.textContent = 'Try again';
      }
    });

    stack.appendChild(card);
    // An unanswered prompt retires rather than sitting over the conversation.
    setTimeout(() => { if (card.isConnected) finish(); }, 30000);
  }

  // ---------- offering to watch a conversation ----------

  // Known messaging surfaces, plus a structural fallback so the offer isn't
  // limited to a list someone has to keep updating.
  const CHAT_HOSTS = [
    'discord.com', 'slack.com', 'web.whatsapp.com', 'teams.microsoft.com',
    'teams.live.com', 'messenger.com', 'web.telegram.org', 'telegram.org',
    'mail.google.com', 'chat.google.com', 'outlook.office.com',
    'outlook.live.com', 'signal.org', 'element.io', 'matrix.org',
    'groupme.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  ];

  function looksLikeAChat() {
    const host = location.hostname.replace(/^www\./, '');
    if (CHAT_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    // Structural fallback: a live message log plus somewhere to type is what
    // every chat has in common, whatever it is called.
    const log = document.querySelector('[role="log"], [aria-live="polite"] [role="listitem"], ol[role="list"] > li');
    const composer = document.querySelector('[contenteditable="true"], textarea');
    return !!(log && composer);
  }

  function offerToWatch() {
    const { stack } = ensureUI();
    const card = document.createElement('div');
    const site = location.hostname.replace(/^www\./, '');
    card.innerHTML = `
      <div class="card" role="dialog" aria-label="Watch this site for reminders">
        <div class="row">
          <span class="eyebrow">mem</span>
          <button class="close" aria-label="Dismiss">✕</button>
        </div>
        <div class="title">Catch deadlines on ${esc(site)}?</div>
        <div class="sub">When someone gives you a time — "due Friday at 3pm" — mem can offer to remind you. It reads messages on this site only, entirely on your device, and sends nothing anywhere.</div>
        <div class="actions">
          <button class="act">Yes, watch this site</button>
          <button class="ghost never">Not here</button>
        </div>
      </div>`;

    const close = () => dismiss(card);
    card.querySelector('.close').addEventListener('click', async () => {
      // Dismissing without choosing asks again next time; "Not here" doesn't.
      close();
    });
    card.querySelector('.never').addEventListener('click', async () => {
      await send({ type: 'commitment-watch-decline', origin: ORIGIN });
      close();
    });
    card.querySelector('.act').addEventListener('click', async () => {
      const btn = card.querySelector('.act');
      btn.textContent = 'Turning on…';
      const res = await send({ type: 'commitment-watch-set', origin: ORIGIN, enabled: true });
      if (res && res.ok) {
        card.querySelector('.title').textContent = 'Watching this conversation';
        card.querySelector('.sub').textContent = 'mem will offer a reminder when it spots a deadline. Turn it off any time in Settings.';
        card.querySelector('.actions').remove();
        setTimeout(close, 3200);
        // Start watching immediately rather than making the user reload.
        config.commitments = true;
        startWatching();
      } else {
        btn.textContent = 'Try again';
      }
    });

    stack.appendChild(card);
  }

  async function startWatching() {
    if (commitmentsMod) return;
    try {
      commitmentsMod = await import(chrome.runtime.getURL('lib/commitments.js'));
    } catch (e) {
      console.warn('[mem] could not load the commitment detector:', e.message);
      return;
    }
    const obs = new MutationObserver((records) => {
      const nodes = [];
      for (const r of records) {
        if (r.type === 'characterData') nodes.push(r.target);
        else for (const n of r.addedNodes) nodes.push(n);
      }
      if (nodes.length) queueScan(nodes);
    });
    obs.observe(document.body || document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  }

  // ---------- messaging ----------

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          // Reading lastError suppresses the "unchecked runtime.lastError"
          // console noise when the worker is asleep or the page is closing.
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch { resolve(null); }
    });
  }

  // ---------- boot ----------

  async function boot() {
    const res = await send({ type: 'ambient-config', origin: ORIGIN });
    if (res && res.ok) config = { ...config, ...res.config };

    if (config.engagement) {
      window.addEventListener('scroll', trackScroll, { passive: true });
      trackScroll();
      document.addEventListener('visibilitychange', () => {
        tick();
        visible = document.visibilityState === 'visible';
        if (!visible) reportEngagement();
      });
      window.addEventListener('pagehide', reportEngagement);
      setInterval(tick, 5000);
    }

    if (config.related) {
      // Wait for the title to settle — single-page apps set it late.
      setTimeout(checkRelated, 2500);
    }

    // Watching is opt-in per site and off by default, which is right for
    // reading someone's messages — but silently doing nothing forever is not
    // a discoverable default. On a site that is obviously a conversation, ask
    // once. Declining is remembered, so it never asks about that site again.
    if (!config.commitments && config.offerWatch && looksLikeAChat()) {
      offerToWatch();
      return;
    }

    if (config.commitments) await startWatching();
  }

  // Let the page render before doing anything at all.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // The service worker asks for this when the user picks "Remind me about
  // this" from the context menu, which works on every site with no opt-in
  // because the user selected the text themselves.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ambient-prompt-selection') {
      (async () => {
        if (!commitmentsMod) {
          try { commitmentsMod = await import(chrome.runtime.getURL('lib/commitments.js')); }
          catch { sendResponse({ ok: false }); return; }
        }
        const text = String(msg.text || '').trim();
        const hit = commitmentsMod.detectCommitment(text, { now: Date.now(), minConfidence: 0.2 })
          || fallbackFromSelection(text);
        if (!hit) { sendResponse({ ok: false, reason: 'no time found' }); return; }
        promptOpen = false;
        showCommitmentPrompt(hit);
        sendResponse({ ok: true });
      })();
      return true;
    }
    return false;
  });

  /**
   * The user explicitly asked about this text, so a bare time with no
   * obligation cue is enough — the selection itself is the intent.
   */
  function fallbackFromSelection(text) {
    if (!commitmentsMod) return null;
    const when = commitmentsMod.parseWhen(text, Date.now());
    if (!when || when.at < Date.now()) return null;
    return {
      what: text.length > 90 ? text.slice(0, 87).trim() + '…' : text,
      at: when.at,
      whenText: when.whenText,
      confidence: 1,
      cue: 'selected',
      snippet: text.slice(0, 300),
    };
  }
})();
