const { spawn } = require("child_process");
const fs = require("fs");

const FFMPEG_PATH = require("ffmpeg-static");
const { put, del } = require("@vercel/blob");

const MAX_SECONDS = 90;
const MAX_INPUT_BYTES = 450 * 1024 * 1024;
const WATCHDOG_MS = 285 * 1000;
const BLOB_URL_RE = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;

function frameStats(buf, w, h) {
  const step = 3;
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 12 || gh < 12) return null;
  let sum = 0, count = 0;
  for (let yy = 0; yy < h; yy += 2) for (let xx = 0; xx < w; xx += 2) { sum += buf[yy * w + xx]; count++; }
  const mean = sum / count;
  const gx = (i, j) => buf[j * step * w + i * step];
  const vals = [], grads = [];
  for (let j = 3; j < gh - 3; j++) {
    for (let i = 3; i < gw - 3; i++) {
      const c = gx(i, j);
      if (c < 18 || c > 238) continue;
      let s25 = 0;
      for (let dj = -2; dj <= 2; dj++) {
        const rowBase = (j + dj) * step * w;
        for (let di = -2; di <= 2; di++) s25 += buf[rowBase + (i + di) * step];
      }
      vals.push(Math.abs(c * 25 - s25));
      grads.push(Math.abs(c - gx(i + 1, j)) + Math.abs(c - gx(i - 1, j)) + Math.abs(c - gx(i, j + 1)) + Math.abs(c - gx(i, j - 1)));
    }
  }
  if (vals.length < 500) return null;
  const idx = vals.map((v, k) => k).sort((a, b) => grads[a] - grads[b]);
  const half = idx.length >> 1;
  const flatVals = [];
  for (let k = 0; k < half; k++) flatVals.push(vals[idx[k]]);
  flatVals.sort((a, b) => a - b);
  return { y: mean, noise: flatVals[flatVals.length >> 1] / 25 };
}

function brightLift(y) {
  if (y == null) return 0.22;
  if (y <= 90) return 0.22;
  if (y < 150) return 0.22 * (1 - (y - 90) / 60);
  if (y <= 190) return 0;
  return -Math.min(0.12, (y - 190) / 110);
}

function brightContrast(y) {
  if (y == null) return 1.24;
  const t = Math.max(0, Math.min(1, (y - 140) / 80));
  return 1.24 - 0.155 * t;
}

function brightSat(y) {
  if (y == null) return 1.45;
  const t = Math.max(0, Math.min(1, (y - 140) / 80));
  return 1.45 - 0.15 * t;
}

function even(x) {
  return Math.max(2, Math.round(x / 2) * 2);
}

function targets(w, h) {
  const T = 1080;
  const short = Math.min(w, h);
  if (short >= T) return { outW: even(w), outH: even(h), needsScale: even(w) !== w || even(h) !== h };
  const f = T / short;
  let outW = even(w * f), outH = even(h * f);
  const longEdge = Math.max(outW, outH);
  if (longEdge > 3840) {
    const down = 3840 / longEdge;
    outW = even(outW * down);
    outH = even(outH * down);
  }
  return { outW, outH, needsScale: true };
}

function run(args, onStdout) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    p.stdout.on("data", (d) => { if (onStdout) onStdout(d.toString()); });
    p.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-3000); });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code + " :: " + stderrTail.split("\n").filter(Boolean).slice(-3).join(" | ")))));
    p.on("error", (err) => reject(new Error("spawn failed: " + err.message)));
    return p;
  });
}

async function measureSource(file, w, h, dur) {
  const win = Math.min(Math.max(0.5, dur), 90);
  const short = Math.min(w, h);
  let mw, mh;
  if (short <= 1080) { mw = w; mh = h; }
  else if (w < h) { mw = 1080; mh = Math.round((h * 1080) / w); }
  else { mh = 1080; mw = Math.round((w * 1080) / h); }
  mw = even(mw); mh = even(mh);
  const n = Math.max(6, Math.min(16, Math.round(win)));
  const fps = n / win;
  const wh = mw * mh, frameBytes = wh + Math.floor(wh / 2);
  const probePath = `/tmp/probe-${Date.now()}.yuv`;
  await run(["-t", String(win), "-i", file, "-vf", `fps=${fps.toFixed(5)},scale=${mw}:${mh}:flags=bicubic`, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-y", probePath]);
  const raw = fs.readFileSync(probePath);
  try { fs.unlinkSync(probePath); } catch (e) {}
  if (raw.length < frameBytes) return null;
  let ySum = 0, nSum = 0, cnt = 0;
  const total = Math.floor(raw.length / frameBytes);
  for (let i = 0; i < total; i++) {
    const st = frameStats(raw.subarray(i * frameBytes, i * frameBytes + wh), mw, mh);
    if (st) { ySum += st.y; nSum += st.noise; cnt++; }
  }
  return cnt ? { y: ySum / cnt, noise: nSum / cnt } : null;
}

function buildFilters(m, w, h) {
  const noisy = m && m.noise != null && m.noise >= 1.4;
  const y = m ? m.y : null;
  const bright = y != null && y > 170;
  const clar = noisy ? 0.4 : 0.75;
  const f = [noisy ? "hqdn3d=4:4:8:8" : "hqdn3d=3:3:7:7", noisy ? "vaguedenoiser=threshold=3.5:method=soft" : "vaguedenoiser=threshold=2:method=soft"];
  const t = targets(w, h);
  if (t.needsScale) f.push(`scale=${t.outW}:${t.outH}:flags=lanczos`);
  f.push(`unsharp=lx=21:ly=3:la=${clar}`);
  f.push(`unsharp=lx=3:ly=21:la=${clar}`);
  f.push(`cas=${bright ? (noisy ? 0.45 : 0.7) : noisy ? 0.55 : 0.9}`);
  f.push(`exposure=exposure=${brightLift(y).toFixed(3)}`);
  f.push(`eq=contrast=${brightContrast(y).toFixed(3)}:saturation=${brightSat(y).toFixed(3)}:gamma=${bright ? "1.0" : "0.97"}`);
  f.push("colorbalance=rs=0.03:rm=0.05:bs=-0.03:bm=-0.05");
  if (bright) f.push("curves=m='0/0 0.25/0.235 0.5/0.5 0.75/0.775 0.9/0.90 1/0.90'");
  f.push("format=yuv420p");
  return f.join(",");
}

async function grabFrame(file, tSec, outPath, w) {
  const fw = Math.min(1280, Math.max(320, w || 1280));
  await run(["-ss", String(Math.max(0, tSec || 0)), "-i", file, "-frames:v", "1", "-vf", `scale=${fw}:-2`, "-q:v", "4", "-y", outPath]);
  return outPath;
}

async function putFile(localPath, pathname) {
  const buf = fs.readFileSync(localPath);
  const blob = await put(pathname, buf, { access: "public", addRandomSuffix: false });
  return blob.url;
}

async function downloadToFile(url, dest, onBytes) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error("Download failed: HTTP " + r.status);
  const total = parseInt(r.headers.get("content-length") || "0", 10);
  let received = 0;
  const ws = fs.createWriteStream(dest);
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_INPUT_BYTES) throw new Error("Input video is too large (450 MB limit).");
    await new Promise((res2, rej2) => ws.write(Buffer.from(value), (e) => (e ? rej2(e) : res2())));
    if (onBytes && total) onBytes(received / total);
  }
  await new Promise((res2) => ws.end(res2));
  return received;
}

async function handle(body, send, finish) {
  const { blobUrl, w, h, dur, name } = body;
  if (!blobUrl || !BLOB_URL_RE.test(blobUrl)) throw new Error("Invalid video URL.");
  if (!w || !h || !dur) throw new Error("Missing video info.");
  const id = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const inPath = "/tmp/input-" + id + ".mp4";
  const outPath = "/tmp/out-" + id + ".mp4";

  send({ type: "progress", pct: 5, label: "Downloading your video…" });
  const bytes = await downloadToFile(blobUrl, inPath, (f) => send({ type: "progress", pct: 5 + Math.min(10, f * 10), label: "Downloading your video…" }));
  send({ type: "log", line: `[input] ${(bytes / 1048576).toFixed(1)} MB, ${w}x${h}, ${dur.toFixed(1)}s` });

  send({ type: "progress", pct: 17, label: "Analyzing video… (grain + brightness)" });
  const m = await measureSource(inPath, w, h, dur);
  const noisy = m && m.noise != null && m.noise >= 1.4;
  send({ type: "analysis", luma: m ? m.y : null, noise: m ? m.noise : null, path: noisy ? "noisy" : "clean" });
  send({ type: "progress", pct: 24, label: noisy ? "Grainy source detected — deeper cleanup engaged" : "Clean source detected — full sharpness engaged" });

  const vf = buildFilters(m, w, h);
  const t = targets(w, h);
  const clip = Math.min(dur, MAX_SECONDS);
  await run([
    "-y", "-i", inPath,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "faster", "-crf", "18",
    "-c:a", "aac", "-b:a", "320k",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outPath,
  ], (txt) => {
    const matches = txt.match(/out_time_ms=(\d+)/g);
    if (!matches) return;
    const us = parseInt(matches[matches.length - 1].split("=")[1], 10);
    const pct = Math.min(88, Math.max(25, (us / (clip * 1000000)) * 63 + 25));
    send({ type: "progress", pct, label: "Enhancing… " + Math.min(99, Math.round(((pct - 25) / 63) * 100)) + "%" });
  });

  send({ type: "progress", pct: 89, label: "Extracting comparison frames…" });
  const frameT = dur > 1.2 ? 1 : 0;
  let beforeUrl = null, afterUrl = null;
  try {
    const bPath = `/tmp/b-${id}.jpg`;
    const aPath = `/tmp/a-${id}.jpg`;
    await grabFrame(inPath, frameT, bPath, w);
    await grabFrame(outPath, frameT, aPath, t.outW);
    [beforeUrl, afterUrl] = await Promise.all([
      putFile(bPath, `frames/${id}-before.jpg`),
      putFile(aPath, `frames/${id}-after.jpg`),
    ]);
  } catch (e) {
    send({ type: "log", line: "[frames] skipped: " + e.message });
  }

  send({ type: "progress", pct: 93, label: "Uploading result…" });
  const url = await putFile(outPath, `enhanced/${id}.mp4`);
  try { await del(blobUrl); } catch (e) {}
  [inPath, outPath].forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });

  send({ type: "done", url, beforeUrl, afterUrl, outW: t.outW, outH: t.outH, analysis: { luma: m ? m.y : null, noise: m ? m.noise : null, path: noisy ? "noisy" : "clean" } });
  finish();
}

function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { res.status(400).json({ error: "Bad JSON" }); return; }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    let finished = false;
    const send = (obj) => { if (!finished) { try { res.write(JSON.stringify(obj) + "\n"); } catch (e) {} } };
    const finish = () => { finished = true; try { res.end(); } catch (e) {} };
    const watchdog = setTimeout(() => {
      send({ type: "error", message: "Processing took too long (5 min limit). Try a shorter clip." });
      finish();
    }, WATCHDOG_MS);
    handle(parsed, send, () => { clearTimeout(watchdog); finish(); })
      .catch((err) => {
        clearTimeout(watchdog);
        send({ type: "error", message: String(err.message || err) });
        finish();
      });
  });
}

module.exports = handler;

if (require.main === module) {
  const file = process.argv[2];
  const w = parseInt(process.argv[3], 10), h = parseInt(process.argv[4], 10);
  if (!file || !w || !h) { console.log("usage: node api/enhance.js <file> <w> <h>"); process.exit(1); }
  (async () => {
    const send = (o) => console.log(JSON.stringify(o));
    const dur = 90;
    send({ type: "progress", pct: 17, label: "Analyzing…" });
    const m = await measureSource(file, w, h, dur);
    console.log("[analysis]", JSON.stringify(m));
    const vf = buildFilters(m, w, h);
    console.log("[vf]", vf);
    await run(["-y", "-t", "3", "-i", file, "-vf", vf, "-c:v", "libx264", "-preset", "faster", "-crf", "18", "-an", "-movflags", "+faststart", "/tmp/out.mp4"]);
    await grabFrame("/tmp/out.mp4", 1, "/tmp/a.jpg", w);
    console.log("[ok] /tmp/out.mp4 + /tmp/a.jpg written");
  })().catch((e) => { console.error("[fail]", e.message); process.exit(1); });
}
