# Enhance — cinematic video, right in your browser

A 100% static web app: drop a video → it gets the cinematic treatment (pro color
grade, deep blacks, rich color, maximum sharpness, capped at 1080p) → compare
before/after → download. All processing happens in the visitor's browser using
FFmpeg compiled to WebAssembly. Nothing is uploaded to any server.

## Files in this repo

| File | What it is |
|---|---|
| `index.html` | The entire app (UI + logic) |
| `style.css` | Design (white/blue) |
| `vendor/` | The ffmpeg.wasm engine — **do not delete or rename anything in here** |
| `vercel.json` | COOP/COEP headers for Vercel (enables the multi-thread engine) |
| `_headers` | Same headers for Netlify |
| `lut.cube` *(optional)* | Drop a working LUT here named exactly `lut.cube` and the app automatically switches to LUT mode |

Limits by design: clips longer than 180 seconds (1080p sources) or 90 seconds
(above-1080p sources) are trimmed to fit the browser memory ceiling; inside an
embedded frame (e.g. Whop) the engine runs single-threaded — opened directly in
a tab it's multi-threaded. Both are handled automatically.

Parity with the paid server version:
- **Same adaptive brain** — before enhancing, the app decodes sample frames and
  measures each video's grain level and brightness, then picks a tailored
  filter path (deep denoise for grainy sources, full sharpness for clean ones,
  auto-exposure). The analysis is logged to **Technical details** as
  `[analysis]`, e.g. `luma=164.8 noise=0.65 path=clean`.
- **Same resolution logic** — upscales smaller videos to a 1080 short edge
  (Lanczos, capped at 3840 long edge), never downscales larger ones.
- **Same encoding** — libx264, preset `faster`, CRF 18, AAC 320k audio.
- **Smooth-motion mode** — optional 120 fps interpolation (same filter chain as
  the server's 120fps mode). Very slow in the browser; desktop recommended.
- **History** — the last 5 results are saved in the browser (IndexedDB, up to
  ~1.5 GB) and can be re-downloaded anytime on that device.

What still needs the server version: Whop payment enforcement (a static page
can't validate purchases — Whop itself gates members when the app runs as an
in-whop app) and heavy long encodes (browser memory).

## Put it on GitHub

1. Create a new repository on github.com (any name, e.g. `enhance-app`).
2. Upload **the contents of this folder** (not the folder itself — `index.html`
   must sit at the repo root). GitHub's web uploader handles drag-and-drop of
   the `vendor` folder fine.
3. Commit.

## Free hosting options (pick one)

**A. GitHub Pages (no account extras, no card):**
Repo → Settings → Pages → Source: `main` branch, folder `/ (root)` → Save.
After ~1 minute the site is live at `https://YOURUSERNAME.github.io/REPO NAME/`.
Note: GitHub Pages can't send custom headers, so the app runs in its
single-thread mode there — fully working, just slower.

**B. Vercel / Netlify (multi-thread enabled, still no card):**
- Vercel: vercel.com/new → import the repo → Deploy (uses `vercel.json`).
- Netlify: app.netlify.com → Add new site → Import from Git (uses `_headers`).

## Publishing it on Whop

Whop hosts websites free at a `yourname.whop.site` address with payments built in.

**Route 1 — Whop's AI migration (no terminal):**
1. Get the site live somewhere first (GitHub Pages works).
2. Whop Dashboard → **Websites** → **New website** → **Clone an existing site** →
   paste your live URL.
3. Whop's AI rebuilds the pages, products and checkout at your whop.site address.
4. **Check it immediately:** run a short video through the cloned site. The AI
   rebuild is made for marketing pages — if the video tool is broken or missing
   features, use Route 2 to put the real code on Whop.

**Route 2 — deploy your own code with the Whop CLI (keeps this exact app):**
Needs a terminal (on Windows use WSL or Git Bash):
```
curl -fsSL whop.com/install.sh | sh
whop apps init --app_type website --name "Enhance" --domain enhancer
cd enhance
```
Copy this repo's files into that project's `dist/client/` folder, then:
```
whop apps dev      # test locally
whop apps deploy   # publish to your whop.site address
```
Note: app type is chosen once — a website can't be converted into a Whop app
later, so start with `--app_type website`.

## Selling (when you're ready)

1. Whop Dashboard → Products → create a product with recurring $20/month pricing.
2. Copy its checkout link.
3. In `index.html`, find `WHOP_JOIN_URL` (near the top of the script) and paste
   the checkout link between the quotes. The "Join the Enhance community"
   button appears on the site automatically.

## Troubleshooting

- An error appeared → open **Technical details** under the message, copy it, send it for debugging.
- "Single-thread mode" note at the top → the page is embedded or served without
  cross-origin headers; open the URL directly in its own browser tab for full speed.
- Memory error → use a shorter clip (90 s is the cap).
