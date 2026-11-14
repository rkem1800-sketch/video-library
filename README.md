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

Ticks, deletions, the webhook connection and the sent list are saved in `localStorage` on that device. The gear icon (top right) has **Restore** for deleted videos and **Untick everything**. To remove a video for good, delete its entry from `videos.json`.

## Add a video

The gold **+ Add video** button on the Library tab opens a sheet. Paste a link (or tap **Paste**), then tap **Send**.

- Accepted links: `youtube.com/watch`, `youtu.be`, `youtube.com/shorts`, `youtube.com/live`, and Facebook video or reel links (`facebook.com/reel/…`, `…/videos/…`, `watch?v=`, `share/r|v/…`, `fb.watch`). Channel pages and anything else get an error and a **Copy link** button, so you can paste the link into Summer's chat instead.
- Send POSTs to Summer's Grok Bot routine webhook:
  - `Content-Type: application/json`
  - `Authorization: Bearer <sender key>` (the header documented for Grok Bot routine webhooks)
  - body `{"url": "<link>", "source": "video-library-app"}`
  - A 200 means the routine started. Any other status is shown in the app.
- If the browser blocks the request (CORS or network), the app retries once with `mode: "no-cors"` and a `text/plain` body and shows "Probably sent". In that mode the browser drops the `Authorization` header, so the retry may be rejected without the app seeing it.
- The last 15 sends are kept under "Sent recently" (localStorage).

**Connect to Summer (one time):** gear icon → *Connect to Summer*. Paste the **Webhook URL** and **Sender key** from Summer's Routines tab → *Video Library: add pasted video*. They show in the Grok Bot desktop app. Both are stored only in this phone's localStorage. **Forget** removes them. The URL and key are secret and are never in this repo.

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
