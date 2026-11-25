# farmclip: OpusClip teardown and build plan

Written for: the founder and whoever builds farmclip with them. Date: 2026-11-20.

---

## Part 1: OpusClip teardown

### 1.1 Company

| | |
|---|---|
| Revenue | $50M+ ARR (CEO, Oct 2026). About $10M in 2024, so 5x in two years. |
| Users | 20M+ registered, ~300K paying. |
| Team | ~100–150 people. |
| Funding | $50M–79M total (sources differ). SoftBank Vision Fund 2 led the latest round (Mar 2025) at a $215M valuation. |
| Direction | Moving from "clipping tool" to "AI growth tool for video": OpusClip 4.0 auto-edit (Nov 2026), Agent Opus (prompt to finished video using Veo, Kling, Runway, Sora), OpusSearch (mine a whole video catalogue). |

Sources: [Sacra](https://sacra.com/c/opusclip/), [ARR Club](https://www.arr.club/signal/opusclip-hit-50m-arr-with-20m-users-turning-long-video-into-shorts), [CB Insights](https://www.cbinsights.com/company/opus-clip/financials), [OpusClip blog](https://www.opus.pro/blog/celebrating-2-years-of-opusclip-from-the-best-ai-clipping-tool-to-the-best-ai-growth-tool-for-video-creators), [Agent Opus explainer](https://mer.vin/2026/07/agent-opus-explained-opusclip-end-to-end-ai-video-agent/).

**Takeaway:** the money is in the full pipeline (clip, edit, post, measure), not in clipping alone. Their growth from $10M to $50M came with adding editing, publishing and an API on top of clipping.

### 1.2 Complete feature map

From [opus.pro](https://www.opus.pro), [ClipAnything](https://www.opus.pro/clipanything), the [help center](https://help.opus.pro/docs/article/introduction-to-opusclip), the [API docs](https://help.opus.pro/api-reference/overview) and [pricing](https://www.opus.pro/pricing).

**Ingest**
- Links from YouTube, Drive, Vimeo, Zoom, Twitch, Rumble, Facebook, LinkedIn, X, Loom, Riverside, StreamYard; file upload.
- Up to 10 hours and 30 GB per video. 20+ languages.

**AI clipping ("ClipAnything")**
- Multimodal: reads visuals (objects, actions, on-screen text), audio (speakers, laughter, cheering, music), sentiment, and genre "narratives".
- Works with little or no dialogue (sports, vlogs, gaming).
- Hands-free mode auto-detects genre. Custom mode takes a natural-language prompt ("every Messi goal").
- Outputs shorts, clips up to 15 minutes, and highlight reels stitched from several moments.
- **Virality score 0–99**, built from four sub-scores: Hook, Flow, Value, Trend.

**Reframing ("ReframeAnything")**
- 9:16, 1:1 and 16:9. Tracks faces and moving objects.
- Manual reframe and subject tracking in the editor.
- Layouts: speaker focus, split screen, screen share.

**Captions**
- Animated templates, ~97% accuracy claimed, 20+ languages.
- AI emojis and keyword highlighting; editable text; custom fonts (Pro: 2).

**Editor**
- Trim and extend; text and timeline editing; text overlays; transitions.
- Speech cleanup (filler words, pauses, bad takes).
- AI B-roll (stock and generated, costs extra credits); music; AI sound effects; AI voiceover; dubbing.
- Intro and outro cards; eye-contact correction; AI upscaling.
- 4.0: auto-edit "Recipes", viral hook templates, motion graphics (spoken numbers and names become animated graphics).

**Brand**
- Brand templates (fonts, colours, logo, intro/outro): Starter 1, Pro up to 4, Business custom.

**Distribution**
- Titles, descriptions and hashtags generated per clip.
- Scheduler and one-click posting to YouTube Shorts, TikTok, Instagram, plus more on Pro (6 accounts).
- Custom thumbnails.

**Export**
- MP4 up to 4K on Business; bulk export.
- XML export to Premiere Pro and DaVinci Resolve.

**Teams**
- Workspaces (Pro 2–4 seats, Business unlimited), sub-teams, collections, SSO, invoicing.

**Developer**
- REST API: create project, query clips, edit clips, brand templates, social posting, share project, webhooks.
- 30 requests/min. Concurrency 4 on Pro, 50 on Business. 1 credit = 1 minute, 10-credit minimum.
- Zapier; MCP connector with 25 tools; ChatGPT/Claude "AI Producer" plugin.

**Pricing**

| Plan | Price | Key limits |
|---|---|---|
| Free | $0 | ~60 min/mo, watermark, 3-day storage, no virality score |
| Starter | $15/mo | ~150 min/mo, no watermark, 1 brand template, auto-post to 3 platforms |
| Pro | $29/mo | ~300 min/mo, B-roll, XML export, 2–4 seats, scheduler, API (beta) |
| Business | Custom | Unlimited seats, SSO, 4K, CMS integration, 50 concurrent API jobs |

### 1.3 What users complain about (our openings)

From [Trustpilot](https://www.trustpilot.com/review/opus.pro) (4.0 from 513 reviews) and independent reviews ([BIGVU](https://bigvu.tv/blog/opus-clip-tested-2026-where-ai-wins-40-percent-discard/), [Choppity](https://www.choppity.com/blog/best-opus-clip-alternatives/), [Castmagic](https://www.castmagic.io/blog/opus-clip-alternatives)):

1. **Credits.** Unused credits vanish at renewal (one user lost ~3,000). B-roll costs +4–15 credits per clip. Re-uploading after a failure costs credits again.
2. **Billing.** Charges after cancelling, surprise annual renewals, 20-day refund reviews, support mostly a bot.
3. **Clip quality.** 20–40% of picks get discarded; the virality score favours loud moments; hook detection is the most-cited weakness.
4. **Built for one video at a time.** The editor-centric workflow is slow when you process dozens of videos a day.

### 1.4 Competitors in one line each

- **Submagic:** best animated captions and 120+ languages; weak at picking clips.
- **Klap:** good caption styles, pays per clip; no free tier, thin brand kit and publishing.
- **Vizard:** cheaper at volume, team-friendly; fewer AI features.
- **Captions app:** mobile-first, generative B-roll.
- **CapCut, Descript:** big editors adding clipping as one feature among many.

---

## Part 2: Where we stand today

What the codebase already does, mapped against OpusClip:

| Capability | OpusClip | farmclip today | Where in our code |
|---|---|---|---|
| YouTube link ingest | ✅ | ✅ (yt-dlp; only the needed seconds are downloaded) | `src/youtube.ts` |
| Other links (Vimeo, Twitch, X…) | ✅ | ⚠️ yt-dlp supports them, untested | `src/youtube.ts` |
| File upload | ✅ | ❌ | — |
| Transcript | ✅ own ASR | ✅ YouTube captions; Gemini watches the video when there are none | `src/captions.ts`, `src/jobs.ts` |
| AI clip picking | ✅ multimodal + prompts | ✅ Gemini on transcript or video; no prompts | `src/highlights.ts`, `src/gemini.ts` |
| Cuts snapped to spoken words | ✅ | ✅ | `resolveClip` in `src/highlights.ts` |
| Virality score | ✅ 0–99, 4 sub-scores | ⚠️ 1–10, one number | `CLIP_SCHEMA` |
| Speaker-tracking 9:16 reframe | ✅ | ✅ face + mouth motion, scene cuts | `src/reframe.ts`, `src/faces.ts` |
| 1:1 and 16:9, split screen, object tracking | ✅ | ❌ (we have a blurred full-frame fallback) | `src/render.ts` |
| Animated word-by-word captions | ✅ many templates | ✅ one style | `buildAss` in `src/render.ts` |
| Review queue (keep/reject) | ⚠️ basic | ✅ built for volume | `public/app.js` (desktop UI) |
| Batch queue, auto-retry, spend tracking | ⚠️ | ✅ | `src/jobs.ts`, `src/usage.ts` |
| Editor, B-roll, speech cleanup, brand kit | ✅ | ❌ | — |
| Scheduler and publishing | ✅ | ❌ | — |
| API, webhooks, MCP | ✅ | ❌ | — |
| Accounts, teams, billing | ✅ | ⚠️ website has demo login only | `my-platform/src/lib/mock-auth.server.ts` |
| Desktop app | ❌ | ✅ Windows (Electron) | `desktop/` |

**Our advantages already in code:** high-volume batch processing on cheap hardware, a review-first workflow, word-accurate cuts, real speaker tracking, and a desktop app that runs on the user's own machine at near-zero server cost.

---

## Part 3: Product shape (desktop-first)

**Decision (2026-11-20):** all clipping happens in the desktop app. The website never processes video.

| Lives in the **desktop app** | Lives on the **website** |
|---|---|
| Paste links, file import | Marketing site, pricing, docs |
| yt-dlp download, transcript, Gemini clip picking | Sign up, login, password reset |
| Face/speaker tracking, reframe, captions, render | Account dashboard: plan, linked computers, profile |
| Review (keep/reject), editor, export | Billing (Stripe checkout, invoices, one-click cancel) |
| Brand kit applied at render time | Download page and the auto-update feed |
| Posting clips to social platforms | Device linking: connects the app to an account |
| Local job queue, spend counter | Entitlements API: tells the app what the plan unlocks |
| | Social account connections (OAuth needs a web redirect) |
| | Later: team workspaces, shared brand kits, analytics |

**Why this is a strong position against OpusClip:**

1. **Near-zero processing cost.** Rendering runs on the customer's machine. OpusClip pays for every minute it processes; we don't, so we can offer far more volume per dollar.
2. **No upload wait.** A 2-hour 4K file never leaves the user's disk; YouTube links stream only the seconds needed.
3. **YouTube blocking is mostly avoided.** Downloads come from the user's home connection, not datacentre IPs, which is the biggest operational risk for cloud clippers.
4. **Privacy.** Agencies with client footage under NDA keep it on their own machines.
5. **Volume workflow.** The review-first UI and batch queue already exist.

**What we give up, and how we handle it:**

| Trade-off | Answer |
|---|---|
| Windows only today | Mac build in months 4–6 (Electron supports it; ffmpeg, yt-dlp and ONNX have Mac builds). |
| Speed depends on the user's hardware | Hardware encoding (Sprint 0), pipeline overlap, clear minimum specs on the download page. |
| Scheduled posts need the app running | Start with "post now / post while the app is open"; add an optional cloud relay later. |
| Desktop apps are easier to pirate | The real value gate is the AI and account services, which live server-side (see below). |

### Key decision: whose Gemini key?

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **A. User brings their own key** (today) | Key stored in desktop settings | Zero AI cost for us; simplest | Setup friction kills mass-market signups; no way to charge for AI |
| **B. AI calls go through our API** (recommended) | App sends the transcript (a few KB) to `/api/ai/pick`; our server calls Gemini with our key and meters usage per account | One-click onboarding; plan limits enforced server-side; piracy-resistant; prompts improve without an app update | We pay Gemini (roughly $0.01–0.05 per video) and must keep the API up |
| **C. Both** | Paid plans use B; power users may switch to their own key | Flexible | Two code paths |

Recommendation: **B for launch, C later.** The transcript-based pick is a small JSON request, so it fits the website's Cloudflare hosting with no video passing through it.

---

## Part 4: Architecture

```
┌──────────────── Desktop app (Electron, Windows → Mac) ─────────────────┐
│ UI (review, editor) ──► local Node backend (src/): queue, yt-dlp,      │
│                         transcript, faces (ONNX), reframe, ffmpeg      │
│                         clips stay on disk; posting via platform APIs  │
└───────┬──────────────────────────────────────────────────────▲─────────┘
        │ device token (HTTPS)                                  │ update feed
        ▼                                                       │
┌──────────────── Website (my-platform, Cloudflare) ─────────────┴───────┐
│ Marketing · auth · dashboard · billing · downloads                     │
│ /api/device/*   link a computer to an account                          │
│ /api/me         plan and entitlements for the app                      │
│ /api/ai/pick    Gemini proxy with per-account metering (option B)      │
│ /api/social/*   OAuth connect, short-lived upload tokens               │
└───────┬───────────────────────────────────────────────┬───────────────┘
        ▼                                               ▼
   Postgres (Neon): users, devices,              Stripe, Gemini,
   subscriptions, usage, social accounts         Resend, R2 (installers)
```

| Need | Choice |
|---|---|
| Website auth | Better Auth on Postgres (replaces the demo login; pages already call `session.ts`) |
| Database | Neon Postgres (works from Cloudflare via its serverless driver) |
| App ↔ account linking | OAuth 2.0 device flow: the app shows a code, the user approves it on the website |
| Payments | Stripe Checkout + Customer Portal + webhooks |
| Installer and updates | electron-builder NSIS + `electron-updater`; feed on R2 or GitHub Releases |
| Code signing | Windows code-signing certificate (Azure Trusted Signing is the cheapest); without it SmartScreen warns every user |
| Crash reporting | Sentry (Electron + website) |
| Product analytics | PostHog, opt-in in the app |

---

## Part 5: Build plan

Two-week sprints, two developers. **D** = desktop work, **W** = website work.

### Sprint 0: desktop core fixes (in progress)

| Task | Status |
|---|---|
| **D** Block cross-site requests to the local server (`src/guard.ts`, `test/guard.test.ts`) | ✅ done |
| **W** Remove the clipping proxy from the website; dashboard becomes an account page | ✅ done |
| **D** Hardware encoding (`src/encoder.ts`, `ENCODER` setting, automatic x264 fallback). Measured on the dev laptop: QuickSync was **no faster** than x264 (decoding and scaling dominate), so `auto` only picks NVIDIA NVENC; QSV/AMF are opt-in. | ✅ done |
| **D** Resume after restart: picks and finished clips kept, no repeat Gemini call (verified live) | ✅ done |
| **D** Pipeline overlap: next video's info, captions and Gemini pick run while the current one renders (verified live: ~45 s saved per video) | ✅ done |
| **D** Find the real render bottleneck: profile decode vs scale vs captions vs face tracking per clip, then optimise the biggest one | next |
| Commit the work; clean up old `swarm-*` branches | needs your go-ahead |

### Sprint 1: accounts and device linking

| Task | Detail |
|---|---|
| **W** Real auth | Better Auth + Neon; keep the existing login, signup and reset pages. |
| **W** Device flow | `POST /api/device/code` returns a device code and a short user code; `/link?code=ABCD-EFGH` lets a signed-in user approve; the app polls `POST /api/device/token`. Tokens stored hashed in a `devices` table. |
| **W** Linked computers | Dashboard lists devices (name, OS, app version, last seen) with "Sign out this computer". |
| **D** Sign-in screen | First launch: "Sign in with your browser" opens `/link`, shows the code, polls, stores the token with Electron `safeStorage`. |
| **W/D** `/api/me` | Returns user, plan and entitlements; the app caches it for offline use (7-day grace). |

### Sprint 2: distribution

| Task | Detail |
|---|---|
| **D** Signed installer | Code signing in electron-builder; builds in GitHub Actions on a Windows runner. |
| **D** Auto-update | `electron-updater` with stable and beta channels; "Restart to update" banner. |
| **W** Download page | `/download`: version, release notes, system requirements; the dashboard button reads `VITE_DESKTOP_DOWNLOAD_URL`. |
| **D/W** Crash reporting | Sentry in Electron main, renderer and backend; release tagging. |
| **D** First-run checks | GPU encoder, disk space, write access; friendly fixes instead of raw ffmpeg errors. |

### Sprint 3: billing and the AI proxy

| Task | Detail |
|---|---|
| **W** Stripe | Checkout for paid plans, Customer Portal for cancel and invoices, webhooks update `subscriptions`. |
| **W** Pricing page | Real plans; FAQ on local processing and no expiring credits. |
| **W** `/api/ai/pick` | Takes `{transcript, meta, settings, prompt}`, calls Gemini with our key, returns clip ideas, writes `usage_events`. Per-plan monthly limits. |
| **D** Use the proxy | `src/gemini.ts` gets a second transport: "farmclip cloud" (default when signed in) or "own key" (advanced setting). |
| **D** Plan gating | Watermark and feature flags read from `/api/me`. |

### Sprints 4–6: clip quality and captions (desktop)

| Feature | Build |
|---|---|
| Prompted clipping | Prompt box beside the links ("funny moments", "clips about pricing"), passed into the pick prompt. Genre auto-detect. |
| Virality score v2 | Hook / Flow / Value / Trend sub-scores (0–25 each) with a reason each, shown on the clip card. |
| Hook check | Second pass on the first 3 seconds; suggests a tighter start or a text hook. |
| Kept-rate tracking | Each keep/reject reported (anonymised) with the prompt version so prompts can be A/B tested across users. Needs the AI proxy. |
| Caption templates | `buildAss` becomes a JSON-template renderer (font, colours, outline, position, words per line, highlight, animation). 12 presets. |
| Keywords and emojis | Gemini marks keywords per line; the template styles them. |
| Caption translation | Translate words, re-time within each caption group. |
| Titles, descriptions, hashtags | Generated in the same pick call. |
| Fast review | Keyboard shortcuts, bulk keep/reject, "keep all above score X". |

### Sprints 7–9: editor and reframe (desktop)

| Feature | Build |
|---|---|
| Clip editor | Preview the source range with a caption overlay; edits saved as an `edit_spec`; final render through ffmpeg. |
| Trim and extend | Word-level handles on the transcript. |
| Speech cleanup | Remove fillers and long pauses using word timings; ffmpeg cut list. |
| Aspect ratios | 1:1 and 16:9 (the crop maths is already parameterised). |
| Layouts | Split screen for two speakers; screen share + facecam. |
| Manual reframe | Drag the crop box on keyframes. |
| Object tracking | YOLO-nano ONNX model when there's no face. |
| Brand kit | Fonts, colours, logo, intro/outro; stored on the account so it follows the user to any computer. |
| Export to editors | FCPXML and Premiere XML. |

### Sprints 10–12: publishing and B-roll

| Feature | Build |
|---|---|
| **W** Connect accounts | OAuth for YouTube, TikTok, Instagram, LinkedIn, X; refresh tokens encrypted. Apply for TikTok and Instagram API approval in Sprint 4. |
| **D** Post from the app | App asks `/api/social/token` for a short-lived access token, then uploads the clip directly to the platform. |
| **D** Auto-post rules | "Kept clips scoring 80+ go to TikTok at 6 pm" while the app runs. |
| **W** Cloud relay (optional) | Posting while the computer is off: the app uploads the scheduled clip to R2, a cron job posts it, the file is deleted after. Paid plans only. |
| **D** Thumbnails | Best frame plus title text. |
| **D** Stock B-roll and music | Pexels keywords from Gemini; licensed music with ducking under speech. |

### Month 7 onward

- **Mac app** (Apple Silicon: VideoToolbox encoding, ONNX/CoreML faces).
- **Teams:** workspaces on the website; shared brand kits and review links; seats in billing.
- **Analytics loop:** the website pulls views per posted clip; the dashboard shows performance; picking learns from it.
- **Public API and MCP** for agencies that automate.
- **Cloud render tier** as an upsell for users without a capable PC.

---

## Part 6: Pricing proposal

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 10 AI-picked videos/mo, watermark, all local features |
| Creator | $15/mo | 100 videos/mo, no watermark, all caption templates, posting to 3 accounts |
| Agency | $79/mo | 1,000 videos/mo, 5 computers, brand kits, auto-post rules, priority support |
| Own key | $8/mo | Unlimited with your own Gemini key, no watermark |

Rules: one-click cancel; failed picks don't count; nothing prepaid expires. AI cost per video is logged from Sprint 3 so limits can be tuned.

---

## Part 7: Metrics from day one

- **Download → linked device** conversion.
- **Time to first kept clip** after install.
- **Kept rate** per prompt version.
- **Videos per active device per week.**
- **AI cost per video vs revenue per video.**
- **Crash-free sessions.**

## Part 8: Risks

| Risk | Plan |
|---|---|
| Content rights | Rights attestation in the app, DMCA contact on the website, marketing aimed at people clipping their own or licensed content. |
| SmartScreen and antivirus warnings | Code signing before public launch; submit builds to Microsoft for reputation. |
| yt-dlp breaking | The app already self-updates yt-dlp; add an in-app "update now" and a status banner fed by the website. |
| Gemini price or quota changes | The proxy lets us switch models server-side without an app update. |
| Weak user hardware | Minimum spec on the download page; automatic fallback to lower output height. |

