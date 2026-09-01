// Reel-style audio-vs-transcript reviewer with loudness-normalized playback.
// Each user gets a random episode and reviews it in order, skipping globally-reviewed clips.
// Swipe right = Good, left = Bad, up = Skip.

const cfg = window.CONFIG;
const params = new URLSearchParams(location.search);
const reviewerName = (params.get("name") || "anon").trim() || "anon";

let chunks = [];          // all chunks, sorted episode -> file
let judgedIds = new Set();// globally + locally reviewed chunk ids (yes/no)
let skippedLocal = new Set(); // skipped this session
let current = null;
let ready = false;
let pendingStart = false;
let started = false;
let animating = false;

let episodes = new Map(); // episode -> [chunk, ...] in order
let currentEpisode = null;
let myCount = 0;          // reviews done this session (yes/no)
let myInstagram = "";     // optional, persisted in localStorage

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
const TARGET_RMS = 0.10;
const MAX_GAIN = 8.0;
const PEAK_LIMIT = 0.95;

async function loadNormalized(c) {
  const hit = audioCache.get(c.id);
  if (hit) return hit;
  const url = cfg.WORKER_URL + "/audio/telugu-female-voice/" + c.episode + "/" + c.file;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("audio " + resp.status);
  const arr = await resp.arrayBuffer();
  const buffer = await ctx().decodeAudioData(arr);
  let sum = 0, peak = 0;
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    sum += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, ch.length));
  let gain = rms > 1e-6 ? TARGET_RMS / rms : 1.0;
  if (peak > 0 && gain * peak > PEAK_LIMIT) gain = PEAK_LIMIT / peak;
  gain = Math.min(Math.max(gain, 0.1), MAX_GAIN);
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
    done();
    card.classList.remove(dir);
    card.style.transition = "none";
    card.style.transform = "";
    void card.offsetWidth;
    card.style.transition = "";
    card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    animating = false;
  }, 200);
}

// ---------- emoji pop ----------
let flashTimer = null;
function flash(emoji, word, color) {
  const f = el("verdict-flash");
  f.innerHTML = '<div class="emoji">' + emoji + '</div><div class="word">' + word + '</div>';
  f.style.color = color;
  f.classList.add("pop");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove("pop"), 500);
}

// ---------- episode assignment ----------
function buildEpisodes() {
  episodes = new Map();
  for (const c of chunks) {
    if (!episodes.has(c.episode)) episodes.set(c.episode, []);
    episodes.get(c.episode).push(c);
  }
}

function assignEpisode() {
  // random episode that still has unreviewed clips (ignoring local skips)
  const avail = [];
  for (const [ep, list] of episodes) {
    if (list.some((c) => !judgedIds.has(c.id) && !skippedLocal.has(c.id))) avail.push(ep);
  }
  if (avail.length) return avail[Math.floor(Math.random() * avail.length)];
  // fallback: allow episodes that only have locally-skipped clips
  const avail2 = [];
  for (const [ep, list] of episodes) {
    if (list.some((c) => !judgedIds.has(c.id))) avail2.push(ep);
  }
  return avail2.length ? avail2[Math.floor(Math.random() * avail2.length)] : null;
}

// ---------- UI ----------
function doStart() {
  if (started) return;
  started = true;
  const insta = (el("instaInput").value || "").trim();
  if (insta) {
    myInstagram = insta;
    try { localStorage.setItem("instagram_id", insta); } catch (e) {}
  }
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
    chunks.sort((a, b) => a.episode.localeCompare(b.episode) || a.file.localeCompare(b.file));
    buildEpisodes();
  } catch (e) {
    chunks = [];
    console.error("manifest load failed:", e);
  }
  // skip clips that were already reviewed (yes/no) by anyone
  try {
    const r = await fetch(cfg.WORKER_URL + "/api/judged");
    const d = await r.json();
    (d.judged || []).forEach((id) => judgedIds.add(id));
  } catch (e) { /* worker offline -> no dedup */ }

  ready = true;
  el("startBtn").textContent = "Start reviewing ▶";
  if (pendingStart) doStart();
}

function init() {
  // remember their optional Instagram id from last time
  try {
    const saved = localStorage.getItem("instagram_id") || "";
    myInstagram = saved;
    el("instaInput").value = saved;
  } catch (e) {}

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
  const list = currentEpisode ? episodes.get(currentEpisode) : null;
  const pool = list ? list.filter((c) => !judgedIds.has(c.id) && !skippedLocal.has(c.id)) : [];
  if (!pool.length) {
    currentEpisode = assignEpisode();
    if (!currentEpisode) {
      el("card").innerHTML = '<div class="done">🎉 All clips have been reviewed!<br>Thanks — share the link with more friends.</div>';
      return;
    }
    return next();
  }
  show(pool[0]);
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
  if (verdict === "yes") flash("✅", "Good", "#22c55e");
  else flash("❌", "Bad", "#ef4444");
  judgedIds.add(current.id);
  myCount++;
  renderStats();
  stopAudio();
  swipeOut(verdict === "yes" ? "slide-right" : "slide-left", () => next());
  fetch(cfg.WORKER_URL + "/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id, verdict, reviewer: reviewerName, instagram: myInstagram }),
  }).catch(() => {});
}

function skip() {
  if (!current || animating) return;
  animating = true;
  flash("⏭️", "Skip", "#f59e0b");
  skippedLocal.add(current.id);
  stopAudio();
  swipeOut("slide-up", () => next());
}

function renderStats() {
  const left = chunks.length - judgedIds.size;
  el("stats").textContent = "You: " + myCount + " · Left: " + left;
}

init();
