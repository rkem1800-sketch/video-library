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

Ticks and deletions are saved in `localStorage` on that device. The gear icon (top right) has **Restore** for deleted videos and **Untick everything**. To remove a video for good, delete its entry from `videos.json`.

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
