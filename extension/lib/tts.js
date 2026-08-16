// Text-to-speech via the browser's built-in SpeechSynthesis API. No key, no
// quota, works offline. Voices come from the OS.
//
// Usage:
//   const tts = new TTSController();
//   tts.speak('hello world');     // play
//   tts.pause(); tts.resume();
//   tts.stop();
//   tts.onState((state) => ...);  // 'idle' | 'speaking' | 'paused'

export class TTSController {
  constructor() {
    this.synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    this.utterance = null;
    this.listeners = new Set();
    this.state = 'idle';
  }

  available() { return !!this.synth; }

  onState(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.listeners) {
      try { cb(s); } catch {}
    }
  }

  _pickVoice() {
    if (!this.synth) return null;
    const voices = this.synth.getVoices();
    if (!voices || voices.length === 0) return null;
    // Prefer English voices; macOS "Samantha"/"Alex" or Chrome's "Google US English" sound natural.
    const prefer = (v) => {
      const n = (v.name || '').toLowerCase();
      const lang = (v.lang || '').toLowerCase();
      let score = 0;
      if (lang.startsWith('en-us')) score += 4;
      else if (lang.startsWith('en')) score += 3;
      if (n.includes('google')) score += 2;
      if (n.includes('samantha') || n.includes('alex') || n.includes('siri')) score += 3;
      if (v.default) score += 1;
      return score;
    };
    return [...voices].sort((a, b) => prefer(b) - prefer(a))[0] || voices[0];
  }

  // Strip HTML, normalise whitespace, collapse citation tokens into pauses
  // so the reading sounds natural rather than literally saying "hashtag 1".
  static prepareText(htmlOrText) {
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlOrText || '';
    let text = tmp.textContent || '';
    // Replace [#1], #1 citation markers with a brief pause.
    text = text.replace(/\[#\d+\]/g, ',');
    text = text.replace(/\s*#\d+\s*/g, ', ');
    // Collapse whitespace.
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  speak(text, { rate = 1.0, pitch = 1.0 } = {}) {
    if (!this.synth) return;
    this.stop();
    const cleaned = TTSController.prepareText(text);
    if (!cleaned) return;
    const u = new SpeechSynthesisUtterance(cleaned);
    u.rate = rate;
    u.pitch = pitch;
    const voice = this._pickVoice();
    if (voice) u.voice = voice;
    u.onstart = () => this._setState('speaking');
    u.onpause = () => this._setState('paused');
    u.onresume = () => this._setState('speaking');
    u.onend = () => this._setState('idle');
    u.onerror = () => this._setState('idle');
    this.utterance = u;
    // Some browsers need a tick before speak() takes after a stop().
    setTimeout(() => this.synth.speak(u), 30);
  }

  pause() { if (this.synth) this.synth.pause(); }
  resume() { if (this.synth) this.synth.resume(); }
  stop() {
    if (!this.synth) return;
    this.synth.cancel();
    this._setState('idle');
  }
}
