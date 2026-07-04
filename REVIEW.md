# AIGHT.VISION — Architecture Review

## Purpose of This Document
This is a review prompt for an AI assistant. Please evaluate the architecture, code quality, and decisions made for this project, and suggest anything that could be done more efficiently, more robustly, or more simply. Point out any blind spots, future pain points, or better alternatives.

---

## Project Brief

**Site:** aight.vision (domain purchased, DNS at Porkbun, Cloudflare account exists)  
**Goal:** A publicly viewable, endless randomized stream of short video clips (0–60 sec, some longer) with no gaps or interruptions between videos. Feels like a TV channel — unusual content, no context.

**Controls:** Minimal. Fade in on interaction (mousemove, touch, keypress), fade out after 3 seconds of inactivity.
- `←` — restart current video; tap again within 1.5s to go to previous
- `→` — skip to next video

**Upload portal:** Accessible only via direct link (`aight.vision/upload`). Password-gated. Supports:
- Drag and drop files/folders (desktop)
- File picker with multiple select (desktop + mobile)
- Camera roll access (mobile)
- Shows upload queue with per-file progress

**Playlist behavior:** On each visit, shuffle the full library, start at a random point, play sequentially through. When exhausted, reshuffle and loop. No repeats within a cycle.

**Future plans:**
- Download button in controls
- QNAP NAS as storage origin (user has fast fiber, large NAS, wants to use it but safely — no exposed home network)
- Possible video transcoding for format compatibility

---

## Chosen Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Frontend hosting | Cloudflare Pages | User already has Cloudflare, free tier, global CDN |
| Video storage | Cloudflare R2 | Zero egress fees, S3-compatible, integrates with Pages |
| API (playlist, upload) | Cloudflare Pages Functions | Same repo, no separate server, runs at edge |
| Video serving | R2 public URL / custom subdomain `cdn.aight.vision` | Direct CDN serving, no Worker overhead per video |
| Auth for uploads | Shared secret header (`x-upload-secret`) | Simple, no user accounts needed for small group |
| No build step | Vanilla HTML/CSS/JS | No framework needed, deploy directly |

---

## File Structure

```
/
├── index.html                  # Main stream player
├── upload.html                 # Upload portal
├── functions/
│   └── api/
│       ├── playlist.js         # GET /api/playlist — lists R2 bucket, returns URLs
│       └── upload.js           # POST /api/upload — receives file, writes to R2
└── wrangler.toml               # Cloudflare Pages config (local dev)
```

---

## Key Implementation Details

### Seamless Playback (index.html)
Two `<video>` elements overlaid. While one plays, the other preloads the next clip. On `ended`, swap z-index and immediately play the preloaded element. The outgoing element is then loaded with the clip after next.

```
v0 (z:1, playing) → ends → v1 (z:1, plays) → v0 (z:0, preloads next+1)
```

Start muted (required for autoplay). On first user interaction, attempt unmute. If browser blocks audio, stay muted silently.

### Playlist Shuffle
Fisher-Yates shuffle on the array received from `/api/playlist`. Random `idx` start. When `idx` reaches end of array, reshuffle and restart from 0.

### Upload Flow
- Client sends `POST /api/upload` with `FormData` containing the file
- Header `x-upload-secret` checked against `UPLOAD_SECRET` env var
- Worker calls `env.VIDEOS.put(key, file.stream(), { httpMetadata })` — streams directly to R2
- Key format: `{timestamp}_{sanitized_filename}` for uniqueness
- No separate index/database — `/api/playlist` dynamically lists the R2 bucket on every request (cached 30s)
- Playlist auto-updates after every upload with no extra step

### Playlist API
Paginates through R2 bucket listing (1000 objects per page) to build full URL array. Returns JSON. `Cache-Control: public, max-age=30`.

### Upload Portal Auth
Password stored in `sessionStorage`. Sent as `x-upload-secret` header. If server returns 401, session key is cleared and user must re-enter. The upload page is not linked from the main site.

---

## Decisions Made + Rationale

1. **No database / index file** — R2 bucket listing is the source of truth for the playlist. Simpler, no sync needed, handles concurrent uploads naturally. Tradeoff: listing a bucket with thousands of objects adds latency (~100-300ms) but is cached.

2. **Two-video element swap vs. single element** — Chose two elements for seamless playback. Single element has a visible gap when setting `src` between clips. For 0-60 sec clips, the user notices gaps.

3. **No transcoding on upload** — Accepted that MOV/HEVC files may not play in Chrome/Android. Most modern mobile videos are H.264 MP4 which works universally. Can add FFmpeg transcoding later (QNAP can do this server-side).

4. **Vanilla JS, no framework** — The player and upload page are simple enough that React/Vue would add complexity and a build step with no benefit.

5. **Pages Functions over standalone Workers** — Keeps everything in one repo, one deployment. Less operational overhead.

6. **R2 public subdomain vs. serving through Worker** — Direct R2 serving is faster (no Worker invocation per video request) and cheaper. Workers have a 100MB body limit and per-invocation cost that would make video streaming expensive.

7. **Sequential upload queue (max 2 concurrent)** — Prevents mobile connections from being overwhelmed when uploading hundreds of files.

---

## Known Limitations / Open Questions

1. **Upload file size limit** — Cloudflare Workers/Pages Functions buffer the full request body. For a file > ~100MB, the upload will fail (Workers have a 128MB memory limit). Most 0-60 sec clips are well under this, but longer videos could be an issue. **Better approach:** R2 presigned URLs for direct browser-to-R2 upload (bypasses Worker memory limit). R2 presigned URLs require using the S3-compatible API, which needs AWS SDK or manual HMAC signing.

2. **Cold start on playlist fetch** — Pages Functions can have cold starts (~50-200ms). For the player, the playlist fetch happens before the user taps "begin" so this should be invisible in practice.

3. **No video format validation on upload** — The upload function accepts any file type. A user could upload non-video files. Currently filtered client-side by file extension only.

4. **Cache-Control on playlist** — 30-second cache means a newly uploaded video won't appear for up to 30s. This is fine for the use case but worth noting.

5. **No retry logic on upload errors** — Failed uploads show an error state but don't auto-retry. User would need to re-select and re-upload failed files.

6. **QNAP integration not yet implemented** — The current R2 approach is temporary/standalone. Future options:
   - Cloudflare Tunnel on QNAP (outbound-only, no open ports) serving as video origin
   - R2 as CDN cache in front of QNAP (R2 pulls from QNAP on cache miss)
   - QNAP auto-syncs to R2 via rclone/QNAP CloudSync

7. **No video thumbnail/preview** — Could be useful for a management UI later.

8. **Single UPLOAD_SECRET for all uploaders** — Works for a small group. If one person's access needs to be revoked, everyone needs a new secret.

---

## What Would You Do Differently?

Please evaluate:
- Is the two-video seamless swap the best approach for short clip playback? Any edge cases I'm missing?
- Is dynamically listing the R2 bucket for the playlist a good pattern at scale (thousands of clips)?
- Is there a simpler/safer way to handle the upload secret / access control?
- Are there any Cloudflare-specific gotchas with Pages Functions + R2 that could bite us?
- For the QNAP integration, what's the cleanest architecture that keeps the home network safe?
- Any performance concerns with hundreds of short video clips on mobile?
- Anything missing from the upload UX that would make batch-uploading hundreds of files painful?
