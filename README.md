# Gokyo — The 68 Throws of Kodokan Judo

A personal reference app for every official Kodokan nage-waza: pick a throw,
read what it is and how it works, and instantly pull up real YouTube videos for
it — optionally filtered by your own context ("for BJJ", a coach's name, "no gi", …).

## Run

```bash
npm run dev            # → http://localhost:7100/
npm run dev -- --port 8000   # custom port/host args are forwarded
```

No dependencies, no build step. Node 18+ is enough.

## Features

- **All 68 official throws** — the Gokyo-no-waza (5 sets of 8), the 8
  habukareta-waza preserved from the 1895 list, and the 20 shinmeisho-no-waza
  accepted in 1982/1997, each with kanji, translation, classification,
  description, and key points. Competition-banned techniques (kani-basami,
  kawazu-gake) are flagged.
- **Filter + dropdown + prev/next/random** — keyboard arrows work too.
- **Context-aware video search** — your context text is merged into the
  YouTube query (`Seoi-nage judo for BJJ`). Results are embedded in-page;
  a direct "open full search on YouTube" link is always there as backup.
- **Personal notes per throw**, saved to `localStorage` (this browser only).

## How video search works

YouTube has no keyless search API and blocks embedding its search page, so
`server.js` exposes `/api/search?q=…` which fetches YouTube's results page
server-side, parses `ytInitialData`, and returns video IDs/titles/channels
(with public Piped/Invidious instances as fallback). Opened without the dev
server, the page still works but shows YouTube search links instead of embeds.

## Structure

```
index.html      markup + design system (single page)
src/throws.js   the 68-throw database
src/main.js     UI + search logic
server.js       static server + /api/search proxy
```

## Credits

- Throw list and classification follow the Kodokan nage-waza (as documented in
  Wikipedia's "List of Kodokan judo techniques", CC BY-SA 4.0).
- Descriptions and key points written for this app.
- Video results are returned live by YouTube search; all videos belong to
  their respective channels.
