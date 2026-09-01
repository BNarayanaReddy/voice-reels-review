// Reel-style audio-vs-transcript reviewer with loudness-normalized playback.
// Swipe right = Correct, left = Very bad, up = Skip. Buttons + arrow keys work.

const cfg = window.CONFIG;
const params = new URLSearchParams(location.search);
const reviewerName = (params.get("name") || "anon").trim() || "anon";

let chunks = [];          // all chunks from manifest
let judgedIds = new Set();// chunk ids already judged yes/no (global)
let skippedLocal = new Set(); // recently skipped this session
let current = null;
let ready = false;        // manifest loaded?
let pendingStart = false; // user tapped start before manifest was ready
let started = false;

const el = (id) => document.getElementById(id);

// ---------- Web Audio (loudness normalization) ----------
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

const audioCache = new Map(); // id -> { buffer, gain }
const TARGET_PEAK = 0.89;
const MAX_GAIN = 4.0;

async function loadNormalized(c) {
  const hit = audioCache.get(c.id);
  if (hit) return hit;
  const url = cfg.WORKER_URL + "/audio/telugu-female-voice/" + c.episode + "/" + c.file;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("audio " + resp.status);
  const arr = await resp.arrayBuffer();
  const buffer = await ctx().decodeAudioData(arr);
  let peak = 0;
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  const gain = peak > 0 ? Math.min(TARGET_PEAK / peak, MAX_GAIN) : 1.0;
  const out = { buffer, gain };
  audioCache.set(c.id, out);
  return out;
}

let srcNode = null;
let startedAt = 0;
let pausedAt = 0;
let playing = false;
let loading = false;

async function play() {
  const c = current;
  if (!c || loading) return;
  loading = true;
  el("playBtn").classList.add("loading");
  el("playBtn").textContent = "Loading…";
  try {
    const { buffer, gain } = await loadNormalized(c);
    if (current !== c) { loading = false; return; }
    const ac = ctx();
    if (srcNode) { try { srcNode.stop(); } catch (e) {} }
    srcNode = ac.createBufferSource();
    srcNode.buffer = buffer;
    const g = ac.createGain();
    g.gain.value = gain;
    srcNode.connect(g).connect(ac.destination);
    srcNode.start(0, pausedAt);
    startedAt = ac.currentTime - pausedAt;
    playing = true;
    el("playBtn").textContent = "⏸ Pause";
    srcNode.onended = () => {
      if (!playing) return;
      playing = false;
      pausedAt = 0;
      srcNode = null;
      el("playBtn").textContent = "▶ Play";
    };
  } catch (e) {
    el("playBtn").textContent = "▶ Play";
  } finally {
    loading = false;
    el("playBtn").classList.remove("loading");
  }
}

function pause() {
  if (!playing || !srcNode) return;
  const ac = ctx();
  pausedAt = ac.currentTime - startedAt;
  try { srcNode.stop(); } catch (e) {}
  playing = false;
  srcNode = null;
  el("playBtn").textContent = "▶ Play";
}

function togglePlay() {
  if (playing) pause();
  else play();
}

// ---------- UI ----------
function flash(symbol, color) {
  const f = el("verdict-flash");
  f.textContent = symbol;
  f.style.color = color;
  f.style.opacity = "1";
  setTimeout(() => { f.style.opacity = "0"; }, 180);
}

function doStart() {
  if (started) return;
  started = true;
  try { ctx().resume(); } catch (e) {}
  el("overlay").classList.add("hidden");
  renderStats();
  next();
}

async function loadManifest() {
  try {
    const resp = await fetch(cfg.MANIFEST_URL);
    if (!resp.ok) throw new Error("manifest " + resp.status);
    chunks = (await resp.json()).chunks;
  } catch (e) {
    chunks = [];
    console.error("manifest load failed:", e);
  }
  try {
    const r = await fetch(cfg.WORKER_URL + "/api/judged");
    const d = await r.json();
    (d.judged || []).forEach((id) => judgedIds.add(id));
  } catch (e) { /* worker offline -> empty dedup */ }

  ready = true;
  el("startBtn").textContent = "Start reviewing ▶";
  if (pendingStart) doStart();
}

function init() {
  // attach handlers immediately (so the Start button always responds)
  el("btnYes").onclick = () => judge("yes");
  el("btnNo").onclick = () => judge("no");
  el("btnSkip").onclick = () => skip();
  el("playBtn").onclick = togglePlay;

  el("startBtn").onclick = () => {
    pendingStart = true;
    if (ready) doStart();
    else el("startBtn").textContent = "Loading…";
  };

  // swipe gestures
  const card = el("card");
  let sx = 0, sy = 0;
  card.addEventListener("touchstart", (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  card.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return; // tap
    if (Math.abs(dx) > Math.abs(dy)) { dx > 0 ? judge("yes") : judge("no"); }
    else { dy < 0 ? skip() : null; }
  }, { passive: true });

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") judge("yes");
    else if (e.key === "ArrowLeft") judge("no");
    else if (e.key === "ArrowUp") { e.preventDefault(); skip(); }
    else if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  });

  // load data in the background
  loadManifest();
}

function next() {
  if (!chunks.length) {
    el("card").innerHTML = '<div class="done">⚠️ Could not load the clip list.<br>Please refresh the page.</div>';
    return;
  }
  const pool = chunks.filter((c) => !judgedIds.has(c.id) && !skippedLocal.has(c.id));
  if (!pool.length) {
    skippedLocal.clear();
    const p2 = chunks.filter((c) => !judgedIds.has(c.id));
    if (!p2.length) {
      el("card").innerHTML = '<div class="done">🎉 No unjudged clips left right now.<br>Check back later or share the link with more friends!</div>';
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
  if (srcNode) { try { srcNode.stop(); } catch (e) {} }
  srcNode = null;
  playing = false;
  pausedAt = 0;
  el("playBtn").textContent = "▶ Play";
  play(); // auto-play (normalized)
}

function fmt(s) { return Number(s).toFixed(1); }

function judge(verdict) {
  if (!current) return;
  flash(verdict === "yes" ? "✅" : "❌", verdict === "yes" ? "#22c55e" : "#ef4444");
  judgedIds.add(current.id);
  renderStats();
  next();
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
