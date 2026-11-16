# RK's Video Library

A mobile-first, installable (PWA) library of Summer's video summaries. Same look and setup as the Drink Library. There's no build step.

## Add to Home Screen (iPhone)

1. Open the site in Safari.
2. Tap Share, then **Add to Home Screen**.

After the first visit it works offline.

## Tabs

- **Library**: search across all text, category pills, and video cards. Tap a card to open its detail sheet. The sheet has a Watch button, the gist, key points, a tickable "What to do" list, jump-to timestamps, a "Watch out" line and Delete (with a confirm step).
- **Big picture**: takeaways across the investing videos. These are YouTubers' claims, not advice.
- **Action list**: every "What to do" item from every video in one tickable list.

Ticks and deletions sync through the Worker once you sign in with your PIN, and are cached in `localStorage`. The gear icon (top right) has **Restore** for deleted videos and **Untick everything**. To remove a video for good, delete its entry from `videos.json`.

## Sign in, sync and Add video

Every video shows without signing in. A PIN turns on two things: **sync** (deletes and checklist ticks are the same on every device) and **Add video**.

The app talks to a small Cloudflare Worker, `video-library-api`, at `https://video-library-api.rkem1800.workers.dev`, which stores data in a KV namespace of the same name. Its source is in [`worker/worker.js`](worker/worker.js). The webhook URL and sender key live only in KV. They are never in this repo or in the app.

**First time (gear icon → Set up):** pick a PIN (at least 6 characters), then paste the **Webhook URL** and **Sender key** from Summer's Routines tab → *Video Library: add pasted video*. They show in the Grok Bot desktop app.

**Other devices (gear → Sign in with PIN):** enter the same PIN. The PIN is remembered on that device. Anything deleted or ticked there before signing in is merged in. **Sign out** forgets the PIN. **Change PIN or webhook** updates the Worker, and you need the current PIN to do it.

**Add video:** the gold **+ Add video** button. Paste a link or tap **Paste**, then tap **Send**. Accepted links: `youtube.com/watch`, `youtu.be`, `youtube.com/shorts`, `youtube.com/live`, and Facebook video or reel links (`reel/`, `/videos/`, `watch?v=`, `share/r|v/`, `fb.watch`). The Worker forwards the link to Summer's webhook with `Authorization: Bearer <key>` and the body `{"url": "<link>", "source": "video-library-app"}`, then shows the webhook's real HTTP status. If sending fails, the app shows a **Copy link** button so you can paste the link into Summer's chat instead. The last 15 sends show under "Sent recently".

localStorage stays as an offline cache. Changes made offline sync the next time the app is online.

### Worker API

All endpoints use JSON. CORS allows only `https://rkem1800-sketch.github.io`.

| Endpoint | PIN (`X-PIN` header) | What it does |
|---|---|---|
| `GET /status` | no | `{setup: true/false}` |
| `POST /setup` | only after the first setup | First time: `{pin, webhookUrl, webhookKey}`. Later: `{newPin?, webhookUrl?, webhookKey?}`. The PIN is stored as salted SHA-256. |
| `GET /state` | yes | `{state: {deleted: [], ticks: {}, updatedAt}}` |
| `PUT /state` | yes | Body `{deleted: [], ticks: {}}`. Last write wins. |
| `POST /add` | yes | Body `{url}`. Returns `{ok, webhookStatus}`. |

Wrong PINs: 10 from one IP (or 50 total) lock PIN checks for 15 minutes (HTTP 429).

### Penguin HQ endpoints

The same Worker also serves Penguin HQ (https://rkem1800-sketch.github.io/penguin-hq/): board (`/hq/state`, `/hq/tasks`), workspaces (`/hq/ws`, `/hq/ws/<ar|closeout|members|permits>`), activity (`/hq/activity`) and the daily brief (`/hq/brief`). Reads and app writes use this same PIN and lockout. Bot writes use write-only Bearer tokens whose SHA-256 hashes are the Worker secrets `HQ_WRITE_TOKEN_HASH` and `HQ_BRIEF_TOKEN_HASH`. See the penguin-hq README for formats.

## Run locally

```bash
python3 -m http.server 8080
```

## videos.json format

```json
{
  "bigPicture": {
    "note": "These are YouTubers' claims, not advice.",
    "agree": { "title": "Where they agree", "text": "..." },
    "views": [{ "who": "Felix", "title": "...", "detail": "...", "videoId": "GSDnRo7IuuU" }]
  },
  "videos": [
    {
      "id": "GSDnRo7IuuU",
      "youtubeId": "GSDnRo7IuuU",
      "category": "Investing",
      "title": "Video title",
      "channel": "Channel name",
      "date": "2026-10-29",
      "dateLabel": "Oct 29, 2026",
      "length": "20:34",
      "url": "https://youtu.be/GSDnRo7IuuU",
      "gist": "One or two sentences.",
      "points": [{ "title": "Short idea", "text": "One line." }],
      "todo": ["Action item written as a to-do"],
      "stamps": [{ "seconds": 168, "label": "What happens here" }],
      "links": [{ "title": "Extra link", "href": "https://..." }],
      "list": { "heading": "His short list", "rows": [{ "lead": "STX", "title": "Seagate", "detail": "One line." }] },
      "watch": "Sponsor / unverified-claim caveat, or null"
    }
  ]
}
```

Field notes:

- `category` must be one of `Investing`, `Crypto`, `Motivation`, `Sales`. Each one sets the card's color and drawn icon. To add a new category, add it to `CAT` and `icon()` in `index.html`.
- `id` must be unique and must not change, because ticks and deletions are keyed to it.
- `youtubeId` builds the timestamp links (`https://youtu.be/<id>?t=<seconds>`). For a channel or collection entry, set it to `null` and leave `stamps` empty.
- `date` (`YYYY-MM-DD`, or `null`) sets the order, newest first. Entries with `null` go last.
- `links`, `list` and `watch` are optional.
- After editing, bump `CACHE` in `sw.js` so installed copies refresh quickly. They fetch network-first anyway.
