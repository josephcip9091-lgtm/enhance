const $ = (id) => document.getElementById(id);
let me = null;
let pollTimer = null;
let activeTab = "create";

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

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = {};
  try { body = await res.json(); } catch { }
  if (!res.ok) {
    if (body && body.error) throw new Error(body.error);
    if (res.status === 401) throw new Error("not_signed_in");
    if (res.status === 403) throw new Error("no_access");
    throw new Error("Something went wrong. Try again.");
  }
  return body;
}

function uploadXHR(file, filename, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("video", file, filename);
    form.append("title", filename);
    form.append("mode", mode);
    form.append("look", document.getElementById("cinematicLook").checked ? "capcut" : "none");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload", true);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        onProgress(pct, e.loaded, e.total);
      }
    });
    xhr.addEventListener("load", () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else {
        reject(body && body.error ? new Error(body.error) : new Error("Upload failed."));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload lost connection. Check your Wi-Fi and try again.")));
    xhr.send(form);
  });
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

/* ————— Job rendering (diff-based: cards persist across polls) ————— */

function jobSig(j) {
  return [j.status, j.status === "processing" ? Math.round(j.progress) : 0, j.queue_position || 0,
    j.error || "", j.has_out ? 1 : 0, j.has_src ? 1 : 0, j.output_size || 0, j.title || ""].join("|");
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

function renderJobs(jobs) {
  const active = jobs.filter((j) => j.status === "queued" || j.status === "processing");
  const finished = jobs.filter((j) => j.status === "done" || j.status === "failed");

  // announce newly finished jobs
  for (const j of finished) {
    const prev = prevStatus.get(j.id);
    if (prev === "processing" || prev === "queued") {
      toast(`"${(j.title || "video").slice(0, 28)}" is ready — scroll to Ready to download ↓`);
    }
    prevStatus.set(j.id, j.status);
  }

  $("jobsList").dataset.emptyMsg = 'Nothing cooking yet — drop a video above and press <strong>Enhance video</strong>.';
  $("histList").dataset.emptyMsg = 'No finished videos yet. Your enhanced clips will live here — <strong>watchable, comparable, downloadable</strong>.';
  syncList($("jobsList"), active, activeCard);
  syncList($("histList"), finished, doneCard);

  const latest = $("latestDone");
  if (finished.length && finished[0].status === "done") {
    syncList(latest, [finished[0]], doneCard);
    $("latestCard").classList.remove("hidden");
  } else if (!finished.some((j) => j.status === "done")) {
    $("latestCard").classList.add("hidden");
  }

  const nProcessing = active.filter((j) => j.status === "processing").length;
  const nQueued = active.length - nProcessing;
  $("queuePill").textContent = nProcessing + " encoding" + (nQueued ? " · " + nQueued + " waiting" : "");
  $("queuePill").style.display = active.length ? "" : "none";
  $("histCountPill").textContent = finished.filter((j) => j.status === "done").length + " finished";
  $("histCountPill").style.display = finished.length ? "" : "none";
}

const prevStatus = new Map();

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
  tag.className = "job-tag tag-" + job.status;
  tag.textContent = { queued: "QUEUED", processing: "ENCODING" }[job.status] || job.status;
  const right = document.createElement("span");
  right.className = "job-right";
  head.append(title, tag, right);
  div.appendChild(head);

  if (job.status === "queued") {
    const note = document.createElement("div");
    note.className = "job-note";
    const pos = job.queue_position || 1;
    note.textContent = `Waiting in queue · position ${pos} · starts in about ${fmtMs(job.est_ms * pos)}`;
    div.appendChild(note);
    const bar = document.createElement("div");
    bar.className = "bar dim";
    bar.innerHTML = `<div style="width:0%"></div>`;
    div.appendChild(bar);
  } else if (job.status === "processing") {
    const note = document.createElement("div");
    note.className = "job-note";
    const modeName = { fast: "1080p Fast", best: "1080p Ultra-Best", fps120: "1080p 120fps" }[job.mode] || job.mode;
    note.textContent = `Grading (${modeName}) · about ${fmtMs(job.est_ms)} total`;
    div.appendChild(note);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.innerHTML = `<div style="width:${job.progress.toFixed(1)}%"></div>`;
    div.appendChild(bar);
    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent = `${job.progress.toFixed(0)}% · running on the server`;
    div.appendChild(meta);
  }
  return div;
}

/* ————— Before/after compare slider ————— */

function buildCompare(job, mount) {
  const cmp = document.createElement("div");
  cmp.className = "cmp";
  const t = Math.max(0.3, ((job.duration_ms || 3000) / 1000) * 0.35).toFixed(2);
  const after = document.createElement("img");
  after.className = "cmp-after";
  after.draggable = false;
  after.alt = "Enhanced frame";
  after.src = `/api/files/${job.id}/frame/out?t=${t}`;
  const beforeWrap = document.createElement("div");
  beforeWrap.className = "cmp-before-wrap";
  beforeWrap.style.width = "50%";
  const before = document.createElement("img");
  before.className = "cmp-before";
  before.draggable = false;
  before.alt = "Original frame";
  before.src = `/api/files/${job.id}/frame/src?t=${t}`;
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
    meta0.textContent = "Something went wrong during this render. Try again — or pick a lower quality mode.";
    div.appendChild(meta0);
    return div;
  }
  meta0.textContent = `Finished ${fmtDate(job.finished_at)} · auto-deletes in ${fmtMs(job.expire_ms) || "12 hours"}`;
  div.appendChild(meta0);

  if (job.has_out) {
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
    player.src = `/api/files/${job.id}?inline=1`;
    if (job.has_out) {
      const t = Math.max(0.3, ((job.duration_ms || 3000) / 1000) * 0.35).toFixed(2);
      player.poster = `/api/files/${job.id}/frame/out?t=${t}`;
    }
    div.appendChild(player);

    const compareWrap = document.createElement("div");
    compareWrap.className = "compare-wrap hidden";
    if (job.has_src && job.has_out) buildCompare(job, compareWrap);
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
  dl.href = `/api/files/${job.id}`;
  dl.setAttribute("download", "");
  dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><span>Download enhanced video</span>`;
  row.appendChild(dl);
  div.appendChild(row);
  return div;
}

async function refresh() {
  try {
    const data = await api("/api/jobs");
    renderJobs(data.jobs || []);
  } catch (err) {
    if (String(err.message).includes("not_signed_in")) showLocked();
  }
}

function showLocked() {
  $("locked").classList.remove("hidden");
  $("app").classList.add("hidden");
}

let pickedFile = null;

function setChip(file) {
  $("chipName").textContent = file.name;
  $("chipSize").textContent = fmtSize(file.size);
  $("fileChip").classList.remove("hidden");
  $("dropzone").classList.add("picked");
  $("dzTitle").textContent = "Ready";
  $("dzSub").textContent = "Different file? Remove this one first";
  const lims = me ? me.limits : null;
  const tooBig = lims && file.size > lims.max_mb * 1048576;
  $("goBtn").disabled = tooBig;
  $("goBtn").querySelector("span").textContent = tooBig ? `Too big — max ${lims.max_mb} MB` : "Enhance video";
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

async function startUpload() {
  if (!pickedFile) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  $("goBtn").disabled = true;
  $("goBtn").querySelector("span").textContent = "Working…";
  $("uploadProgressWrap").classList.remove("hidden");
  try {
    await uploadXHR(pickedFile, pickedFile.name, mode, (pct) => {
      $("uploadBar").style.width = pct + "%";
      $("uploadMeta").textContent = `Uploading… ${pct}%`;
    });
    clearChip();
    await refresh();
    poll();
  } catch (err) {
    alert(String(err.message || err));
  } finally {
    $("uploadProgressWrap").classList.add("hidden");
    $("uploadBar").style.width = "0%";
    if (pickedFile) {
      $("goBtn").disabled = false;
      $("goBtn").querySelector("span").textContent = "Enhance video";
    }
  }
}

function poll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 4000);
}

async function init() {
  try {
    me = await api("/api/me");
  } catch (err) {
    const msg = String(err.message || "");
    if (msg.includes("not_signed_in") || msg.includes("no_access")) {
      showLocked();
      return;
    }
    $("locked").classList.remove("hidden");
    $("locked").querySelector("p").textContent = "The video server is not running. Start it and refresh.";
    return;
  }
  $("app").classList.remove("hidden");
  $("limMb").textContent = me.limits.max_mb;
  $("limMin").textContent = me.limits.max_minutes;
  initTabs();
  radioInit();

  const fi = $("fileInput");
  const dz = $("dropzone");
  dz.addEventListener("click", () => fi.click());
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
  $("goBtn").addEventListener("click", () => { if (pickedFile) startUpload(); });

  await refresh();
  poll();
}

function radioInit() {
  const modes = me.modes || [];
  const SHORT = { fast: "Fast", best: "Ultra", fps120: "120fps" };
  const HINT = {
    fast: "Fastest turnaround, great quality",
    best: "Maximum quality, slower to make",
    fps120: "Ultra smooth motion, slow to make",
  };
  const inputs = $("modeRow").querySelectorAll(".seg-item input");
  inputs.forEach((inp, i) => {
    const m = modes[i];
    if (!m) return;
    inp.value = m.id;
    inp.nextElementSibling.textContent = SHORT[m.id] || m.name;
  });
  const upd = () => {
    const v = document.querySelector('input[name=mode]:checked').value;
    $("segHint").textContent = HINT[v] || v;
  };
  inputs.forEach((inp) => inp.addEventListener("change", upd));
  upd();
}

init();
