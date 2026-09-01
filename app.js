// Reel-style audio-vs-transcript reviewer with loudness-normalized playback.
// Swipe right = Correct, left = Very bad, up = Skip. Buttons + arrow keys work.
// Chunks play in order (episode by episode), so every new reviewer starts from the beginning.

const cfg = window.CONFIG;
const params = new URLSearchParams(location.search);
const reviewerName = (params.get("name") || "anon").trim() || "anon";

let chunks = [];          // all chunks, sorted episode -> file
let judgedIds = new Set();// chunk ids judged this session (yes/no)
let skippedLocal = new Set(); // recently skipped this session
let current = null;
let ready = false;
let pendingStart = false;
let started = false;
let animating = false;

const el = (id) => document.getElementById(id);

// ---------- Web Audio (loudness normalization) ----------
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

const audioCache = new Map();
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

function stopAudio() {
  if (srcNode) { try { srcNode.stop(); } catch (e) {} }
  srcNode = null;
  playing = false;
}

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
    stopAudio();
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
  stopAudio();
  el("playBtn").textContent = "▶ Play";
}

function togglePlay() {
  if (playing) pause();
  else play();
}

// ---------- swipe animation ----------
function swipeOut(dir, done) {
  const card = el("card");
  card.classList.add(dir);
  setTimeout(() => {
    done();                       // advance to next chunk while off-screen
    card.classList.remove(dir);
    card.style.transition = "none";
    card.style.transform = "";
    void card.offsetWidth;        // reflow to reset without animating back
    card.style.transition = "";
    card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    animating = false;
  }, 200);
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
    // sequential order: episode, then file number (so every user starts from the start)
    chunks.sort((a, b) => a.episode.localeCompare(b.episode) || a.file.localeCompare(b.file));
  } catch (e) {
    chunks = [];
    console.error("manifest load failed:", e);
  }
  ready = true;
  el("startBtn").textContent = "Start reviewing ▶";
  if (pendingStart) doStart();
}

function init() {
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
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return;
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
      el("card").innerHTML = '<div class="done">🎉 You reviewed every clip!<br>Thanks — share the link with more friends.</div>';
      return;
    }
    return show(p2[0]); // first remaining in order
  }
  show(pool[0]); // first unjudged in order
}

function show(c) {
  current = c;
  el("transcript").textContent = c.transcript;
  el("meta").textContent = c.episode + " · " + c.file + " · " + fmt(c.start) + "–" + fmt(c.end) + "s";
  el("epiLabel").textContent = c.episode;
  stopAudio();
  pausedAt = 0;
  el("playBtn").textContent = "▶ Play";
  play();
}

function fmt(s) { return Number(s).toFixed(1); }

function judge(verdict) {
  if (!current || animating) return;
  animating = true;
  flash(verdict === "yes" ? "✅" : "❌", verdict === "yes" ? "#22c55e" : "#ef4444");
  judgedIds.add(current.id);
  renderStats();
  stopAudio();
  swipeOut(verdict === "yes" ? "slide-right" : "slide-left", () => next());
  fetch(cfg.WORKER_URL + "/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id, verdict, reviewer: reviewerName }),
  }).catch(() => {});
}

function skip() {
  if (!current || animating) return;
  animating = true;
  flash("⏭️", "#f59e0b");
  skippedLocal.add(current.id);
  stopAudio();
  swipeOut("slide-up", () => next());
}

function renderStats() {
  const remaining = chunks.length - judgedIds.size;
  el("stats").textContent = "Reviewed " + judgedIds.size + " · Left " + remaining;
}

init();
