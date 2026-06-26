#!/usr/bin/env node
// scripts/fetch-playlist.js
//
// Regenerates data/videos.json from the live Professor Messer SY0-701 playlist
// using the YouTube Data API v3. No npm installs — uses Node's built-in global
// fetch (Node 18+).
//
// Usage:
//   export YT_API_KEY="your-key"      (Windows PowerShell: $env:YT_API_KEY="...")
//   node scripts/fetch-playlist.js
//
// You only need the API key for this one step; the live app never calls YouTube.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLAYLIST_ID = "PLG49S3nxzAnl4QDVqK-hOnoqcSKEIDDuv";
const API = "https://www.googleapis.com/youtube/v3";
const KEY = process.env.YT_API_KEY;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "videos.json");

if (!KEY) {
  console.error("ERROR: set YT_API_KEY first. See README Stage 1.");
  process.exit(1);
}

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`YouTube API ${res.status}: ${msg}`);
  }
  return data;
}

// Step 1+2: page through playlistItems to get videoId, title and order.
async function fetchPlaylistItems() {
  const items = [];
  let pageToken = "";
  do {
    const url = `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${PLAYLIST_ID}` +
      `&pageToken=${pageToken}&key=${KEY}`;
    const data = await getJSON(url);
    for (const it of data.items || []) {
      const sn = it.snippet || {};
      const videoId = sn.resourceId?.videoId;
      const title = sn.title || "";
      // Skip private/deleted placeholders (no playable video).
      if (!videoId || title === "Private video" || title === "Deleted video") continue;
      items.push({ id: videoId, title, position: (sn.position ?? items.length) + 1 });
    }
    pageToken = data.nextPageToken || "";
    process.stdout.write(`\rFetched ${items.length} playlist items…`);
  } while (pageToken);
  process.stdout.write("\n");
  return items;
}

// Step 3+4: batch videos.list for contentDetails → duration in seconds.
async function fetchDurations(ids) {
  const durations = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = `${API}/videos?part=contentDetails&id=${batch.join(",")}&key=${KEY}`;
    const data = await getJSON(url);
    for (const v of data.items || []) durations[v.id] = parseISODuration(v.contentDetails.duration);
  }
  return durations;
}

// Parse ISO-8601 duration like "PT11M30S" or "PT1H2M3S" into integer seconds.
function parseISODuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "") || [];
  const h = Number(m[1] || 0), min = Number(m[2] || 0), s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

// Step 5: derive domain + objective from the title.
// The spec's canonical pattern is `SY0-701 - (\d)\.(\d+)`. We use a tolerant,
// case-insensitive superset so real-world title quirks ("SY0-701 Security+ - 1.2",
// lowercase "Sy0-701", "SY0-701- 2.4") still classify correctly. No objective
// number (course intro/outro) → domain 0, objective null.
function deriveObjective(title) {
  const m = /SY0-?701\b[^0-9]*?(\d)\.(\d+)/i.exec(title || "");
  if (!m) return { domain: 0, objective: null };
  return { domain: Number(m[1]), objective: `${m[1]}.${m[2]}` };
}

async function main() {
  const items = await fetchPlaylistItems();
  if (!items.length) throw new Error("No playlist items returned — check the playlist ID and API key.");
  const durations = await fetchDurations(items.map((i) => i.id));

  const videos = items.map((it) => {
    const { domain, objective } = deriveObjective(it.title);
    return {
      id: it.id,
      title: it.title,
      domain,
      objective,
      position: it.position,
      durationSec: durations[it.id] ?? 0,
      url: `https://www.youtube.com/watch?v=${it.id}`,
    };
  }).sort((a, b) => a.position - b.position);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(videos, null, 2) + "\n");
  console.log(`Wrote ${videos.length} videos to data/videos.json`);
}

main().catch((e) => { console.error("\n" + e.message); process.exit(1); });
