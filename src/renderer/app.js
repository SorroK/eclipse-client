'use strict';

const api = window.eclipseClient;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

if (!api) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:Segoe UI,sans-serif;color:#eef3f1"><h1>Eclipse Client could not start</h1><p>The secure launcher bridge did not load. Restart the application.</p></div>';
  throw new Error('Launcher preload bridge is unavailable');
}

const THEMES = {
  eclipse: 'Eclipse',
  aurora: 'Aurora',
  ember: 'Ember',
  daylight: 'Daylight',
  midnight: 'Midnight',
  frost: 'Frost',
  sakura: 'Sakura',
  solar: 'Solar',
};

const DEFAULT_SETTINGS = {
  selectedVersion: '',
  memoryMb: 4096,
  customResolution: false,
  resolutionWidth: 1280,
  resolutionHeight: 720,
  javaPath: '',
  gameDir: '',
  minimizeOnLaunch: false,
  fastLaunch: true,
  performanceJvm: true,
  theme: 'eclipse',
  discordRpc: true,
  discordClientId: '',
  modrinthPageSize: 20,
};

const RENDER_DISTANCE_FIELDS = [
  { selector: '#renderItemFrames', key: 'itemFrames', label: 'Item frames' },
  { selector: '#renderPlayers', key: 'players', label: 'Players' },
  { selector: '#renderDroppedItems', key: 'droppedItems', label: 'Dropped items' },
  { selector: '#renderArmorStands', key: 'armorStands', label: 'Armor stands' },
];

const state = {
  ready: false,
  settings: { ...DEFAULT_SETTINGS },
  accounts: { selectedId: '', profiles: [] },
  manifest: null,
  manifestFetchedAt: 0,
  installed: new Map(),
  modpacks: new Map(),
  contentTarget: '',
  content: [],
  contentLoadedFor: '',
  contentLoading: false,
  essentials: null,
  essentialsLoadedFor: '',
  essentialsBusy: false,
  essentialsNote: '',
  render: null,
  renderLoadedFor: '',
  renderBusy: false,
  renderNote: '',
  contentTab: 'mod',
  modrinthQuery: '',
  modrinthResults: [],
  modrinthTotal: 0,
  modrinthLoading: false,
  modrinthLoadingMore: false,
  modrinthError: '',
  modrinthLoaded: false,
  installingContentId: '',
  removingContentId: '',
  confirmContentId: '',
  modpackModalOpen: false,
  modpackCreating: false,
  modpackError: '',
  modpackLoader: 'fabric',
  loaderVersions: [],
  loaderLoading: false,
  modpackProgress: null,
  importingModpack: false,
  confirmDeletePack: '',
  packQuery: '',
  packFilter: 'all',
  modpackTab: 'download',
  packBrowserQuery: '',
  packBrowserResults: [],
  packBrowserTotal: 0,
  packBrowserLoading: false,
  packBrowserLoadingMore: false,
  packBrowserError: '',
  packBrowserLoaded: false,
  installingPackId: '',
  managerQuery: '',
  managerError: '',
  renamingPack: '',
  renameBusy: false,
  renameError: '',
  duplicatingPack: '',
  confirmDeletePackPage: '',
  java: { detecting: true, installations: [] },
  installing: null,
  game: null,
  launching: false,
  stopping: false,
  system: {},
  update: {
    checking: false,
    installing: false,
    available: null,
    currentVersion: '',
    status: 'idle',
    error: '',
    downloaded: 0,
    total: null,
  },
  logs: [],
  page: 'play',
  versionFilter: 'release',
  versionQuery: '',
  catalogError: '',
  catalogErrorNotified: false,
  refreshing: false,
  accountsOpen: false,
  accountError: '',
  signingIn: false,
  addingOffline: false,
  confirmRemoveId: null,
  removeTimer: null,
  consoleOpen: false,
  unread: false,
  scrollLogs: true,
};

let settingsSaveToken = 0;
let versionSearchTimer = null;
let modrinthSearchTimer = null;
let confirmContentTimer = null;
let modrinthRequestToken = 0;
let contentRequestToken = 0;
let loaderRequestToken = 0;
let confirmDeleteTimer = null;
let packDeleteTimer = null;
let packSearchTimer = null;
let packBrowserSearchTimer = null;
let packBrowserRequestToken = 0;
let toastSequence = 0;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function cleanError(error) {
  let message = String((error && error.message) || error || 'Something went wrong.');
  message = message.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  message = message.replace(/^Error:\s*/i, '');
  return message;
}

function setText(selector, value) {
  const element = typeof selector === 'string' ? $(selector) : selector;
  if (element) element.textContent = value == null ? '' : String(value);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function formatGb(megabytes) {
  return `${(Number(megabytes || 0) / 1024).toFixed(1)} GB`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatClock(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function typeInfo(type) {
  switch (type) {
    case 'modpack':
      return { label: 'Modpack', className: 'badge-modpack' };
    case 'snapshot':
      return { label: 'Snapshot', className: 'badge-snapshot' };
    case 'old_beta':
    case 'old_alpha':
      return { label: 'Legacy', className: 'badge-legacy' };
    default:
      return { label: 'Release', className: '' };
  }
}

function accountTypeLabel(type) {
  return type === 'msa' ? 'Microsoft account' : 'Offline profile';
}

function loaderLabel(loader) {
  if (loader === 'forge') return 'Forge';
  if (loader === 'neoforge') return 'NeoForge';
  return 'Fabric';
}

function loaderMark(loader) {
  if (loader === 'forge') return 'G';
  if (loader === 'neoforge') return 'N';
  return 'F';
}

function loaderSummary(instance) {
  return instance ? `${loaderLabel(instance.loader)} ${instance.loaderVersion}` : '';
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

const avatarSkinCache = new Map();
const avatarSkinRequests = new Map();

function avatarSkinKey(account) {
  return `${account.type || 'offline'}:${account.uuid || account.id}`;
}

function setAvatarSkin(element, url) {
  const existing = element.querySelector('.avatar-skin');
  if (!url) {
    if (existing) existing.remove();
    element.classList.remove('has-head');
    element.style.removeProperty('--avatar-skin');
    return;
  }
  if (!existing) {
    const layer = document.createElement('span');
    layer.className = 'avatar-skin';
    layer.setAttribute('aria-hidden', 'true');
    for (const part of ['face', 'hat']) {
      const piece = document.createElement('i');
      piece.className = `avatar-skin-${part}`;
      layer.append(piece);
    }
    element.appendChild(layer);
  }
  element.style.setProperty('--avatar-skin', `url("${url}")`);
  element.classList.add('has-head');
}

function requestAvatarSkin(account) {
  const key = avatarSkinKey(account);
  const cached = avatarSkinCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = avatarSkinRequests.get(key);
  if (pending) return pending;
  const skin = api.accounts && typeof api.accounts.skin === 'function' ? api.accounts.skin : null;
  const request = skin
    ? Promise.resolve()
        .then(() => skin(account.id))
        .then((value) => (typeof value === 'string' && value.startsWith('data:image/png;base64,') ? value : ''))
        .catch(() => '')
    : Promise.resolve('');
  const tracked = request.then((url) => {
    avatarSkinCache.set(key, url);
    avatarSkinRequests.delete(key);
    return url;
  });
  avatarSkinRequests.set(key, tracked);
  return tracked;
}

function applyAvatarSkin(element, account) {
  const key = avatarSkinKey(account);
  element.dataset.avatarAccount = account.id;
  element.dataset.avatarSkinKey = key;
  const cached = avatarSkinCache.get(key);
  if (cached !== undefined) {
    setAvatarSkin(element, cached);
    return;
  }
  setAvatarSkin(element, '');
  if (account.type !== 'msa') {
    avatarSkinCache.set(key, '');
    return;
  }
  requestAvatarSkin(account).then((url) => {
    if (!url) return;
    $$(`[data-avatar-account="${CSS.escape(account.id)}"]`).forEach((target) => {
      if (target.dataset.avatarSkinKey === key) setAvatarSkin(target, url);
    });
  });
}

function paintAvatar(element, account) {
  if (!element) return;
  if (!account) {
    element.textContent = '?';
    element.style.setProperty('--hue', '160');
    element.classList.remove('is-msa');
    delete element.dataset.avatarAccount;
    delete element.dataset.avatarSkinKey;
    setAvatarSkin(element, '');
    element.title = '';
    return;
  }
  const name = account.name || 'Player';
  const initials = name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 2).toUpperCase() || 'P';
  element.textContent = initials;
  element.style.setProperty('--hue', String((hashString(name) % 300) + 35));
  element.classList.toggle('is-msa', account.type === 'msa');
  element.title = name;
  applyAvatarSkin(element, account);
}

function currentProfile() {
  const profiles = state.accounts.profiles || [];
  return profiles.find((profile) => profile.id === state.accounts.selectedId) || profiles[0] || null;
}

function resolveGameDir() {
  return state.settings.gameDir || state.system.minecraftRoot || '';
}

function setModpacks(records) {
  state.modpacks = new Map(
    (Array.isArray(records) ? records : []).map((instance) => [instance.id, instance]),
  );
}

function currentContentModpack() {
  return (
    state.modpacks.get(state.contentTarget) ||
    state.modpacks.get(selectedVersionId()) ||
    state.modpacks.values().next().value ||
    null
  );
}

function ensureContentTarget() {
  const current = currentContentModpack();
  if (current) {
    state.contentTarget = current.id;
    return current;
  }
  state.contentTarget = '';
  return null;
}

function selectedModpack() {
  return state.modpacks.get(selectedVersionId()) || null;
}

function activeGameDir() {
  const modpack = selectedModpack();
  return modpack ? modpack.gameDir : resolveGameDir();
}

function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function findCatalogVersion(versionId) {
  if (!state.manifest || !Array.isArray(state.manifest.versions)) return null;
  return state.manifest.versions.find((entry) => entry.id === versionId) || null;
}

function versionEntry(versionId) {
  const modpack = state.modpacks.get(versionId);
  if (modpack) {
    return {
      id: versionId,
      type: 'modpack',
      releaseTime: modpack.createdAt,
      local: true,
      modpack,
    };
  }
  const fromCatalog = findCatalogVersion(versionId);
  if (fromCatalog) return fromCatalog;
  const installed = state.installed.get(versionId);
  if (installed) {
    return { id: versionId, type: 'release', releaseTime: null, local: true };
  }
  return null;
}

function selectedVersionId() {
  const configured = state.settings.selectedVersion;
  if (
    configured &&
    (state.installed.has(configured) ||
      findCatalogVersion(configured) ||
      state.modpacks.has(configured))
  ) {
    return configured;
  }
  const modpack = state.modpacks.values().next().value;
  if (!state.manifest && modpack) return modpack.id;
  if (state.manifest && state.manifest.latest && state.manifest.latest.release) {
    return state.manifest.latest.release;
  }
  const installedIds = Array.from(state.installed.keys());
  return installedIds[installedIds.length - 1] || '';
}

function preferredJava() {
  const installations = state.java.installations || [];
  if (state.settings.javaPath) {
    const match = installations.find(
      (entry) => normalizePath(entry.path) === normalizePath(state.settings.javaPath),
    );
    if (match) return match;
    return {
      path: state.settings.javaPath,
      major: 'custom',
      version: 'custom path',
      vendor: 'Custom runtime',
      source: 'Custom',
    };
  }
  return installations[0] || null;
}

function setSaveState(saving) {
  const element = $('#saveState');
  if (!element) return;
  element.classList.toggle('saving', Boolean(saving));
  element.innerHTML = saving ? '<span></span>Saving…' : '<span></span>Saved locally';
}

function normalizeTheme(value) {
  return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : 'eclipse';
}

function renderThemePicker(theme) {
  $$('[data-theme-choice]').forEach((button) => {
    const selected = button.dataset.themeChoice === theme;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  setText('#themeCurrent', THEMES[theme] || THEMES.eclipse);
}

function applyTheme(value) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  renderThemePicker(theme);
  return theme;
}

function toast(message, type = 'info', duration = 4400) {
  const stack = $('#toastStack');
  if (!stack || !message) return;
  while (stack.children.length >= 4) stack.removeChild(stack.firstElementChild);

  const element = document.createElement('div');
  element.className = `toast toast-${type}`;
  element.dataset.toastId = String((toastSequence += 1));

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warn' ? '!' : 'i';

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = String(message);

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 190);
  };
  close.addEventListener('click', remove);
  element.append(icon, text, close);
  stack.appendChild(element);
  setTimeout(remove, duration);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function bindApiEvents() {
  api.on('catalog:updated', (manifest) => {
    state.manifest = manifest;
    state.manifestFetchedAt = Date.now();
    state.catalogError = '';
    renderPlay();
    renderVersions();
    renderStatus();
  });

  api.on('catalog:error', (message) => {
    state.catalogError = String(message || 'Could not reach Mojang.');
    renderPlay();
    renderVersions();
    renderStatus();
    if (!state.catalogErrorNotified) {
      state.catalogErrorNotified = true;
      toast('Could not refresh the version list. Check your internet connection.', 'warn', 6000);
    }
  });

  api.on('installed:updated', (installed) => {
    state.installed = new Map((installed || []).map((entry) => [entry.id, entry]));
    renderSidebar();
    renderPlay();
    renderVersions();
    renderModpacksPage();
    renderModrinth();
  });

  api.on('modpacks:updated', (modpacks) => {
    setModpacks(modpacks);
    ensureContentTarget();
    renderVersions();
    renderModpacksPage();
    renderPlay();
    renderModrinth();
    updatePageTitle();
  });

  api.on('modpack:progress', handleModpackProgress);
  api.on('essentials:progress', (event) => {
    if (!event || state.contentTarget !== event.versionId) return;
    if (event.done) {
      state.essentialsNote = 'Finishing Essentials…';
    } else if (event.title) {
      state.essentialsNote = `Installing ${event.title}…${event.total ? ` (${event.index}/${event.total})` : ''}`;
    }
    renderEssentials(ensureContentTarget());
  });

  api.on('accounts:updated', (accounts) => {
    state.accounts = accounts || { selectedId: '', profiles: [] };
    renderSidebar();
    renderPlay();
    renderProfileSettings();
    renderAccounts();
  });

  api.on('update:progress', (progress) => {
    if (!progress) return;
    state.update.installing = true;
    if (progress.done) {
      state.update.status = 'installed';
    } else {
      state.update.downloaded = Number(progress.downloaded) || 0;
      state.update.total = progress.total == null ? null : Number(progress.total) || null;
    }
    renderUpdateCard();
  });

  api.on('java:updated', (java) => {
    state.java = java || { detecting: false, installations: [] };
    renderJavaCard();
    renderJavaOptions();
    renderStatus();
  });

  api.on('install:progress', handleInstallProgress);
  api.on('game:state', handleGameState);

  api.on('launcher:log', (entry) => {
    if (!entry || !entry.line) return;
    state.logs.push(entry);
    if (state.logs.length > 1200) state.logs.shift();
    appendLogEntry(entry);
    if (!state.consoleOpen) {
      state.unread = true;
      updateConsoleUnread();
    }
  });

  api.on('window:maximized', (maximized) => {
    document.body.classList.toggle('is-maximized', Boolean(maximized));
  });
}

async function boot() {
  bindStaticEvents();
  bindApiEvents();

  try {
    const data = await api.init();
    state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    applyTheme(state.settings.theme);
    state.accounts = data.accounts || { selectedId: '', profiles: [] };
    state.manifest = data.manifest || null;
    state.manifestFetchedAt = data.manifestFetchedAt || 0;
    state.installed = new Map((data.installed || []).map((entry) => [entry.id, entry]));
    setModpacks(data.modpacks);
    state.contentTarget = state.modpacks.has(state.settings.selectedVersion)
      ? state.settings.selectedVersion
      : (state.modpacks.values().next().value || {}).id || '';
    state.java = data.java || { detecting: true, installations: [] };
    state.system = data.system || {};
    state.installing = data.installing || null;
    state.logs = Array.isArray(data.logs) ? data.logs : [];
    state.game = data.game && data.game.status !== 'idle' ? data.game : null;

    document.body.classList.add('ready');
    state.ready = true;
    renderAll();

    if (state.game) {
      handleGameState(state.game);
    }
    if (state.installing) {
      openConsole(true);
      updateProgressPanel(state.installing);
    }

    updatePageTitle();

    if (!state.system.smoke) {
      setTimeout(() => checkForUpdates(false), 3000);
    }
  } catch (error) {
    document.body.classList.add('ready');
    console.error(error);
    toast(`The launcher could not initialise: ${cleanError(error)}`, 'error', 12000);
    setText('#statusText', 'Startup failed');
    setText('#launchHint', cleanError(error));
  }
}

function updatePageTitle() {
  const versionId = selectedVersionId();
  const modpack = state.modpacks.get(versionId);
  document.title = modpack
    ? `Eclipse Client — ${modpack.name}`
    : versionId
      ? `Eclipse Client — ${versionId}`
      : 'Eclipse Client';
}

function bindStaticEvents() {
  $$('[data-page]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.page));
  });

  $$('[data-window]').forEach((button) => {
    button.addEventListener('click', () => {
      api.windowControl(button.dataset.window).catch((error) => toast(cleanError(error), 'error'));
    });
  });

  $('#titlebar').addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    api.windowControl('maximize').catch(() => {});
  });

  $('#titleConsoleBtn').addEventListener('click', toggleConsole);
  $('#statusConsoleBtn').addEventListener('click', toggleConsole);
  $('#hideConsole').addEventListener('click', () => openConsole(false));
  $('#clearConsole').addEventListener('click', clearConsole);

  const consoleBody = $('#consoleBody');
  consoleBody.addEventListener('scroll', () => {
    state.scrollLogs =
      consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 42;
  });

  ['#openAccounts', '#accountManageBtn', '#settingsAccountsBtn'].forEach((selector) => {
    const element = $(selector);
    if (element) element.addEventListener('click', openAccounts);
  });

  $('#closeAccounts').addEventListener('click', closeAccounts);
  $('#accountsModal').addEventListener('click', (event) => {
    if (event.target === $('#accountsModal')) closeAccounts();
  });
  $('#offlineForm').addEventListener('submit', handleAddOffline);
  $('#microsoftBtn').addEventListener('click', signInMicrosoft);
  $('#accountList').addEventListener('click', handleAccountListClick);
  $('#accountList').addEventListener('keydown', handleAccountListKeydown);

  $('#playBtn').addEventListener('click', handlePlayButton);
  $('#javaSettingsBtn').addEventListener('click', () => {
    navigate('settings');
    setTimeout(() => $('#javaOptions')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
  });
  $('#openGameFolderBtn').addEventListener('click', openGameFolder);

  $('#recentVersions').addEventListener('click', (event) => {
    const card = event.target.closest('[data-version-id]');
    if (card) selectVersion(card.dataset.versionId);
  });

  $('#versionFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.versionFilter = button.dataset.filter;
    $$('#versionFilters button').forEach((entry) =>
      entry.classList.toggle('active', entry === button),
    );
    renderVersions();
  });

  $('#versionSearch').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(versionSearchTimer);
    versionSearchTimer = setTimeout(() => {
      state.versionQuery = value.trim();
      renderVersions();
    }, 110);
  });

  $('#refreshVersionsBtn').addEventListener('click', () => refreshCatalog(false));
  $$('#createModpackBtn, [data-create-modpack]').forEach((button) => {
    button.addEventListener('click', openModpackModal);
  });
  $$('[data-import-mrpack]').forEach((button) => {
    button.addEventListener('click', importMrpack);
  });
  $('#closeModpackModal').addEventListener('click', closeModpackModal);
  $('#cancelModpack').addEventListener('click', closeModpackModal);
  $('#modpackModal').addEventListener('click', (event) => {
    if (event.target === $('#modpackModal')) closeModpackModal();
  });
  $('#modpackForm').addEventListener('submit', handleCreateModpack);
  $('#renamePackForm').addEventListener('submit', handleRenamePackSubmit);
  $('#closeRenamePack').addEventListener('click', closeRenamePackModal);
  $('#cancelRenamePack').addEventListener('click', closeRenamePackModal);
  $('#renamePackModal').addEventListener('click', (event) => {
    if (event.target === $('#renamePackModal')) closeRenamePackModal();
  });
  $('#modpackGameVersion').addEventListener('change', loadModpackLoaderVersions);
  $('#modpackLoader').addEventListener('change', (event) => {
    state.modpackLoader = event.target.value;
    loadModpackLoaderVersions();
  });
  $('#contentDeletePack').addEventListener('click', deleteCurrentPack);

  $('#modpackGrid').addEventListener('click', handleModpackShelfClick);
  $('#modpackGrid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button')) return;
    const card = event.target.closest('[data-modpack-id]');
    if (!card) return;
    event.preventDefault();
    selectVersion(card.dataset.modpackId);
  });

  $('#packGrid').addEventListener('click', handlePackGridClick);
  $('#packGrid').addEventListener('keydown', handlePackGridKeydown);
  $('#modpackTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-modpack-tab]');
    if (button) setModpackTab(button.dataset.modpackTab);
  });
  $('#packBrowserSearch').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(packBrowserSearchTimer);
    packBrowserSearchTimer = setTimeout(() => {
      state.packBrowserQuery = value.trim();
      state.packBrowserResults = [];
      state.packBrowserTotal = 0;
      state.packBrowserError = '';
      state.packBrowserLoaded = false;
      packBrowserRequestToken += 1;
      searchModpacks(false);
    }, 280);
  });
  $('#packBrowserResults').addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-pack-browser]')) {
      searchModpacks(false);
      return;
    }
    const button = event.target.closest('[data-install-pack]');
    if (button) installModrinthModpack(button);
  });
  $('#packBrowserFooter').addEventListener('click', (event) => {
    if (event.target.closest('[data-load-more-packs]')) searchModpacks(true);
  });
  $('#packDetail').addEventListener('click', handlePackDetailClick);
  $('#managerRows').addEventListener('click', (event) => {
    const row = event.target.closest('[data-manager-pack-id]');
    if (!row) return;
    state.managerError = '';
    selectVersion(row.dataset.managerPackId);
  });
  $('#managerSearch').addEventListener('input', (event) => {
    state.managerQuery = event.target.value.trim();
    renderManagerPage();
  });
  $('#managerEditor').addEventListener('click', (event) => {
    if (event.target.closest('#managerNameSave')) {
      saveManagerName();
      return;
    }
    handlePackDetailClick(event);
  });
  $('#managerEditor').addEventListener('keydown', (event) => {
    if (event.target.id !== 'managerNameInput' || event.key !== 'Enter') return;
    event.preventDefault();
    saveManagerName();
  });
  $('#packSearch').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(packSearchTimer);
    packSearchTimer = setTimeout(() => {
      state.packQuery = value.trim();
      renderModpacksPage();
    }, 110);
  });
  $('#packFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-pack-filter]');
    if (!button) return;
    state.packFilter = button.dataset.packFilter;
    $$('#packFilters button').forEach((entry) =>
      entry.classList.toggle('active', entry === button),
    );
    renderModpacksPage();
  });

  $('#contentTarget').addEventListener('change', handleContentTargetChange);
  $('#contentTabs').addEventListener('click', handleContentTabClick);
  $('#modrinthSearch').addEventListener('input', (event) => {
    state.modrinthQuery = event.target.value.trim();
    clearTimeout(modrinthSearchTimer);
    modrinthSearchTimer = setTimeout(() => searchModrinth(false), 300);
  });
  $('#modrinthResults').addEventListener('click', handleModrinthResultsClick);
  $('#modrinthFooter').addEventListener('click', (event) => {
    if (event.target.closest('[data-load-more]')) searchModrinth(true);
    if (event.target.closest('[data-retry-modrinth]')) searchModrinth(false);
  });
  $('#modrinthPageSize').addEventListener('change', async (event) => {
    const value = Number(event.target.value);
    if (![20, 50, 100].includes(value)) {
      syncSettingsValues();
      return;
    }
    const saved = await saveSettings({ modrinthPageSize: value });
    if (!saved) {
      syncSettingsValues();
      return;
    }
    modrinthRequestToken += 1;
    state.modrinthResults = [];
    state.modrinthTotal = 0;
    state.modrinthError = '';
    state.modrinthLoaded = false;
    state.modrinthLoading = false;
    state.modrinthLoadingMore = false;
    renderModrinth();
    if (ensureContentTarget()) searchModrinth(false);
  });
  $('#essentialsToggle').addEventListener('change', (event) => {
    setEssentialsEnabled(event.target.checked);
  });
  $('#essentialsApply').addEventListener('click', () => setEssentialsEnabled(true));
  $('#renderApply').addEventListener('click', () => applyRenderDistances());
  $('#renderReset').addEventListener('click', resetRenderDistances);
  $('#renderCard').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.matches('input')) return;
    event.preventDefault();
    applyRenderDistances();
  });
  $('#installedContentList').addEventListener('click', handleInstalledContentClick);
  $('#contentOpenFolder').addEventListener('click', openContentFolder);
  $('#versionList').addEventListener('click', handleVersionListClick);
  $('#versionList').addEventListener('keydown', handleVersionListKeydown);
  $('#versionFooter').addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-catalog]')) refreshCatalog(false);
    if (event.target.closest('[data-clear-search]')) {
      state.versionQuery = '';
      $('#versionSearch').value = '';
      renderVersions();
    }
  });

  bindSettingsEvents();
  $('#settingsSignIn').addEventListener('click', openAccounts);
  $('#openMinecraftSite').addEventListener('click', () => {
    api.openExternal('https://www.minecraft.net').catch((error) => toast(cleanError(error), 'error'));
  });

  $('#toastStack').addEventListener('click', (event) => {
    if (event.target.closest('.toast-close')) {
      const toastElement = event.target.closest('.toast');
      if (toastElement) toastElement.remove();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.modpackModalOpen) closeModpackModal();
    else if (state.accountsOpen) closeAccounts();
    else if (state.consoleOpen) openConsole(false);
  });
}

function bindSettingsEvents() {
  const memoryRange = $('#memoryRange');
  memoryRange.addEventListener('input', () => {
    setText('#memoryValue', formatGb(memoryRange.value));
  });
  memoryRange.addEventListener('change', () => {
    saveSettings({ memoryMb: Number(memoryRange.value) });
  });

  $('#resolutionToggle').addEventListener('change', (event) => {
    syncResolutionFieldState(event.target.checked);
    saveSettings({ customResolution: event.target.checked });
  });
  ['#resolutionWidth', '#resolutionHeight'].forEach((selector) => {
    $(selector).addEventListener('change', (event) => {
      const value = Math.round(Number(event.target.value));
      if (!Number.isFinite(value) || value < 320 || value > 7680) {
        toast('Resolution must be between 320 and 7680 pixels.', 'warn');
        syncSettingsValues();
        return;
      }
      saveSettings(selector === '#resolutionWidth' ? { resolutionWidth: value } : { resolutionHeight: value });
    });
  });

  $('#minimizeToggle').addEventListener('change', (event) => {
    saveSettings({ minimizeOnLaunch: event.target.checked });
  });
  $('#fastLaunchToggle').addEventListener('change', (event) => {
    saveSettings({ fastLaunch: event.target.checked });
  });
  $('#performanceJvmToggle').addEventListener('change', (event) => {
    saveSettings({ performanceJvm: event.target.checked });
  });

  $('#discordRpcToggle').addEventListener('change', (event) => {
    saveSettings({ discordRpc: event.target.checked });
  });
  $('#saveDiscordClientId').addEventListener('click', saveDiscordClientId);
  $('#checkUpdatesBtn').addEventListener('click', () => checkForUpdates(true));
  $('#installUpdateBtn').addEventListener('click', installUpdate);
  $('#discordClientIdInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveDiscordClientId();
    }
  });
  $('#openDiscordPortal').addEventListener('click', () => {
    api.openExternal('https://discord.com/developers/applications').catch((error) => toast(cleanError(error), 'error'));
  });

  $('#themeGrid').addEventListener('click', (event) => {
    const option = event.target.closest('[data-theme-choice]');
    if (!option) return;
    const theme = normalizeTheme(option.dataset.themeChoice);
    if (theme === normalizeTheme(state.settings.theme)) return;
    saveSettings({ theme });
  });

  $('#usernameInput').addEventListener('change', renameSelectedOffline);
  $('#javaOptions').addEventListener('click', (event) => {
    const option = event.target.closest('[data-java-path]');
    if (!option) return;
    const path = option.dataset.javaPath;
    saveSettings({ javaPath: path === 'auto' ? '' : path });
  });
  $('#browseJavaBtn').addEventListener('click', browseJava);
  $('#clearJavaBtn').addEventListener('click', () => saveSettings({ javaPath: '' }));
  $('#rescanJavaBtn').addEventListener('click', rescanJava);

  $('#browseGameDir').addEventListener('click', browseGameDirectory);
  $('#resetGameDir').addEventListener('click', () => saveSettings({ gameDir: '' }));
  $('#openSettingsGameFolder').addEventListener('click', openGameFolder);
  $('#openDataFolder').addEventListener('click', () => {
    if (!state.system.dataRoot) return;
    api.openPath(state.system.dataRoot).catch((error) => toast(cleanError(error), 'error'));
  });
}

/* ------------------------------------------------------------------ */
/* Navigation and settings                                            */
/* ------------------------------------------------------------------ */

function navigate(page) {
  const valid = new Set(['play', 'versions', 'modpacks', 'manager', 'modrinth', 'settings']);
  state.page = valid.has(page) ? page : 'play';

  $$('.nav-item').forEach((button) =>
    button.classList.toggle('active', button.dataset.page === state.page),
  );
  $$('[data-page-panel]').forEach((panel) =>
    panel.classList.toggle('active', panel.dataset.pagePanel === state.page),
  );
  $('#pages').scrollTop = 0;

  if (state.page === 'versions') renderVersions();
  if (state.page === 'modpacks') {
    renderModpacksPage();
    if (state.modpackTab === 'download' && !state.packBrowserLoaded && !state.packBrowserLoading) {
      searchModpacks(false);
    }
  }
  if (state.page === 'manager') renderManagerPage();
  if (state.page === 'modrinth') {
    ensureContentTarget();
    renderModrinth();
    if (ensureContentTarget()) {
      loadContentList();
      if (!state.modrinthLoaded) searchModrinth(false);
    }
  }
  if (state.page === 'settings') renderSettings();
}

function saveDiscordClientId() {
  const input = $('#discordClientIdInput');
  const value = input.value.trim();
  if (value && !/^\d{17,20}$/.test(value)) {
    toast('A Discord Application ID is 17–20 digits.', 'warn');
    syncSettingsValues();
    return;
  }
  saveSettings({ discordClientId: value });
}

async function saveSettings(patch) {
  const token = (settingsSaveToken += 1);
  const previousTheme = normalizeTheme(state.settings.theme);
  if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
    state.settings.theme = normalizeTheme(patch.theme);
    applyTheme(state.settings.theme);
  }
  setSaveState(true);
  try {
    const updated = await api.updateSettings(patch);
    if (token !== settingsSaveToken) return true;
    state.settings = { ...DEFAULT_SETTINGS, ...(updated || {}) };
    setSaveState(false);
    renderPlay();
    renderStatus();
    syncSettingsValues();
    if (Object.prototype.hasOwnProperty.call(patch, 'javaPath')) {
      renderJavaOptions();
      renderJavaCard();
    }
    return true;
  } catch (error) {
    if (token === settingsSaveToken) {
      setSaveState(false);
      state.settings.theme = previousTheme;
      applyTheme(previousTheme);
      toast(cleanError(error), 'error');
      renderSettings();
    }
    return false;
  }
}

function formatUpdateSize(bytes) {
  const value = Number(bytes) || 0;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderUpdateCard() {
  const update = state.update;
  const current = update.currentVersion || state.system.appVersion || '1.1.1';
  setText('#updateBadge', `v${current}`);

  let title = 'Update check runs automatically on launch.';
  let detail = `You're running Eclipse Client ${current}.`;

  if (update.installing) {
    title = update.status === 'installed' ? 'Update installed.' : 'Downloading the new launcher…';
    detail = update.status === 'installed'
      ? 'Relaunch Eclipse Client if it does not reopen on its own.'
      : update.total
        ? `${formatUpdateSize(update.downloaded)} of ${formatUpdateSize(update.total)} downloaded. Eclipse Client will verify it, swap itself, and reopen.`
        : 'Eclipse Client will verify the download, swap itself in place, and reopen automatically.';
  } else if (update.checking) {
    title = 'Checking for updates…';
    detail = 'Looking for the newest signed release on GitHub.';
  } else if (update.status === 'error') {
    title = 'Update check failed.';
    detail = update.error || 'GitHub Releases could not be reached.';
  } else if (update.available) {
    title = `Eclipse Client ${update.available.version} is available.`;
    const notes = String(update.available.notes || '').trim();
    detail = notes
      ? notes.split('\n').filter(Boolean).slice(0, 2).join(' ')
      : `You're running ${current}. The update downloads, verifies its signature, and swaps the launcher in place.`;
  } else if (update.status === 'current') {
    title = 'You are up to date.';
    detail = `Eclipse Client ${current} is the newest release.`;
  } else if (update.status === 'installed') {
    title = 'Update installed.';
    detail = 'Relaunch Eclipse Client to use the new version.';
  }

  setText('#updateStatus', title);
  setText('#updateDetail', detail);

  const checkButton = $('#checkUpdatesBtn');
  if (checkButton) {
    checkButton.disabled = update.checking || update.installing;
    checkButton.textContent = update.checking ? 'Checking…' : 'Check now';
  }

  const installButton = $('#installUpdateBtn');
  if (installButton) {
    installButton.hidden = !update.available || update.installing || update.status === 'installed';
    installButton.disabled = update.installing;
    installButton.textContent = update.installing ? 'Installing…' : 'Update now';
  }

  const progress = $('#updateProgress');
  if (progress) {
    const active = update.installing && update.status !== 'installed';
    progress.hidden = !active;
    progress.classList.toggle('indeterminate', active && !update.total);
    const fill = $('#updateProgressFill');
    if (fill && active) {
      const percent = update.total
        ? Math.min(100, Math.round((update.downloaded / update.total) * 100))
        : 0;
      fill.style.width = `${percent}%`;
    }
  }
}

async function checkForUpdates(manual = false) {
  if (state.update.checking || state.update.installing) return;
  state.update.checking = true;
  state.update.error = '';
  renderUpdateCard();
  try {
    const result = await api.updates.check();
    state.update.currentVersion = (result && result.currentVersion) || state.system.appVersion || '';
    if (result && result.available) {
      state.update.available = result;
      state.update.status = 'available';
      toast(`Eclipse Client ${result.version} is available. Install it from Settings.`, 'info', 8000);
    } else {
      state.update.available = null;
      state.update.status = 'current';
      if (manual) toast('Eclipse Client is up to date.', 'success');
    }
  } catch (error) {
    state.update.status = 'error';
    state.update.error = cleanError(error);
    if (manual) toast(`Update check failed: ${state.update.error}`, 'error', 7000);
  } finally {
    state.update.checking = false;
    renderUpdateCard();
  }
}

async function installUpdate() {
  if (!state.update.available || state.update.installing) return;
  state.update.installing = true;
  state.update.error = '';
  state.update.downloaded = 0;
  state.update.total = null;
  state.update.status = 'installing';
  renderUpdateCard();
  try {
    await api.updates.install();
    state.update.available = null;
    state.update.status = 'installed';
    toast('Update installed. Eclipse Client is restarting.', 'success', 7000);
  } catch (error) {
    state.update.status = 'error';
    state.update.error = cleanError(error);
    toast(`Update failed: ${state.update.error}`, 'error', 9000);
  } finally {
    state.update.installing = false;
    renderUpdateCard();
  }
}

function syncResolutionFieldState(enabled) {
  const container = $('#resolutionFields');
  if (!container) return;
  container.dataset.disabled = String(!enabled);
  $('#resolutionWidth').disabled = !enabled;
  $('#resolutionHeight').disabled = !enabled;
}

function syncSettingsValues() {
  const settings = state.settings;
  applyTheme(settings.theme);

  const memoryRange = $('#memoryRange');
  const maximum = Math.max(16384, Number(settings.memoryMb) || 4096);
  memoryRange.max = String(maximum);
  if (document.activeElement !== memoryRange) memoryRange.value = String(settings.memoryMb || 4096);
  setText('#memoryValue', formatGb(settings.memoryMb || 4096));

  const toggle = $('#resolutionToggle');
  toggle.checked = Boolean(settings.customResolution);
  if (document.activeElement !== $('#resolutionWidth')) {
    $('#resolutionWidth').value = String(settings.resolutionWidth || 1280);
  }
  if (document.activeElement !== $('#resolutionHeight')) {
    $('#resolutionHeight').value = String(settings.resolutionHeight || 720);
  }
  syncResolutionFieldState(Boolean(settings.customResolution));

  const minimize = $('#minimizeToggle');
  minimize.checked = Boolean(settings.minimizeOnLaunch);
  $('#fastLaunchToggle').checked = settings.fastLaunch !== false;
  $('#performanceJvmToggle').checked = settings.performanceJvm !== false;
  $('#discordRpcToggle').checked = settings.discordRpc !== false;
  const discordInput = $('#discordClientIdInput');
  if (document.activeElement !== discordInput) discordInput.value = settings.discordClientId || '';
  const pageSizeSelect = $('#modrinthPageSize');
  if (pageSizeSelect) pageSizeSelect.value = String(settings.modrinthPageSize || 20);

  const gameDir = resolveGameDir();
  const gameDirInput = $('#gameDirInput');
  if (document.activeElement !== gameDirInput) gameDirInput.value = gameDir;
  gameDirInput.title = gameDir;
  setText(
    '#gameDirNote',
    settings.gameDir
      ? 'Custom location. Libraries and assets still live in the launcher data folder.'
      : `Default location: ${state.system.minecraftRoot || '—'}`,
  );

  const customJava = $('#customJavaPath');
  customJava.value = settings.javaPath || '';
  customJava.placeholder = 'Automatic selection';

  const appVersion = state.system.appVersion || '1.0.0';
  setText('#aboutVersion', `Eclipse Client ${appVersion}`);
  setText('#appVersion', `v${appVersion}`);
}

function renderSettings() {
  renderProfileSettings();
  renderJavaOptions();
  syncSettingsValues();
  renderUpdateCard();
}

function renderProfileSettings() {
  const profile = currentProfile();
  const avatar = $('#settingsAvatar');
  paintAvatar(avatar, profile);
  setText('#settingsProfileName', profile ? profile.name : 'No profile selected');
  setText('#settingsProfileType', profile ? accountTypeLabel(profile.type) : 'Add a profile to get started');
  setText('#settingsProfileBadge', profile && profile.type === 'msa' ? 'Microsoft' : 'Offline');

  const username = $('#usernameInput');
  const disabled = !profile || profile.type !== 'offline';
  username.disabled = disabled;
  if (document.activeElement !== username) username.value = profile ? profile.name : '';
  setText(
    '#usernameHint',
    profile && profile.type === 'msa'
      ? 'Your Microsoft profile name is managed by Microsoft.'
      : 'Changing this updates the local profile UUID.',
  );
  setText('#settingsSignIn', profile && profile.type === 'msa' ? 'Add account' : 'Sign in with Microsoft');
}

function renderJavaOptions() {
  const container = $('#javaOptions');
  const settings = state.settings;
  const installations = state.java.installations || [];
  const selectedPath = settings.javaPath || '';
  const customFound = installations.some(
    (entry) => normalizePath(entry.path) === normalizePath(selectedPath),
  );

  const pieces = [];
  pieces.push(`
    <button type="button" class="java-option ${selectedPath ? '' : 'selected'}" data-java-path="auto">
      <span class="java-dot"></span>
      <span class="java-info">
        <strong>Automatic <span class="java-source">Recommended</span></strong>
        <span class="java-meta">Matches the best compatible runtime to each version</span>
      </span>
      <span class="java-check" aria-hidden="true">✓</span>
    </button>
  `);

  for (const installation of installations) {
    const selected = Boolean(selectedPath) && normalizePath(installation.path) === normalizePath(selectedPath);
    pieces.push(`
      <button type="button" class="java-option ${selected ? 'selected' : ''}" data-java-path="${esc(installation.path)}" title="${esc(installation.path)}">
        <span class="java-dot"></span>
        <span class="java-info">
          <strong>Java ${esc(installation.major)} <span class="java-source">${esc(installation.source || 'Detected')}</span></strong>
          <span class="java-meta">${esc(installation.vendor || 'Java')} · ${esc(installation.version)}</span>
          <span class="java-path">${esc(installation.path)}</span>
        </span>
        <span class="java-check" aria-hidden="true">✓</span>
      </button>
    `);
  }

  if (selectedPath && !customFound) {
    pieces.push(`
      <button type="button" class="java-option selected" data-java-path="${esc(selectedPath)}" title="${esc(selectedPath)}">
        <span class="java-dot"></span>
        <span class="java-info">
          <strong>Custom runtime <span class="java-source">Custom</span></strong>
          <span class="java-meta">Selected Java executable</span>
          <span class="java-path">${esc(selectedPath)}</span>
        </span>
        <span class="java-check" aria-hidden="true">✓</span>
      </button>
    `);
  }

  if (state.java.detecting) {
    pieces.push('<div class="java-option skeleton-option" aria-hidden="true"></div>');
  } else if (!installations.length) {
    pieces.push(
      '<div class="account-list-empty">No Java runtime found. Install Java 21 or newer, or choose a Java executable below.</div>',
    );
  }

  container.innerHTML = pieces.join('');

  const note = state.java.detecting
    ? 'Scanning common install locations…'
    : installations.length
      ? selectedPath
        ? 'This runtime is used for every version. Make sure it meets each version’s requirement.'
        : `${installations.length} runtime${installations.length === 1 ? '' : 's'} found. Automatic mode picks the closest compatible version.`
      : 'Install Java 21 or newer to play current Minecraft versions.';

  setText('#javaSettingsNote', note);
}

function renderJavaCard() {
  const java = preferredJava();
  if (state.java.detecting) {
    setText('#javaSummary', 'Scanning runtimes…');
    setText('#javaDetail', 'Looking for a compatible Java');
    setText('#javaNote', 'Eclipse Client picks a compatible runtime automatically.');
    return;
  }
  if (!java) {
    setText('#javaSummary', 'No Java detected');
    setText('#javaDetail', 'Install Java 21 or newer');
    setText('#javaNote', 'A Java runtime is required to launch the game.');
    return;
  }

  setText('#javaSummary', `Java ${java.major} ${state.settings.javaPath ? 'selected' : 'available'}`);
  setText('#javaDetail', `${java.vendor || 'Java'} · ${java.version || 'unknown'}`);
  setText(
    '#javaNote',
    state.settings.javaPath
      ? 'Custom runtime selected in Settings.'
      : 'Eclipse Client matches the right runtime to each version.',
  );
}

async function rescanJava() {
  state.java = { detecting: true, installations: state.java.installations || [] };
  renderJavaCard();
  renderJavaOptions();
  renderStatus();
  try {
    const java = await api.detectJava();
    state.java = java || { detecting: false, installations: [] };
    renderJavaCard();
    renderJavaOptions();
    renderStatus();
    toast(
      state.java.installations.length
        ? `Found ${state.java.installations.length} Java runtime${state.java.installations.length === 1 ? '' : 's'}.`
        : 'No Java runtime found.',
      state.java.installations.length ? 'success' : 'warn',
    );
  } catch (error) {
    state.java = { detecting: false, installations: [] };
    renderJavaCard();
    renderJavaOptions();
    toast(cleanError(error), 'error');
  }
}

async function browseJava() {
  const button = $('#browseJavaBtn');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Checking…';
  try {
    const info = await api.chooseJava();
    if (info) {
      const saved = await saveSettings({ javaPath: info.path });
      if (saved) toast(`Java ${info.major} selected.`, 'success');
    }
  } catch (error) {
    toast(cleanError(error), 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
    renderJavaOptions();
  }
}

async function browseGameDirectory() {
  const button = $('#browseGameDir');
  button.disabled = true;
  try {
    const folder = await api.chooseFolder();
    if (folder) {
      const saved = await saveSettings({ gameDir: folder });
      if (saved) toast('Game folder updated.', 'success');
    }
  } catch (error) {
    toast(cleanError(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function renameSelectedOffline() {
  const profile = currentProfile();
  const input = $('#usernameInput');
  if (!profile || profile.type !== 'offline') {
    renderProfileSettings();
    return;
  }
  const name = input.value.trim();
  if (name === profile.name) return;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    toast('Usernames must be 3–16 characters and use only letters, numbers, or underscores.', 'error');
    input.value = profile.name;
    return;
  }
  input.disabled = true;
  try {
    const accounts = await api.accounts.renameOffline(profile.id, name);
    state.accounts = accounts;
    setSaveState(false);
    toast(`Offline profile renamed to ${name}.`, 'success');
    renderSidebar();
    renderPlay();
    renderProfileSettings();
  } catch (error) {
    toast(cleanError(error), 'error');
    input.value = profile.name;
  } finally {
    input.disabled = false;
  }
}

async function openGameFolder() {
  const folder = activeGameDir();
  if (!folder) return;
  try {
    await api.openPath(folder);
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Play page                                                          */
/* ------------------------------------------------------------------ */

function renderSidebar() {
  const profile = currentProfile();
  const count = state.installed.size;
  setText(
    '#installedCount',
    count === 0 ? 'No versions installed' : `${count} version${count === 1 ? '' : 's'} installed`,
  );
  paintAvatar($('#sidebarAvatar'), profile);
  setText('#sidebarName', profile ? profile.name : 'Add profile');
  setText('#sidebarType', profile ? accountTypeLabel(profile.type) : 'No account selected');
}

function renderPlay() {
  const profile = currentProfile();
  const versionId = selectedVersionId();
  const entry = versionId ? versionEntry(versionId) : null;
  const installed = versionId ? state.installed.has(versionId) : false;
  const activeModpack = versionId ? state.modpacks.get(versionId) || null : null;
  const type = typeInfo(entry ? entry.type : 'release');
  const running = Boolean(state.game && ['starting', 'running'].includes(state.game.status));
  const busy = Boolean(state.installing || state.launching || state.importingModpack || state.modpackCreating);

  paintAvatar($('#playAvatar'), profile);
  setText('#playAccountName', profile ? profile.name : 'No profile selected');
  setText('#playAccountType', profile ? accountTypeLabel(profile.type) : 'Add an account to play');
  setText(
    '#playAccountNote',
    profile && profile.type === 'msa'
      ? 'Signed in with Microsoft. Ready for online servers.'
      : 'Local profile. Online servers need a Microsoft account.',
  );

  setText('#heroVersion', activeModpack ? activeModpack.name : versionId || '—');
  const heroType = $('#heroType');
  heroType.textContent = type.label.toUpperCase();
  heroType.className = `badge ${type.className}`.trim();

  if (!versionId) {
    setText('#heroSub', 'No version is available yet. Open the version library and refresh.');
  } else if (activeModpack) {
    setText(
      '#heroSub',
      `${activeModpack.name} runs Minecraft ${activeModpack.gameVersion} with ${loaderLabel(activeModpack.loader)} ${activeModpack.loaderVersion}. ${installed ? 'The pack is ready to launch.' : 'Minecraft files download on the first launch.'}`,
    );
  } else if (installed) {
    setText('#heroSub', `Minecraft ${versionId} is installed and ready to launch.`);
  } else if (state.catalogError && !entry) {
    setText('#heroSub', 'The version list is offline and this version is not installed yet.');
  } else {
    setText('#heroSub', `Minecraft ${versionId} will be downloaded the first time you launch it.`);
  }

  const latestChip = $('#latestReleaseChip');
  if (state.manifest && state.manifest.latest && state.manifest.latest.release) {
    latestChip.className = 'pill online';
    latestChip.innerHTML = `<span class="pill-dot"></span>Latest ${esc(state.manifest.latest.release)}`;
  } else {
    latestChip.className = 'pill';
    latestChip.innerHTML = '<span class="pill-dot"></span>Latest —';
  }

  const connectivity = $('#connectivityChip');
  if (state.manifest) {
    connectivity.className = 'pill online';
    connectivity.innerHTML = '<span class="pill-dot"></span>Mojang connected';
  } else if (state.catalogError) {
    connectivity.className = 'pill offline';
    connectivity.innerHTML = '<span class="pill-dot"></span>Mojang offline';
  } else {
    connectivity.className = 'pill';
    connectivity.innerHTML = '<span class="pill-dot"></span>Connecting…';
  }

  const playButton = $('#playBtn');
  const playIcon = $('#playIcon');
  const playLabel = $('#playLabel');
  let disabled = false;
  let stop = false;
  let spinner = false;

  if (running) {
    playLabel.textContent = state.stopping ? 'Stopping…' : 'Stop game';
    playIcon.textContent = '■';
    stop = true;
    disabled = state.stopping;
  } else if (state.installing) {
    playLabel.textContent = 'Downloading…';
    playIcon.innerHTML = '<span class="spinner"></span>';
    spinner = true;
    disabled = true;
  } else if (state.launching) {
    playLabel.textContent = 'Launching…';
    playIcon.innerHTML = '<span class="spinner"></span>';
    spinner = true;
    disabled = true;
  } else if (state.importingModpack || state.modpackCreating) {
    playLabel.textContent = state.importingModpack ? 'Importing…' : 'Creating…';
    playIcon.innerHTML = '<span class="spinner"></span>';
    spinner = true;
    disabled = true;
  } else if (!profile) {
    playLabel.textContent = 'Create profile';
    playIcon.textContent = '▶';
  } else if (!versionId) {
    playLabel.textContent = 'No version available';
    playIcon.textContent = '▶';
    disabled = true;
  } else {
    playLabel.textContent = 'Launch game';
    playIcon.textContent = '▶';
  }

  playButton.classList.toggle('is-stop', stop);
  playButton.disabled = disabled;
  playButton.setAttribute('aria-busy', String(busy || spinner));

  let hint = 'Choose a version, then press launch.';
  if (!profile) {
    hint = 'Add an offline or Microsoft profile to start playing.';
  } else if (running) {
    hint = state.stopping ? 'Waiting for Minecraft to close…' : 'Minecraft is running. Press stop to close it.';
  } else if (state.installing) {
    hint = `${state.installing.label || 'Installing'} · ${state.installing.percent || 0}%`;
  } else if (state.launching) {
    hint = 'Checking your profile and starting Java…';
  } else if (state.importingModpack || state.modpackCreating) {
    hint = state.modpackProgress && state.modpackProgress.label
      ? state.modpackProgress.label
      : 'Working on a modpack…';
  } else if (!versionId) {
    hint = 'No version selected. Refresh the library or install a version.';
  } else if (activeModpack) {
    hint = installed
      ? `${loaderLabel(activeModpack.loader)} ${activeModpack.loaderVersion} ready. Game folder: ${activeGameDir()}`
      : `Minecraft ${activeModpack.gameVersion} and ${loaderLabel(activeModpack.loader)} will download on first launch.`;
  } else if (installed) {
    hint = `Installed and ready. Game folder: ${activeGameDir()}`;
  } else if (state.catalogError && !entry) {
    hint = 'Connect to the internet and refresh the version library.';
  } else {
    hint = `Minecraft ${versionId} will download automatically on first launch.`;
  }
  setText('#launchHint', hint);
  $('#launchHint').title = hint;

  renderJavaCard();

  const versions = state.installed.size;
  setText('#filesSummary', versions === 0 ? 'No files yet' : `${versions} version${versions === 1 ? '' : 's'} installed`);
  setText('#filesPath', activeGameDir() || '—');
  $('#filesPath').title = activeGameDir() || '';

  renderRecentVersions();
  updatePageTitle();
}

function renderRecentVersions() {
  const container = $('#recentVersions');
  if (!container) return;

  let entries = [];
  if (state.manifest && Array.isArray(state.manifest.versions)) {
    entries = state.manifest.versions.filter((entry) => entry.type === 'release').slice(0, 4);
  }
  if (!entries.length) {
    entries = Array.from(state.installed.keys())
      .slice(-4)
      .reverse()
      .map((id) => ({ id, type: 'release', releaseTime: null, local: true }));
  }

  if (!entries.length) {
    container.innerHTML = `<div class="recent-empty">${
      state.catalogError ? 'Could not load releases. Open the library to retry.' : 'Loading releases from Mojang…'
    }</div>`;
    return;
  }

  const selected = selectedVersionId();
  container.innerHTML = entries
    .map((entry) => {
      const type = typeInfo(entry.type);
      const installed = state.installed.has(entry.id);
      const isSelected = entry.id === selected;
      return `
        <button type="button" class="recent-card ${isSelected ? 'selected' : ''}" data-version-id="${esc(entry.id)}" title="Select Minecraft ${esc(entry.id)}">
          <span class="recent-top">
            <span class="badge ${type.className}">${esc(type.label)}</span>
            <span class="recent-arrow" aria-hidden="true">↗</span>
          </span>
          <strong>${esc(entry.id)}</strong>
          <span class="recent-date">${entry.local ? 'Local install' : esc(formatDate(entry.releaseTime))}</span>
          <span class="recent-status ${installed ? '' : 'dim'}">${installed ? 'Installed' : 'Download on launch'}</span>
        </button>
      `;
    })
    .join('');
}

function handlePlayButton() {
  if (state.game && ['starting', 'running'].includes(state.game.status)) {
    stopGame();
    return;
  }
  if (state.installing || state.launching || state.importingModpack || state.modpackCreating) return;

  const profile = currentProfile();
  if (!profile) {
    openAccounts();
    return;
  }

  const versionId = selectedVersionId();
  if (!versionId) {
    toast('No Minecraft version is available yet. Refresh the version library first.', 'warn');
    return;
  }
  if (
    !state.installed.has(versionId) &&
    !findCatalogVersion(versionId) &&
    !state.modpacks.has(versionId)
  ) {
    toast('That version is not available from Mojang. Choose another version.', 'error');
    return;
  }
  launchGame(versionId);
}

async function launchGame(versionId) {
  state.launching = true;
  openConsole(true);
  updateProgressPanel({ label: 'Preparing launch', percent: 0, indeterminate: true });
  renderPlay();
  renderStatus();

  try {
    await api.launch(versionId);
  } catch (error) {
    state.launching = false;
    toast(cleanError(error), 'error', 7000);
    updateProgressPanel(null);
    openConsole(true);
    renderPlay();
    renderStatus();
  } finally {
    state.launching = false;
    renderPlay();
    renderStatus();
  }
}

async function stopGame() {
  if (state.stopping) return;
  state.stopping = true;
  renderPlay();
  renderStatus();
  try {
    await api.stopGame();
  } catch (error) {
    toast(cleanError(error), 'error');
  } finally {
    state.stopping = false;
    renderPlay();
    renderStatus();
  }
}

/* ------------------------------------------------------------------ */
/* Version library                                                    */
/* ------------------------------------------------------------------ */

function allCatalogEntries() {
  const entries = state.manifest && Array.isArray(state.manifest.versions)
    ? [...state.manifest.versions]
    : [];
  const known = new Set(entries.map((entry) => entry.id));
  for (const [id] of state.installed) {
    if (!known.has(id)) {
      entries.push({ id, type: 'release', releaseTime: null, local: true });
    }
  }
  return entries;
}

function renderVersions() {
  renderModpacks();
  const countElement = $('#versionCount');
  const list = $('#versionList');
  const footer = $('#versionFooter');
  if (!list) return;

  const hasAnything = allCatalogEntries().length > 0;
  if (!hasAnything && !state.manifest) {
    if (state.catalogError) {
      list.innerHTML = `
        <div class="catalog-empty">
          <strong>The version list is offline</strong>
          <p>${esc(state.catalogError)}</p>
          <button class="btn btn-quiet btn-sm" type="button" data-retry-catalog>Try again</button>
        </div>
      `;
      countElement.textContent = 'Unavailable';
      footer.hidden = true;
    } else {
      list.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton-row"></div>').join('');
      countElement.textContent = 'Loading…';
      footer.hidden = true;
    }
    updateRefreshButton();
    return;
  }

  const query = state.versionQuery.toLowerCase();
  let filtered = allCatalogEntries().filter((entry) => {
    if (state.versionFilter === 'release' && entry.type !== 'release') return false;
    if (state.versionFilter === 'snapshot' && entry.type !== 'snapshot') return false;
    if (query && !entry.id.toLowerCase().includes(query)) return false;
    return true;
  });

  const selected = selectedVersionId();
  const limit = 400;
  const truncated = filtered.length > limit;
  if (truncated) filtered = filtered.slice(0, limit);

  countElement.textContent = `${filtered.length}${truncated ? '+' : ''} version${filtered.length === 1 ? '' : 's'}`;

  if (!filtered.length) {
    list.innerHTML = `
      <div class="catalog-empty">
        <strong>No matching versions</strong>
        <p>Try a different build number or switch the filter.</p>
        <button class="btn btn-quiet btn-sm" type="button" data-clear-search>Clear search</button>
      </div>
    `;
  } else {
    const blocked = Boolean(state.installing || state.launching || state.game);
    list.innerHTML = filtered
      .map((entry) => {
        const type = typeInfo(entry.type);
        const installed = state.installed.has(entry.id);
        const isSelected = entry.id === selected;
        const isInstalling = Boolean(state.installing && state.installing.versionId === entry.id);
        const action = isInstalling
          ? '<span class="state-pill installing"><span class="spinner"></span>Working</span>'
          : installed
            ? `<span class="state-pill installed"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.4 6.2 2.2 2.2 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Installed</span>`
            : `<button class="install-btn" type="button" data-install="${esc(entry.id)}" ${blocked ? 'disabled' : ''}>Install</button>`;
        const selectedBadge = isSelected
          ? '<span class="state-pill active">Selected</span>'
          : '';
        return `
          <div class="version-row ${isSelected ? 'selected' : ''} ${isInstalling ? 'installing' : ''}" role="button" tabindex="0" data-version-id="${esc(entry.id)}" aria-pressed="${isSelected}">
            <span class="version-name">
              <span class="version-block" aria-hidden="true"></span>
              <span>
                <strong>${esc(entry.id)}</strong>
                <span class="version-sub">Minecraft Java Edition</span>
              </span>
            </span>
            <span><span class="badge ${type.className}">${esc(type.label)}</span></span>
            <span class="version-date">${entry.local ? 'Local install' : esc(formatDate(entry.releaseTime))}</span>
            <span class="version-actions">${selectedBadge}${action}</span>
          </div>
        `;
      })
      .join('');
  }

  const notes = [];
  if (truncated) notes.push(`Showing the first ${limit} versions. Refine your search for older builds.`);
  if (state.catalogError) notes.push('Mojang could not be reached; showing cached and installed versions.');
  if (!state.manifest) notes.push('Waiting for Mojang’s version manifest…');
  footer.innerHTML = notes.map(esc).join(' ');
  footer.hidden = notes.length === 0;

  updateRefreshButton();
}

function updateRefreshButton() {
  const button = $('#refreshVersionsBtn');
  if (!button) return;
  button.disabled = state.refreshing;
  const icon = $('.refresh-icon', button);
  if (icon) icon.classList.toggle('spinning', state.refreshing);
}

function handleVersionListClick(event) {
  const installButton = event.target.closest('[data-install]');
  if (installButton) {
    event.stopPropagation();
    installVersionFromUi(installButton.dataset.install);
    return;
  }
  const retryButton = event.target.closest('[data-retry-catalog]');
  if (retryButton) {
    refreshCatalog(false);
    return;
  }
  const clearButton = event.target.closest('[data-clear-search]');
  if (clearButton) {
    state.versionQuery = '';
    $('#versionSearch').value = '';
    renderVersions();
    return;
  }
  const row = event.target.closest('[data-version-id]');
  if (row) selectVersion(row.dataset.versionId);
}

function handleVersionListKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('button')) return;
  const row = event.target.closest('[data-version-id]');
  if (!row) return;
  event.preventDefault();
  selectVersion(row.dataset.versionId);
}

async function selectVersion(versionId) {
  if (!versionId) return;
  const token = (settingsSaveToken += 1);
  state.settings.selectedVersion = versionId;
  state.confirmDeletePack = '';
  state.managerError = '';
  if (state.modpacks.has(versionId)) {
    state.contentTarget = versionId;
    state.content = [];
    state.contentLoadedFor = '';
    state.modrinthResults = [];
    state.modrinthLoaded = false;
  }
  workbenchSelectionChanged();
  try {
    const updated = await api.updateSettings({ selectedVersion: versionId });
    if (token === settingsSaveToken) state.settings = { ...DEFAULT_SETTINGS, ...(updated || {}) };
    workbenchSelectionChanged();
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function workbenchSelectionChanged() {
  renderPlay();
  renderVersions();
  renderModpacksPage();
  renderStatus();
}

async function installVersionFromUi(versionId) {
  if (state.installing || state.launching) {
    toast('Another download is already running.', 'warn');
    return;
  }
  if (state.game) {
    toast('Close Minecraft before installing a version.', 'warn');
    return;
  }

  state.installing = {
    versionId,
    stage: 'metadata',
    label: 'Preparing download',
    percent: 0,
    indeterminate: true,
  };
  openConsole(true);
  updateProgressPanel(state.installing);
  renderPlay();
  renderVersions();
  renderStatus();

  try {
    await api.installVersion(versionId);
    toast(`Minecraft ${versionId} is installed.`, 'success');
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
    openConsole(true);
  } finally {
    state.installing = null;
    updateProgressPanel(null);
    renderSidebar();
    renderPlay();
    renderVersions();
    renderStatus();
  }
}

async function refreshCatalog(quiet) {
  if (state.refreshing) return;
  state.refreshing = true;
  updateRefreshButton();
  if (!state.manifest) renderVersions();
  try {
    const manifest = await api.refreshCatalog();
    state.manifest = manifest;
    state.catalogError = '';
    if (!quiet) toast('Version list refreshed.', 'success');
  } catch (error) {
    state.catalogError = cleanError(error);
    if (!quiet) toast(state.catalogError, 'error');
  } finally {
    state.refreshing = false;
    updateRefreshButton();
    renderPlay();
    renderVersions();
    renderStatus();
  }
}

/* ------------------------------------------------------------------ */
/* Modpacks and Modrinth                                               */
/* ------------------------------------------------------------------ */

function renderModpacks() {
  const shelf = $('#modpackShelf');
  const grid = $('#modpackGrid');
  const count = $('#modpackCount');
  if (!shelf || !grid) return;

  const records = Array.from(state.modpacks.values()).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
  shelf.hidden = records.length === 0;
  setText('#modpackCount', `${records.length} modpack${records.length === 1 ? '' : 's'}`);
  if (!records.length) {
    grid.innerHTML = '';
    return;
  }

  const selected = selectedVersionId();
  grid.innerHTML = records
    .map((instance) => {
      const installed = state.installed.has(instance.id);
      const isSelected = instance.id === selected;
      return `
        <article class="modpack-card ${isSelected ? 'selected' : ''}" data-modpack-id="${esc(instance.id)}" tabindex="0" role="button" aria-pressed="${isSelected}" title="Select ${esc(instance.name)}">
          <span class="modpack-mark" aria-hidden="true">${esc(loaderMark(instance.loader))}</span>
          <span class="modpack-copy">
            <strong>${esc(instance.name)}</strong>
            <span>Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</span>
            <span class="modpack-state ${installed ? '' : 'dim'}">${installed ? 'Ready to launch' : 'Downloads on first launch'}</span>
          </span>
          <button class="modpack-manage" type="button" data-manage-modpack="${esc(instance.id)}">Content</button>
        </article>
      `;
    })
    .join('');
}

function handleModpackShelfClick(event) {
  const manage = event.target.closest('[data-manage-modpack]');
  if (manage) {
    event.stopPropagation();
    const id = manage.dataset.manageModpack;
    if (!state.modpacks.has(id)) return;
    state.contentTarget = id;
    state.content = [];
    state.contentLoadedFor = '';
    state.essentials = null;
    state.essentialsLoadedFor = '';
    state.render = null;
    state.renderLoadedFor = '';
    state.modrinthResults = [];
    state.modrinthLoaded = false;
    state.modrinthError = '';
    navigate('modrinth');
    return;
  }
  const card = event.target.closest('[data-modpack-id]');
  if (card) selectVersion(card.dataset.modpackId);
}

function packIsRunning(instance) {
  return Boolean(
    state.game &&
      ['starting', 'running'].includes(state.game.status) &&
      state.game.versionId === instance.id,
  );
}

function packBusy() {
  return Boolean(
    state.importingModpack ||
      state.modpackCreating ||
      state.duplicatingPack ||
      state.renameBusy ||
      state.installingPackId ||
      state.installing ||
      state.launching,
  );
}

function managerPackId() {
  const configured = state.settings.selectedVersion;
  if (state.modpacks.has(configured)) return configured;
  const records = Array.from(state.modpacks.values()).sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || '')),
  );
  return records[0]?.id || '';
}

function renderManagerPage() {
  const rows = $('#managerRows');
  const editor = $('#managerEditor');
  if (!rows || !editor) return;

  const records = Array.from(state.modpacks.values()).sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || '')),
  );
  const query = state.managerQuery.toLowerCase();
  const filtered = records.filter((instance) => {
    if (!query) return true;
    return `${instance.name} ${instance.gameVersion} ${loaderLabel(instance.loader)} ${instance.loaderVersion}`
      .toLowerCase()
      .includes(query);
  });

  setText('#managerCount', `${filtered.length} pack${filtered.length === 1 ? '' : 's'}`);

  if (!records.length) {
    rows.innerHTML =
      '<div class="manager-empty">No packs yet. Create or import one to start managing it.</div>';
    editor.innerHTML = `
      <div class="pack-detail-empty">
        <span class="pack-detail-mark" aria-hidden="true">+</span>
        <strong>No packs to manage</strong>
        <p>Create a pack or import an .mrpack, then come back here to edit it.</p>
      </div>
    `;
    return;
  }

  const activeId = managerPackId();
  rows.innerHTML = filtered.length
    ? filtered
        .map((instance) => {
          const ready = state.installed.has(instance.id);
          const running = packIsRunning(instance);
          const stateLabel = running ? 'Running' : ready ? 'Ready' : 'Not installed';
          return `
            <button class="manager-row ${instance.id === activeId ? 'selected' : ''}" type="button" data-manager-pack-id="${esc(instance.id)}" title="Edit ${esc(instance.name)}">
              <span class="pack-mark" aria-hidden="true">${esc(loaderMark(instance.loader))}</span>
              <span class="manager-row-copy">
                <strong>${esc(instance.name)}</strong>
                <span>Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</span>
              </span>
              <span class="manager-row-state ${ready || running ? '' : 'dim'}">${stateLabel}</span>
            </button>
          `;
        })
        .join('')
    : '<div class="manager-empty">No matching packs. Try a different search.</div>';

  renderManagerEditor(records.find((instance) => instance.id === activeId) || records[0]);
}

function renderManagerEditor(instance) {
  const editor = $('#managerEditor');
  if (!editor) return;
  if (!instance) {
    editor.innerHTML = `
      <div class="pack-detail-empty">
        <span class="pack-detail-mark" aria-hidden="true">+</span>
        <strong>Select a pack</strong>
        <p>Pick a pack from the list to edit its name or manage its files.</p>
      </div>
    `;
    return;
  }

  const ready = state.installed.has(instance.id);
  const running = packIsRunning(instance);
  const busy = packBusy();
  const duplicating = state.duplicatingPack === instance.id;
  const confirming = state.confirmDeletePackPage === instance.id;
  const folderName = String(instance.gameDir || '').split(/[\\/]/).pop() || instance.id;
  const stateLabel = running ? 'Running' : ready ? 'Installed' : 'Downloads on first launch';

  editor.innerHTML = `
    <div class="pack-detail-head">
      <span class="pack-detail-mark" aria-hidden="true">${esc(loaderMark(instance.loader))}</span>
      <div class="pack-detail-copy">
        <p class="eyebrow">Editing pack</p>
        <h2>${esc(instance.name)}</h2>
        <span>Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</span>
      </div>
    </div>
    <div class="pack-detail-badges">
      <span class="badge ${ready ? 'badge-soft' : ''}">${esc(stateLabel)}</span>
      <span class="badge">${instance.essentialsEnabled ? 'Essentials on' : 'Essentials off'}</span>
    </div>
    <div class="manager-name">
      <label class="field" for="managerNameInput">
        <span>Pack name</span>
        <div class="manager-name-row">
          <input id="managerNameInput" type="text" maxlength="48" value="${esc(instance.name)}" autocomplete="off" spellcheck="false" ${busy ? 'disabled' : ''} />
          <button class="btn btn-primary btn-sm" type="button" id="managerNameSave" ${busy ? 'disabled' : ''}>Save name</button>
        </div>
        <small>2–48 characters. Renaming doesn't move files.</small>
      </label>
      <div class="modal-error" id="managerError" role="alert" ${state.managerError ? '' : 'hidden'}>${esc(state.managerError || '')}</div>
    </div>
    <div class="pack-facts">
      <div class="pack-fact"><span>Minecraft</span><strong>${esc(instance.gameVersion)}</strong></div>
      <div class="pack-fact"><span>Loader</span><strong>${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</strong></div>
      <div class="pack-fact"><span>Folder</span><strong class="pack-path" title="${esc(instance.gameDir)}">${esc(folderName)}</strong></div>
    </div>
    <div class="pack-detail-actions">
      <button class="btn btn-primary btn-sm pack-play" type="button" data-pack-action="play" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${running ? (state.stopping ? 'Stopping…' : 'Stop game') : 'Play pack'}</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="content" data-pack-id="${esc(instance.id)}">Content</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="folder" data-pack-id="${esc(instance.id)}">Open folder</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="duplicate" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${duplicating ? 'Copying…' : 'Duplicate'}</button>
      <button class="btn btn-quiet btn-sm danger-quiet ${confirming ? 'confirm' : ''}" type="button" data-pack-action="delete" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${confirming ? 'Confirm delete' : 'Delete'}</button>
    </div>
    <p class="card-note pack-detail-note">Renaming only changes the label. Duplicate copies this pack's mods, configs, and worlds into a new instance.</p>
  `;
}

/* ------------------------------------------------------------------ */
/* Modpack download tab                                                */
/* ------------------------------------------------------------------ */

const MODPACK_TABS = new Set(['download', 'manage']);

function renderModpackTabs() {
  const tab = MODPACK_TABS.has(state.modpackTab) ? state.modpackTab : 'download';
  $$('#modpackTabs [data-modpack-tab]').forEach((button) => {
    const active = button.dataset.modpackTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const downloadPanel = $('#modpackDownloadPanel');
  if (downloadPanel) downloadPanel.hidden = tab !== 'download';
  const managePanel = $('#modpackManagePanel');
  if (managePanel) managePanel.hidden = tab !== 'manage';
}

function setModpackTab(tab) {
  const next = MODPACK_TABS.has(tab) ? tab : 'download';
  if (state.modpackTab === next) return;
  state.modpackTab = next;
  renderModpacksPage();
  if (next === 'download' && !state.packBrowserLoaded && !state.packBrowserLoading) {
    searchModpacks(false);
  }
}

// Packs installed straight from Modrinth remember their project, so the
// browser can mark them instead of offering a second copy.
function installedModrinthProjects() {
  const ids = new Set();
  state.modpacks.forEach((instance) => {
    if (!instance.source || instance.source.type !== 'modrinth') return;
    const projectId = String(instance.source.projectId || '');
    if (projectId) ids.add(projectId);
  });
  return ids;
}

function renderPackBrowser() {
  const container = $('#packBrowserResults');
  const footer = $('#packBrowserFooter');
  const count = $('#packBrowserCount');
  if (!container || !footer || !count) return;

  const searchInput = $('#packBrowserSearch');
  if (searchInput && document.activeElement !== searchInput && searchInput.value !== state.packBrowserQuery) {
    searchInput.value = state.packBrowserQuery;
  }

  count.textContent = state.packBrowserLoading && !state.packBrowserResults.length
    ? 'Loading…'
    : state.packBrowserError
      ? 'Offline'
      : state.packBrowserLoaded
        ? `${state.packBrowserTotal.toLocaleString()} pack${state.packBrowserTotal === 1 ? '' : 's'}`
        : '—';

  if (state.modpackTab === 'manage') return;

  if (state.packBrowserLoading && !state.packBrowserResults.length) {
    footer.hidden = true;
    container.innerHTML = Array.from({ length: 4 }, () => '<div class="mod-card skeleton"></div>').join('');
    return;
  }

  if (state.packBrowserError) {
    footer.hidden = true;
    container.innerHTML = `
      <div class="content-state">
        <strong>Modrinth is unreachable</strong>
        <p>${esc(state.packBrowserError)}</p>
        <button class="btn btn-quiet btn-sm" type="button" data-retry-pack-browser>Try again</button>
      </div>
    `;
    return;
  }

  if (!state.packBrowserResults.length) {
    footer.hidden = true;
    container.innerHTML = `
      <div class="content-state">
        <strong>No modpacks found</strong>
        <p>Try another search, or switch to Manage to import an .mrpack you already have.</p>
      </div>
    `;
    return;
  }

  const inLibrary = installedModrinthProjects();
  const busy = packBusy();
  container.innerHTML = state.packBrowserResults
    .map((project) => {
      const already = inLibrary.has(project.id);
      const installing = state.installingPackId === project.id;
      const tags = (project.categories || [])
        .filter((category) => !['fabric', 'quilt', 'neoforge', 'forge', 'minecraft'].includes(category))
        .slice(0, 3);
      const icon = project.iconUrl
        ? `<img src="${esc(project.iconUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        : `<span>${esc((project.title || '?').slice(0, 1).toUpperCase())}</span>`;
      const action = already
        ? '<span class="state-pill installed">In library</span>'
        : `<button class="content-add" type="button" data-install-pack="${esc(project.id)}" ${installing || busy ? 'disabled' : ''}>${installing ? 'Installing…' : 'Install'}</button>`;
      return `
        <article class="mod-card">
          <div class="mod-card-head">
            <span class="mod-icon">${icon}</span>
            <span class="mod-title">
              <strong>${esc(project.title)}</strong>
              <span>by ${esc(project.author || 'Unknown author')}</span>
            </span>
            <span class="mod-downloads" title="Downloads">↓ ${formatCount(project.downloads)}</span>
          </div>
          <p class="mod-desc">${esc(project.description)}</p>
          <div class="mod-foot">
            <span class="mod-tags">${tags.map((tag) => `<span class="mod-tag">${esc(tag.replace(/-/g, ' '))}</span>`).join('')}</span>
            ${action}
          </div>
        </article>
      `;
    })
    .join('');

  const hasMore = state.packBrowserResults.length < state.packBrowserTotal;
  footer.hidden = !hasMore;
  footer.innerHTML = hasMore
    ? `<button class="btn btn-quiet btn-sm" type="button" data-load-more-packs ${state.packBrowserLoadingMore ? 'disabled' : ''}>${state.packBrowserLoadingMore ? 'Loading…' : `Load more (${state.packBrowserResults.length} of ${state.packBrowserTotal.toLocaleString()})`}</button>`
    : '';
}

async function searchModpacks(append) {
  if (state.packBrowserLoading || state.packBrowserLoadingMore) return;
  const token = (packBrowserRequestToken += 1);
  const offset = append ? state.packBrowserResults.length : 0;
  state.packBrowserLoading = !append;
  state.packBrowserLoadingMore = append;
  state.packBrowserError = '';
  if (!append) state.packBrowserLoaded = false;
  renderPackBrowser();
  try {
    const result = await api.content.searchModpacks({
      query: state.packBrowserQuery,
      offset,
    });
    if (token !== packBrowserRequestToken) return;
    const hits = Array.isArray(result.hits) ? result.hits : [];
    state.packBrowserResults = append ? [...state.packBrowserResults, ...hits] : hits;
    state.packBrowserTotal = Number(result.totalHits) || state.packBrowserResults.length;
    state.packBrowserLoaded = true;
  } catch (error) {
    if (token !== packBrowserRequestToken) return;
    state.packBrowserError = cleanError(error);
    state.packBrowserLoaded = true;
  } finally {
    if (token === packBrowserRequestToken) {
      state.packBrowserLoading = false;
      state.packBrowserLoadingMore = false;
      renderPackBrowser();
    }
  }
}

async function installModrinthModpack(button) {
  const projectId = button.dataset.installPack;
  const project = state.packBrowserResults.find((entry) => entry.id === projectId);
  if (!project || state.installingPackId) return;
  if (state.game) {
    toast('Close Minecraft before installing a modpack.', 'warn');
    return;
  }

  state.installingPackId = projectId;
  state.modpackProgress = {
    phase: 'download',
    label: `Installing ${project.title}…`,
    percent: 0,
    indeterminate: true,
  };
  renderPackBrowser();
  renderStatus();
  try {
    const result = await api.modpacks.installModrinth({ projectId });
    setModpacks(result.modpacks);
    const instance = result.instance;
    if (instance) {
      state.contentTarget = instance.id;
      state.content = [];
      state.contentLoadedFor = '';
      state.essentials = null;
      state.essentialsLoadedFor = '';
      state.render = null;
      state.renderLoadedFor = '';
      state.modrinthResults = [];
      state.modrinthTotal = 0;
      state.modrinthError = '';
      state.modrinthLoaded = false;
      state.modrinthQuery = '';
      await selectVersion(instance.id);
      state.modpackTab = 'manage';
    }
    renderAll();
    toast(
      `${project.title} installed${instance ? ` as ${instance.name}` : ''}${result.importedFiles ? ` with ${result.importedFiles} files` : ''}. Open Manage to launch it.`,
      'success',
      7000,
    );
  } catch (error) {
    toast(cleanError(error), 'error', 8000);
  } finally {
    state.installingPackId = '';
    state.modpackProgress = null;
    renderModpacksPage();
    renderPlay();
    renderVersions();
    renderStatus();
  }
}

function renderModpacksPage() {
  renderModpackTabs();
  renderPackBrowser();
  renderManagerPage();
  const grid = $('#packGrid');
  const empty = $('#packEmpty');
  if (!grid) return;

  const query = state.packQuery.toLowerCase();
  const records = Array.from(state.modpacks.values()).sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || '')),
  );
  const filtered = records.filter((instance) => {
    if (state.packFilter !== 'all' && instance.loader !== state.packFilter) return false;
    if (!query) return true;
    return `${instance.name} ${instance.gameVersion} ${loaderLabel(instance.loader)} ${instance.loaderVersion}`
      .toLowerCase()
      .includes(query);
  });

  setText('#packCount', `${filtered.length} pack${filtered.length === 1 ? '' : 's'}`);
  if (empty) empty.hidden = records.length > 0;
  grid.hidden = records.length === 0;

  if (!records.length) {
    grid.innerHTML = '';
    renderPackDetail(null);
    return;
  }

  const selected = selectedVersionId();
  const busy = packBusy();
  grid.classList.toggle('is-busy', busy);

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="pack-empty-inline">
        <strong>No matching packs</strong>
        <p>Try a different name or loader filter.</p>
      </div>
    `;
  } else {
    grid.innerHTML = filtered
      .map((instance) => {
        const isSelected = instance.id === selected;
        const running = packIsRunning(instance);
        const ready = state.installed.has(instance.id);
        const duplicating = state.duplicatingPack === instance.id;
        const stateLabel = duplicating
          ? 'Copying…'
          : running
            ? 'Running'
            : ready
              ? 'Ready to launch'
              : 'Downloads on first launch';
        return `
          <article class="pack-card ${isSelected ? 'selected' : ''} ${duplicating ? 'busy' : ''}" data-pack-id="${esc(instance.id)}" tabindex="0" role="button" aria-pressed="${isSelected}" title="Select ${esc(instance.name)}">
            <div class="pack-card-head">
              <span class="pack-mark" aria-hidden="true">${esc(loaderMark(instance.loader))}</span>
              <span class="pack-card-copy">
                <strong>${esc(instance.name)}</strong>
                <span>Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</span>
              </span>
              ${isSelected ? '<span class="pack-active">Active</span>' : ''}
            </div>
            <div class="pack-card-foot">
              <span class="pack-status ${ready || running ? '' : 'dim'}"><span class="pack-status-dot" aria-hidden="true"></span>${esc(stateLabel)}</span>
              <span class="pack-manage" aria-hidden="true">Manage →</span>
            </div>
          </article>
        `;
      })
      .join('');
  }

  renderPackDetail(records.find((instance) => instance.id === selected) || null);
}

function renderPackDetail(instance) {
  const panel = $('#packDetail');
  if (!panel) return;
  if (!instance) {
    panel.innerHTML = `
      <div class="pack-detail-empty">
        <span class="pack-detail-mark" aria-hidden="true">+</span>
        <strong>Select a pack</strong>
        <p>Pick a pack from your library to see its base, jump into its content, or make a copy.</p>
      </div>
    `;
    return;
  }

  const selected = selectedVersionId() === instance.id;
  const ready = state.installed.has(instance.id);
  const running = packIsRunning(instance);
  const busy = packBusy();
  const duplicating = state.duplicatingPack === instance.id;
  const confirming = state.confirmDeletePackPage === instance.id;
  const stateLabel = running ? 'Running' : ready ? 'Installed' : 'Downloads on first launch';
  const folderName = String(instance.gameDir || '').split(/[\\/]/).pop() || instance.id;

  panel.innerHTML = `
    <div class="pack-detail-head">
      <span class="pack-detail-mark" aria-hidden="true">${esc(loaderMark(instance.loader))}</span>
      <div class="pack-detail-copy">
        <p class="eyebrow">Selected pack</p>
        <h2>${esc(instance.name)}</h2>
        <span>Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</span>
      </div>
    </div>
    <div class="pack-detail-badges">
      <span class="badge ${selected ? 'badge-soft' : ''}">${selected ? 'Active profile' : 'Inactive'}</span>
      <span class="badge ${ready ? 'badge-soft' : ''}">${esc(stateLabel)}</span>
      <span class="badge">${instance.essentialsEnabled ? 'Essentials on' : 'Essentials off'}</span>
    </div>
    <div class="pack-facts">
      <div class="pack-fact"><span>Minecraft</span><strong>${esc(instance.gameVersion)}</strong></div>
      <div class="pack-fact"><span>Loader</span><strong>${esc(loaderLabel(instance.loader))} ${esc(instance.loaderVersion)}</strong></div>
      <div class="pack-fact"><span>Created</span><strong>${esc(formatDate(instance.createdAt))}</strong></div>
      <div class="pack-fact"><span>Folder</span><strong class="pack-path" title="${esc(instance.gameDir)}">${esc(folderName)}</strong></div>
    </div>
    <div class="pack-detail-actions">
      <button class="btn btn-primary btn-sm pack-play" type="button" data-pack-action="play" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${running ? (state.stopping ? 'Stopping…' : 'Stop game') : 'Play pack'}</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="content" data-pack-id="${esc(instance.id)}">Content</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="folder" data-pack-id="${esc(instance.id)}">Open folder</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="duplicate" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${duplicating ? 'Copying…' : 'Duplicate'}</button>
      <button class="btn btn-quiet btn-sm" type="button" data-pack-action="rename" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>Rename</button>
      <button class="btn btn-quiet btn-sm danger-quiet ${confirming ? 'confirm' : ''}" type="button" data-pack-action="delete" data-pack-id="${esc(instance.id)}" ${busy ? 'disabled' : ''}>${confirming ? 'Confirm delete' : 'Delete'}</button>
    </div>
    <p class="card-note pack-detail-note">Duplicating copies this pack's mods, configs, and worlds into a new instance. Renaming only changes its label.</p>
  `;
}

function handlePackGridClick(event) {
  const card = event.target.closest('[data-pack-id]');
  if (!card) return;
  selectVersion(card.dataset.packId);
}

function handlePackGridKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-pack-id]');
  if (!card) return;
  event.preventDefault();
  selectVersion(card.dataset.packId);
}

async function handlePackDetailClick(event) {
  const button = event.target.closest('[data-pack-action]');
  if (!button) return;
  const instance = state.modpacks.get(button.dataset.packId || selectedVersionId());
  if (!instance) return;

  switch (button.dataset.packAction) {
    case 'play':
      await playPackFromPage(instance);
      return;
    case 'content':
      state.contentTarget = instance.id;
      state.content = [];
      state.contentLoadedFor = '';
      state.essentials = null;
      state.essentialsLoadedFor = '';
      state.render = null;
      state.renderLoadedFor = '';
      state.modrinthResults = [];
      state.modrinthTotal = 0;
      state.modrinthLoaded = false;
      state.modrinthError = '';
      if (selectedVersionId() !== instance.id) await selectVersion(instance.id);
      navigate('modrinth');
      return;
    case 'folder':
      api.openPath(instance.gameDir).catch((error) => toast(cleanError(error), 'error'));
      return;
    case 'duplicate':
      await duplicatePack(instance);
      return;
    case 'rename':
      openRenamePackModal(instance);
      return;
    case 'delete':
      await deletePackFromPage(instance);
      return;
    default:
  }
}

async function playPackFromPage(instance) {
  if (packIsRunning(instance)) {
    stopGame();
    return;
  }
  if (state.game) {
    toast('Close Minecraft before launching another pack.', 'warn');
    return;
  }
  if (
    state.installing ||
    state.launching ||
    state.importingModpack ||
    state.modpackCreating ||
    state.duplicatingPack
  ) {
    toast('Wait for the current operation to finish.', 'warn');
    return;
  }
  if (!currentProfile()) {
    openAccounts();
    return;
  }
  if (selectedVersionId() !== instance.id) await selectVersion(instance.id);
  launchGame(instance.id);
}

async function duplicatePack(instance) {
  if (!instance || state.duplicatingPack) return;
  if (state.game) {
    toast('Close Minecraft before duplicating a modpack.', 'warn');
    return;
  }
  if (state.importingModpack || state.modpackCreating || state.installing || state.launching) {
    toast('Wait for the current operation to finish.', 'warn');
    return;
  }

  state.duplicatingPack = instance.id;
  state.confirmDeletePackPage = '';
  renderModpacksPage();
  try {
    const result = await api.modpacks.duplicate(instance.id);
    setModpacks(result.modpacks);
    await selectVersion(result.instance.id);
    updatePageTitle();
    toast(`${result.instance.name} is ready to customize.`, 'success', 5200);
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
  } finally {
    state.duplicatingPack = '';
    renderModpacksPage();
  }
}

async function deletePackFromPage(instance) {
  if (state.importingModpack || state.modpackCreating || state.installing || state.launching || state.duplicatingPack) {
    toast('Wait for the current operation to finish.', 'warn');
    return;
  }
  if (state.game) {
    toast('Close Minecraft before deleting a modpack.', 'warn');
    return;
  }

  if (state.confirmDeletePackPage !== instance.id) {
    state.confirmDeletePackPage = instance.id;
    clearTimeout(packDeleteTimer);
    packDeleteTimer = setTimeout(() => {
      state.confirmDeletePackPage = '';
      renderModpacksPage();
    }, 3500);
    renderModpacksPage();
    return;
  }

  clearTimeout(packDeleteTimer);
  state.confirmDeletePackPage = '';
  try {
    const result = await api.modpacks.remove(instance.id);
    setModpacks(result.modpacks);
    if (state.settings.selectedVersion === instance.id) {
      state.settings.selectedVersion = result.selectedVersion || '';
    }
    state.contentTarget = '';
    state.content = [];
    state.contentLoadedFor = '';
    ensureContentTarget();
    renderAll();
    updatePageTitle();
    toast(`${instance.name} deleted.`, 'success');
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
    renderModpacksPage();
  }
}

function openRenamePackModal(instance) {
  if (!instance) return;
  state.renamingPack = instance.id;
  state.renameBusy = false;
  state.renameError = '';
  const input = $('#renamePackName');
  if (input) input.value = instance.name;
  const modal = $('#renamePackModal');
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  renderRenamePackState();
  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 60);
}

function closeRenamePackModal() {
  if (state.renameBusy) return;
  state.renamingPack = '';
  state.renameError = '';
  const modal = $('#renamePackModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function renderRenamePackState() {
  const errorElement = $('#renamePackError');
  if (errorElement) {
    errorElement.hidden = !state.renameError;
    errorElement.textContent = state.renameError || '';
  }
  const submit = $('#renamePackSubmit');
  if (submit) {
    submit.disabled = state.renameBusy;
    submit.textContent = state.renameBusy ? 'Saving…' : 'Save name';
  }
  const close = $('#closeRenamePack');
  if (close) close.disabled = state.renameBusy;
  const cancel = $('#cancelRenamePack');
  if (cancel) cancel.disabled = state.renameBusy;
}

async function handleRenamePackSubmit(event) {
  event.preventDefault();
  const instance = state.modpacks.get(state.renamingPack);
  if (!instance || state.renameBusy) return;
  const input = $('#renamePackName');
  const name = input ? input.value.trim() : '';
  state.renameError = '';

  if (name.length < 2 || name.length > 48) {
    state.renameError = 'Give the modpack a name between 2 and 48 characters.';
    renderRenamePackState();
    return;
  }
  if (name === instance.name) {
    closeRenamePackModal();
    return;
  }

  state.renameBusy = true;
  renderRenamePackState();
  renderModpacksPage();
  try {
    const result = await api.modpacks.rename({ id: instance.id, name });
    setModpacks(result.modpacks);
    state.renameBusy = false;
    closeRenamePackModal();
    updatePageTitle();
    toast(`Renamed to ${result.instance.name}.`, 'success');
  } catch (error) {
    state.renameError = cleanError(error);
  } finally {
    state.renameBusy = false;
    renderRenamePackState();
    renderModpacksPage();
  }
}

async function saveManagerName() {
  if (state.renameBusy) return;
  const instance = state.modpacks.get(managerPackId());
  if (!instance) return;
  const input = $('#managerNameInput');
  const button = $('#managerNameSave');
  const name = input ? input.value.trim() : '';
  const showError = (message) => {
    state.managerError = message;
    const errorElement = $('#managerError');
    if (errorElement) {
      errorElement.hidden = false;
      errorElement.textContent = message;
    }
    input?.focus();
    input?.select();
  };

  if (name.length < 2 || name.length > 48) {
    showError('Give the modpack a name between 2 and 48 characters.');
    return;
  }
  if (name === instance.name) {
    state.managerError = '';
    input?.blur();
    return;
  }

  state.managerError = '';
  state.renameBusy = true;
  if (input) input.disabled = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Saving…';
  }

  try {
    const result = await api.modpacks.rename({ id: instance.id, name });
    setModpacks(result.modpacks);
    state.renameBusy = false;
    state.managerError = '';
    updatePageTitle();
    renderModpacksPage();
    toast(`Renamed to ${result.instance.name}.`, 'success');
  } catch (error) {
    state.renameBusy = false;
    if (input) input.disabled = false;
    if (button) {
      button.disabled = false;
      button.textContent = 'Save name';
    }
    showError(cleanError(error));
  }
}

function renderModrinth() {
  const target = ensureContentTarget();
  const targetSelect = $('#contentTarget');
  const targetMeta = $('#contentTargetMeta');
  const targetMark = $('#contentTargetMark');
  const targetStats = $('#contentTargetStats');
  const openButton = $('#contentOpenFolder');
  const deleteButton = $('#contentDeletePack');
  const searchInput = $('#modrinthSearch');
  const count = $('#modrinthCount');
  if (!targetSelect || !targetMeta) return;

  const records = Array.from(state.modpacks.values()).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || '')),
  );
  targetSelect.innerHTML = records.length
    ? records
        .map(
          (instance) =>
            `<option value="${esc(instance.id)}">${esc(instance.name)} — Minecraft ${esc(instance.gameVersion)} · ${esc(loaderLabel(instance.loader))}</option>`,
        )
        .join('')
    : '<option value="">No modpacks yet</option>';
  targetSelect.disabled = records.length === 0;
  if (target) targetSelect.value = target.id;

  if (!target) {
    targetMark.textContent = '+';
    targetMeta.textContent = 'Create a modpack to start adding content.';
    targetStats.innerHTML = '';
    openButton.disabled = true;
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = 'Delete pack';
    }
    searchInput.disabled = true;
    count.textContent = '—';
  } else {
    const installed = state.installed.has(target.id);
    targetMark.textContent = loaderMark(target.loader);
    targetMeta.textContent = `Minecraft ${target.gameVersion} · ${loaderLabel(target.loader)} ${target.loaderVersion} · ${installed ? 'Installed' : 'Downloads on first launch'}`;
    const counts = { mod: 0, resourcepack: 0, shader: 0 };
    state.content.forEach((entry) => {
      if (Object.prototype.hasOwnProperty.call(counts, entry.projectType)) counts[entry.projectType] += 1;
    });
    targetStats.innerHTML = `
      <span class="content-stat"><strong>${counts.mod}</strong> mods</span>
      <span class="content-stat"><strong>${counts.resourcepack}</strong> packs</span>
      <span class="content-stat"><strong>${counts.shader}</strong> shaders</span>
    `;
    openButton.disabled = false;
    if (deleteButton) {
      deleteButton.disabled = Boolean(state.importingModpack || state.modpackCreating);
      deleteButton.textContent = state.confirmDeletePack === target.id ? 'Confirm delete' : 'Delete pack';
      deleteButton.classList.toggle('confirm', state.confirmDeletePack === target.id);
    }
    searchInput.disabled = false;
    count.textContent = state.modrinthLoading && !state.modrinthResults.length
      ? 'Loading…'
      : state.modrinthError
        ? 'Offline'
        : state.modrinthLoaded
          ? `${state.modrinthTotal.toLocaleString()} result${state.modrinthTotal === 1 ? '' : 's'}`
          : '—';
  }

  setText('#installedContentCount', String(state.content.length));
  $$('#contentTabs [data-content-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.contentTab === state.contentTab);
  });
  const placeholders = {
    mod: `Search ${target ? loaderLabel(target.loader) : ''} mods…`,
    resourcepack: 'Search resource packs…',
    shader: 'Search shaders…',
  };
  searchInput.placeholder = placeholders[state.contentTab] || 'Search Modrinth…';
  if (document.activeElement !== searchInput && searchInput.value !== state.modrinthQuery) {
    searchInput.value = state.modrinthQuery;
  }

  renderInstalledContent(target);
  renderModrinthResults(target);
  renderEssentials(target);
  renderRenderDistances(target);
}

function renderEssentials(target) {
  const card = $('#essentialsCard');
  if (!card) return;
  if (!target) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const status = state.essentialsLoadedFor === target.id ? state.essentials : null;
  const enabled = status ? Boolean(status.enabled) : Boolean(target.essentialsEnabled);
  const items = status && Array.isArray(status.items) ? status.items : [];
  const installed = items.filter((item) => item.installed).length;
  const toggle = $('#essentialsToggle');
  if (toggle) {
    toggle.checked = enabled;
    toggle.disabled = Boolean(state.essentialsBusy);
  }
  setText('#essentialsToggleLabel', enabled ? 'Enabled for this pack' : 'Off for this pack');
  setText('#essentialsBadge', enabled ? 'Recommended' : 'Off');

  const apply = $('#essentialsApply');
  if (apply) {
    apply.hidden = !enabled || !items.length || installed >= items.length || state.essentialsBusy;
    apply.disabled = Boolean(state.essentialsBusy);
    apply.textContent = state.essentialsBusy ? 'Installing…' : 'Install now';
  }

  const featureList = $('#essentialsFeatures');
  if (featureList) {
    featureList.innerHTML = items.length
      ? items
          .map(
            (item) =>
              `<span class="essentials-feature ${item.installed ? 'is-on' : ''}" title="${esc(item.description)}">${esc(item.title)}${item.custom ? ' <span class="essentials-custom">Custom</span>' : ''}</span>`,
          )
          .join('')
      : '<span class="essentials-feature">Checking compatible extras…</span>';
  }

  if (state.essentialsBusy) {
    setText('#essentialsNote', state.essentialsNote || 'Working on Essentials…');
  } else if (!status) {
    setText('#essentialsNote', 'Checking which extras are installed…');
  } else if (!items.length) {
    setText('#essentialsNote', 'No Essentials items are available for this pack yet.');
  } else if (!enabled) {
    setText('#essentialsNote', 'Off for this pack. Turn it on to install compatible extras; turning it off removes Essentials-managed files, while shared libraries stay installed.');
  } else if (installed >= items.length) {
    setText('#essentialsNote', `${installed} of ${items.length} extras installed and ready.`);
  } else {
    setText('#essentialsNote', `${installed} of ${items.length} extras installed. Install now, or they will be added on the next launch.`);
  }
}

function renderRenderDistances(target) {
  const card = $('#renderCard');
  if (!card) return;
  if (!target) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const status = state.renderLoadedFor === target.id ? state.render : null;
  const supported = status ? Boolean(status.supported) : target.loader === 'fabric';
  const distances = (status && status.distances) || target.renderDistances || {};

  RENDER_DISTANCE_FIELDS.forEach((field) => {
    const input = $(field.selector);
    if (!input) return;
    input.disabled = state.renderBusy || !supported;
    if (document.activeElement !== input) {
      const value = distances[field.key];
      input.value = Number.isInteger(value) && value >= 0 ? String(value) : '';
    }
  });

  const active = status
    ? Boolean(status.active)
    : RENDER_DISTANCE_FIELDS.some((field) => Number(distances[field.key]) >= 0);
  const helper = Boolean(status && status.helperInstalled);
  setText(
    '#renderSupportBadge',
    supported ? (helper ? 'Applied' : 'Fabric helper') : 'Fabric only',
  );

  const apply = $('#renderApply');
  if (apply) {
    apply.disabled = state.renderBusy || !supported;
    apply.textContent = state.renderBusy ? 'Applying…' : 'Save & apply';
  }
  const reset = $('#renderReset');
  if (reset) {
    reset.disabled = state.renderBusy || !supported || !active;
  }

  if (state.renderBusy) {
    setText('#renderNote', state.renderNote || 'Applying render distances…');
  } else if (!supported) {
    setText(
      '#renderNote',
      (status && status.reason) || 'Per-entity distances currently require a Fabric modpack.',
    );
  } else if (!status) {
    setText('#renderNote', 'Choose a distance for each entity type. Blank fields use the vanilla default.');
  } else if (!active) {
    setText('#renderNote', 'Using vanilla defaults. Applying a distance installs Entity View Distance in this pack.');
  } else if (!helper) {
    setText('#renderNote', 'Settings are saved, but Entity View Distance is missing. Apply again to reinstall the helper.');
  } else {
    setText('#renderNote', 'Applied to this pack. Values are client-side limits; a server can still hide entities sooner.');
  }
}

function readRenderDistances() {
  const distances = {};
  RENDER_DISTANCE_FIELDS.forEach((field) => {
    const input = $(field.selector);
    const raw = input ? input.value.trim() : '';
    if (!raw) {
      distances[field.key] = -1;
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 512) {
      throw new Error(`${field.label} must be 0–512 blocks, or blank for the game default.`);
    }
    distances[field.key] = value;
  });
  return distances;
}

async function applyRenderDistances(override = null) {
  const target = ensureContentTarget();
  if (!target || state.renderBusy) return;
  let distances = override;
  if (!distances) {
    try {
      distances = readRenderDistances();
    } catch (error) {
      toast(cleanError(error), 'warn', 7000);
      return;
    }
  }

  state.renderBusy = true;
  state.renderNote = 'Writing this pack’s render settings…';
  renderModrinth();
  try {
    const result = await api.content.renderApply({ versionId: target.id, distances });
    if (state.contentTarget !== target.id) return;
    const status = result && result.status ? result.status : null;
    if (status) {
      state.render = status;
      state.renderLoadedFor = target.id;
    }
    const row = state.modpacks.get(target.id);
    if (row && status && status.distances) row.renderDistances = status.distances;
    state.contentLoadedFor = '';
    await loadContentList();
    if (status && status.active) {
      toast(
        result && result.installed
          ? 'Entity View Distance installed and render distances applied.'
          : 'Render distances applied.',
        'success',
        5000,
      );
    } else {
      toast('Render distances reset to vanilla defaults.', 'success', 5000);
    }
  } catch (error) {
    toast(cleanError(error), 'error', 9000);
  } finally {
    state.renderBusy = false;
    state.renderNote = '';
    renderModrinth();
  }
}

function resetRenderDistances() {
  applyRenderDistances({ itemFrames: -1, players: -1, droppedItems: -1, armorStands: -1 });
}

async function setEssentialsEnabled(enabled) {
  const target = ensureContentTarget();
  if (!target || state.essentialsBusy) return;
  const row = state.modpacks.get(target.id);
  if (row) row.essentialsEnabled = enabled;
  if (state.essentials && state.essentialsLoadedFor === target.id) {
    state.essentials.enabled = enabled;
  }
  state.essentialsBusy = true;
  state.essentialsNote = enabled ? 'Installing compatible extras…' : 'Removing Essentials…';
  renderModrinth();
  try {
    const result = enabled
      ? await api.content.essentialsInstall(target.id)
      : await api.content.essentialsRemove(target.id);
    if (state.contentTarget !== target.id) return;
    const updated = state.modpacks.get(target.id);
    if (updated) updated.essentialsEnabled = Boolean(result.status ? result.status.enabled : enabled);
    state.essentials = result.status || null;
    state.essentialsLoadedFor = target.id;
    state.contentLoadedFor = '';
    await loadContentList();
    if (enabled) {
      const report = Array.isArray(result.report) ? result.report : [];
      const skipped = report.filter((entry) => entry.status === 'skipped');
      toast(
        skipped.length
          ? `Essentials installed; ${skipped.length} item${skipped.length === 1 ? '' : 's'} unavailable for this version.`
          : 'Essentials installed for this pack.',
        skipped.length ? 'warn' : 'success',
        6000,
      );
    } else {
      toast('Essentials removed from this pack.', 'success');
    }
  } catch (error) {
    toast(cleanError(error), 'error', 8000);
    state.essentials = null;
    state.essentialsLoadedFor = '';
    state.contentLoadedFor = '';
    await loadContentList();
  } finally {
    state.essentialsBusy = false;
    state.essentialsNote = '';
    renderModrinth();
  }
}

function renderInstalledContent(target) {
  const container = $('#installedContentList');
  if (!container) return;

  if (!target) {
    container.innerHTML = '<div class="content-empty">Create a modpack, then add your first mod.</div>';
    return;
  }
  if (state.contentLoading && state.contentLoadedFor !== target.id) {
    container.innerHTML = '<div class="content-empty">Checking this pack…</div>';
    return;
  }
  if (!state.content.length) {
    container.innerHTML = '<div class="content-empty">Nothing installed yet. Pick a mod, resource pack, or shader from Modrinth.</div>';
    return;
  }

  const labels = { mod: 'Mod', resourcepack: 'Resource pack', shader: 'Shader' };
  const items = [...state.content].sort((a, b) =>
    String(b.installedAt || '').localeCompare(String(a.installedAt || '')),
  );
  container.innerHTML = items
    .map((entry) => {
      const confirming = state.confirmContentId === entry.id;
      const removing = state.removingContentId === entry.id;
      const managed = entry.bundle === 'essentials';
      return `
        <div class="installed-item" data-content-id="${esc(entry.id)}">
          <span class="content-kind kind-${esc(entry.projectType)}" aria-hidden="true">${entry.projectType === 'mod' ? 'M' : entry.projectType === 'shader' ? 'S' : 'R'}</span>
          <span class="installed-copy">
            <strong>${esc(entry.projectTitle)}</strong>
            <span>${esc(labels[entry.projectType] || 'Content')} · ${esc(entry.versionNumber || 'installed')}${managed ? ' · Essentials' : ''}${entry.exists === false ? ' · missing' : ''}</span>
          </span>
          ${managed ? '<span class="content-managed" title="Managed by Eclipse Essentials">Auto</span>' : `<button class="content-remove ${confirming ? 'confirm' : ''}" type="button" data-remove-content="${esc(entry.id)}" ${removing ? 'disabled' : ''} title="${confirming ? 'Click again to remove' : 'Remove from modpack'}">${removing ? '…' : confirming ? 'Remove?' : '×'}</button>`}
        </div>
      `;
    })
    .join('');
}

function renderModrinthResults(target) {
  const container = $('#modrinthResults');
  const footer = $('#modrinthFooter');
  if (!container) return;

  if (!target) {
    footer.hidden = true;
    container.innerHTML = `
      <div class="content-state content-state-wide">
        <strong>Build your first modpack</strong>
        <p>Modrinth content lives in an isolated Fabric, Forge, or NeoForge modpack. Create or import one, then search for mods, resource packs, and shaders.</p>
        <button class="btn btn-primary btn-sm" type="button" data-create-modpack>Create modpack</button>
      </div>
    `;
    return;
  }

  if (state.modrinthLoading && !state.modrinthResults.length) {
    footer.hidden = true;
    container.innerHTML = Array.from({ length: 4 }, () => '<div class="mod-card skeleton"></div>').join('');
    return;
  }

  if (state.modrinthError) {
    footer.hidden = true;
    container.innerHTML = `
      <div class="content-state">
        <strong>Modrinth is unreachable</strong>
        <p>${esc(state.modrinthError)}</p>
        <button class="btn btn-quiet btn-sm" type="button" data-retry-modrinth>Try again</button>
      </div>
    `;
    return;
  }

  if (!state.modrinthResults.length) {
    footer.hidden = true;
    container.innerHTML = `
      <div class="content-state">
        <strong>No results</strong>
        <p>Try a different search or another content type for Minecraft ${esc(target.gameVersion)}.</p>
      </div>
    `;
    return;
  }

  const installedProjects = new Set(state.content.map((entry) => entry.projectId));
  container.innerHTML = state.modrinthResults
    .map((project) => {
      const installed = installedProjects.has(project.id);
      const adding = state.installingContentId === project.id;
      const tags = (project.categories || [])
        .filter((category) => !['fabric', 'quilt', 'neoforge', 'forge', 'minecraft'].includes(category))
        .slice(0, 3);
      const icon = project.iconUrl
        ? `<img src="${esc(project.iconUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        : `<span>${esc((project.title || '?').slice(0, 1).toUpperCase())}</span>`;
      const action = installed
        ? '<span class="state-pill installed">Installed</span>'
        : `<button class="content-add" type="button" data-install-project="${esc(project.id)}" data-project-type="${esc(project.projectType)}" ${adding || state.installingContentId ? 'disabled' : ''}>${adding ? 'Adding…' : 'Add'}</button>`;
      return `
        <article class="mod-card">
          <div class="mod-card-head">
            <span class="mod-icon">${icon}</span>
            <span class="mod-title">
              <strong>${esc(project.title)}</strong>
              <span>by ${esc(project.author || 'Unknown author')}</span>
            </span>
            <span class="mod-downloads" title="Downloads">↓ ${formatCount(project.downloads)}</span>
          </div>
          <p class="mod-desc">${esc(project.description)}</p>
          <div class="mod-foot">
            <span class="mod-tags">${tags.map((tag) => `<span class="mod-tag">${esc(tag.replace(/-/g, ' '))}</span>`).join('')}</span>
            ${action}
          </div>
        </article>
      `;
    })
    .join('');

  const hasMore = state.modrinthResults.length < state.modrinthTotal;
  footer.hidden = !hasMore;
  footer.innerHTML = hasMore
    ? `<button class="btn btn-quiet btn-sm" type="button" data-load-more ${state.modrinthLoadingMore ? 'disabled' : ''}>${state.modrinthLoadingMore ? 'Loading…' : `Load more (${state.modrinthResults.length} of ${state.modrinthTotal.toLocaleString()})`}</button>`
    : '';
}

async function loadContentList() {
  const target = ensureContentTarget();
  if (!target) {
    state.content = [];
    state.contentLoadedFor = '';
    state.contentLoading = false;
    state.essentials = null;
    state.essentialsLoadedFor = '';
    state.render = null;
    state.renderLoadedFor = '';
    renderModrinth();
    return;
  }
  if (state.contentLoadedFor === target.id) {
    renderModrinth();
    return;
  }

  const token = (contentRequestToken += 1);
  state.contentLoading = true;
  renderModrinth();
  try {
    const content = await api.content.list(target.id);
    if (token !== contentRequestToken || state.contentTarget !== target.id) return;
    state.content = Array.isArray(content) ? content : [];
    state.contentLoadedFor = target.id;
    try {
      const status = await api.content.essentialsStatus(target.id);
      if (token !== contentRequestToken || state.contentTarget !== target.id) return;
      state.essentials = status && typeof status === 'object' ? status : null;
      state.essentialsLoadedFor = target.id;
    } catch (statusError) {
      if (token === contentRequestToken && state.contentTarget === target.id) {
        state.essentials = null;
        state.essentialsLoadedFor = '';
      }
    }
    try {
      const render = await api.content.renderStatus(target.id);
      if (token !== contentRequestToken || state.contentTarget !== target.id) return;
      state.render = render && typeof render === 'object' ? render : null;
      state.renderLoadedFor = target.id;
    } catch (renderStatusError) {
      if (token === contentRequestToken && state.contentTarget === target.id) {
        state.render = null;
        state.renderLoadedFor = '';
      }
    }
  } catch (error) {
    if (token === contentRequestToken) {
      state.content = [];
      state.contentLoadedFor = '';
      state.essentials = null;
      state.essentialsLoadedFor = '';
      state.render = null;
      state.renderLoadedFor = '';
      toast(cleanError(error), 'error');
    }
  } finally {
    if (token === contentRequestToken) {
      state.contentLoading = false;
      renderModrinth();
    }
  }
}

async function searchModrinth(append) {
  const target = ensureContentTarget();
  if (!target) {
    renderModrinth();
    return;
  }
  if (state.modrinthLoading || state.modrinthLoadingMore) return;

  const token = (modrinthRequestToken += 1);
  const offset = append ? state.modrinthResults.length : 0;
  state.modrinthLoading = !append;
  state.modrinthLoadingMore = append;
  state.modrinthError = '';
  if (!append) state.modrinthLoaded = false;
  renderModrinth();

  try {
    const result = await api.content.search({
      targetVersion: target.id,
      projectType: state.contentTab,
      query: state.modrinthQuery,
      offset,
    });
    if (token !== modrinthRequestToken || state.contentTarget !== target.id) return;
    const hits = Array.isArray(result.hits) ? result.hits : [];
    state.modrinthResults = append ? [...state.modrinthResults, ...hits] : hits;
    state.modrinthTotal = Number(result.totalHits) || state.modrinthResults.length;
    state.modrinthLoaded = true;
  } catch (error) {
    if (token === modrinthRequestToken) {
      state.modrinthError = cleanError(error);
      state.modrinthLoaded = true;
      if (append) state.modrinthLoadingMore = false;
    }
  } finally {
    if (token === modrinthRequestToken) {
      state.modrinthLoading = false;
      state.modrinthLoadingMore = false;
      renderModrinth();
    }
  }
}

function handleContentTabClick(event) {
  const button = event.target.closest('[data-content-tab]');
  if (!button || button.dataset.contentTab === state.contentTab) return;
  state.contentTab = button.dataset.contentTab;
  state.modrinthResults = [];
  state.modrinthTotal = 0;
  state.modrinthError = '';
  state.modrinthLoaded = false;
  state.modrinthLoading = false;
  state.modrinthLoadingMore = false;
  modrinthRequestToken += 1;
  renderModrinth();
  if (ensureContentTarget()) searchModrinth(false);
}

function handleContentTargetChange(event) {
  const id = event.target.value;
  if (!state.modpacks.has(id)) return;
  state.contentTarget = id;
  state.content = [];
  state.contentLoadedFor = '';
  state.contentLoading = false;
  state.essentials = null;
  state.essentialsLoadedFor = '';
  state.render = null;
  state.renderLoadedFor = '';
  state.modrinthResults = [];
  state.modrinthTotal = 0;
  state.modrinthError = '';
  state.modrinthLoaded = false;
  state.modrinthLoading = false;
  state.modrinthLoadingMore = false;
  state.installingContentId = '';
  state.confirmContentId = '';
  modrinthRequestToken += 1;
  contentRequestToken += 1;
  renderModrinth();
  loadContentList();
  searchModrinth(false);
}

async function installModrinthProject(button) {
  const projectId = button.dataset.installProject;
  const projectType = button.dataset.projectType;
  const project = state.modrinthResults.find((entry) => entry.id === projectId);
  const target = ensureContentTarget();
  if (!project || !target || state.installingContentId) return;

  const targetId = target.id;
  state.installingContentId = projectId;
  state.confirmContentId = '';
  renderModrinth();
  try {
    const result = await api.content.install({
      targetVersion: targetId,
      projectId,
      projectType,
    });
    if (state.contentTarget !== targetId) return;
    state.content = Array.isArray(result.content) ? result.content : [];
    state.contentLoadedFor = targetId;
    try {
      const status = await api.content.essentialsStatus(targetId);
      if (state.contentTarget === targetId) {
        state.essentials = status || null;
        state.essentialsLoadedFor = targetId;
      }
    } catch (_) {
      // The Essentials card is optional; content installation still succeeded.
    }
    const added = Array.isArray(result.added) ? result.added : [];
    const main = added.find((entry) => !entry.dependency) || added[0];
    const dependencyCount = added.filter((entry) => entry.dependency).length;
    if (main) {
      toast(
        `${main.projectTitle} added to ${target.name}${dependencyCount ? ` with ${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}` : ''}.`,
        'success',
        5400,
      );
    } else {
      toast(`${project.title} is already in ${target.name}.`, 'info');
    }
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      toast(warnings.slice(0, 2).join(' '), 'warn', 7000);
    }
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
  } finally {
    if (state.installingContentId === projectId) state.installingContentId = '';
    renderModrinth();
  }
}

function handleModrinthResultsClick(event) {
  if (event.target.closest('[data-create-modpack]')) {
    openModpackModal();
    return;
  }
  if (event.target.closest('[data-retry-modrinth]')) {
    searchModrinth(false);
    return;
  }
  const button = event.target.closest('[data-install-project]');
  if (button) installModrinthProject(button);
}

function handleInstalledContentClick(event) {
  const button = event.target.closest('[data-remove-content]');
  if (!button || state.removingContentId) return;
  const id = button.dataset.removeContent;
  if (state.confirmContentId !== id) {
    state.confirmContentId = id;
    clearTimeout(confirmContentTimer);
    confirmContentTimer = setTimeout(() => {
      state.confirmContentId = '';
      renderInstalledContent(ensureContentTarget());
    }, 3000);
    renderInstalledContent(ensureContentTarget());
    return;
  }

  clearTimeout(confirmContentTimer);
  state.confirmContentId = '';
  const target = ensureContentTarget();
  if (!target) return;
  state.removingContentId = id;
  renderInstalledContent(target);
  api.content
    .remove({ targetVersion: target.id, entryId: id })
    .then((result) => {
      if (state.contentTarget !== target.id) return;
      state.content = Array.isArray(result.content) ? result.content : [];
      state.contentLoadedFor = target.id;
      toast('Content removed.', 'success');
    })
    .catch((error) => toast(cleanError(error), 'error'))
    .finally(() => {
      state.removingContentId = '';
      renderModrinth();
    });
}

async function openContentFolder() {
  const target = ensureContentTarget();
  if (!target) return;
  try {
    await api.openPath(target.gameDir);
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

function updateModpackBusyUi() {
  const busy = Boolean(state.importingModpack || state.modpackCreating);
  const progress = state.modpackProgress;
  const percent = progress && Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : null;
  $$('[data-import-mrpack]').forEach((button) => {
    button.disabled = busy;
    button.textContent = state.importingModpack
      ? (percent !== null ? `Importing ${percent}%` : 'Importing…')
      : 'Import .mrpack';
  });
}

async function importMrpack() {
  if (state.importingModpack || state.modpackCreating || state.installing || state.launching) {
    toast('Wait for the current operation to finish before importing a pack.', 'warn');
    return;
  }
  if (state.game) {
    toast('Close Minecraft before importing a modpack.', 'warn');
    return;
  }

  state.importingModpack = true;
  state.modpackProgress = { phase: 'dialog', label: 'Choose a .mrpack file…', percent: 0, indeterminate: true };
  updateModpackBusyUi();
  renderStatus();
  let imported = false;
  try {
    const result = await api.modpacks.import();
    if (!result || result.canceled) return;
    imported = true;
    setModpacks(result.modpacks);
    const instance = result.instance;
    state.contentTarget = instance.id;
    state.content = [];
    state.contentLoadedFor = '';
    state.modrinthResults = [];
    state.modrinthTotal = 0;
    state.modrinthLoaded = false;
    state.modrinthQuery = '';
    state.contentTab = 'mod';
    await selectVersion(instance.id);
    navigate('modrinth');
    toast(
      `${instance.name} imported with ${loaderLabel(instance.loader)} ${instance.loaderVersion}${result.importedFiles ? ` and ${result.importedFiles} files` : ''}.`,
      'success',
      6200,
    );
  } catch (error) {
    toast(cleanError(error), 'error', 8000);
  } finally {
    state.importingModpack = false;
    state.modpackProgress = null;
    updateModpackBusyUi();
    renderPlay();
    renderVersions();
    renderStatus();
    if (imported) renderModrinth();
  }
}

async function deleteCurrentPack() {
  const target = ensureContentTarget();
  if (!target) return;
  if (state.importingModpack || state.modpackCreating || state.installing || state.launching) {
    toast('Wait for the current operation to finish.', 'warn');
    return;
  }
  if (state.game) {
    toast('Close Minecraft before deleting a modpack.', 'warn');
    return;
  }

  if (state.confirmDeletePack !== target.id) {
    state.confirmDeletePack = target.id;
    clearTimeout(confirmDeleteTimer);
    confirmDeleteTimer = setTimeout(() => {
      state.confirmDeletePack = '';
      renderModrinth();
    }, 3500);
    renderModrinth();
    return;
  }

  clearTimeout(confirmDeleteTimer);
  state.confirmDeletePack = '';
  const targetId = target.id;
  try {
    const result = await api.modpacks.remove(targetId);
    setModpacks(result.modpacks);
    if (state.settings.selectedVersion === targetId) {
      state.settings.selectedVersion = result.selectedVersion || '';
    }
    state.contentTarget = '';
    state.content = [];
    state.contentLoadedFor = '';
    state.modrinthResults = [];
    state.modrinthTotal = 0;
    state.modrinthLoaded = false;
    ensureContentTarget();
    renderAll();
    if (state.page === 'modrinth') navigate('modrinth');
    toast(`${target.name} deleted.`, 'success');
  } catch (error) {
    toast(cleanError(error), 'error', 7000);
    renderModrinth();
  }
}

function handleModpackProgress(progress) {
  if (!progress) return;
  state.modpackProgress = progress;
  if (state.modpackModalOpen) renderModpackModalState();
  updateModpackBusyUi();
  renderStatus();
}

function renderModpackGameVersions() {
  const select = $('#modpackGameVersion');
  if (!select) return;
  const releases = state.manifest && Array.isArray(state.manifest.versions)
    ? state.manifest.versions.filter((entry) => entry.type === 'release')
    : [];
  const current = select.value;
  select.innerHTML = releases.length
    ? releases.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.id)}</option>`).join('')
    : '<option value="">Version list unavailable</option>';
  select.disabled = releases.length === 0;
  const preferred = releases.some((entry) => entry.id === current)
    ? current
    : releases[0]?.id || '';
  if (preferred) select.value = preferred;
}

function renderModpackModalState() {
  const errorElement = $('#modpackError');
  if (!errorElement) return;
  if (state.modpackError) {
    errorElement.hidden = false;
    errorElement.textContent = state.modpackError;
  } else {
    errorElement.hidden = true;
    errorElement.textContent = '';
  }

  const submit = $('#createModpackSubmit');
  if (submit) {
    submit.disabled = state.modpackCreating || state.loaderLoading || !state.loaderVersions.length;
    submit.textContent = state.modpackCreating
      ? (state.modpackProgress && state.modpackProgress.label ? state.modpackProgress.label : `Creating ${loaderLabel(state.modpackLoader)} pack…`)
      : 'Create modpack';
  }
  const close = $('#closeModpackModal');
  if (close) close.disabled = state.modpackCreating;
  const cancel = $('#cancelModpack');
  if (cancel) cancel.disabled = state.modpackCreating;
}

function openModpackModal() {
  if (state.modpackModalOpen) return;
  state.modpackModalOpen = true;
  state.modpackError = '';
  state.modpackCreating = false;
  state.modpackProgress = null;
  state.loaderVersions = [];
  state.loaderLoading = false;
  renderModpackGameVersions();
  const name = $('#modpackName');
  if (name) name.value = '';
  const loaderSelect = $('#modpackLoader');
  if (loaderSelect) loaderSelect.value = state.modpackLoader;
  const loaderVersionSelect = $('#modpackLoaderVersion');
  if (loaderVersionSelect) {
    loaderVersionSelect.innerHTML = `<option>Checking ${loaderLabel(state.modpackLoader)}…</option>`;
    loaderVersionSelect.disabled = true;
  }
  const note = $('#modpackLoaderNote');
  if (note) note.textContent = `Loader versions come directly from ${loaderLabel(state.modpackLoader)}.`;
  $('#modpackModal').classList.add('open');
  $('#modpackModal').setAttribute('aria-hidden', 'false');
  renderModpackModalState();
  loadModpackLoaderVersions();
  setTimeout(() => name?.focus(), 60);
}

function closeModpackModal() {
  if (state.modpackCreating) return;
  state.modpackModalOpen = false;
  state.modpackError = '';
  $('#modpackModal').classList.remove('open');
  $('#modpackModal').setAttribute('aria-hidden', 'true');
}

async function loadModpackLoaderVersions() {
  if (!state.modpackModalOpen) return;
  const select = $('#modpackLoaderVersion');
  const note = $('#modpackLoaderNote');
  const loaderSelect = $('#modpackLoader');
  const loader = (loaderSelect && loaderSelect.value) || state.modpackLoader || 'fabric';
  state.modpackLoader = loader;
  const label = loaderLabel(loader);
  const gameVersion = $('#modpackGameVersion').value;
  const token = (loaderRequestToken += 1);
  state.loaderVersions = [];
  state.loaderLoading = true;
  state.modpackError = '';
  if (select) {
    select.disabled = true;
    select.innerHTML = `<option>Checking ${esc(label)}…</option>`;
  }
  if (note) {
    note.textContent = gameVersion
      ? `Looking up ${label} for Minecraft ${gameVersion}…`
      : 'Choose a Minecraft version first.';
  }
  renderModpackModalState();

  if (!gameVersion) {
    state.loaderLoading = false;
    renderModpackModalState();
    return;
  }

  try {
    const versions = await api.modpacks.loaderVersions(loader, gameVersion);
    if (token !== loaderRequestToken) return;
    const usable = (Array.isArray(versions) ? versions : []).filter(
      (entry) => entry && entry.version,
    );
    state.loaderVersions = usable.slice().sort(
      (left, right) => Number(Boolean(right.stable)) - Number(Boolean(left.stable)),
    );
    if (select) {
      select.innerHTML = state.loaderVersions.length
        ? state.loaderVersions
            .map(
              (entry) =>
                `<option value="${esc(entry.version)}">${esc(entry.version)}${entry.recommended ? ' · recommended' : entry.stable ? ' · stable' : ' · unstable'}</option>`,
            )
            .join('')
        : `<option value="">No ${esc(label)} loader available</option>`;
      select.disabled = state.loaderVersions.length === 0;
    }
    if (note) {
      note.textContent = state.loaderVersions.length
        ? `${state.loaderVersions.length} ${label} loader version${state.loaderVersions.length === 1 ? '' : 's'} available for Minecraft ${gameVersion}.`
        : `${label} does not publish a loader for Minecraft ${gameVersion}.`;
    }
  } catch (error) {
    if (token !== loaderRequestToken) return;
    if (select) {
      select.innerHTML = `<option value="">${esc(label)} unavailable</option>`;
      select.disabled = true;
    }
    if (note) note.textContent = `Could not load ${label} loader versions.`;
    state.modpackError = cleanError(error);
  } finally {
    if (token === loaderRequestToken) {
      state.loaderLoading = false;
      renderModpackModalState();
    }
  }
}

async function handleCreateModpack(event) {
  event.preventDefault();
  if (state.modpackCreating) return;
  const name = $('#modpackName').value.trim();
  const gameVersion = $('#modpackGameVersion').value;
  const loader = $('#modpackLoader').value || state.modpackLoader;
  const loaderVersion = $('#modpackLoaderVersion').value;
  state.modpackError = '';
  if (name.length < 2 || name.length > 48) {
    state.modpackError = 'Give the modpack a name between 2 and 48 characters.';
    renderModpackModalState();
    return;
  }
  if (!gameVersion || !loaderVersion) {
    state.modpackError = `Choose a Minecraft version and ${loaderLabel(loader)} loader.`;
    renderModpackModalState();
    return;
  }

  state.modpackCreating = true;
  state.modpackProgress = {
    phase: 'metadata',
    label: `Creating ${loaderLabel(loader)} pack…`,
    percent: 0,
    indeterminate: true,
  };
  updateModpackBusyUi();
  renderModpackModalState();
  renderStatus();
  try {
    const result = await api.modpacks.create({ name, gameVersion, loader, loaderVersion });
    setModpacks(result.modpacks);
    const instance = result.instance;
    state.contentTarget = instance.id;
    state.content = [];
    state.contentLoadedFor = '';
    state.modrinthResults = [];
    state.modrinthTotal = 0;
    state.modrinthLoaded = false;
    state.modrinthQuery = '';
    state.loaderLoading = false;
    state.modpackCreating = false;
    state.modpackProgress = null;
    closeModpackModal();
    renderVersions();
    renderPlay();
    renderModrinth();
    await selectVersion(instance.id);
    navigate('modrinth');
    toast(`${instance.name} created with ${loaderLabel(instance.loader)} ${instance.loaderVersion}.`, 'success', 5200);
  } catch (error) {
    state.modpackError = cleanError(error);
    state.modpackProgress = null;
    renderModpackModalState();
  } finally {
    state.modpackCreating = false;
    updateModpackBusyUi();
    renderModpackModalState();
    renderStatus();
  }
}

/* ------------------------------------------------------------------ */
/* Installation and game state events                                 */
/* ------------------------------------------------------------------ */

function handleInstallProgress(progress) {
  if (!progress) return;

  if (progress.stage === 'complete') {
    state.installing = null;
    updateProgressPanel({
      ...progress,
      label: 'Install complete',
      percent: 100,
      indeterminate: false,
    });
    renderPlay();
    renderVersions();
    renderStatus();
    return;
  }

  const previousStage = state.installing ? state.installing.stage : null;
  state.installing = progress;
  updateProgressPanel(progress);
  renderStatus();
  if (previousStage !== progress.stage) {
    renderPlay();
    renderVersions();
  }
}

function handleGameState(game) {
  if (!game || game.status === 'idle') {
    state.game = null;
    state.launching = false;
    updateProgressPanel(null);
    renderPlay();
    renderModpacksPage();
    renderStatus();
    return;
  }

  if (game.status === 'starting' || game.status === 'running') {
    const wasRunning = Boolean(state.game && state.game.status === 'running');
    state.game = game;
    state.installing = null;
    state.launching = false;
    openConsole(true);
    updateProgressPanel(null);
    renderPlay();
    renderVersions();
    renderModpacksPage();
    renderStatus();
    setConsoleStage(game.status === 'running' ? `Minecraft ${game.versionId} running` : 'Starting Minecraft');
    if (game.status === 'running' && !wasRunning) {
      toast(`Minecraft ${game.versionId} is running.`, 'success', 3000);
    }
    return;
  }

  if (game.status === 'exited') {
    const versionId = game.versionId || (state.game && state.game.versionId);
    state.game = null;
    state.launching = false;
    state.stopping = false;
    updateProgressPanel(null);
    renderPlay();
    renderVersions();
    renderModpacksPage();
    renderStatus();
    setConsoleStage(game.stopped ? 'Minecraft stopped' : 'Minecraft closed');
    if (game.stopped) {
      toast(`Minecraft ${versionId || ''} stopped.`.replace('  ', ' '), 'info', 3000);
    } else if (game.code === 0) {
      toast(`Minecraft ${versionId || ''} closed.`.replace('  ', ' '), 'info', 3000);
    } else {
      toast(`Minecraft exited with code ${game.code}. Check the console for details.`, 'error', 7000);
      openConsole(true);
    }
    return;
  }

  if (game.status === 'error') {
    state.game = null;
    state.launching = false;
    state.stopping = false;
    updateProgressPanel(null);
    renderPlay();
    renderVersions();
    renderModpacksPage();
    renderStatus();
    toast(game.error || 'Minecraft could not start.', 'error', 7000);
    openConsole(true);
  }
}

/* ------------------------------------------------------------------ */
/* Console                                                            */
/* ------------------------------------------------------------------ */

function updateConsoleUnread() {
  const button = $('#titleConsoleBtn');
  if (button) button.classList.toggle('has-unread', Boolean(state.unread) && !state.consoleOpen);
}

function openConsole(open) {
  if (state.consoleOpen === Boolean(open)) {
    if (open) scrollConsoleToBottom();
    return;
  }
  state.consoleOpen = Boolean(open);
  const consoleElement = $('#console');
  consoleElement.classList.toggle('open', state.consoleOpen);
  consoleElement.setAttribute('aria-hidden', String(!state.consoleOpen));
  if (state.consoleOpen) {
    state.unread = false;
    requestAnimationFrame(scrollConsoleToBottom);
  }
  updateConsoleUnread();
}

function toggleConsole() {
  openConsole(!state.consoleOpen);
}

function scrollConsoleToBottom() {
  const body = $('#consoleBody');
  if (!body) return;
  body.scrollTop = body.scrollHeight;
  state.scrollLogs = true;
}

function clearConsole() {
  state.logs = [];
  const body = $('#consoleBody');
  body.innerHTML = '<div class="console-empty">Launcher and game output will appear here.</div>';
}

function renderConsole() {
  const body = $('#consoleBody');
  if (!body) return;
  body.innerHTML = '';
  if (!state.logs.length) {
    body.innerHTML = '<div class="console-empty">Launcher and game output will appear here.</div>';
    return;
  }
  state.logs.slice(-600).forEach((entry) => appendLogEntry(entry, false));
  scrollConsoleToBottom();
}

function appendLogEntry(entry, autoScroll = true) {
  const body = $('#consoleBody');
  if (!body) return;
  const empty = body.querySelector('.console-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'console-line';
  if (entry.level === 'error') line.classList.add('error');
  else if (entry.level === 'warn') line.classList.add('warn');
  else if (entry.level === 'debug') line.classList.add('debug');
  if (entry.source === 'game') line.classList.add('game');

  const time = document.createElement('span');
  time.className = 'console-time';
  time.textContent = formatClock(entry.time);

  const source = document.createElement('span');
  source.className = 'console-src';
  source.textContent = entry.source === 'game' ? 'MC' : 'EC';

  const text = document.createElement('span');
  text.className = 'console-text';
  text.textContent = entry.line;

  line.append(time, source, text);
  body.appendChild(line);
  while (body.children.length > 600) body.removeChild(body.firstElementChild);

  if (autoScroll && (state.consoleOpen || state.scrollLogs)) {
    body.scrollTop = body.scrollHeight;
  }
}

function setConsoleStage(text) {
  setText('#consoleStage', text || 'Idle');
}

function updateProgressPanel(progress) {
  const panel = $('#consoleProgress');
  const fill = $('#progressFill');
  const track = $('.progress-track');
  const label = $('#progressLabel');
  const detail = $('#progressDetail');

  if (!progress) {
    panel.hidden = true;
    fill.style.width = '0%';
    track.classList.remove('indeterminate');
    setConsoleStage(state.game ? `Minecraft ${state.game.versionId} running` : 'Idle');
    return;
  }

  panel.hidden = false;
  track.classList.toggle('indeterminate', Boolean(progress.indeterminate));
  fill.style.width = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;

  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  label.textContent = progress.label || 'Working…';

  const pieces = [];
  if (progress.filesTotal) {
    pieces.push(`${progress.filesDone || 0}/${progress.filesTotal} files`);
  }
  if (progress.bytesTotal) {
    pieces.push(`${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`);
  } else if (!progress.indeterminate) {
    pieces.push(`${percent}%`);
  }
  detail.textContent = pieces.join(' · ');
  setConsoleStage(`${progress.label || 'Working'}${progress.indeterminate ? '' : ` · ${percent}%`}`);
  $('#consoleLive').classList.add('active');
}

/* ------------------------------------------------------------------ */
/* Accounts                                                           */
/* ------------------------------------------------------------------ */

function openAccounts() {
  state.accountsOpen = true;
  state.accountError = '';
  $('#accountsModal').classList.add('open');
  $('#accountsModal').setAttribute('aria-hidden', 'false');
  renderAccounts();
}

function closeAccounts() {
  state.accountsOpen = false;
  $('#accountsModal').classList.remove('open');
  $('#accountsModal').setAttribute('aria-hidden', 'true');
}

function renderAccounts() {
  const container = $('#accountList');
  if (!container) return;
  const profiles = state.accounts.profiles || [];
  const activeId = state.accounts.selectedId;

  if (!profiles.length) {
    container.innerHTML =
      '<div class="account-list-empty">No profiles yet. Add an offline profile or sign in with Microsoft.</div>';
  } else {
    container.innerHTML = profiles
      .map((profile) => {
        const active = profile.id === activeId;
        const confirming = state.confirmRemoveId === profile.id;
        return `
          <div class="account-row ${active ? 'active' : ''}" role="button" tabindex="0" data-account-id="${esc(profile.id)}" aria-selected="${active}">
            <span class="avatar avatar-md" data-account-avatar="${esc(profile.id)}">${esc((profile.name || 'P').slice(0, 2).toUpperCase())}</span>
            <span class="account-row-copy">
              <strong>${esc(profile.name)}</strong>
              <span>${esc(accountTypeLabel(profile.type))}</span>
            </span>
            ${active ? '<span class="account-tag">Active</span>' : ''}
            <button class="remove-account ${confirming ? 'confirm' : ''}" type="button" data-remove-account="${esc(profile.id)}" title="${confirming ? 'Click again to remove' : 'Remove profile'}">${confirming ? 'Remove?' : '×'}</button>
          </div>
        `;
      })
      .join('');

    profiles.forEach((profile) => {
      const avatar = container.querySelector(`[data-account-avatar="${CSS.escape(profile.id)}"]`);
      paintAvatar(avatar, profile);
    });
  }

  const errorElement = $('#accountError');
  if (state.accountError) {
    errorElement.hidden = false;
    errorElement.textContent = state.accountError;
  } else {
    errorElement.hidden = true;
    errorElement.textContent = '';
  }

  const microsoftButton = $('#microsoftBtn');
  microsoftButton.disabled = state.signingIn;
  microsoftButton.innerHTML = state.signingIn
    ? '<span class="spinner"></span><span>Waiting for Microsoft…</span>'
    : `<svg class="ms-logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" /><rect x="13" y="3" width="8" height="8" /><rect x="3" y="13" width="8" height="8" /><rect x="13" y="13" width="8" height="8" /></svg><span>Sign in</span>`;

  const addButton = $('#addOfflineBtn');
  addButton.disabled = state.addingOffline;
  addButton.textContent = state.addingOffline ? 'Adding…' : 'Add offline';
  $('#offlineName').disabled = state.addingOffline;
}

function handleAccountListClick(event) {
  const removeButton = event.target.closest('[data-remove-account]');
  if (removeButton) {
    event.stopPropagation();
    confirmRemoveAccount(removeButton.dataset.removeAccount);
    return;
  }
  const row = event.target.closest('[data-account-id]');
  if (row) selectAccount(row.dataset.accountId);
}

function handleAccountListKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('button')) return;
  const row = event.target.closest('[data-account-id]');
  if (!row) return;
  event.preventDefault();
  selectAccount(row.dataset.accountId);
}

async function selectAccount(id) {
  if (id === state.accounts.selectedId) return;
  try {
    const accounts = await api.accounts.select(id);
    state.accounts = accounts;
    renderSidebar();
    renderPlay();
    renderProfileSettings();
    renderAccounts();
  } catch (error) {
    state.accountError = cleanError(error);
    renderAccounts();
  }
}

function confirmRemoveAccount(id) {
  const profile = (state.accounts.profiles || []).find((entry) => entry.id === id);
  if (!profile) return;

  if (state.confirmRemoveId === id) {
    clearTimeout(state.removeTimer);
    state.confirmRemoveId = null;
    removeAccount(id);
    return;
  }

  state.confirmRemoveId = id;
  clearTimeout(state.removeTimer);
  state.removeTimer = setTimeout(() => {
    state.confirmRemoveId = null;
    renderAccounts();
  }, 3000);
  renderAccounts();
}

async function removeAccount(id) {
  try {
    const accounts = await api.accounts.remove(id);
    state.accounts = accounts;
    state.accountError = '';
    toast('Profile removed.', 'success');
    renderSidebar();
    renderPlay();
    renderProfileSettings();
    renderAccounts();
  } catch (error) {
    state.accountError = cleanError(error);
    renderAccounts();
  }
}

async function handleAddOffline(event) {
  event.preventDefault();
  if (state.addingOffline) return;
  const input = $('#offlineName');
  const name = input.value.trim();
  state.accountError = '';

  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    state.accountError = 'Usernames must be 3–16 characters and use only letters, numbers, or underscores.';
    renderAccounts();
    return;
  }

  state.addingOffline = true;
  renderAccounts();
  try {
    const accounts = await api.accounts.addOffline(name);
    state.accounts = accounts;
    input.value = '';
    toast(`Offline profile "${name}" added.`, 'success');
    renderSidebar();
    renderPlay();
    renderProfileSettings();
    renderAccounts();
  } catch (error) {
    state.accountError = cleanError(error);
    renderAccounts();
  } finally {
    state.addingOffline = false;
    renderAccounts();
  }
}

async function signInMicrosoft() {
  if (state.signingIn) return;
  state.signingIn = true;
  state.accountError = '';
  renderAccounts();
  try {
    const result = await api.accounts.signInMicrosoft();
    if (result && result.accounts) state.accounts = result.accounts;
    toast(`Signed in as ${result.account.name}.`, 'success');
    renderSidebar();
    renderPlay();
    renderProfileSettings();
  } catch (error) {
    state.accountError = cleanError(error);
  } finally {
    state.signingIn = false;
    renderAccounts();
  }
}

/* ------------------------------------------------------------------ */
/* Status bar and global rendering                                   */
/* ------------------------------------------------------------------ */

function renderStatus() {
  const dot = $('#statusDot');
  let statusClass = 'ok';
  let text = 'Ready';

  if (state.game && ['starting', 'running'].includes(state.game.status)) {
    statusClass = 'ok';
    text = state.game.status === 'running'
      ? `Minecraft ${state.game.versionId} is running`
      : 'Starting Minecraft…';
  } else if (state.stopping) {
    statusClass = 'busy';
    text = 'Stopping Minecraft…';
  } else if (state.installing) {
    statusClass = 'busy';
    text = `${state.installing.label || 'Installing'} · ${state.installing.percent || 0}%`;
  } else if (state.launching) {
    statusClass = 'busy';
    text = 'Launching Minecraft…';
  } else if (state.importingModpack || state.modpackCreating) {
    statusClass = 'busy';
    const progress = state.modpackProgress;
    const percent = progress && Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : null;
    text = progress && progress.label
      ? `${progress.label}${percent !== null && !progress.indeterminate ? ` · ${percent}%` : ''}`
      : (state.importingModpack ? 'Importing modpack…' : 'Creating modpack…');
  } else if (state.catalogError && !state.manifest) {
    statusClass = 'error';
    text = 'Version list offline';
  }

  dot.className = `status-dot ${statusClass}`;
  setText('#statusText', text);

  const versionId = selectedVersionId();
  const statusModpack = state.modpacks.get(versionId);
  setText(
    '#statusVersion',
    statusModpack
      ? `Modpack ${statusModpack.name}`
      : versionId
        ? `Minecraft ${versionId}`
        : 'No version selected',
  );

  let javaText = 'Java: scanning…';
  if (!state.java.detecting) {
    const java = preferredJava();
    javaText = java ? `Java ${java.major}${state.settings.javaPath ? ' selected' : ''}` : 'Java: not found';
  }
  setText('#statusJava', javaText);

  setText('#appVersion', `v${state.system.appVersion || '1.0.0'}`);
  const live = $('#consoleLive');
  if (live) {
    live.classList.toggle('active', Boolean(state.installing || state.launching || state.stopping));
    live.classList.toggle('game', Boolean(state.game && state.game.status === 'running'));
  }
}

function renderAll() {
  renderSidebar();
  renderPlay();
  renderVersions();
  renderModpacksPage();
  renderModrinth();
  renderSettings();
  renderConsole();
  renderStatus();
  updateConsoleUnread();
  updateModpackBusyUi();
}

function reportRendererError(error) {
  const message = String((error && error.message) || error || 'Unknown renderer error');
  const stack = String((error && error.stack) || '');
  if (api && typeof api.reportError === 'function') {
    api.reportError(message, stack).catch(() => {});
  }
}

window.addEventListener('error', (event) => {
  reportRendererError(event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererError(event.reason);
});

window.__eclipseClient = { state, selectedVersionId, currentProfile };

boot();
