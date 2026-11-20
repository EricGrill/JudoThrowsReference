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

// Notes remain editable even when the browser blocks persistent storage.
const sessionValues = new Map();
function readSaved(key) {
  if (sessionValues.has(key)) return sessionValues.get(key);
  try { return localStorage.getItem(key); }
  catch { return null; }
}
function writeSaved(key, value) {
  sessionValues.set(key, value);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

let currentIndex = Number(readSaved("gokyo.index")) || 0;
if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= THROWS.length) currentIndex = 0;
let searchToken = 0; // prevents stale results from replacing the current throw
let searchController;

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
    const opt = new Option("No throws match - clear the filter", "");
    selectEl.appendChild(opt);
    return;
  }
  for (const setName of SETS) {
    const group = matches.filter((t) => t.set === setName);
    if (!group.length) continue;
    const og = document.createElement("optgroup");
    og.label = setName;
    for (const t of group) {
      const opt = new Option(`${t.name} - ${t.en}`, t.id);
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
  const note = readSaved("gokyo.note." + t.id) || "";
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
        ${t.banned ? `<div class="ban-note">Kinshi-waza: forbidden in IJF competition because of injury risk. Discuss safe alternatives with your coach.</div>` : ""}
      </div>
    </div>
    <h3 class="section-title">What it is</h3>
    <p class="desc">${esc(t.desc)}</p>
    <h3 class="section-title">Key points</h3>
    <ul class="tips">${t.tips.map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>
    <h3 class="section-title"><label for="note-box">My notes</label> <span style="font-weight:400;letter-spacing:0;text-transform:none">(saved in this browser)</span></h3>
    <div class="notes">
      <textarea id="note-box" placeholder="Drills, grips, combos, who hit it on you…">${esc(note)}</textarea>
      <div class="savestate" id="note-state" role="status"></div>
    </div>
  `;
  const box = $("#note-box");
  const state = $("#note-state");
  box.addEventListener("input", () => {
    const saved = writeSaved("gokyo.note." + t.id, box.value.trim() ? box.value : "");
    state.textContent = saved ? "Saved in this browser." : "Browser storage is unavailable. Notes last only until this page closes.";
  });
}

// ---------- selection ----------
function selectThrow(id, { autoSearch = true } = {}) {
  const idx = THROWS.findIndex((t) => t.id === id);
  if (idx < 0) return;
  currentIndex = idx;
  writeSaved("gokyo.index", String(idx));
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
// One bounded same-origin request; the direct YouTube link is always available.
async function searchVideos(q) {
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.videos)) return null;
    const videos = data.videos.filter((video) =>
      /^[A-Za-z0-9_-]{11}$/.test(video.id) && typeof video.title === "string"
    ).map((video) => ({ ...video, channel: typeof video.channel === "string" ? video.channel : "" }));
    return videos.length ? videos : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
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
  const ytUrl = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
  fallbackEl.hidden = false;
  fallbackEl.innerHTML = `<a href="${ytUrl}" target="_blank" rel="noopener">Open “${esc(q)}” on YouTube</a>`;
  statusEl.className = "video-status show";
  statusEl.innerHTML = `<span class="spinner"></span>Searching YouTube for “${esc(q)}”…`;

  const videos = await searchVideos(q);
  if (token !== searchToken) return; // a newer search superseded this one
  findBtn.disabled = false;

  if (videos) {
    statusEl.innerHTML = `${videos.length >= 6 ? "Top 6" : videos.length} result${videos.length === 1 ? "" : "s"} for <strong>${esc(t.name)}</strong>${ctx ? ` with “${esc(ctx)}”` : ""} · <a href="${ytUrl}" target="_blank" rel="noopener">open full search on YouTube</a>`;
    renderVideos(videos, t, ctx);
  } else {
    statusEl.className = "video-status show error";
    statusEl.textContent = "Couldn't load embedded results. Use the YouTube link below.";
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

function visibleThrows() {
  return [...selectEl.options].map((option) => option.value).filter(Boolean);
}
function moveThrow(offset) {
  const ids = visibleThrows();
  if (!ids.length) return;
  const position = Math.max(0, ids.indexOf(THROWS[currentIndex].id));
  selectThrow(ids[(position + offset + ids.length) % ids.length]);
}
$("#prev-btn").addEventListener("click", () => moveThrow(-1));
$("#next-btn").addEventListener("click", () => moveThrow(1));
$("#random-btn").addEventListener("click", () => {
  const ids = visibleThrows().filter((id) => id !== THROWS[currentIndex].id);
  if (ids.length) selectThrow(ids[Math.floor(Math.random() * ids.length)]);
});

findBtn.addEventListener("click", findVideos);
contextEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") findVideos();
});
contextEl.addEventListener("input", updateQueryPreview);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select, button, a") || e.target.isContentEditable) return;
  if (e.key === "ArrowLeft") $("#prev-btn").click();
  if (e.key === "ArrowRight") $("#next-btn").click();
});

// ---------- init ----------
buildOptions();
renderDetail();
updateQueryPreview();
findVideos();
