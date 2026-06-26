# SecPlus Tracker — Setup Guide

A phone/iPad study app for the Professor Messer Security+ SY0-701 playlist. Tracks what to study today,
your confidence per video, a domain roadmap, and a spaced-repetition weakspot review. Hosted free on
**GitHub Pages**, synced across your devices with **Firebase**.

Setup is four stages. Total time ~30–40 min the first time. You only do stages 1–3 once.

---

## What you need first

- A **GitHub account** (free).
- A **Google account** (you already have one — it's also your Firebase + YouTube API login).
- **Node.js** installed on your computer (only to generate the playlist file once). Get it at
  nodejs.org if you don't have it. Check with `node --version`.

---

## Stage 1 — Get the playlist data

This pulls all ~170 videos, their order, and exact durations into `data/videos.json`.

1. **Get a YouTube Data API key:**
   - Go to <https://console.cloud.google.com/> and sign in.
   - Create a new project (top bar → "New Project"), name it anything.
   - In the search bar, find **"YouTube Data API v3"** and click **Enable**.
   - Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key.

2. **Run the generator script** (from the project folder Claude Code built):

   ```bash
   # macOS / Linux
   export YT_API_KEY="paste-your-key-here"
   node scripts/fetch-playlist.js

   # Windows (PowerShell)
   $env:YT_API_KEY="paste-your-key-here"
   node scripts/fetch-playlist.js
   ```

   This writes `data/videos.json`. Open it to confirm it has ~170 entries with durations.

> You only need the API key for this one step. The live app never calls YouTube's API, so you can
> delete the key afterward if you want.

---

## Stage 2 — Set up Firebase (sync + login)

This is what makes your iPhone and iPad show the same data.

1. Go to <https://console.firebase.google.com/> → **Add project**. Name it, accept defaults, skip
   Google Analytics (not needed).

2. **Enable Google sign-in:**
   - Left menu → **Build → Authentication → Get started**.
   - **Sign-in method** tab → click **Google** → toggle **Enable** → pick your support email → **Save**.

3. **Create the database:**
   - Left menu → **Build → Firestore Database → Create database**.
   - Choose **Start in production mode** → pick a location near you → **Enable**.

4. **Set the security rules** so only you can read/write your own data:
   - In Firestore → **Rules** tab → replace everything with this → **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

5. **Get your config:**
   - Project Overview (top) → click the **web icon `</>`** to "Add app". Give it a nickname → **Register**.
   - It shows a `firebaseConfig = { ... }` object. Copy the values into the project's
     **`firebase-config.js`** file (Claude Code left it for you to fill in). Save.

6. **Authorize your live site for login** (do this after Stage 3 once you know your Pages URL):
   - Authentication → **Settings → Authorized domains → Add domain** → add your GitHub Pages domain,
     e.g. `yourusername.github.io`. (Sign-in will fail until you do this.)

---

## Stage 3 — Put it on GitHub & turn on Pages

1. Create a new repo on GitHub (e.g. `secplus-tracker`). Can be public — none of your Firebase values
   are secret.

2. Push the project files (everything Claude Code built, including `data/videos.json` and your
   filled-in `firebase-config.js`):

   ```bash
   git init
   git add .
   git commit -m "SecPlus Tracker"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/secplus-tracker.git
   git push -u origin main
   ```

3. On GitHub: repo → **Settings → Pages** → under "Build and deployment", set **Source: Deploy from a
   branch**, **Branch: `main` / `root`** → **Save**. Wait ~1 minute.

4. Your app is live at `https://YOURNAME.github.io/secplus-tracker/`. Copy that domain and finish
   **Stage 2, step 6** (add it to Firebase authorized domains).

---

## Stage 4 — Install it on your iPhone / iPad

1. Open the Pages URL in **Safari** on the device.
2. Tap **Share → Add to Home Screen**. Now it has an app icon and opens full-screen.
3. Open it, tap **Sign in with Google**, use the same Google account on both devices.
4. That's it — rate a video on your phone, open the iPad, it's already there.

---

## How to use it day to day

- **Today** opens first: it shows anything due for review, then a pace-sized batch of new videos. Tap
  **Watch now** (opens YouTube), and when you're done, rate your confidence **1–5** right there.
  - 1 = totally lost · 3 = okay · 5 = could teach it.
- **Roadmap**: see each domain's progress, hours of video left, and your **Readiness %** (this counts
  your confidence, not just whether you pressed play — keep it honest).
- **Weakspots**: anything you rated 1–3 comes back on a spaced schedule (low scores return sooner). Rate
  it higher when you've got it and it graduates out. Two 5s in a row = mastered, gone for good.

A real reminder baked into the app: **watching ≠ exam-ready.** Use it to stay on pace, but let Jason
Dion practice tests (~85%+) be your actual go/no-go before booking SY0-701.

---

## Updating the playlist later

If Messer adds/changes videos, re-run **Stage 1** to regenerate `data/videos.json`, then
`git add data/videos.json && git commit -m "update playlist" && git push`. Pages redeploys
automatically. Your ratings and progress are untouched — they live in Firestore, keyed by video ID.

---

## If something breaks

- **Sign-in popup closes / "unauthorized domain":** you skipped Stage 2 step 6 — add your
  `*.github.io` domain to Firebase authorized domains.
- **Blank app / console errors about Firebase:** `firebase-config.js` values are wrong or missing.
- **Empty video list:** `data/videos.json` didn't generate — re-run Stage 1 and check the API key is
  set and the YouTube Data API is enabled.
- **Phone and iPad don't match:** make sure you signed in with the **same** Google account on both.
