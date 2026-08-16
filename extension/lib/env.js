// Runtime helpers — let the dashboard work in two modes:
//   1. As a Chrome extension page → uses chrome.storage and chrome.runtime
//   2. As a regular web page (preview / demo) → falls back to localStorage
//
// This means the preview at localhost can be a real working demo for anyone
// who pastes an OpenAI key, not just a static design surface.

export const inExtension =
  typeof chrome !== 'undefined' &&
  !!chrome.runtime &&
  !!chrome.runtime.id;

export async function getSetting(key) {
  if (inExtension && chrome.storage?.local) {
    const obj = await chrome.storage.local.get(key);
    return obj[key];
  }
  try {
    const raw = localStorage.getItem('mem.' + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch { return undefined; }
}

export async function setSetting(key, value) {
  if (inExtension && chrome.storage?.local) {
    return chrome.storage.local.set({ [key]: value });
  }
  localStorage.setItem('mem.' + key, JSON.stringify(value));
}

export async function removeSetting(key) {
  if (inExtension && chrome.storage?.local) {
    return chrome.storage.local.remove(key);
  }
  localStorage.removeItem('mem.' + key);
}

export function openOptions() {
  if (inExtension && chrome.runtime?.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  // Same-tab navigation for the preview / web page.
  window.location.href = 'options.html';
}

export function openDashboard() {
  if (inExtension && chrome.tabs?.create) {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    return;
  }
  window.open('dashboard.html', '_blank');
}

export function openExternal(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}
