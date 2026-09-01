# Voice Reels Review — transcript validation site

A mobile-friendly, reel-style site to validate Telugu audio↔transcript chunks.
Friends just swipe — **no export, no accounts, nothing to install**.

- Swipe **right** = Yes (correct)
- Swipe **left**  = No  (wrong)
- Swipe **up**    = Skip
- (Buttons and arrow keys also work on desktop)

Judgments are saved automatically to a serverless backend. Already-judged
chunks are never shown again to anyone.

## Architecture

```
GitHub Pages (static site)           Cloudflare R2 (audio)         Cloudflare Worker + D1
  index.html / app.js / manifest ──► 17k .wav chunks        ┌──►  records judgments
  (reel UI, swipe)                    manifest.json          └──►  /api/judged (dedup)
```

## One-time setup

### 1. Cloudflare account → R2 + D1 + Worker

1. Create a Cloudflare account.
2. **R2**: create a bucket, enable **Public access**, copy the `r2.dev` URL.
   Fill `ACCOUNT_ID/ACCESS_KEY/SECRET_KEY/BUCKET` in `upload_r2.sh`, run it.
3. **D1**: `npx wrangler d1 create pavani-judgments` → paste the `database_id`
   into `wrangler.toml`. Then create the table:
   ```bash
   npx wrangler d1 execute pavani-judgments --file=schema.sql
   ```
4. **Worker**: `npx wrangler deploy` (after `npm i -g wrangler`). Note the
   `*.workers.dev` URL.

### 2. Config

Edit `config.js`:
```js
AUDIO_BASE: "https://pub-xxxx.r2.dev/pavani_audio/",
WORKER_URL: "https://female-voice-review.xxxx.workers.dev",
```

### 3. Host the site on GitHub Pages

Push this folder (`index.html`, `app.js`, `config.js`, `manifest.json`) to a
GitHub repo, enable Pages, and share the link.

## Getting the validated dataset

When reviewing is done, fetch the final verdicts:

```bash
curl "https://YOUR-WORKER.workers.dev/api/export" -o judgments/worker.json
python3 apply_judgments.py --judgments-dir ./judgments
```

→ `validated.csv` (keep), `rejected.csv` (drop), `skipped.csv` (re-review).

## Files

- `index.html` / `app.js` — reel UI + swipe logic
- `config.js` — your R2 + Worker URLs
- `manifest.json` — all chunks (id, episode, file, transcript, timings)
- `worker.js` / `wrangler.toml` / `schema.sql` — the judgments backend
