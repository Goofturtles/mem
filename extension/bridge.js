// mem ← LifeOS bridge
//
// Runs as a content script ONLY on LifeOS origins (see manifest content_scripts).
// Translates window.postMessage from the LifeOS page into chrome.runtime.sendMessage
// to the mem service worker, and posts the response back to the page.
//
// LifeOS protocol:
//   page → window.postMessage({ source: "lifeos", id, type, payload }, "*")
//   page ← window.postMessage({ source: "mem-extension", id, ok, data, error })
//
// Supported `type` values:
//   "ping"        — health check, returns { version }
//   "list"        — returns recent memories (limit ?? 200)
//   "search"      — text-search memories ({ q, limit })
//   "save"        — save a memory ({ title, url, summary, tags[] })
//   "delete"      — delete by id ({ id })

(() => {
  const PROTOCOL_VERSION = 1;

  function reply(id, payload) {
    window.postMessage({ source: "mem-extension", id, ...payload }, "*");
  }

  window.addEventListener("message", async (event) => {
    // Only accept messages from this same page
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "lifeos" || !msg.type) return;
    const { id, type, payload = {} } = msg;

    try {
      switch (type) {
        case "ping": {
          reply(id, { ok: true, data: { version: PROTOCOL_VERSION } });
          break;
        }
        case "list": {
          const resp = await chrome.runtime.sendMessage({
            type: "bridge-list-memories",
            limit: Number(payload.limit) || 200,
          });
          reply(id, resp);
          break;
        }
        case "search": {
          const resp = await chrome.runtime.sendMessage({
            type: "bridge-search-memories",
            q: String(payload.q || ""),
            limit: Number(payload.limit) || 50,
          });
          reply(id, resp);
          break;
        }
        case "save": {
          const resp = await chrome.runtime.sendMessage({
            type: "bridge-save-memory",
            title: String(payload.title || ""),
            url: String(payload.url || ""),
            summary: String(payload.summary || ""),
            tags: Array.isArray(payload.tags) ? payload.tags : [],
          });
          reply(id, resp);
          break;
        }
        case "delete": {
          const resp = await chrome.runtime.sendMessage({
            type: "bridge-delete-memory",
            id: String(payload.id || ""),
          });
          reply(id, resp);
          break;
        }
        default:
          reply(id, { ok: false, error: "Unknown type: " + type });
      }
    } catch (e) {
      reply(id, { ok: false, error: e?.message || "Bridge error" });
    }
  });

  // Announce presence on load so LifeOS can latch on without polling.
  window.postMessage({ source: "mem-extension", type: "hello", version: PROTOCOL_VERSION }, "*");
})();
