import { THROWS, SETS } from "./throws.js";

const $ = (sel) => document.querySelector(sel);

const selectEl = $("#throw-select");
const filterEl = $("#filter");
const detailEl = $("#detail");
const contextEl = $("#context");
const findBtn = $("#find-btn");
const queryPreview = $("#query-preview");
const statusEl = $("#video-status");
const gridEl = $("#video-grid");
const fallbackEl = $("#yt-fallback");

let currentIndex = Number(localStorage.getItem("gokyo.index")) || 0;
if (currentIndex < 0 || currentIndex >= THROWS.length) currentIndex = 0;
let searchToken = 0; // cancels stale video searches

// ---------- dropdown ----------
function buildOptions(filter = "") {
  const q = filter.trim().toLowerCase();
  selectEl.innerHTML = "";
  const matches = THROWS.filter((t) =>
    !q ||
    t.name.toLowerCase().includes(q) ||
    t.en.toLowerCase().includes(q) ||
    t.type.toLowerCase().includes(q) ||
    t.set.toLowerCase().includes(q)
  );
  if (matches.length === 0) {
    const opt = new Option("No throws match — clear the filter", "");
    selectEl.appendChild(opt);
    return;
  }
  for (const setName of SETS) {
    const group = matches.filter((t) => t.set === setName);
    if (!group.length) continue;
    const og = document.createElement("optgroup");
    og.label = setName;
    for (const t of group) {
      const opt = new Option(`${t.name} — ${t.en}`, t.id);
      og.appendChild(opt);
    }
    selectEl.appendChild(og);
  }
  const cur = THROWS[currentIndex];
  if (matches.some((t) => t.id === cur.id)) selectEl.value = cur.id;
}

// ---------- detail panel ----------
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderDetail() {
  const t = THROWS[currentIndex];
  const note = localStorage.getItem("gokyo.note." + t.id) || "";
  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="kanji" lang="ja">${t.kanji}</div>
      <div class="detail-names">
        <h2>${t.name}</h2>
        <div class="en">${t.en}</div>
        <div class="badges">
          <span class="badge">${esc(t.set)}</span>
          <span class="badge type">${esc(t.type)}</span>
          ${t.banned ? `<span class="badge ban">Banned in competition</span>` : ""}
        </div>
        ${t.banned ? `<div class="ban-note">Kinshi-waza: forbidden in IJF competition because of injury risk. Train it, don't compete with it.</div>` : ""}
      </div>
    </div>
    <h3 class="section-title">What it is</h3>
    <p class="desc">${esc(t.desc)}</p>
    <h3 class="section-title">Key points</h3>
    <ul class="tips">${t.tips.map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>
    <h3 class="section-title">My notes <span style="font-weight:400;letter-spacing:0;text-transform:none">(saved in this browser)</span></h3>
    <div class="notes">
      <textarea id="note-box" placeholder="Drills, grips, combos, who hit it on you…">${esc(note)}</textarea>
      <div class="savestate" id="note-state"></div>
    </div>
  `;
  const box = $("#note-box");
  const state = $("#note-state");
  let timer;
  box.addEventListener("input", () => {
    state.textContent = "…";
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (box.value.trim()) localStorage.setItem("gokyo.note." + t.id, box.value);
      else localStorage.removeItem("gokyo.note." + t.id);
      state.textContent = "Saved.";
    }, 500);
  });
}

// ---------- selection ----------
function selectThrow(id, { autoSearch = true } = {}) {
  const idx = THROWS.findIndex((t) => t.id === id);
  if (idx < 0) return;
  currentIndex = idx;
  localStorage.setItem("gokyo.index", String(idx));
  selectEl.value = id;
  renderDetail();
  updateQueryPreview();
  if (autoSearch) findVideos();
}

function updateQueryPreview() {
  const t = THROWS[currentIndex];
  const ctx = contextEl.value.trim();
  queryPreview.innerHTML = `Search query: <code>${esc(buildQuery(t, ctx))}</code>`;
}

function buildQuery(t, ctx) {
  return `${t.name} judo${ctx ? " " + ctx : ""}`;
}

// ---------- video search ----------
// YouTube blocks embedding its search page, so results are fetched through
// public Piped / Invidious instances (no API key). If all are unreachable,
// we fall back to a direct YouTube search link.
const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://api.piped.private.coffee",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.r4fo.com",
];
const INVIDIOUS = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.nerdvpn.de",
  "https://iv.melmac.space",
  "https://invidious.f5.si",
];

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function tryPiped(base, q) {
  const { signal, done } = withTimeout(8000);
  try {
    const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&filter=videos`, { signal });
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
  } finally {
    done();
  }
}

async function tryInvidious(base, q) {
  const { signal, done } = withTimeout(8000);
  try {
    const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, { signal });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const items = (Array.isArray(data) ? data : [])
      .filter((v) => v.type === "video" && v.videoId)
      .map((v) => ({ id: v.videoId, title: v.title || "Untitled", channel: v.author || "" }));
    if (!items.length) throw new Error("empty");
    return items;
  } finally {
    done();
  }
}

async function tryProxy(q) {
  const { signal, done } = withTimeout(15000);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!Array.isArray(data.videos) || !data.videos.length) throw new Error("empty");
    return data.videos;
  } finally {
    done();
  }
}

async function searchVideos(q) {
  const attempts = [
    () => tryProxy(q), // same-origin dev-server proxy (scrapes YouTube server-side)
    ...PIPED.map((b) => () => tryPiped(b, q)),
    ...INVIDIOUS.map((b) => () => tryInvidious(b, q)),
  ];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch {
      /* next instance */
    }
  }
  return null;
}

function renderVideos(videos, t, ctx) {
  gridEl.innerHTML = videos
    .slice(0, 6)
    .map(
      (v) => `
      <div class="vcard">
        <div class="frame">
          <iframe src="https://www.youtube-nocookie.com/embed/${v.id}" title="${esc(v.title)}"
            loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
        <div class="vmeta">
          <div class="vtitle"><a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">${esc(v.title)}</a></div>
          ${v.channel ? `<div class="vchan">${esc(v.channel)}</div>` : ""}
        </div>
      </div>`
    )
    .join("");
}

async function findVideos() {
  const t = THROWS[currentIndex];
  const ctx = contextEl.value.trim();
  const q = buildQuery(t, ctx);
  const token = ++searchToken;

  updateQueryPreview();
  findBtn.disabled = true;
  gridEl.innerHTML = "";
  fallbackEl.hidden = true;
  statusEl.className = "video-status show";
  statusEl.innerHTML = `<span class="spinner"></span>Searching YouTube for “${esc(q)}”…`;

  const videos = await searchVideos(q);
  if (token !== searchToken) return; // a newer search superseded this one
  findBtn.disabled = false;

  const ytUrl = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  if (videos) {
    statusEl.innerHTML = `${videos.length >= 6 ? "Top 6" : videos.length} result${videos.length === 1 ? "" : "s"} for <strong>${esc(t.name)}</strong>${ctx ? ` with “${esc(ctx)}”` : ""} · <a href="${ytUrl}" target="_blank" rel="noopener">open full search on YouTube ↗</a>`;
    renderVideos(videos, t, ctx);
  } else {
    statusEl.className = "video-status show error";
    statusEl.textContent = "Couldn't reach a video search gateway right now.";
    fallbackEl.hidden = false;
    fallbackEl.innerHTML = `No embedded results — but YouTube has this search ready: <a href="${ytUrl}" target="_blank" rel="noopener">“${esc(q)}” on YouTube ↗</a>`;
  }
}

// ---------- wiring ----------
selectEl.addEventListener("change", () => selectThrow(selectEl.value));

filterEl.addEventListener("input", () => {
  const before = selectEl.value;
  buildOptions(filterEl.value);
  // keep current throw if still visible; otherwise jump to first match
  if ([...selectEl.options].some((o) => o.value === before)) {
    selectEl.value = before;
  } else if (selectEl.options.length && selectEl.options[0].value) {
    selectThrow(selectEl.options[0].value);
  }
});

$("#prev-btn").addEventListener("click", () =>
  selectThrow(THROWS[(currentIndex - 1 + THROWS.length) % THROWS.length].id)
);
$("#next-btn").addEventListener("click", () =>
  selectThrow(THROWS[(currentIndex + 1) % THROWS.length].id)
);
$("#random-btn").addEventListener("click", () => {
  let i = currentIndex;
  while (i === currentIndex) i = Math.floor(Math.random() * THROWS.length);
  selectThrow(THROWS[i].id);
});

findBtn.addEventListener("click", findVideos);
contextEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") findVideos();
});
contextEl.addEventListener("input", updateQueryPreview);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "ArrowLeft") $("#prev-btn").click();
  if (e.key === "ArrowRight") $("#next-btn").click();
});

// ---------- init ----------
buildOptions();
renderDetail();
updateQueryPreview();
findVideos();
