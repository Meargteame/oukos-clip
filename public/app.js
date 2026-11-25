// ==========================================================================
// oukos clip — OpusClip Dark Studio Desktop Application Controller
// ==========================================================================

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const ACTIVE_STATUSES = new Set(["fetching", "transcribing", "picking", "rendering"]);

// Electron detection
const isElectron = Boolean(window.electronAPI?.isElectron);

let currentView = "studio";
let currentReviewFilter = "review";
let jobs = [];
let healthData = null;
let usageData = null;

// Node caches to prevent <video> recreation during polling intervals
const studioJobEls = new Map();
const reviewJobEls = new Map();
const clipEls = new Map();

// --------------------------------------------------------------------------
// API Helpers
// --------------------------------------------------------------------------
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function money(usd) {
  if (!usd) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Insert nodes into container in order, only moving nodes that are out of place */
function place(container, nodes) {
  nodes.forEach((node, index) => {
    if (container.children[index] !== node) {
      container.insertBefore(node, container.children[index] ?? null);
    }
  });
  while (container.children.length > nodes.length) {
    container.lastElementChild.remove();
  }
}

// --------------------------------------------------------------------------
// Toast Notification
// --------------------------------------------------------------------------
let toastTimer = null;
function showToast(message) {
  const toastEl = $("#app-toast");
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove("hide");
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    toastEl.classList.add("hide");
  }, 3500);
}

// --------------------------------------------------------------------------
// View Routing
// --------------------------------------------------------------------------
function switchView(viewName) {
  currentView = viewName;
  $$(".sidebar-nav .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });
  $$(".view-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `view-${viewName}`);
  });

  if (viewName === "library") renderLibrary();
  if (viewName === "analytics") renderAnalytics();
}

$$(".sidebar-nav .nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// Settings button in sidebar
$("#open-settings-btn").addEventListener("click", () => {
  if (isElectron && window.electronAPI?.openSettings) {
    window.electronAPI.openSettings();
  } else {
    showToast("Configure settings in your .env file in CLI mode.");
  }
});

$("#preset-edit-btn").addEventListener("click", () => {
  if (isElectron && window.electronAPI?.openSettings) {
    window.electronAPI.openSettings();
  } else {
    showToast("Open desktop settings to edit resolution & parameters.");
  }
});

// --------------------------------------------------------------------------
// Studio Hero Form & Batch Drawer
// --------------------------------------------------------------------------
const batchToggleBtn = $("#batch-toggle-btn");
const batchTray = $("#batch-tray");
const batchCancelBtn = $("#batch-cancel-btn");
const heroForm = $("#hero-add-form");
const heroInput = $("#hero-url-input");

batchToggleBtn.addEventListener("click", () => {
  batchTray.hidden = !batchTray.hidden;
  if (!batchTray.hidden) $("#batch-urls-input").focus();
});

batchCancelBtn.addEventListener("click", () => {
  batchTray.hidden = true;
});

heroForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = heroInput.value.trim();
  if (!url) return;
  try {
    await api("/api/jobs", { method: "POST", body: JSON.stringify({ urls: url }) });
    heroInput.value = "";
    showToast("⚡ Video added to clipping queue!");
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$("#batch-submit-btn").addEventListener("click", async () => {
  const textarea = $("#batch-urls-input");
  const urls = textarea.value.trim();
  if (!urls) return;
  try {
    await api("/api/jobs", { method: "POST", body: JSON.stringify({ urls }) });
    textarea.value = "";
    batchTray.hidden = true;
    showToast("⚡ Batch queued successfully!");
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------------------
// Live Pipeline Engine Visualizer
// --------------------------------------------------------------------------
function updatePipelineVisualizer(activeJob) {
  const pipelineSec = $("#pipeline-section");
  if (!activeJob) {
    pipelineSec.hidden = true;
    return;
  }

  pipelineSec.hidden = false;
  $("#pipeline-job-name").textContent = activeJob.title || activeJob.url || "Processing video...";

  const status = activeJob.status;
  const steps = [
    { id: "p-step-fetch", activeFor: ["fetching"], doneAfter: ["transcribing", "picking", "rendering", "done"] },
    { id: "p-step-transcript", activeFor: ["transcribing"], doneAfter: ["picking", "rendering", "done"] },
    { id: "p-step-ai", activeFor: ["picking"], doneAfter: ["rendering", "done"] },
    { id: "p-step-render", activeFor: ["rendering"], doneAfter: ["done"] },
  ];

  steps.forEach((s) => {
    const el = $(`#${s.id}`);
    if (!el) return;
    el.classList.remove("active", "completed");
    if (s.activeFor.includes(status)) el.classList.add("active");
    else if (s.doneAfter.includes(status)) el.classList.add("completed");
  });
}

// --------------------------------------------------------------------------
// Studio View Jobs Queue
// --------------------------------------------------------------------------
function renderStudioJobs() {
  const container = $("#studio-jobs-list");
  const emptyState = $("#studio-empty");
  const queueCountEl = $("#studio-queue-count");

  const sortedJobs = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  queueCountEl.textContent = `${sortedJobs.length} video${sortedJobs.length === 1 ? "" : "s"}`;
  emptyState.hidden = sortedJobs.length > 0;

  const nodes = sortedJobs.map((job) => {
    let el = studioJobEls.get(job.id);
    if (!el) {
      el = document.createElement("article");
      el.className = "job";
      el.dataset.job = job.id;
      studioJobEls.set(job.id, el);
    }

    const statusClass = ACTIVE_STATUSES.has(job.status) ? "active" : job.status;
    const readyClips = job.clips.filter((c) => c.status === "ready").length;
    const clipsSub = readyClips ? ` · ${readyClips} clip${readyClips === 1 ? "" : "s"} ready` : "";
    const sub = [job.channel, job.duration ? clock(job.duration) : "", job.message, clipsSub].filter(Boolean).join(" · ");

    el.innerHTML = `
      <div class="job-head">
        <span class="status ${statusClass}">${esc(job.status)}</span>
        <div class="job-title">
          <a href="${esc(job.url)}" target="_blank" rel="noreferrer">${esc(job.title || job.url)}</a>
          <div class="job-sub">${esc(sub)}</div>
        </div>
        <div class="job-actions">
          ${readyClips > 0 ? `<button class="btn-secondary btn-sm" data-action="view-clips">View Clips (${readyClips})</button>` : ""}
          ${job.status === "error" || job.status === "done" ? `<button class="btn-secondary btn-sm" data-action="retry">Redo</button>` : ""}
          <button class="btn-secondary btn-sm" data-action="delete" title="Remove this video">Remove</button>
        </div>
      </div>
      ${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ""}`;

    return el;
  });

  place(container, nodes);
}

// --------------------------------------------------------------------------
// Review Studio & Clips Rendering
// --------------------------------------------------------------------------
function visibleClips(job) {
  if (currentReviewFilter === "review") return job.clips.filter((c) => c.status !== "ready" || c.review === "unreviewed");
  if (currentReviewFilter === "kept") return job.clips.filter((c) => c.review === "kept");
  return job.clips;
}

function jobVisibleInReview(job) {
  if (currentReviewFilter === "all") return true;
  if (currentReviewFilter === "kept") return job.clips.some((c) => c.review === "kept");
  return job.status !== "done" || job.clips.some((c) => c.status === "ready" && c.review === "unreviewed");
}

function renderClip(el, job, clip) {
  const media = el.querySelector(".clip-media");
  const src = `/media/${job.id}/${clip.file}?v=${clip.start}`;

  if (clip.status === "ready") {
    if (el._src !== src) {
      media.innerHTML = `<video controls preload="metadata" playsinline src="${esc(src)}"></video>`;
      el._src = src;
    }
  } else {
    const text = clip.status === "failed"
      ? `Render failed<br><small style="opacity:0.7">${esc(clip.error || "")}</small>`
      : clip.status === "rendering"
      ? "Rendering 9:16..."
      : "Waiting in queue...";
    if (el._placeholder !== text) {
      media.innerHTML = `<div style="padding:16px;">${text}</div>`;
      el._placeholder = text;
      el._src = undefined;
    }
  }

  el.className = `clip ${clip.review}`;

  const framingLabel = {
    track: "Face Tracked",
    fit: "Full Frame",
    center: "Center Crop",
  }[clip.framing] || clip.framing || "9:16";

  const scoreFormatted = Number(clip.score || 0).toFixed(1);

  const bodyHtml = `
    <div class="clip-meta-row">
      <span class="score-badge">⚡ ${esc(scoreFormatted)} / 10</span>
      <span class="clip-time-pill">${clock(clip.start)}–${clock(clip.end)} (${Math.round(clip.end - clip.start)}s)</span>
    </div>
    <div class="clip-title" title="${esc(clip.title)}">${esc(clip.title)}</div>
    <div class="clip-framing-pill">${esc(framingLabel)}</div>
    <div class="clip-reason">${esc(clip.reason || "")}</div>
    <div class="clip-buttons">
      <button class="keep ${clip.review === "kept" ? "on" : ""}" data-review="kept" ${clip.status !== "ready" ? "disabled" : ""}>
        ✓ Keep
      </button>
      <button class="reject ${clip.review === "rejected" ? "on" : ""}" data-review="rejected" ${clip.status !== "ready" ? "disabled" : ""}>
        ✕ Reject
      </button>
    </div>`;

  if (el._body !== bodyHtml) {
    el.querySelector(".clip-body").innerHTML = bodyHtml;
    el._body = bodyHtml;
  }
}

function renderReviewStudio() {
  const container = $("#review-jobs-container");
  const emptyState = $("#review-empty");

  const visibleJobs = jobs.filter(jobVisibleInReview).sort((a, b) => b.createdAt - a.createdAt);
  emptyState.hidden = visibleJobs.length > 0;

  const nodes = visibleJobs.map((job) => {
    let el = reviewJobEls.get(job.id);
    if (!el) {
      el = document.createElement("article");
      el.className = "job";
      el.dataset.job = job.id;
      el.innerHTML = `<div class="job-top"></div><div class="clips"></div>`;
      reviewJobEls.set(job.id, el);
    }

    const statusClass = ACTIVE_STATUSES.has(job.status) ? "active" : job.status;
    const sub = [job.channel, job.duration ? clock(job.duration) : "", job.message].filter(Boolean).join(" · ");

    const headHtml = `
      <div class="job-head">
        <span class="status ${statusClass}">${esc(job.status)}</span>
        <div class="job-title">
          <a href="${esc(job.url)}" target="_blank" rel="noreferrer">${esc(job.title || job.url)}</a>
          <div class="job-sub">${esc(sub)}</div>
        </div>
        <div class="job-actions">
          ${job.status === "error" || job.status === "done" ? `<button class="btn-secondary btn-sm" data-action="retry">Redo</button>` : ""}
          <button class="btn-secondary btn-sm" data-action="delete" title="Remove this video">Remove</button>
        </div>
      </div>
      ${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ""}`;

    if (el._head !== headHtml) {
      el.querySelector(".job-top").innerHTML = headHtml;
      el._head = headHtml;
    }

    const clipNodes = visibleClips(job).map((clip) => {
      const key = `${job.id}/${clip.id}/${clip.start}`;
      let clipEl = clipEls.get(key);
      if (!clipEl) {
        clipEl = document.createElement("div");
        clipEl.dataset.clip = clip.id;
        clipEl.innerHTML = `<div class="clip-media"></div><div class="clip-body"></div>`;
        clipEls.set(key, clipEl);
      }
      renderClip(clipEl, job, clip);
      return clipEl;
    });

    place(el.querySelector(".clips"), clipNodes);
    return el;
  });

  place(container, nodes);

  // Update counters
  const allClips = jobs.flatMap((j) => j.clips).filter((c) => c.status === "ready");
  const reviewCount = allClips.filter((c) => c.review === "unreviewed").length;
  const keptCount = allClips.filter((c) => c.review === "kept").length;

  $("#count-review").textContent = reviewCount;
  $("#count-kept").textContent = keptCount;
  $("#count-all").textContent = jobs.length;

  $("#nav-count-review").textContent = reviewCount;
  $("#nav-count-kept").textContent = keptCount;
}

// Review Segmented Filter Handler
$("#review-filter-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  currentReviewFilter = btn.dataset.filter;
  $$("#review-filter-tabs .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === currentReviewFilter);
  });
  renderReviewStudio();
});

// --------------------------------------------------------------------------
// Library View
// --------------------------------------------------------------------------
function renderLibrary() {
  const grid = $("#library-grid");
  const empty = $("#library-empty");

  const keptItems = [];
  for (const job of jobs) {
    for (const clip of job.clips) {
      if (clip.review === "kept") {
        keptItems.push({ job, clip });
      }
    }
  }

  empty.hidden = keptItems.length > 0;
  grid.innerHTML = "";

  keptItems.forEach(({ job, clip }) => {
    const card = document.createElement("div");
    card.className = "library-card";
    card.innerHTML = `
      <div class="library-card-title">${esc(clip.title)}</div>
      <div class="clip-meta-row">
        <span class="score-badge">⚡ ${esc(clip.score || 0)} / 10</span>
        <span class="clip-time-pill">${clock(clip.start)}–${clock(clip.end)} (${Math.round(clip.end - clip.start)}s)</span>
      </div>
      <div class="library-card-file">📄 ${esc(clip.exportedAs || clip.file || "Exported MP4")}</div>
      <div class="library-card-actions">
        <button class="btn-secondary btn-sm" data-action="open-folder">Reveal File</button>
      </div>`;
    grid.appendChild(card);
  });
}

// Open folder buttons
function handleOpenFolder() {
  if (isElectron && window.electronAPI?.openOutputFolder) {
    window.electronAPI.openOutputFolder();
  } else {
    showToast(`Kept clips are in: ${healthData?.outputDir || "output/"}`);
  }
}

$("#btn-open-explorer").addEventListener("click", handleOpenFolder);
$("#library-open-folder-btn").addEventListener("click", handleOpenFolder);

// --------------------------------------------------------------------------
// Analytics & Intelligence View
// --------------------------------------------------------------------------
async function loadAnalytics() {
  try {
    usageData = await api("/api/usage");
    renderAnalytics();
  } catch (err) {
    console.error("Failed to load usage analytics:", err);
  }
}

function renderAnalytics() {
  if (!usageData) return;
  const u = usageData;

  $("#metric-today-spend").textContent = money(u.today.costUsd);
  $("#metric-today-calls").textContent = `${u.today.calls} AI highlight calls`;

  $("#metric-7d-spend").textContent = money(u.last7.costUsd);
  $("#metric-7d-calls").textContent = `${u.last7.calls} calls in past 7 days`;

  $("#metric-model").textContent = u.pricing.model;
  $("#metric-pricing").textContent = `$${u.pricing.inputPerM} in / $${u.pricing.outputPerM} out per M`;

  $("#metric-tokens").textContent = (u.today.inputTokens + u.today.outputTokens).toLocaleString();
  $("#metric-tokens-sub").textContent = `${u.today.inputTokens.toLocaleString()} in · ${u.today.outputTokens.toLocaleString()} out`;

  // Update sidebar live spend display
  $("#sidebar-spend").textContent = money(u.today.costUsd);

  // Table breakdown
  const tbody = $("#analytics-table-body");
  if (!tbody) return;
  const days = Object.entries(u.days).sort(([a], [b]) => b.localeCompare(a));
  if (!days.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; opacity:0.5; padding:24px;">No AI calls recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = days
    .map(
      ([date, stat]) => `
      <tr>
        <td style="font-family:var(--font-mono); font-weight:600;">${esc(date)}</td>
        <td>${stat.calls}</td>
        <td>${stat.inputTokens.toLocaleString()}</td>
        <td>${stat.outputTokens.toLocaleString()}</td>
        <td style="color:var(--color-tertiary); font-weight:700;">${money(stat.costUsd)}</td>
      </tr>`
    )
    .join("");
}

// --------------------------------------------------------------------------
// System Health Sidebar
// --------------------------------------------------------------------------
async function loadHealth() {
  try {
    healthData = await api("/api/health");
    const h = healthData;

    const row = (ok, label) => `
      <div class="health-indicator-row">
        <span><span class="health-dot ${ok ? "ok" : "missing"}"></span>${esc(label)}</span>
        <span style="opacity:0.6; font-size:10px;">${ok ? "Ready" : "Missing"}</span>
      </div>`;

    $("#health-pills").innerHTML = [
      row(Boolean(h.ffmpeg), "FFmpeg Encoder"),
      row(Boolean(h.ytDlp), "yt-dlp Extractor"),
      row(Boolean(h.gemini), "Gemini AI Key"),
      row(h.reframe === "auto" ? Boolean(h.faces) : true, h.reframe === "auto" ? "Face Tracking" : `Reframe: ${h.reframe}`),
    ].join("");

    if (h.settings) {
      $("#preset-res").textContent = h.settings.output;
      $("#preset-captions").textContent = h.settings.captions ? "Burned-In" : "Off";
      $("#preset-reframe").textContent = h.reframe === "auto" ? "Auto Face-Track" : h.reframe;
    }

    $("#output-hint").textContent = `Kept clips export to: ${h.outputDir || "output/"}`;
  } catch (err) {
    console.error("Health check failed:", err);
  }
}

// --------------------------------------------------------------------------
// Job Actions Event Delegation (Delete, Retry, Review, View Clips)
// --------------------------------------------------------------------------
async function handleJobAction(event) {
  const button = event.target.closest("button");
  if (!button) return;

  const jobId = button.closest("[data-job]")?.dataset.job;

  if (button.dataset.action === "view-clips") {
    switchView("review");
    return;
  }

  if (button.dataset.action === "open-folder") {
    handleOpenFolder();
    return;
  }

  if (!jobId) return;

  try {
    if (button.dataset.review) {
      const clipId = button.closest("[data-clip]").dataset.clip;
      const job = jobs.find((j) => j.id === jobId);
      const clip = job?.clips.find((c) => c.id === clipId);
      const review = clip?.review === button.dataset.review ? "unreviewed" : button.dataset.review;
      button.disabled = true;
      await api(`/api/jobs/${jobId}/clips/${clipId}/review`, {
        method: "POST",
        body: JSON.stringify({ review }),
      });
      showToast(review === "kept" ? "✓ Clip kept & exported to library" : "Clip review updated");
    } else if (button.dataset.action === "retry") {
      await api(`/api/jobs/${jobId}/retry`, { method: "POST" });
      showToast("Job restarted in queue");
    } else if (button.dataset.action === "delete") {
      if (!confirm("Remove this video and all its clips? Kept clips in your output folder will stay.")) return;
      await api(`/api/jobs/${jobId}`, { method: "DELETE" });
      studioJobEls.get(jobId)?.remove();
      studioJobEls.delete(jobId);
      reviewJobEls.get(jobId)?.remove();
      reviewJobEls.delete(jobId);
      showToast("Video removed");
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

$("#studio-jobs-list").addEventListener("click", handleJobAction);
$("#review-jobs-container").addEventListener("click", handleJobAction);

// --------------------------------------------------------------------------
// Polling & State Refresh Loop
// --------------------------------------------------------------------------
let previouslyActiveJobIds = new Set();

async function refresh() {
  try {
    jobs = await api("/api/jobs");

    // Check currently active job for the live pipeline visualizer
    const activeJob = jobs.find((j) => ACTIVE_STATUSES.has(j.status));
    updatePipelineVisualizer(activeJob);

    renderStudioJobs();
    renderReviewStudio();

    if (currentView === "library") renderLibrary();

    // Check if jobs transitioned from active to complete -> trigger notification
    const currentlyActive = new Set(jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).map((j) => j.id));
    if (previouslyActiveJobIds.size > 0 && currentlyActive.size === 0) {
      showToast("✅ All clips rendered and ready for review!");
      if (isElectron && window.electronAPI?.showNotification) {
        window.electronAPI.showNotification("oukos clip", "Your clips are ready for review!");
      }
    }
    previouslyActiveJobIds = currentlyActive;
  } catch (err) {
    console.error("Refresh cycle error:", err);
  }
}

// --------------------------------------------------------------------------
// Electron Desktop Integration
// --------------------------------------------------------------------------
if (isElectron) {
  document.body.classList.add("electron");

  // Intercept external link clicks -> open in OS default browser
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (a.target === "_blank" || (href && href.startsWith("http"))) {
      e.preventDefault();
      window.electronAPI.openExternalLink(href);
    }
  });

  if (typeof window.electronAPI.onBackendReady === "function") {
    window.electronAPI.onBackendReady(() => {
      showToast("⚡ Desktop Studio Connected");
      refresh();
      loadHealth();
      loadAnalytics();
    });
  }
}

// Initial Boot
loadHealth();
loadAnalytics();
refresh();
setInterval(refresh, 2000);
setInterval(loadAnalytics, 15000);
