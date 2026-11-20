# Jiu Jitsu Tools

A searchable reference for all 68 Kodokan judo throws, published at
https://jiujitsutools.com/. Pick a throw, read its description and key points,
find videos for your training context, and save personal notes in your browser.

## Run and verify

```bash
npm start
npm run dev -- --port 8000 --host 127.0.0.1
npm test
npm run check
npm run build
```

No dependencies or compilation are required. Use Node 24 in production.
The default port is 7100. Set `PORT` or pass `--port` to override it.

## Features

- All 68 official throws with kanji, translation, classification, descriptions,
  and key points. Competition-banned techniques are flagged.
- Filter the catalog and use previous, next, or random within the filtered list.
- Add video search context such as "for BJJ", "no gi", or a coach's name.
- Save notes immediately in local storage. If storage is blocked, notes remain
  available for the current page session and the app explains that limitation.
- Follow the navigation links to the existing timer and calculators. These
  routes are provided by the site's existing service behind the production proxy.

## Video search

`GET /api/search?q=...` fetches YouTube's public results page and returns up to
12 unique video IDs, titles, and channels. Queries are limited to 200 characters;
upstream requests time out after eight seconds. Successful results are cached
for five minutes, with at most 100 cached queries and 20 concurrent upstream
searches per process.

The browser makes one same-origin request with a ten-second timeout and always
shows a direct YouTube search link immediately. Embedded search is best effort:
YouTube can block server requests or change its page format. A failed search
leaves the direct link usable without cycling through public gateways.

The Node server serves an explicit list of public assets. It never exposes Git
metadata, package files, deployment files, or server source.

## Structure

```text
index.html             markup, design system, and public metadata
src/throws.js          the 68-throw catalog
src/main.js            interface, notes, and video search
server.js              public asset server and bounded search endpoint
favicon.svg            site icon
robots.txt             crawler instructions
sitemap.xml            canonical homepage sitemap
tests/                 dependency-free browser logic and HTTP tests
docs/launch-plan.md    bounded implementation and verification plan
```

## Credits

The throw list and classification follow the Kodokan nage-waza as documented in
[Wikipedia's List of Kodokan judo techniques](https://en.wikipedia.org/wiki/List_of_Kodokan_judo_techniques),
licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Descriptions and key points were written for this app. Videos belong to their
respective channels. See [LICENSE](LICENSE) for the application code license.
