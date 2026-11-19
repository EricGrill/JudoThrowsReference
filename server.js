// Zero-dependency static dev server + video search proxy.
// Forwards --port / --host CLI args (e.g. `npm run dev -- --port 7100 --host 0.0.0.0`).
//
// GET /api/search?q=<query>
//   Returns { videos: [{ id, title, channel }] } from a real YouTube search.
//   Strategy: (1) scrape YouTube's results page server-side (no API key, no CORS),
//   (2) fall back to public Piped / Invidious instances.
const http = require("http");
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const PORT = Number(arg("port", process.env.PORT || 7100));
const HOST = arg("host", "0.0.0.0");
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---------- YouTube results-page scrape ----------
function extractJsonObject(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function walkForVideos(node, out) {
  if (!node || typeof node !== "object" || out.length >= 30) return;
  if (node.videoRenderer && node.videoRenderer.videoId) {
    const v = node.videoRenderer;
    out.push({
      id: v.videoId,
      title: (v.title?.runs?.[0]?.text || v.title?.simpleText || "Untitled").slice(0, 200),
      channel: v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || "",
    });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkForVideos(item, out);
    return;
  }
  for (const key of Object.keys(node)) walkForVideos(node[key], out);
}

async function searchViaYouTubeHTML(q) {
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("YouTube HTTP " + res.status);
  const html = await res.text();
  const marker = html.indexOf("ytInitialData");
  if (marker === -1) throw new Error("ytInitialData not found");
  const brace = html.indexOf("{", marker);
  const jsonText = extractJsonObject(html, brace);
  if (!jsonText) throw new Error("could not extract ytInitialData JSON");
  const data = JSON.parse(jsonText);
  const videos = [];
  walkForVideos(data, videos);
  // de-duplicate by id
  const seen = new Set();
  const unique = videos.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
  if (!unique.length) throw new Error("no videos in results");
  return unique;
}

// ---------- Piped / Invidious fallbacks ----------
const PIPED = ["https://adminforge.de", "https://pipedapi.adminforge.de", "https://api.piped.private.coffee"];
const INVIDIOUS = ["https://inv.nadeko.net", "https://invidious.nerdvpn.de", "https://yewtu.be"];

async function searchViaPiped(base, q) {
  const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&filter=videos`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const items = (data.items || data || [])
    .map((v) => {
      const m = /[?&]v=([\w-]{11})/.exec(v.url || "");
      return m ? { id: m[1], title: v.title || "Untitled", channel: v.uploaderName || "" } : null;
    })
    .filter(Boolean);
  if (!items.length) throw new Error("empty");
  return items;
}

async function searchViaInvidious(base, q) {
  const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const data = await res.json();
  const items = (Array.isArray(data) ? data : [])
    .filter((v) => v.type === "video" && v.videoId)
    .map((v) => ({ id: v.videoId, title: v.title || "Untitled", channel: v.author || "" }));
  if (!items.length) throw new Error("empty");
  return items;
}

async function handleSearch(req, res) {
  const q = new URL(req.url, "http://x").searchParams.get("q") || "";
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!q.trim()) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "missing q" }));
  }
  const attempts = [
    () => searchViaYouTubeHTML(q),
    ...PIPED.map((b) => () => searchViaPiped(b, q)),
    ...INVIDIOUS.map((b) => () => searchViaInvidious(b, q)),
  ];
  for (const attempt of attempts) {
    try {
      const videos = await attempt();
      return res.end(JSON.stringify({ videos: videos.slice(0, 12) }));
    } catch {
      /* next strategy */
    }
  }
  res.writeHead(502);
  res.end(JSON.stringify({ error: "all search backends failed" }));
}

// ---------- static + api ----------
http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/api/search") return handleSearch(req, res);

    let filePath = urlPath === "/" ? "/index.html" : urlPath;
    const file = path.normalize(path.join(ROOT, filePath));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, HOST, () => console.log(`Gokyo app → http://localhost:${PORT}/`));
