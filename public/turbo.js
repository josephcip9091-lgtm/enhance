/* Turbo engine — WebCodecs + WebGL2 (engine #2).
   Decodes with hardware, filters on GPU with the same grade recipe as the
   server/wasm engine, encodes with hardware encoder, muxes to MP4.
   Caller (index.html) falls back to the wasm quality engine on any error. */

function even(x) {
  return Math.max(2, Math.round(x / 2) * 2);
}

export const supported = (function () {
  try {
    return (
      typeof window !== "undefined" &&
      "VideoDecoder" in window &&
      "VideoEncoder" in window &&
      "AudioEncoder" in window &&
      "AudioData" in window &&
      !!document.createElement("canvas").getContext("webgl2")
    );
  } catch (e) {
    return false;
  }
})();

function frameStats(buf, w, h) {
  const step = 3;
  const gw = Math.floor(w / step), gh = Math.floor(h / step);
  if (gw < 12 || gh < 12) return null;
  let sum = 0, count = 0;
  for (let yy = 0; yy < h; yy += 2) for (let xx = 0; xx < w; xx += 2) { sum += buf[yy * w + xx]; count++; }
  const mean = sum / count;
  const vals = [], grads = [];
  for (let j = 3; j < gh - 3; j++) {
    for (let i = 3; i < gw - 3; i++) {
      const base = j * step * w;
      const c = buf[base + i * step];
      if (c < 18 || c > 238) continue;
      let s25 = 0;
      for (let dj = -2; dj <= 2; dj++) {
        const row = (j + dj) * step * w;
        for (let di = -2; di <= 2; di++) s25 += buf[row + (i + di) * step];
      }
      const cx = i * step, cy = j * step;
      const g = Math.abs(c - buf[cy * w + cx + step]) + Math.abs(c - buf[cy * w + cx - step]) +
                Math.abs(c - buf[(cy + step) * w + cx]) + Math.abs(c - buf[(cy - step) * w + cx]);
      vals.push(Math.abs(c * 25 - s25));
      grads.push(g);
    }
  }
  if (vals.length < 500) return null;
  const idx = vals.map((v, k) => k).sort((a, b) => grads[a] - grads[b]);
  const half = idx.length >> 1;
  const flat = [];
  for (let k = 0; k < half; k++) flat.push(vals[idx[k]]);
  flat.sort((a, b) => a - b);
  return { y: mean, noise: flat[flat.length >> 1] / 25 };
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

function gpuParams(m) {
  const noisy = m && m.noise != null && m.noise >= 1.4;
  const y = m ? m.y : null;
  const bright = y != null && y > 170;
  const clar = noisy ? 0.4 : 0.75;
  return {
    dn: noisy ? 0.55 : 0.35,
    tMix: noisy ? 0.16 : 0,
    s1: clar,
    s2: bright ? (noisy ? 0.45 : 0.7) : (noisy ? 0.55 : 0.9),
    expo: brightLift(y),
    con: brightContrast(y),
    sat: brightSat(y),
    gam: bright ? 1.0 : 0.97,
    tint: 0.04,
    roll: bright ? 1 : 0
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function measureVideo(file, w, h, dur) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error("probe load failed"));
      v.src = url;
    });
    const short = Math.min(w, h);
    let mw = w, mh = h;
    if (short > 1080) {
      if (w < h) { mw = 1080; mh = Math.round(h * 1080 / w); }
      else { mh = 1080; mw = Math.round(w * 1080 / h); }
    }
    mw = even(mw); mh = even(mh);
    const win = Math.min(Math.max(0.5, dur), 90);
    const n = Math.max(6, Math.min(16, Math.round(win)));
    const cvs = document.createElement("canvas");
    cvs.width = mw; cvs.height = mh;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    let ySum = 0, nSum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.min((i + 0.5) * win / n, Math.max(0, dur - 0.05));
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error("seek timeout")), 5000);
        v.onseeked = () => { clearTimeout(to); res(); };
        v.currentTime = t;
      });
      ctx.drawImage(v, 0, 0, mw, mh);
      const d = ctx.getImageData(0, 0, mw, mh).data;
      const luma = new Uint8Array(mw * mh);
      for (let p = 0; p < mw * mh; p++) luma[p] = (d[p * 4] * 77 + d[p * 4 + 1] * 150 + d[p * 4 + 2] * 29) >> 8;
      const st = frameStats(luma, mw, mh);
      if (st) { ySum += st.y; nSum += st.noise; cnt++; }
    }
    return cnt ? { y: ySum / cnt, noise: nSum / cnt } : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const FS = `#version 300 es
precision highp float;
uniform sampler2D uCur, uPrev;
uniform vec2 uOut, uTexel;
uniform float uExpo, uCon, uSat, uGam, uTint, uDn, uTMix, uS1, uS2, uRoll;
out vec4 o;
const vec2 OFFS[8] = vec2[8](vec2(1.0,0.0),vec2(-1.0,0.0),vec2(0.0,1.0),vec2(0.0,-1.0),vec2(1.0,1.0),vec2(-1.0,-1.0),vec2(1.0,-1.0),vec2(-1.0,1.0));
float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
vec3 smp(vec2 uv){ return texture(uCur, clamp(uv, vec2(0.002), vec2(0.998))).rgb; }
void main(){
  vec2 uv = gl_FragCoord.xy / uOut;
  vec3 c0 = texture(uCur, uv).rgb;
  vec3 m = c0; float wsum = 1.0;
  for (int i = 0; i < 8; i++) {
    vec3 s = smp(uv + OFFS[i] * uTexel * 1.5);
    float d = distance(s, c0);
    float w = exp(-d * d * 12.0);
    m += s * w; wsum += w;
  }
  m /= wsum;
  vec3 c = mix(c0, m, uDn);
  if (uTMix > 0.001) {
    vec3 pv = texture(uPrev, uv).rgb;
    float sim = clamp(1.0 - distance(pv, c0) * 4.0, 0.0, 1.0);
    c = mix(c, mix(c0, pv, 0.5), uTMix * sim);
  }
  vec3 wide = (smp(uv + vec2(2.0,0.0)*uTexel) + smp(uv - vec2(2.0,0.0)*uTexel)
             + smp(uv + vec2(0.0,2.0)*uTexel) + smp(uv - vec2(0.0,2.0)*uTexel)) * 0.25;
  c += uS1 * (c - wide);
  vec3 fine = (smp(uv + vec2(1.0,0.0)*uTexel) + smp(uv - vec2(1.0,0.0)*uTexel)
             + smp(uv + vec2(0.0,1.0)*uTexel) + smp(uv - vec2(0.0,1.0)*uTexel)) * 0.25;
  c += uS2 * 0.5 * (c - fine);
  c = max(c, vec3(0.0));
  c *= exp2(uExpo);
  c = (c - 0.5) * uCon + 0.5;
  float l = lum(c);
  c = mix(vec3(l), c, uSat);
  c.r += uTint; c.b -= uTint;
  c = pow(c, vec3(uGam));
  if (uRoll > 0.5) c = mix(c, min(c, vec3(0.90)), smoothstep(0.86, 1.0, c));
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const VS = `#version 300 es
void main(){
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

function initGL(outW, outH, p, srcW, srcH) {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, alpha: false, premultipliedAlpha: false });
  if (!gl) throw new Error("WebGL2 init failed");
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const curTex = mkTex();
  const prevTex = mkTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, outW, outH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, curTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  const U = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(U("uCur"), 0);
  gl.uniform1i(U("uPrev"), 1);
  gl.uniform2f(U("uOut"), outW, outH);
  gl.uniform2f(U("uTexel"), 1 / srcW, 1 / srcH);
  gl.uniform1f(U("uExpo"), p.expo);
  gl.uniform1f(U("uCon"), p.con);
  gl.uniform1f(U("uSat"), p.sat);
  gl.uniform1f(U("uGam"), p.gam);
  gl.uniform1f(U("uTint"), p.tint);
  gl.uniform1f(U("uDn"), p.dn);
  gl.uniform1f(U("uTMix"), p.tMix);
  gl.uniform1f(U("uS1"), p.s1);
  gl.uniform1f(U("uS2"), p.s2);
  gl.uniform1f(U("uRoll"), p.roll);
  gl.viewport(0, 0, outW, outH);
  return { canvas, gl, curTex, prevTex, prog };
}

function drawFrame(frame, st) {
  const gl = st.gl;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, st.curTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function extractDescription(entry) {
  const b = entry && (entry.avcC || entry.hvcC);
  if (!b) return null;
  const ds = new window.MP4BoxNS.DataStream();
  ds.endianness = 0;
  b.write(ds);
  const size = b.size || ds.buffer.byteLength;
  return new Uint8Array(ds.buffer, 0, Math.min(size, ds.buffer.byteLength));
}

async function encodeAudioCollect(audio, log) {
  const out = [];
  const rates = [320000, 256000, 192000, 128000];
  let enc = null, used = 0;
  for (const bitrate of rates) {
    try {
      enc = new AudioEncoder({
        output: (chunk, meta) => out.push({ chunk, meta }),
        error: (e) => log("[audio-enc] " + (e.message || e))
      });
      enc.configure({ codec: "mp4a.40.2", sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate });
      used = bitrate;
      break;
    } catch (e) { enc = null; }
  }
  if (!enc) throw new Error("AAC encoder unavailable");
  log("[audio] encoding AAC @ " + used / 1000 + "k");
  const CH = audio.sampleRate;
  const nCh = audio.buf.numberOfChannels, outCh = audio.channels;
  for (let off = 0; off < audio.length; off += CH) {
    const n = Math.min(CH, audio.length - off);
    const data = new Float32Array(n * outCh);
    for (let c = 0; c < outCh; c++) {
      const srcCh = audio.buf.getChannelData(Math.min(c, nCh - 1));
      data.set(srcCh.subarray(off, off + n), c * n);
    }
    const ad = new AudioData({
      format: "f32-planar",
      sampleRate: audio.sampleRate,
      numberOfFrames: n,
      numberOfChannels: outCh,
      timestamp: Math.round(off / audio.sampleRate * 1e6),
      data
    });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 6) await sleep(0);
  }
  await enc.flush();
  enc.close();
  return out;
}

export async function runTurbo(file, meta, hooks) {
  if (!supported) throw new Error("This browser lacks WebCodecs support");
  if (!window.Mp4Muxer) throw new Error("Muxer library not loaded");
  const { bar, log, analysis } = hooks;
  const cap = Math.min(meta.dur, Math.min(meta.w, meta.h) <= 1080 ? 180 : 90);
  const fail = { err: null };
  let demuxComplete = false;

  bar(4, "Analyzing video… (grain + brightness)");
  const m = await measureVideo(file, meta.w, meta.h, meta.dur).catch(e => {
    log("[analysis-fallback] " + e.message);
    return null;
  });
  const noisy = m && m.noise != null && m.noise >= 1.4;
  if (analysis) analysis(m);
  bar(14, noisy ? "Grainy source detected — deeper cleanup engaged" : "Clean source detected — full sharpness engaged");

  let audio = null;
  try {
    bar(15, "Reading audio…");
    const ab = await file.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const actx = new Ctx();
    try {
      const buf = await actx.decodeAudioData(ab);
      audio = {
        sampleRate: buf.sampleRate,
        channels: Math.min(2, buf.numberOfChannels),
        buf,
        length: Math.min(buf.length, Math.round(cap * buf.sampleRate))
      };
    } finally {
      try { actx.close(); } catch (e) {}
    }
  } catch (e) {
    log("[audio] decode failed: " + (e.message || e));
  }

  bar(17, "Reading video…");
  const vbuf = await file.arrayBuffer();

  const MP4BoxNS = await import("./vendor/turbo/mp4box.all.js");
  window.MP4BoxNS = MP4BoxNS;

  let info = null, vt = null;
  const boxFile = MP4BoxNS.createFile();
  const demuxReady = new Promise((res, rej) => {
    boxFile.onReady = (i) => {
      info = i;
      const v = i.videoTracks && i.videoTracks[0];
      if (v && /^(avc1|hvc1|hev1)/i.test(v.codec || "")) {
        vt = v;
        boxFile.setExtractionOptions(v.id, null, {});
      }
      res();
    };
    boxFile.onError = (e) => rej(new Error("demux: " + (e.message || e)));
  });
  vbuf.fileStart = 0;
  boxFile.appendBuffer(vbuf);
  boxFile.flush();
  await demuxReady;
  demuxComplete = true;
  if (!vt) throw new Error("No supported video track found (Turbo needs MP4/MOV)");
  const fps = vt.samples_duration ? (vt.nb_samples / (vt.samples_duration / vt.timescale)) : 30;
  const tw = even(vt.track_width), th = even(vt.track_height);
  log("[turbo] " + tw + "x" + th + " @ " + fps.toFixed(1) + "fps, " + vt.nb_samples + " frames, codec " + vt.codec);

  let audioChunks = null;
  if (audio) {
    try { audioChunks = await encodeAudioCollect(audio, log); }
    catch (e) { log("[audio-enc] " + (e.message || e)); }
  }

  const muxOpts = {
    target: new window.Mp4Muxer.ArrayBufferTarget(),
    video: { codec: "avc", width: tw, height: th },
    fastStart: "in-memory"
  };
  if (audioChunks && audioChunks.length)
    muxOpts.audio = { codec: "aac", numberOfChannels: audio.channels, sampleRate: audio.sampleRate };
  const muxer = new window.Mp4Muxer.Muxer(muxOpts);
  if (audioChunks) for (const a of audioChunks) muxer.addAudioChunk(a.chunk, a.meta);

  const vbitrate = Math.max(2500000, Math.min(42000000, Math.round(tw * th * fps * 0.09)));
  const cand = [];
  if (/^avc1/i.test(vt.codec)) cand.push(vt.codec);
  cand.push("avc1.640034", "avc1.4D0034", "avc1.42E03E");
  let encCfg = null;
  for (const codec of cand) {
    try {
      const c = { codec, width: tw, height: th, bitrate: vbitrate, framerate: fps, latencyMode: "quality", avc: { format: "avc" } };
      const s = await VideoEncoder.isConfigSupported(c);
      if (s && s.supported) { encCfg = c; break; }
    } catch (e) {}
  }
  if (!encCfg) throw new Error("No usable H.264 encoder config");
  log("[turbo] encoder " + encCfg.codec + " @ " + Math.round(vbitrate / 1e6 * 10) / 10 + " Mbps");

  const params = gpuParams(m);
  const st = initGL(tw, th, params, meta.w, meta.h);

  const targetUs = Math.max(0.3, Math.min(meta.dur, cap) * 0.35) * 1e6;
  const snapW = Math.min(1280, meta.w);
  const snapH = Math.max(2, Math.round(snapW * meta.h / meta.w));
  const snap = { done: false, before: null, after: null };
  const mkCvs = () => {
    const c = document.createElement("canvas");
    c.width = snapW;
    c.height = snapH;
    return c;
  };

  let lastKf = -1e12, processed = 0, stop = false;
  const encoder = new VideoEncoder({
    output: (chunk, mta) => { muxer.addVideoChunk(chunk, mta); },
    error: (e) => { fail.err = fail.err || new Error("encoder: " + (e.message || e)); }
  });
  encoder.configure(encCfg);

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (fail.err) { try { frame.close(); } catch (e) {} return; }
      try {
        if (frame.timestamp >= cap * 1e6) { stop = true; try { frame.close(); } catch (e) {} return; }
        const dur = frame.duration || Math.round(1e6 / Math.max(1, Math.min(240, fps)));
        if (!snap.done && frame.timestamp >= targetUs) {
          snap.done = true;
          try {
            const bc = mkCvs();
            bc.getContext("2d").drawImage(frame, 0, 0, snapW, snapH);
            snap.before = bc;
          } catch (e) {}
        }
        drawFrame(frame, st);
        frame.close();
        if (snap.before && !snap.after) {
          try {
            const ac = mkCvs();
            ac.getContext("2d").drawImage(st.canvas, 0, 0, snapW, snapH);
            snap.after = ac;
          } catch (e) {}
        }
        const out = new VideoFrame(st.canvas, { timestamp: frame.timestamp, duration: dur });
        if (params.tMix > 0) {
          const gl = st.gl;
          gl.bindTexture(gl.TEXTURE_2D, st.prevTex);
          gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 0, 0, tw, th, 0);
        }
        const kf = out.timestamp - lastKf >= 2e6;
        if (kf) lastKf = out.timestamp;
        encoder.encode(out, { keyFrame: kf });
        out.close();
        processed++;
        if (processed % 5 === 0) {
          const p = Math.min(1, frame.timestamp / (cap * 1e6));
          bar(20 + p * 74, "Enhancing (GPU)… " + Math.round(p * 100) + "% — keep this tab open");
        }
      } catch (e) {
        fail.err = fail.err || e;
        try { frame.close(); } catch (e2) {}
      }
    },
    error: (e) => { fail.err = fail.err || new Error("decoder: " + (e.message || e)); }
  });

  const sampleQ = [];
  let configured = false;
  boxFile.onSamples = (id, user, samples) => {
    if (id !== vt.id) return;
    for (const s of samples) sampleQ.push(s);
  };

  try {
    let qi = 0;
    let stall = 0;
    const total = vt.nb_samples || 0;
    for (;;) {
      if (fail.err) throw fail.err;
      if (stop) break;
      if (qi >= sampleQ.length) {
        if (demuxComplete && ((total && qi >= total) || stall > 200)) break;
        stall += 4;
        await sleep(4);
        continue;
      }
      if (decoder.decodeQueueSize > 40 || encoder.encodeQueueSize > 12) {
        await sleep(4);
        continue;
      }
      const s = sampleQ[qi++];
      const tUs = s.cts * 1e6 / s.timescale;
      if (tUs >= cap * 1e6) { stop = true; break; }
      if (!configured) {
        const desc = extractDescription(s.description);
        decoder.configure({ codec: vt.codec, description: desc });
        configured = true;
      }
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: tUs,
        duration: s.duration * 1e6 / s.timescale,
        data: new Uint8Array(s.data, 0, s.data.byteLength)
      }));
    }
    await decoder.flush();
    decoder.close();
    await encoder.flush();
    encoder.close();
    if (fail.err) throw fail.err;
    muxer.finalize();
  } finally {
    if (decoder.state !== "closed") try { decoder.close(); } catch (e) {}
    if (encoder.state !== "closed") try { encoder.close(); } catch (e) {}
    try {
      const lc = st.gl.getExtension("WEBGL_lose_context");
      if (lc) lc.loseContext();
    } catch (e) {}
  }

  log("[turbo] encoded " + processed + " frames");
  bar(96, "Packaging…");
  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  if (!blob.size) throw new Error("Empty output");

  let beforeUrl = null, afterUrl = null;
  try {
    if (snap.before && snap.after) {
      const [b, a] = await Promise.all([
        new Promise(res => snap.before.toBlob(res, "image/jpeg", 0.85)),
        new Promise(res => snap.after.toBlob(res, "image/jpeg", 0.85))
      ]);
      if (b) beforeUrl = URL.createObjectURL(b);
      if (a) afterUrl = URL.createObjectURL(a);
    }
  } catch (e) { log("[frames] skipped: " + (e.message || e)); }

  return { blob, frames: processed, outW: tw, outH: th, beforeUrl, afterUrl };
}
