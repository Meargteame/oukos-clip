// settings.js — oukos clip settings dialog renderer
// Talks to Electron main process via window.electronAPI (provided by preload.js)

(function () {
  'use strict';

  // ── Element references ──────────────────────────────────────────
  const els = {
    geminiApiKey:    document.getElementById('geminiApiKey'),
    toggleApiKey:    document.getElementById('toggleApiKey'),
    eyeIcon:         document.getElementById('eyeIcon'),
    geminiModel:     document.getElementById('geminiModel'),
    clipsPerVideo:   document.getElementById('clipsPerVideo'),
    minClipSeconds:  document.getElementById('minClipSeconds'),
    maxClipSeconds:  document.getElementById('maxClipSeconds'),
    outputHeight:    document.getElementById('outputHeight'),
    burnCaptions:    document.getElementById('burnCaptions'),
    captionLanguage: document.getElementById('captionLanguage'),
    reframe:         document.getElementById('reframe'),
    outputDir:       document.getElementById('outputDir'),
    browseBtn:       document.getElementById('browseBtn'),
    openFolderBtn:   document.getElementById('openFolderBtn'),
    saveBtn:         document.getElementById('saveBtn'),
    cancelBtn:       document.getElementById('cancelBtn'),
    closeBtn:        document.getElementById('closeBtn'),
    statusMsg:       document.getElementById('statusMsg'),
    apiKeyLink:      document.getElementById('apiKeyLink'),
  };

  // ── Load settings on open ───────────────────────────────────────
  async function loadSettings() {
    if (!window.electronAPI) return;
    try {
      const s = await window.electronAPI.getSettings();
      if (!s) return;

      if (s.geminiApiKey)           els.geminiApiKey.value    = s.geminiApiKey;
      if (s.geminiModel)            els.geminiModel.value     = s.geminiModel;
      if (s.clipsPerVideo != null)  els.clipsPerVideo.value   = s.clipsPerVideo;
      if (s.minClipSeconds != null) els.minClipSeconds.value  = s.minClipSeconds;
      if (s.maxClipSeconds != null) els.maxClipSeconds.value  = s.maxClipSeconds;
      if (s.outputHeight != null)   els.outputHeight.value    = String(s.outputHeight);
      if (s.burnCaptions != null)   els.burnCaptions.checked  = s.burnCaptions;
      if (s.captionLanguage)        els.captionLanguage.value = s.captionLanguage;
      if (s.reframe)                els.reframe.value         = s.reframe;
      if (s.outputDir)              els.outputDir.value       = s.outputDir;
    } catch (err) {
      showStatus('Failed to load settings', 'error');
      console.error('loadSettings:', err);
    }
  }

  // ── Collect form values ─────────────────────────────────────────
  function collectSettings() {
    return {
      geminiApiKey:    els.geminiApiKey.value.trim(),
      geminiModel:     els.geminiModel.value.trim() || 'gemini-flash-latest',
      clipsPerVideo:   parseInt(els.clipsPerVideo.value, 10) || 5,
      minClipSeconds:  parseInt(els.minClipSeconds.value, 10) || 20,
      maxClipSeconds:  parseInt(els.maxClipSeconds.value, 10) || 75,
      outputHeight:    parseInt(els.outputHeight.value, 10),
      burnCaptions:    els.burnCaptions.checked,
      captionLanguage: els.captionLanguage.value.trim(),
      reframe:         els.reframe.value,
      outputDir:       els.outputDir.value.trim(),
    };
  }

  // ── Validation ──────────────────────────────────────────────────
  function validate(settings) {
    if (!settings.geminiApiKey) {
      showStatus('API key is empty — clips won\'t generate', 'warning');
      // Not blocking; user might want to save other settings first
    }

    if (settings.minClipSeconds >= settings.maxClipSeconds) {
      showStatus('Min clip length must be less than max clip length', 'error');
      return false;
    }

    return true;
  }

  // ── Save ────────────────────────────────────────────────────────
  async function save() {
    const settings = collectSettings();
    if (!validate(settings)) return;

    try {
      els.saveBtn.disabled = true;
      await window.electronAPI.saveSettings(settings);
      showStatus('Settings saved — restarting backend…', 'success');
      await window.electronAPI.restartBackend();
      showStatus('Settings saved ✓', 'success');
    } catch (err) {
      showStatus('Failed to save settings', 'error');
      console.error('save:', err);
    } finally {
      els.saveBtn.disabled = false;
    }
  }

  // ── Status message ──────────────────────────────────────────────
  let statusTimer = null;
  function showStatus(msg, type) {
    els.statusMsg.textContent = msg;
    els.statusMsg.className = 'status-msg ' + (type || '');
    clearTimeout(statusTimer);
    if (type === 'success') {
      statusTimer = setTimeout(function () {
        els.statusMsg.textContent = '';
        els.statusMsg.className = 'status-msg';
      }, 4000);
    }
  }

  // ── API key show/hide toggle ────────────────────────────────────
  function toggleApiKeyVisibility() {
    var isPassword = els.geminiApiKey.type === 'password';
    els.geminiApiKey.type = isPassword ? 'text' : 'password';
    els.eyeIcon.textContent = isPassword ? '🙈' : '👁';
  }

  // ── Browse for output folder ────────────────────────────────────
  async function browseFolder() {
    try {
      var folder = await window.electronAPI.selectOutputFolder();
      if (folder) {
        els.outputDir.value = folder;
      }
    } catch (err) {
      console.error('browseFolder:', err);
    }
  }

  // ── Open output folder in Explorer ──────────────────────────────
  async function openFolder() {
    try {
      await window.electronAPI.openOutputFolder();
    } catch (err) {
      console.error('openFolder:', err);
    }
  }

  // ── Open external link ──────────────────────────────────────────
  function handleApiKeyLink(e) {
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.openExternalLink) {
      window.electronAPI.openExternalLink('https://aistudio.google.com/apikey');
    }
  }

  // ── Event listeners ─────────────────────────────────────────────
  els.saveBtn.addEventListener('click', save);
  els.cancelBtn.addEventListener('click', function () { window.close(); });
  els.closeBtn.addEventListener('click', function () { window.close(); });
  els.toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
  els.browseBtn.addEventListener('click', browseFolder);
  els.openFolderBtn.addEventListener('click', openFolder);
  els.apiKeyLink.addEventListener('click', handleApiKeyLink);

  // Keyboard shortcuts: Escape to close, Ctrl+S to save
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.close();
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });

  // ── Init ────────────────────────────────────────────────────────
  loadSettings();
})();
