# Connecting mem to your Google account

mem can index your Drive (Docs / Slides / Sheets), Gmail subjects, YouTube
playlists, and Calendar events. To do that, Google needs to know it can let
*this specific extension* talk to *your specific account*. That's a one-time
setup, ~5 minutes, all in the Google Cloud Console.

If you only want browser-history + bookmark indexing, skip this whole file —
it runs automatically on install with no Google account required.

---

## TL;DR

You're going to do three things, in this order:

1. Make a Google Cloud project.
2. Configure the **OAuth consent screen** — text Google will show you when
   you authorize the extension.
3. Make an **OAuth client ID** — a token that proves it's *this* extension
   talking, not someone else.

Then paste the resulting client ID into `extension/manifest.json` and reload.

---

## Step 1 — Create a project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Top bar → project dropdown → **New project**.
3. Name it anything (`mem`, `personal-memory`, whatever). Create.
4. Make sure the project is selected in the top bar before continuing.

## Step 2 — Enable the APIs you'll use

1. Sidebar → **APIs & Services** → **Library**.
2. Search for and **Enable** each of:
   - **Google Drive API**
   - **Gmail API**
   - **YouTube Data API v3**
   - **Google Calendar API**

(You can skip any of these — for example, if you don't care about Gmail,
don't enable the Gmail API. mem will just fail-quietly for that source.)

## Step 3 — OAuth consent screen

> *"OAuth consent screen"* = the popup Google will show you when you press
> "Connect Google" in mem. You're filling in what shows in that popup.

The UI has been reorganized recently. Pick the path that matches what you see.

### Path A — newer UI ("Google Auth Platform")

1. Sidebar → **Google Auth Platform** → **Branding**.
2. **App information:**
   - App name: `mem`
   - User support email: your Gmail
3. **Audience:** **External**.
   - This sounds scary but isn't — it just means "any Google account can in
     principle use this app." Until you publish, only emails you add as test
     users can actually authorize, so it's effectively private to you.
4. **Contact information:** your Gmail.
5. Agree to the terms → **Create**.
6. Sidebar → **Data Access** → **Add or remove scopes**.
   - In the **Filter** box, paste each of these one at a time and tick the
     matching row:
     - `drive.readonly`
     - `gmail.readonly`
     - `youtube.readonly`
     - `calendar.readonly`
   - **Update** → **Save**.
7. Sidebar → **Audience** → **Test users** → **Add users**.
   - Add your own Gmail (the account whose data you want indexed).
   - **Save**.

### Path B — older UI ("APIs & Services / OAuth consent screen")

1. Sidebar → **APIs & Services** → **OAuth consent screen**.
2. User Type: **External**. **Create**.
3. Fill in App name, User support email, Developer contact.
   **Save and continue**.
4. **Scopes** step: **Add or remove scopes**.
   - Filter and tick `drive.readonly`, `gmail.readonly`, `youtube.readonly`,
     `calendar.readonly`. **Update** → **Save and continue**.
5. **Test users** step: **+ Add users**. Add your own Gmail. **Save and continue**.
6. **Summary** → done. You can leave **Publishing status** as "Testing".

## Step 4 — Create the OAuth client

This is separate from the consent screen.

1. Sidebar → **APIs & Services** → **Credentials**.
2. Top → **+ Create credentials** → **OAuth client ID**.
3. **Application type:** **Chrome extension** (or older UI: **Chrome app**).
4. Open `chrome://extensions` in another tab; find the mem extension; copy
   the long string under its name (looks like
   `bgdnnjlhhofmpmnedlgloempifjdfbbf`).
5. Paste it into **Item ID** (older UI: **Application ID**).
6. **Create**.
7. Copy the string that ends in `.apps.googleusercontent.com` — that's your
   client ID.

## Step 5 — Plug it in

1. Open `extension/manifest.json`.
2. Find the line:
   ```json
   "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
   ```
3. Replace the placeholder with what you just copied. Save.
4. Go to `chrome://extensions` → click the **reload** icon on mem.
5. Open mem Settings → **Connect Google**. A standard Chrome account picker
   should appear. Pick the Gmail you added as a test user. Done.

If it errors with "bad client" or similar, double-check that the extension
ID you pasted into Google Cloud matches the one shown at `chrome://extensions`
*right now* (it can change if you unload and reload to a different path).

---

## What it looks like when it works

After connecting:
- Settings → Google account shows "Connected as you@gmail.com".
- The **Sync Drive now** button appears under it.
- Clicking it pulls your most recently viewed Docs / Slides / Sheets and
  ingests them. You'll see the dashboard count climb.

To pull everything else (Gmail subjects, YouTube playlists, Calendar), open
the dashboard while a fresh scan is queued — those run as part of the
first-install scan flow. If you skipped that, you can re-trigger it from
the scan pane in onboarding by erasing all memories and reloading.

---

## Why this can't be one click

Chrome ties every OAuth client to a *specific* extension ID. Unpacked
extensions get an ID derived from where you put the folder on disk — so your
ID is different from mine. Without a published, signed extension and a real
deployed backend, there is no way to ship a single hardcoded client ID that
works for everyone. The above is the minimum unavoidable setup.

Once you have a client ID set, *everything else* (account picker, token
refresh, scope grants) happens silently. The one-time pain buys all of that.
