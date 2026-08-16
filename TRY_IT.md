# Try mem in 3 minutes

No account. No API key needed. Nothing leaves your computer.

---

## Step 1 — Load the extension (60 seconds)

1. Download or clone this repo.
2. Open Chrome and go to **`chrome://extensions`**
3. Turn on **Developer mode** — the toggle is in the **top-right corner**.
4. Click **Load unpacked** (top-left).
5. Select the **`extension`** folder inside this repo.
   *(Pick the folder named `extension` — not the outer folder, not a file inside it.)*

```
mem/
└── extension/     ←  select THIS folder
    ├── manifest.json
    ├── background.js
    └── ...
```

mem now appears in your extensions list. Chrome shows a puzzle-piece icon
in the toolbar — click it and pin **mem** so it's always visible.

> **If "Load unpacked" is greyed out:** Developer mode isn't on yet. Go back to step 3.

---

## Step 2 — Open it and load the demo (30 seconds)

Press **`Ctrl+Shift+M`** (Mac: `Cmd+Shift+M`).

> Or **right-click** the mem toolbar icon → **Open mem dashboard**.

You'll see a setup screen. **You do not need an API key to try this.**

Click **"See it work first"** — this loads 5 realistic demo memories
(two research papers, an article, a set of lecture notes from Drive, and an email).

---

## Step 3 — See the thing that makes it not a search bar

In the search box, type this and press **Enter**:

```
how do perovskite solar cells degrade
```

**What to look for:** below the answer, each source card shows a quoted
passage in a bordered box. That is **the specific paragraph that matched your
question** — not the top of the document. That's the whole point of the
project, and it's the one thing a history search fundamentally cannot do.

Then try these, in order — each shows a different capability:

| Type this | What it demonstrates |
| --- | --- |
| `what did I read this week` | Time-scoped recall on real calendar-day boundaries |
| `Give me a daily summary` | A written narrative of your day. Works without a key — the prose is generated locally; a model only makes it richer |
| Click **Sessions** tab | Activity grouped into work sessions, named automatically |
| Click **People & topics** → **Build the graph** | Every person and topic across all sources |
| Click **Resurface** | A forgetting curve over your own memories |

---

## Step 4 — The reminder feature (60 seconds)

This is the part that behaves like an assistant rather than an index.

**The fast way — works anywhere, no setup:**

1. Go to any website.
2. **Select this text with your mouse:**
   `submit the project report by Friday at 3pm`
3. **Right-click** the selection → **"Remind me about this…"**
4. A card appears bottom-right showing the exact date and time it parsed.
   Click **Remind me**.
5. Open the dashboard → **Reminders** tab. It's scheduled.

**The automatic way — on a chat site:**

1. Open Discord, Slack, WhatsApp Web, or any messaging site.
2. mem shows a small card: *"Catch deadlines on discord.com?"* → click **Yes**.
3. When a new message arrives containing a deadline — e.g.
   `hackathon ending tmrw at 12pm` — mem offers to remind you.

**Detection runs entirely on your device.** No model call, no network request.
Nothing is sent anywhere unless you click "Remind me". It's off by default on
every site and asks before turning on.

---

## Step 5 — Run the tests (optional, 30 seconds)

Everything above is backed by a test suite that needs no network and no key.

```bash
python tools/serve.py 3492 extension
```

Open **http://localhost:3492/test/harness.html**

129 tests run automatically. Look for the headline result under
*"Buried facts in long documents"*:

> `chunk #14 of 20: 0.2374 vs document-level 0.0543 — 4.4× better`

That is the core claim, measured: a fact buried 13,650 characters into a
document is invisible to a document-level embedding (0.054, indistinguishable
from noise) but clearly found at passage level (0.237).

---

## Optional — connect a real AI provider

The demo works without one. To use mem on your own browsing:

| Option | Cost | How |
| --- | --- | --- |
| **On-device** | Free, no key | Settings → AI provider → **On-device**. Needs Chrome 138+ desktop and a one-time model download. |
| **Gemini** | Free tier | Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) → paste into Settings. |
| **OpenAI** | ~$0.001/page | Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → paste into Settings. |

Whichever you pick, mem falls back to on-device automatically if your key is
missing, rate-limited, or you're offline — so it never simply stops working.

---

## Troubleshooting

**"This page cannot be captured"** — you're on a `chrome://` page. Chrome
blocks extensions there. Try any normal website.

**Nothing happens when I press Ctrl+Shift+M** — another extension may have
claimed that shortcut. **Right-click** the mem toolbar icon → **Open mem
dashboard** instead.

**The reminder card didn't appear on a chat site** — it only reacts to
messages that arrive *after* you enable it, and only when they contain both a
time and something that reads like a commitment. Use the right-click method
in Step 4 to see it work immediately.

**I want to start over** — Settings → **Erase everything**.

---

## What to look at in the code

If you're reviewing the implementation rather than the product:

| File | Why it's interesting |
| --- | --- |
| `extension/lib/vec.js` | Int8 quantisation with a per-vector scale — measured 14× more accurate than a fixed scale at 1536 dimensions |
| `extension/lib/index.js` | The retrieval index: ordinal table, packed vector shards, BM25 postings. Comments record the bugs that shaped it |
| `extension/lib/search.js` | Two-stage hybrid retrieval with Reciprocal Rank Fusion and MMR |
| `extension/lib/commitments.js` | Local time + obligation parsing, no model involved |
| `extension/test/harness.js` | 129 tests, deterministic, no network |

`README.md` has the architecture diagram and citations.
