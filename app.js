// Reel-style transcript reviewer.
// Judgments are saved automatically to the Cloudflare Worker (no export step).
// Swipe right = yes, left = no, up = skip. Buttons + arrow keys also work.

const cfg = window.CONFIG;
const params = new URLSearchParams(location.search);
const reviewerName = (params.get("name") || "anon").trim() || "anon";

let chunks = [];          // all chunks from manifest
let judgedIds = new Set();// chunk ids already judged yes/no (global)
let skippedLocal = new Set(); // recently skipped this session (don't re-show immediately)
let current = null;

const el = (id) => document.getElementById(id);

function flash(symbol, color) {
  const f = el("verdict-flash");
  f.textContent = symbol;
  f.style.color = color;
  f.style.opacity = "1";
  setTimeout(() => { f.style.opacity = "0"; }, 180);
}

async function init() {
  // manifest
  const resp = await fetch(cfg.MANIFEST_URL);
  chunks = (await resp.json()).chunks;

  // globally-judged ids
  try {
    const r = await fetch(cfg.WORKER_URL + "/api/judged");
    const d = await r.json();
    (d.judged || []).forEach((id) => judgedIds.add(id));
  } catch (e) { /* worker offline -> proceed with empty dedup */ }

  el("btnYes").onclick = () => judge("yes");
  el("btnNo").onclick = () => judge("no");
  el("btnSkip").onclick = () => skip();

  // swipe gestures
  const card = el("card");
  let sx = 0, sy = 0;
  card.addEventListener("touchstart", (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  card.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return; // tap, not swipe
    if (Math.abs(dx) > Math.abs(dy)) { dx > 0 ? judge("yes") : judge("no"); }
    else { dy < 0 ? skip() : null; }
  }, { passive: true });

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") judge("yes");
    else if (e.key === "ArrowLeft") judge("no");
    else if (e.key === "ArrowUp") { e.preventDefault(); skip(); }
    else if (e.code === "Space") {
      e.preventDefault();
      const a = el("audio");
      a.paused ? a.play() : a.pause();
    }
  });

  renderStats();
  next();
}

function next() {
  const pool = chunks.filter((c) => !judgedIds.has(c.id) && !skippedLocal.has(c.id));
  if (!pool.length) {
    // everything judged (or only locally-skipped left) -> clear local skips and retry
    skippedLocal.clear();
    const p2 = chunks.filter((c) => !judgedIds.has(c.id));
    if (!p2.length) {
      el("card").innerHTML = '<div class="done">🎉 No unjudged chunks left right now.<br>Check back later or share the link with more friends!</div>';
      return;
    }
    return show(p2[Math.floor(Math.random() * p2.length)]);
  }
  show(pool[Math.floor(Math.random() * pool.length)]);
}

function show(c) {
  current = c;
  el("transcript").textContent = c.transcript;
  el("meta").textContent = c.episode + " · " + c.file + " · " + fmt(c.start) + "–" + fmt(c.end) + "s";
  el("epiLabel").textContent = c.episode;
  el("audio").src = cfg.AUDIO_BASE + c.episode + "/" + c.file;
}

function fmt(s) { return Number(s).toFixed(1); }

function judge(verdict) {
  if (!current) return;
  flash(verdict === "yes" ? "✅" : "❌", verdict === "yes" ? "#22c55e" : "#ef4444");
  judgedIds.add(current.id);
  renderStats();
  next();
  // fire-and-forget save
  fetch(cfg.WORKER_URL + "/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id, verdict, reviewer: reviewerName }),
  }).catch(() => {});
}

function skip() {
  if (!current) return;
  flash("⏭️", "#f59e0b");
  skippedLocal.add(current.id);
  next();
}

function renderStats() {
  const remaining = chunks.length - judgedIds.size;
  el("stats").textContent = "Reviewed " + judgedIds.size + " · Left " + remaining;
}

init();
