// Zero-dependency static dev server + video search proxy.
// Forwards --port / --host CLI args (e.g. `npm run dev -- --port 7100 --host 0.0.0.0`).
//
// GET /api/search?q=<query>
//   Returns { videos: [{ id, title, channel }] } from a real YouTube search.
//   Fetch YouTube results with a bounded timeout; the browser always offers a direct link.
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
    signal: AbortSignal.timeout(8000),
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

const searchCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
let activeSearches = 0;

async function handleSearch(req, res) {
  const q = (new URL(req.url, "http://x").searchParams.get("q") || "").trim();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!q || q.length > 200) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "q must contain 1 to 200 characters" }));
  }
  const cached = searchCache.get(q);
  if (cached && cached.expires > Date.now()) {
    return res.end(JSON.stringify({ videos: cached.videos }));
  }
  if (activeSearches >= 20) {
    res.writeHead(503, { "Retry-After": "10" });
    return res.end(JSON.stringify({ error: "search is busy; use the YouTube link" }));
  }
  activeSearches++;
  try {
    const videos = (await searchViaYouTubeHTML(q)).slice(0, 12);
    if (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(q, { videos, expires: Date.now() + CACHE_TTL });
    res.end(JSON.stringify({ videos }));
  } catch {
    res.writeHead(502);
    res.end(JSON.stringify({ error: "video search unavailable; use the YouTube link" }));
  } finally {
    activeSearches--;
  }
}

// Only these files are public. Repository files and server code are never served.
const PUBLIC_FILES = new Set([
  "/index.html", "/src/main.js", "/src/throws.js", "/favicon.svg",
  "/robots.txt", "/sitemap.xml",
]);

http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end("Method not allowed");
  }
  if (urlPath === "/api/search") {
    if (req.method === "HEAD") {
      res.writeHead(405, { Allow: "GET" });
      return res.end();
    }
    return handleSearch(req, res);
  }
  const filePath = urlPath === "/" ? "/index.html" : urlPath;
  if (!PUBLIC_FILES.has(filePath)) {
    res.writeHead(404);
    return res.end("Not found");
  }
  fs.readFile(path.join(ROOT, filePath), (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const contentType = filePath.endsWith(".xml") ? "application/xml; charset=utf-8"
      : filePath.endsWith(".txt") ? "text/plain; charset=utf-8"
      : MIME[path.extname(filePath)];
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=300" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}).listen(PORT, HOST, () => console.log(`Jiu Jitsu Tools: http://localhost:${PORT}/`));
