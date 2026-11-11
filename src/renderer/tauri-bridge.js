'use strict';

(function installTauriBridge() {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;
  if (window.eclipseClient) return;

  const EVENT_CHANNELS = new Set([
    'launcher:log',
    'install:progress',
    'catalog:updated',
    'catalog:error',
    'installed:updated',
    'modpacks:updated',
    'modpack:progress',
    'essentials:progress',
    'accounts:updated',
    'java:updated',
    'game:state',
    'window:maximized',
    'update:progress',
  ]);
  const unlisteners = new Map();

  function call(action, payload = null) {
    return tauri.core.invoke('launcher', { action, payload });
  }

  function on(channel, listener) {
    if (!EVENT_CHANNELS.has(channel) || typeof listener !== 'function') {
      return () => {};
    }
    const previous = unlisteners.get(channel);
    if (previous) previous.then((dispose) => dispose()).catch(() => {});
    const ready = tauri.event.listen(channel, (event) => listener(event.payload));
    unlisteners.set(channel, ready);
    return () => {
      ready.then((dispose) => dispose()).catch(() => {});
    };
  }

  window.eclipseClient = {
    init: () => call('app:init'),
    refreshCatalog: () => call('catalog:refresh'),
    installVersion: (versionId) => call('version:install', versionId),
    launch: (versionId) => call('game:launch', versionId),
    stopGame: () => call('game:stop'),
    updateSettings: (patch) => call('settings:update', patch),
    detectJava: () => call('java:detect'),
    modpacks: {
      create: (payload) => call('modpack:create', payload),
      import: () => call('modpack:import'),
      remove: (versionId) => call('modpack:remove', versionId),
      installModrinth: (payload) => call('modpack:install-modrinth', payload),
      rename: (payload) => call('modpack:rename', payload),
      duplicate: (versionId) => call('modpack:duplicate', versionId),
      list: () => call('modpack:list'),
      loaderVersions: (loader, gameVersion) =>
        call('modpack:loader-versions', { loader, gameVersion }),
      fabricVersions: (gameVersion) => call('modpack:fabric-versions', gameVersion),
    },
    content: {
      search: (payload) => call('modrinth:search', payload),
      searchModpacks: (payload) => call('modrinth:search-modpacks', payload),
      list: (versionId) => call('content:list', versionId),
      install: (payload) => call('content:install', payload),
      remove: (payload) => call('content:remove', payload),
      essentialsStatus: (versionId) => call('essentials:status', versionId),
      essentialsInstall: (versionId) => call('essentials:install', versionId),
      essentialsRemove: (versionId) => call('essentials:remove', versionId),
      renderStatus: (versionId) => call('render:status', versionId),
      renderApply: (payload) => call('render:apply', payload),
    },
    chooseFolder: () => call('dialog:choose-folder'),
    chooseJava: () => call('dialog:choose-java'),
    openPath: (target) => call('shell:open-path', target),
    openExternal: (url) => call('shell:open-url', url),
    windowControl: (action) => call('window:control', action),
    reportError: (message, stack) => call('client:error', { message, stack }),
    updates: {
      check: () => call('app:update-check'),
      install: () => call('app:update-install'),
    },
    accounts: {
      addOffline: (name) => call('accounts:add-offline', name),
      renameOffline: (id, name) => call('accounts:rename-offline', { id, name }),
      select: (id) => call('accounts:select', id),
      remove: (id) => call('accounts:remove', id),
      signInMicrosoft: () => call('accounts:sign-in-microsoft'),
      skin: (id) => call('accounts:skin', id),
    },
    on,
  };
})();
