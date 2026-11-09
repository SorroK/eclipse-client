'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = new Set([
  'launcher:log',
  'install:progress',
  'catalog:updated',
  'catalog:error',
  'installed:updated',
  'modpacks:updated',
  'modpack:progress',
  'accounts:updated',
  'java:updated',
  'game:state',
  'window:maximized',
]);

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('eclipseClient', {
  init: () => invoke('app:init'),
  refreshCatalog: () => invoke('catalog:refresh'),
  installVersion: (versionId) => invoke('version:install', versionId),
  launch: (versionId) => invoke('game:launch', versionId),
  stopGame: () => invoke('game:stop'),
  updateSettings: (patch) => invoke('settings:update', patch),
  detectJava: () => invoke('java:detect'),
  modpacks: {
    create: (payload) => invoke('modpack:create', payload),
    import: () => invoke('modpack:import'),
    remove: (versionId) => invoke('modpack:remove', versionId),
    list: () => invoke('modpack:list'),
    loaderVersions: (loader, gameVersion) => invoke('modpack:loader-versions', { loader, gameVersion }),
    fabricVersions: (gameVersion) => invoke('modpack:fabric-versions', gameVersion),
  },
  content: {
    search: (payload) => invoke('modrinth:search', payload),
    list: (versionId) => invoke('content:list', versionId),
    install: (payload) => invoke('content:install', payload),
    remove: (payload) => invoke('content:remove', payload),
  },
  chooseFolder: () => invoke('dialog:choose-folder'),
  chooseJava: () => invoke('dialog:choose-java'),
  openPath: (target) => invoke('shell:open-path', target),
  openExternal: (url) => invoke('shell:open-url', url),
  windowControl: (action) => invoke('window:control', action),
  reportError: (message, stack) => invoke('client:error', { message, stack }),
  accounts: {
    addOffline: (name) => invoke('accounts:add-offline', name),
    renameOffline: (id, name) => invoke('accounts:rename-offline', { id, name }),
    select: (id) => invoke('accounts:select', id),
    remove: (id) => invoke('accounts:remove', id),
    signInMicrosoft: () => invoke('accounts:sign-in-microsoft'),
  },
  on(channel, listener) {
    if (!EVENT_CHANNELS.has(channel) || typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
