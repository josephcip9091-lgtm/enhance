const $ = (id) => document.getElementById(id);
const LS_KEY = "enhance-cloud-jobs-v1";
const LIMITS = { max_mb: 450, capShort: 90, capLong: 180 };
let jobs = [];
let activeTab = "create";
let turboMod = null;
const prevStatus = new Map();

function fmtSize(bytes) {
  if (!bytes || bytes < 1024) return "0 B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function fmtMs(ms) {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 90) return s + "s";
  const m = Math.round(s / 60);
  if (m < 90) return m + " min";
  return Math.round(m / 60) + " hr";
}

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function loadJobs() {
  try { jobs = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { jobs = []; }
  for (const j of jobs) {
    if (j.url && j.url.startsWith("blob:")) {
      j.status = "failed";
      j.error = "This result link expired (device links don't survive a page reload). Run it again — it takes seconds.";
    }
  }
}

function saveJobs() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(jobs.slice(0, 30))); } catch { }
}

/* ————— Tabs ————— */

function setTab(name) {
  activeTab = name;
  document.querySelectorAll(".ap-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("tabCreate").classList.toggle("hidden", name !== "create");
  $("tabHistory").classList.toggle("hidden", name !== "history");
}

function initTabs() {
  document.querySelectorAll(".ap-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
}

/* ————— Job rendering (diff-based: cards persist) ————— */

function jobSig(j) {
  return [j.status, j.status === "processing" ? Math.round(j.progress) : 0, j.error || "",
    j.url || "", j.out_w || 0, j.output_size || 0, j.title || "", j.lane || ""].join("|");
}

function syncList(list, arr, builder) {
  const want = new Set(arr.map((j) => j.id));
  [...list.children].forEach((ch) => { if (ch.dataset.id && !want.has(ch.dataset.id)) ch.remove(); });
  for (const j of arr) {
    const sig = jobSig(j);
    let card = list.querySelector(`[data-id="${CSS.escape(j.id)}"]`);
    if (card && card.dataset.sig === sig) continue;
    const fresh = builder(j);
    fresh.dataset.sig = sig;
    if (card) list.replaceChild(fresh, card);
    else list.appendChild(fresh);
  }
  let empty = list.querySelector(".empty");
  if (arr.length === 0) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = list.dataset.emptyMsg || "";
      list.appendChild(empty);
    }
  } else if (empty) empty.remove();
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}

function refresh() {
  const active = jobs.filter((j) => j.status === "processing");
  const finished = jobs.filter((j) => j.status === "done" || j.status === "failed");

  for (const j of finished) {
    const prev = prevStatus.get(j.id);
    if ((prev === "processing") && j.status === "done") {
      toast(`"${(j.title || "video").slice(0, 28)}" is ready — scroll to Ready to download ↓`);
    }
    prevStatus.set(j.id, j.status);
  }

  $("jobsList").dataset.emptyMsg = 'Nothing cooking yet — drop a video above and press <strong>Enhance video</strong>.';
  $("histList").dataset.emptyMsg = 'No finished videos yet. Your enhanced clips will live here — <strong>watchable, comparable, downloadable</strong>.';
  syncList($("jobsList"), active, activeCard);
  syncList($("histList"), finished, doneCard);

  const latest = $("latestDone");
  const latestDone = finished.find((j) => j.status === "done");
  if (latestDone) {
    syncList(latest, [latestDone], doneCard);
    $("latestCard").classList.remove("hidden");
  } else {
    $("latestCard").classList.add("hidden");
    latest.textContent = "";
  }

  $("queuePill").textContent = active.length + " encoding";
  $("queuePill").style.display = active.length ? "" : "none";
  $("histCountPill").textContent = finished.filter((j) => j.status === "done").length + " finished";
  $("histCountPill").style.display = finished.length ? "" : "none";
}

function activeCard(job) {
  const div = document.createElement("div");
  div.className = "job " + job.status;
  div.dataset.id = job.id;

  const head = document.createElement("div");
  head.className = "job-head";
  const title = document.createElement("span");
  title.className = "job-title";
  title.textContent = job.title || "video";
  const tag = document.createElement("span");
  tag.className = "job-tag tag-processing";
  tag.textContent = "ENCODING";
  const right = document.createElement("span");
  right.className = "job-right";
  right.textContent = job.lane === "turbo" ? "on your device (GPU)" : "on the cloud";
  head.append(title, tag, right);
  div.appendChild(head);

  const note = document.createElement("div");
  note.className = "job-note";
  note.textContent = job.lane === "turbo"
    ? "Grading on your device (GPU Turbo) — keep this tab open"
    : "Grading on the cloud server — keep this tab open";
  div.appendChild(note);

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = `<div style="width:${Math.max(2, job.progress || 0).toFixed(1)}%"></div>`;
  div.appendChild(bar);

  const meta = document.createElement("div");
  meta.className = "job-meta";
  meta.textContent = `${(job.progress || 0).toFixed(0)}%${job.stage ? " · " + job.stage : ""}`;
  div.appendChild(meta);
  return div;
}

/* ————— Before/after compare slider ————— */

function buildCompare(job, mount) {
  const cmp = document.createElement("div");
  cmp.className = "cmp";
  const after = document.createElement("img");
  after.className = "cmp-after";
  after.draggable = false;
  after.alt = "Enhanced frame";
  after.src = job.afterUrl;
  const beforeWrap = document.createElement("div");
  beforeWrap.className = "cmp-before-wrap";
  beforeWrap.style.width = "50%";
  const before = document.createElement("img");
  before.className = "cmp-before";
  before.draggable = false;
  before.alt = "Original frame";
  before.src = job.beforeUrl;
  beforeWrap.appendChild(before);
  const handle = document.createElement("div");
  handle.className = "cmp-handle";
  handle.style.left = "50%";
  handle.innerHTML = `<div class="cmp-grip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg></div>`;
  const tagL = document.createElement("span");
  tagL.className = "cmp-tag tag-l";
  tagL.textContent = "Before";
  const tagR = document.createElement("span");
  tagR.className = "cmp-tag tag-r";
  tagR.textContent = "Enhanced";
  cmp.append(after, beforeWrap, handle, tagL, tagR);

  let dragging = false;
  const set = (x) => {
    const r = cmp.getBoundingClientRect();
    const p = Math.max(2, Math.min(98, ((x - r.left) / r.width) * 100));
    beforeWrap.style.width = p + "%";
    handle.style.left = p + "%";
  };
  const start = (e) => { dragging = true; set((e.touches ? e.touches[0] : e).clientX); };
  const move = (e) => { if (dragging) set((e.touches ? e.touches[0] : e).clientX); };
  const end = () => { dragging = false; };
  cmp.addEventListener("mousedown", start);
  cmp.addEventListener("touchstart", start, { passive: true });
  window.addEventListener("mousemove", move);
  window.addEventListener("touchmove", move, { passive: true });
  window.addEventListener("mouseup", end);
  window.addEventListener("touchend", end);

  const size = () => {
    const ar = after.naturalWidth && after.naturalHeight ? after.naturalWidth / after.naturalHeight : 9 / 16;
    const availW = cmp.parentElement.clientWidth || 320;
    const capH = Math.min(440, Math.max(260, window.innerHeight * 0.55));
    const h = Math.min(capH, availW / ar);
    cmp.style.width = Math.round(h * ar) + "px";
    cmp.style.height = Math.round(h) + "px";
    set(cmp.getBoundingClientRect().left + (cmp.clientWidth * parseFloat(beforeWrap.style.width || "50")) / 100);
  };
  if (after.complete) size();
  else after.addEventListener("load", size);
  window.addEventListener("resize", size);
  mount._size = size;

  mount.appendChild(cmp);
}

/* ————— Done card: player / compare / download ————— */

function doneCard(job) {
  const div = document.createElement("div");
  div.className = "job done";
  div.dataset.id = job.id;

  const head = document.createElement("div");
  head.className = "job-head";
  const title = document.createElement("span");
  title.className = "job-title";
  title.textContent = job.title || "video";
  const tag = document.createElement("span");
  tag.className = "job-tag " + (job.status === "done" ? "tag-done" : "tag-failed");
  tag.textContent = job.status === "done" ? "DONE" : "FAILED";
  const right = document.createElement("span");
  right.className = "job-right";
  right.textContent = (job.out_w || "?") + "×" + (job.out_h || "?") + " · " + fmtSize(job.output_size);
  head.append(title, tag, right);
  div.appendChild(head);

  const meta0 = document.createElement("div");
  meta0.className = "job-meta";
  if (job.status !== "done") {
    meta0.textContent = job.error || "Something went wrong during this render. Try again.";
    div.appendChild(meta0);
    return div;
  }
  meta0.textContent = `Finished ${fmtDate(job.finished_at)} · link works for 24 hours${job.lane === "turbo" ? " · graded on your device" : " · graded on the cloud"}`;
  div.appendChild(meta0);

  if (job.url) {
    const view = document.createElement("div");
    view.className = "view-tabs";
    const btnPlayer = document.createElement("button");
    btnPlayer.className = "view-tab active";
    btnPlayer.textContent = "▶ Player";
    const btnCompare = document.createElement("button");
    btnCompare.className = "view-tab";
    btnCompare.textContent = "⇔ Compare";
    view.append(btnPlayer, btnCompare);
    div.appendChild(view);

    const player = document.createElement("video");
    player.className = "preview";
    player.controls = true;
    player.preload = "metadata";
    player.src = job.url;
    if (job.afterUrl) player.poster = job.afterUrl;
    div.appendChild(player);

    const compareWrap = document.createElement("div");
    compareWrap.className = "compare-wrap hidden";
    if (job.beforeUrl && job.afterUrl) buildCompare(job, compareWrap);
    else compareWrap.innerHTML = `<div class="empty small">Compare preview isn't available for this one.</div>`;
    div.appendChild(compareWrap);

    const switchView = (mode) => {
      const isPlayer = mode === "player";
      btnPlayer.classList.toggle("active", isPlayer);
      btnCompare.classList.toggle("active", !isPlayer);
      player.classList.toggle("hidden", !isPlayer);
      compareWrap.classList.toggle("hidden", isPlayer);
      if (isPlayer) { try { player.pause(); } catch { } }
      else if (compareWrap._size) compareWrap._size();
    };
    btnPlayer.addEventListener("click", () => switchView("player"));
    btnCompare.addEventListener("click", () => switchView("compare"));
  }

  const row = document.createElement("div");
  row.className = "row";
  const dl = document.createElement("a");
  dl.className = "cta cta-sm";
  dl.href = job.url;
  dl.setAttribute("download", job.title ? "enhanced_" + job.title + ".mp4" : "enhanced.mp4");
  if (!job.url.startsWith("blob:")) dl.setAttribute("target", "_blank");
  dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><span>Download enhanced video</span>`;
  row.appendChild(dl);
  div.appendChild(row);
  return div;
}

/* ————— Picking a file ————— */

let pickedFile = null;

function setChip(file) {
  $("chipName").textContent = file.name;
  $("chipSize").textContent = fmtSize(file.size);
  $("fileChip").classList.remove("hidden");
  $("dropzone").classList.add("picked");
  $("dzTitle").textContent = "Ready";
  $("dzSub").textContent = "Different file? Remove this one first";
  const tooBig = file.size > LIMITS.max_mb * 1048576;
  $("goBtn").disabled = tooBig;
  $("goBtn").querySelector("span").textContent = tooBig ? `Too big — max ${LIMITS.max_mb} MB` : "Enhance video";
}

function clearChip() {
  pickedFile = null;
  $("fileChip").classList.add("hidden");
  $("dropzone").classList.remove("picked");
  $("dzTitle").textContent = "Drop your video here";
  $("dzSub").textContent = "or click to browse";
  $("goBtn").disabled = true;
  $("goBtn").querySelector("span").textContent = "Enhance video";
}

function probeFile(file) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const r = { dur: v.duration, w: v.videoWidth, h: v.videoHeight };
      URL.revokeObjectURL(v.src);
      res(r);
    };
    v.onerror = () => { URL.revokeObjectURL(v.src); rej(new Error("Couldn't read that video — try MP4 or MOV.")); };
    v.src = URL.createObjectURL(file);
  });
}

const TURBO = (function () {
  try {
    return "VideoDecoder" in window && "VideoEncoder" in window && "AudioEncoder" in window &&
      !!document.createElement("canvas").getContext("webgl2");
  } catch (e) { return false; }
})();

/* ————— The job ————— */

function updateJobUI(job) {
  const bar = $("uploadBar");
  const meta = $("uploadMeta");
  if (bar) bar.style.width = Math.max(0, Math.min(100, job.progress || 0)) + "%";
  if (meta) meta.textContent = job.stage || "Working…";
}

function finishJob(job, blob, dims) {
  job.status = "done";
  job.finished_at = Date.now();
  job.url = URL.createObjectURL(blob);
  job.output_size = blob.size;
  job.out_w = dims ? dims.outW : null;
  job.out_h = dims ? dims.outH : null;
  saveJobs();
  refresh();
}

async function runJob() {
  if (!pickedFile) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $("goBtn").disabled = true;
  $("goBtn").querySelector("span").textContent = "Working…";
  $("uploadProgressWrap").classList.remove("hidden");

  const job = {
    id: "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: pickedFile.name.replace(/\.[^.]+$/, "").slice(0, 40),
    mode,
    lane: null,
    status: "processing",
    progress: 0,
    stage: "Reading video…",
    created: Date.now(),
    logs: []
  };
  jobs.unshift(job);
  saveJobs();
  refresh();

  try {
    const meta = await probeFile(pickedFile);
    if (!meta.w || !meta.h || !meta.dur) throw new Error("Couldn't read the video dimensions.");

    const turboEligible = TURBO && /\.(mp4|m4v|mov)$/i.test(pickedFile.name) && meta.dur <= LIMITS.capLong * 2;
    if (turboEligible) {
      job.lane = "turbo";
      job.stage = "GPU Turbo — grading on your device";
      refresh();
      try {
        if (!turboMod) turboMod = await import("./turbo.js");
        const res = await turboMod.runTurbo(pickedFile, meta, {
          bar: () => { },
          log: (l) => { job.logs.push(l); },
          analysis: (m) => { job.logs.push("[analysis] " + JSON.stringify(m)); }
        });
        job.beforeUrl = res.beforeUrl || null;
        job.afterUrl = res.afterUrl || null;
        finishJob(job, res.blob, { outW: res.outW, outH: res.outH });
        clearChip();
        return;
      } catch (e) {
        job.logs.push("[turbo-fallback] " + (e.message || e));
        job.lane = null;
        job.stage = "Switching to the cloud…";
        refresh();
      }
    }

    job.lane = "cloud";
    job.stage = "Uploading to the cloud…";
    job.progress = 2;
    refresh();

    let mod;
    try {
      mod = await import("https://esm.sh/@vercel/blob@1.1.1/client");
    } catch (e) {
      throw new Error("Upload module failed to load — check your connection and retry.");
    }
    const pathname = "inputs/" + Date.now().toString(36) + "-" + pickedFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const { url: blobUrl } = await mod.upload(pathname, pickedFile, {
      access: "public",
      handleUploadUrl: "./api/upload",
    });
    job.progress = 20;
    job.stage = "Grading on the cloud…";
    updateJobUI(job);
    refresh();

    const r = await fetch("./api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl, w: meta.w, h: meta.h, dur: meta.dur, name: pickedFile.name })
    });
    if (!r.ok || !r.body) throw new Error("Server error (HTTP " + r.status + ")");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", out = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let ix;
      while ((ix = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, ix).trim();
        buf = buf.slice(ix + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "progress") {
          job.progress = Math.min(97, msg.pct * 0.99);
          job.stage = msg.label || "Grading on the cloud…";
          updateJobUI(job);
          refresh();
        } else if (msg.type === "log") {
          job.logs.push(msg.line);
        } else if (msg.type === "analysis") {
          job.analysis = msg;
          job.logs.push("[analysis] " + JSON.stringify(msg));
        } else if (msg.type === "done") {
          out = msg;
        } else if (msg.type === "error") {
          throw new Error(msg.message);
        }
      }
    }
    if (!out) throw new Error("The server closed without a result.");

    job.status = "done";
    job.finished_at = Date.now();
    job.url = out.url;
    job.beforeUrl = out.beforeUrl;
    job.afterUrl = out.afterUrl;
    job.out_w = out.outW;
    job.out_h = out.outH;
    job.lane = "cloud";
    saveJobs();
    refresh();
    clearChip();

  } catch (err) {
    job.status = "failed";
    job.error = String(err.message || err);
    job.finished_at = Date.now();
    saveJobs();
    refresh();
    toast("Something went wrong: " + (err.message || err));
  } finally {
    $("uploadProgressWrap").classList.add("hidden");
    $("uploadBar").style.width = "0%";
    $("goBtn").disabled = !pickedFile;
    $("goBtn").querySelector("span").textContent = "Enhance video";
  }
}

function radioInit() {
  const upd = () => {
    const v = document.querySelector('input[name=mode]:checked').value;
    $("segHint").textContent = v === "fast"
      ? (TURBO ? "GPU Turbo on your device when possible — cloud server otherwise" : "Cloud server — fast turnaround, great quality")
      : "";
  };
  document.querySelectorAll("#modeRow input").forEach((inp) => inp.addEventListener("change", upd));
  upd();
}

function init() {
  $("app").classList.remove("hidden");
  $("limMb").textContent = LIMITS.max_mb;
  $("limMin").textContent = LIMITS.capShort + "s clip (180s at 1080p)";
  initTabs();
  radioInit();

  const fi = $("fileInput");
  const dz = $("dropzone");
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fi.click(); });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("hover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("hover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("hover");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      pickedFile = e.dataTransfer.files[0];
      setChip(pickedFile);
    }
  });
  fi.addEventListener("change", () => {
    if (fi.files && fi.files[0]) {
      pickedFile = fi.files[0];
      setChip(pickedFile);
    }
  });
  $("chipRemove").addEventListener("click", clearChip);
  $("goBtn").addEventListener("click", () => { if (pickedFile) runJob(); });
  $("cinematicLook").addEventListener("change", (e) => {
    if (!e.target.checked) {
      e.target.checked = true;
      toast("The cinematic look is always on — it's what makes this thing work.");
    }
  });

  loadJobs();
  refresh();
}

init();
