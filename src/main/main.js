'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

const { LauncherPaths } = require('../core/paths');
const { fetchManifest, findVersion } = require('../core/manifest');
const { Installer } = require('../core/installer');
const { buildLaunchCommand } = require('../core/launch');
const { detectJavaInstallations, selectJava, probeJava } = require('../core/java');
const {
  validateVersionId,
  pathExists,
  ensureDir,
  runCommand,
  stripAnsi,
  formatBytes,
} = require('../core/utils');
const { JsonStore } = require('./store');
const { AccountManager } = require('./accounts');
const { ModpackManager } = require('./modpacks');
const { searchProjects } = require('../core/modrinth');

const THEMES = new Set(['eclipse', 'aurora', 'ember', 'daylight']);
const THEME_WINDOW_BG = {
  eclipse: '#080b0e',
  aurora: '#080a14',
  ember: '#100a0b',
  daylight: '#f3f5f0',
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
};

const dataRoot = process.env.ECLIPSE_CLIENT_DATA_DIR
  ? path.resolve(process.env.ECLIPSE_CLIENT_DATA_DIR)
  : path.join(app.getPath('appData'), 'Eclipse Client');

try {
  fs.mkdirSync(dataRoot, { recursive: true });
} catch {
  /* surfaced during bootstrap if it matters */
}

app.setName('Eclipse Client');
app.setPath('userData', dataRoot);
app.setAppUserModelId('com.eclipseclient.launcher');

const paths = new LauncherPaths(path.join(dataRoot, 'minecraft'));
const manifestCacheFile = path.join(dataRoot, 'cache', 'version_manifest.json');

let mainWindow = null;
let settingsStore = null;
let settings = { ...DEFAULT_SETTINGS };
let accountManager = null;
let modpackManager = null;
let manifestState = null;
let manifestFetchedAt = 0;
let installedState = [];
let javaState = { detecting: true, installations: [] };
let installJob = null;
let lastInstallProgress = null;
let gameProcess = null;
let stoppingGame = false;
let launching = false;
let refreshCatalogPromise = null;
let refreshJavaPromise = null;
let settingsUpdateChain = Promise.resolve();
let contentJob = null;
let modpackJob = null;
let ipcRegistered = false;
const logBuffer = [];
const CONTENT_TYPES = new Set(['mod', 'resourcepack', 'shader']);

function resolvedGameDir() {
  if (settings.gameDir) return path.resolve(settings.gameDir);
  return paths.root;
}

async function getManifestEntry(versionId) {
  const id = validateVersionId(versionId);
  if (!manifestState || !findVersion(manifestState, id)) {
    await refreshCatalog(true).catch(() => {});
  }
  const entry = findVersion(manifestState, id);
  if (!entry) throw new Error(`Minecraft ${id} is not available from Mojang right now.`);
  return entry;
}

function managedModpack(versionId) {
  if (!modpackManager) return null;
  try {
    return modpackManager.find(versionId);
  } catch {
    return null;
  }
}

function gameDirForVersion(versionId) {
  const instance = managedModpack(versionId);
  return instance ? modpackManager.gameDir(instance.id) : resolvedGameDir();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function recordLog(source, level, message) {
  const line = stripAnsi(String(message == null ? '' : message)).replace(/\s+$/, '');
  if (!line) return;
  const entry = {
    time: new Date().toISOString(),
    source,
    level: level || 'info',
    line,
  };
  logBuffer.push(entry);
  if (logBuffer.length > 1200) logBuffer.shift();
  send('launcher:log', entry);
}

function log(message, level = 'info') {
  recordLog('launcher', level, message);
  if (process.env.ECLIPSE_CLIENT_DEBUG || level === 'error') {
    console.log(`[Eclipse Client] ${message}`);
  }
}

async function readManifestCache() {
  try {
    const cached = JSON.parse(await fsp.readFile(manifestCacheFile, 'utf8'));
    if (cached && cached.manifest && Array.isArray(cached.manifest.versions)) {
      manifestFetchedAt = Number(cached.fetchedAt) || 0;
      return cached.manifest;
    }
  } catch {
    /* no usable cache */
  }
  return null;
}

async function writeManifestCache(manifest) {
  try {
    await ensureDir(path.dirname(manifestCacheFile));
    const temp = `${manifestCacheFile}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ fetchedAt: manifestFetchedAt, manifest }, null, 2), 'utf8');
    await fsp.rename(temp, manifestCacheFile);
  } catch (error) {
    log(`Could not cache the version list: ${error.message}`, 'warn');
  }
}

async function scanInstalled() {
  const installed = [];
  let dirs;
  try {
    dirs = await fsp.readdir(paths.versions, { withFileTypes: true });
  } catch {
    return installed;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let versionId;
    try {
      versionId = validateVersionId(dir.name);
    } catch {
      continue;
    }
    try {
      const markerPath = paths.completionMarker(versionId);
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
      installed.push({
        id: versionId,
        installedAt: marker.installedAt || null,
      });
    } catch {
      /* incomplete installs are not listed */
    }
  }

  installed.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return installed;
}

async function updateInstalledState() {
  installedState = await scanInstalled();
  send('installed:updated', installedState);
  return installedState;
}

async function refreshCatalog(force = false) {
  if (refreshCatalogPromise) return refreshCatalogPromise;
  if (
    !force &&
    manifestState &&
    Date.now() - manifestFetchedAt < 5 * 60 * 1000
  ) {
    return manifestState;
  }

  refreshCatalogPromise = (async () => {
    try {
      const manifest = await fetchManifest();
      manifestState = manifest;
      manifestFetchedAt = Date.now();
      await writeManifestCache(manifest);
      send('catalog:updated', manifest);
      log(`Version list updated (${manifest.versions.length} versions).`, 'debug');
      return manifest;
    } catch (error) {
      log(`Could not refresh the Minecraft version list: ${error.message}`, 'error');
      send('catalog:error', error.message);
      throw error;
    } finally {
      refreshCatalogPromise = null;
    }
  })();

  return refreshCatalogPromise;
}

async function refreshJava() {
  if (refreshJavaPromise) return refreshJavaPromise;
  javaState = { detecting: true, installations: javaState.installations || [] };
  send('java:updated', javaState);

  refreshJavaPromise = (async () => {
    try {
      const extraPaths = settings.javaPath ? [settings.javaPath] : [];
      const installations = await detectJavaInstallations({ extraPaths });
      javaState = { detecting: false, installations };
      send('java:updated', javaState);
      log(
        installations.length
          ? `Found ${installations.length} Java runtime${installations.length === 1 ? '' : 's'}.`
          : 'No Java runtime was found. Install Java 21 or newer to play current versions.',
        installations.length ? 'debug' : 'warn',
      );
      return javaState;
    } catch (error) {
      javaState = { detecting: false, installations: [], error: error.message };
      send('java:updated', javaState);
      log(`Java scan failed: ${error.message}`, 'error');
      return javaState;
    } finally {
      refreshJavaPromise = null;
    }
  })();

  return refreshJavaPromise;
}

function installerOptions() {
  return {
    paths,
    concurrency: 10,
    log: (message, level) => log(message, level || 'info'),
    onProgress: (progress) => {
      lastInstallProgress = progress;
      send('install:progress', progress);
      if (progress.stage === 'complete') {
        updateInstalledState().catch(() => {});
      }
    },
  };
}

async function installVersion(versionId) {
  let id;
  try {
    id = validateVersionId(versionId);
  } catch {
    throw new Error('Invalid Minecraft version.');
  }
  if (installJob) {
    throw new Error(`Minecraft ${installJob.versionId} is already installing. Wait for it to finish.`);
  }
  if (gameProcess) throw new Error('Close Minecraft before installing a version.');

  installJob = { versionId: id, startedAt: Date.now() };
  lastInstallProgress = null;

  try {
    const entry = findVersion(manifestState, id);
    const installer = new Installer(installerOptions());
    const result = await installer.install(id, { entry, gameDir: gameDirForVersion(id) });
    await updateInstalledState();
    return result;
  } finally {
    installJob = null;
    lastInstallProgress = null;
  }
}

async function ensureVersionReady(versionId) {
  const installer = new Installer(installerOptions());
  const startedAt = Date.now();
  if (settings.fastLaunch !== false && (await installer.isLaunchReady(versionId))) {
    const ready = await installer.getExisting(versionId);
    ready.fastLaunch = true;
    log(`Fast launch check finished in ${Date.now() - startedAt} ms.`, 'debug');
    return ready;
  }
  if (await installer.canUseExisting(versionId)) {
    const ready = await installer.getExisting(versionId);
    ready.fastLaunch = false;
    log(`Verified game files in deep check (${Date.now() - startedAt} ms).`, 'debug');
    return ready;
  }
  if (installJob) {
    throw new Error(`Minecraft ${installJob.versionId} is already installing. Wait for it to finish.`);
  }
  const installed = await installVersion(versionId);
  installed.fastLaunch = false;
  return installed;
}

async function chooseJavaFor(meta) {
  const requiredMajor = Number(meta.javaVersion && meta.javaVersion.majorVersion) || 8;

  if (settings.javaPath) {
    const info = await probeJava(settings.javaPath).catch(() => null);
    if (!info) {
      throw new Error('The selected Java runtime could not be started. Check the Java path in Settings.');
    }
    const compatible = requiredMajor <= 8 ? info.major === 8 : info.major >= requiredMajor;
    if (!compatible) {
      throw new Error(
        `This version needs Java ${requiredMajor}, but the selected runtime is Java ${info.major}. Choose a compatible Java in Settings.`,
      );
    }
    return info;
  }

  if (javaState.detecting || !javaState.installations.length) {
    await refreshJava();
  }
  const info = selectJava(javaState.installations, requiredMajor);
  if (!info) {
    const found = (javaState.installations || []).map((entry) => entry.major).join(', ') || 'none';
    throw new Error(
      requiredMajor <= 8
        ? `This version needs Java 8. Installed Java versions: ${found}. Install Java 8 or choose a Java path in Settings.`
        : `This version needs Java ${requiredMajor} or newer. Installed Java versions: ${found}. Install a newer Java or choose a path in Settings.`,
    );
  }
  return info;
}

function attachGameOutput(stream) {
  if (!stream) return () => {};
  let buffer = '';
  stream.setEncoding('utf8');
  const onData = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const clean = stripAnsi(line);
      if (!clean.trim()) continue;
      let level = 'game';
      if (/\b(ERROR|FATAL|Exception)\b/i.test(clean)) level = 'error';
      else if (/\bWARN(ING)?\b/i.test(clean)) level = 'warn';
      recordLog('game', level, clean);
    }
  };
  stream.on('data', onData);
  return () => {
    if (buffer.trim()) recordLog('game', 'info', stripAnsi(buffer));
    buffer = '';
    stream.removeListener('data', onData);
  };
}

function gamePayload() {
  if (!gameProcess) return { status: 'idle' };
  return {
    status: gameProcess.status,
    pid: gameProcess.pid,
    versionId: gameProcess.versionId,
    startedAt: gameProcess.startedAt,
  };
}

async function launchGame(versionId) {
  if (launching) throw new Error('A launch is already in progress.');
  if (gameProcess) throw new Error('Minecraft is already running.');
  if (installJob) throw new Error(`Minecraft ${installJob.versionId} is still installing.`);
  if (modpackJob) throw new Error('Wait for the current modpack job to finish.');

  let id;
  try {
    id = validateVersionId(versionId);
  } catch {
    throw new Error('Invalid Minecraft version.');
  }

  const account = accountManager.selectedAccount();
  if (!account) throw new Error('Add a player profile before launching the game.');

  launching = true;
  stoppingGame = false;
  try {
    const gameDir = gameDirForVersion(id);
    await ensureDir(gameDir);

    const ready = await ensureVersionReady(id);
    log(`Preparing Minecraft ${id}${ready.fastLaunch ? ' with a fast launch check' : '...'}`);

    const credentials = await accountManager.credentialsFor(account.id);
    const java = await chooseJavaFor(ready.meta);

    const command = buildLaunchCommand({
      meta: ready.meta,
      paths,
      versionId: id,
      account: credentials,
      settings,
      javaPath: java.path,
      gameDir,
      assetIndex: ready.assetIndex,
      launcherVersion: app.getVersion(),
      verifyFiles: false,
    });

    log(`Launching Minecraft ${id} with Java ${java.version} (${java.vendor})...`);
    let child;
    try {
      child = spawn(command.javaPath, command.args, {
        cwd: command.cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (error) {
      throw new Error(`Could not start Java: ${error.message}`);
    }

    const processInfo = {
      child,
      pid: child.pid,
      versionId: id,
      startedAt: Date.now(),
      status: 'starting',
    };
    gameProcess = processInfo;

    attachGameOutput(child.stdout);
    attachGameOutput(child.stderr);

    child.on('error', (error) => {
      stoppingGame = false;
      log(`Minecraft process error: ${error.message}`, 'error');
      if (gameProcess === processInfo) {
        gameProcess = null;
        send('game:state', { status: 'error', versionId: id, error: error.message });
      }
    });

    child.on('exit', (code, signal) => {
      const stoppedByUser = stoppingGame;
      stoppingGame = false;
      const wasTracked = gameProcess === processInfo;
      if (wasTracked) gameProcess = null;
      send('game:state', {
        status: 'exited',
        versionId: id,
        code,
        signal,
        tracked: wasTracked,
        stopped: stoppedByUser,
      });
      if (stoppedByUser) {
        log(`Minecraft ${id} stopped.`);
      } else if (code === 0) {
        log(`Minecraft ${id} closed.`);
      } else {
        log(`Minecraft ${id} exited with code ${code}${signal ? ` (${signal})` : ''}. Check the console for details.`, 'error');
      }
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve();
      };
      const onError = (error) => {
        child.removeListener('spawn', onSpawn);
        reject(new Error(`Could not start Java: ${error.message}`));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    try {
      child.unref();
    } catch {
      /* optional */
    }

    processInfo.status = 'running';
    send('game:state', gamePayload());
    log(`Minecraft ${id} is running (PID ${processInfo.pid}).`);
    if (settings.minimizeOnLaunch && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }

    return { pid: processInfo.pid, versionId: id };
  } catch (error) {
    if (gameProcess === null) send('game:state', { status: 'idle' });
    log(error.message, 'error');
    throw error;
  } finally {
    launching = false;
  }
}

async function stopGame() {
  if (!gameProcess) return { stopped: false };
  const { pid } = gameProcess;
  stoppingGame = true;
  log(`Stopping Minecraft (PID ${pid})...`, 'warn');
  try {
    if (process.platform === 'win32') {
      const result = await runCommand('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 12000 });
      if (!result.ok && gameProcess) {
        throw new Error(result.stderr.trim() || `taskkill exited with code ${result.code}`);
      }
    } else {
      gameProcess.child.kill('SIGTERM');
    }
    return { stopped: true };
  } catch (error) {
    stoppingGame = false;
    throw error;
  }
}

function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid settings update.');
  }
  const next = {};

  if ('memoryMb' in patch) {
    const value = Number(patch.memoryMb);
    if (!Number.isFinite(value)) throw new Error('Invalid memory value.');
    next.memoryMb = Math.min(32768, Math.max(1024, Math.round(value / 512) * 512));
  }
  if ('customResolution' in patch) next.customResolution = Boolean(patch.customResolution);
  if ('resolutionWidth' in patch) {
    const value = Number(patch.resolutionWidth);
    if (!Number.isFinite(value)) throw new Error('Invalid resolution width.');
    next.resolutionWidth = Math.min(7680, Math.max(320, Math.round(value)));
  }
  if ('resolutionHeight' in patch) {
    const value = Number(patch.resolutionHeight);
    if (!Number.isFinite(value)) throw new Error('Invalid resolution height.');
    next.resolutionHeight = Math.min(7680, Math.max(320, Math.round(value)));
  }
  if ('minimizeOnLaunch' in patch) next.minimizeOnLaunch = Boolean(patch.minimizeOnLaunch);
  if ('fastLaunch' in patch) next.fastLaunch = Boolean(patch.fastLaunch);
  if ('performanceJvm' in patch) next.performanceJvm = Boolean(patch.performanceJvm);
  if ('theme' in patch) {
    const value = String(patch.theme || '').trim();
    if (!THEMES.has(value)) throw new Error('Unknown launcher theme.');
    next.theme = value;
  }
  if ('javaPath' in patch) {
    const value = String(patch.javaPath || '').trim();
    if (value.length > 1024) throw new Error('Java path is too long.');
    if (value) {
      const resolved = path.resolve(value);
      if (!(fs.existsSync(resolved) && fs.statSync(resolved).isFile())) {
        throw new Error('That Java executable does not exist.');
      }
      next.javaPath = resolved;
    } else {
      next.javaPath = '';
    }
  }
  if ('gameDir' in patch) {
    const value = String(patch.gameDir || '').trim();
    if (value.length > 1024) throw new Error('Game folder path is too long.');
    if (value) {
      const resolved = path.resolve(value);
      fs.mkdirSync(resolved, { recursive: true });
      next.gameDir = resolved;
    } else {
      next.gameDir = '';
    }
  }
  if ('selectedVersion' in patch) {
    const value = String(patch.selectedVersion || '').trim();
    if (value) validateVersionId(value);
    next.selectedVersion = value;
  }

  return next;
}

function updateSettings(patch) {
  const operation = settingsUpdateChain.then(async () => {
    const clean = sanitizeSettingsPatch(patch);
    const javaChanged =
      Object.prototype.hasOwnProperty.call(clean, 'javaPath') && clean.javaPath !== settings.javaPath;
    const themeChanged =
      Object.prototype.hasOwnProperty.call(clean, 'theme') && clean.theme !== settings.theme;
    Object.assign(settings, clean);
    await settingsStore.save();
    if (themeChanged && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(THEME_WINDOW_BG[settings.theme] || THEME_WINDOW_BG.eclipse);
    }
    if (javaChanged) refreshJava().catch(() => {});
    return { ...settings };
  });
  settingsUpdateChain = operation.catch(() => {});
  return operation;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function allowedExternalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return [
    'minecraft.net',
    'mojang.com',
    'microsoft.com',
    'xbox.com',
    'adoptium.net',
    'azul.com',
    'java.com',
  ].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('app:init', async () => ({
    settings,
    accounts: accountManager.list(),
    manifest: manifestState,
    manifestFetchedAt,
    installed: installedState,
    modpacks: modpackManager ? modpackManager.list() : [],
    java: javaState,
    installing: installJob
      ? { versionId: installJob.versionId, startedAt: installJob.startedAt, ...(lastInstallProgress || {}) }
      : null,
    game: gamePayload(),
    logs: logBuffer.slice(-400),
    system: {
      platform: process.platform,
      arch: process.arch,
      totalMemory: Math.round(require('os').totalmem() / (1024 * 1024)),
      appVersion: app.getVersion(),
      dataRoot,
      minecraftRoot: paths.root,
      gameDir: resolvedGameDir(),
    },
  }));

  ipcMain.handle('catalog:refresh', async () => {
    try {
      return await refreshCatalog(true);
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('version:install', async (_event, versionId) => {
    try {
      const result = await installVersion(versionId);
      return { versionId: result.versionId, installedAt: result.installedAt };
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('game:launch', async (_event, versionId) => {
    try {
      return await launchGame(versionId);
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('game:stop', async () => {
    try {
      return await stopGame();
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('settings:update', async (_event, patch) => {
    try {
      return await updateSettings(patch);
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('modpack:create', async (_event, payload = {}) => {
    if (modpackJob) throw new Error('Another modpack job is already running.');
    if (contentJob) throw new Error('Wait for the current Modrinth download to finish.');
    if (installJob) throw new Error('Wait for the current Minecraft install to finish.');
    if (gameProcess) throw new Error('Close Minecraft before creating a modpack.');
    modpackJob = { kind: 'create', startedAt: Date.now() };
    try {
      const instance = await modpackManager.create(payload);
      send('modpacks:updated', modpackManager.list());
      return { instance, modpacks: modpackManager.list() };
    } catch (error) {
      log(`Could not create modpack: ${error.message}`, 'error');
      throw new Error(error.message);
    } finally {
      modpackJob = null;
    }
  });

  ipcMain.handle('modpack:loader-versions', async (_event, payload = {}) => {
    try {
      return await modpackManager.loaderVersions(
        String(payload.loader || 'fabric'),
        String(payload.gameVersion || ''),
      );
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('modpack:fabric-versions', async (_event, gameVersion) => {
    try {
      return await modpackManager.loaderVersions('fabric', String(gameVersion || ''));
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('modpack:import', async (event) => {
    if (modpackJob) throw new Error('Another modpack job is already running.');
    if (contentJob) throw new Error('Wait for the current Modrinth download to finish.');
    if (installJob) throw new Error('Wait for the current Minecraft install to finish.');
    if (gameProcess) throw new Error('Close Minecraft before importing a modpack.');
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import a Modrinth modpack',
      properties: ['openFile'],
      filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };

    modpackJob = { kind: 'import', startedAt: Date.now() };
    try {
      const result = await modpackManager.importMrpack(picked.filePaths[0]);
      send('modpacks:updated', modpackManager.list());
      return { canceled: false, ...result };
    } catch (error) {
      log(`Could not import modpack: ${error.message}`, 'error');
      throw new Error(error.message);
    } finally {
      modpackJob = null;
    }
  });

  ipcMain.handle('modpack:remove', async (_event, versionId) => {
    if (gameProcess) throw new Error('Close Minecraft before deleting a modpack.');
    if (installJob || modpackJob || contentJob) {
      throw new Error('Wait for the current download to finish before deleting a modpack.');
    }
    try {
      const result = await modpackManager.remove(String(versionId || ''));
      if (settings.selectedVersion === String(versionId || '')) {
        settings.selectedVersion = '';
        await settingsStore.save();
      }
      send('modpacks:updated', modpackManager.list());
      return { ...result, selectedVersion: settings.selectedVersion };
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('modpack:list', async () => modpackManager.list());

  ipcMain.handle('modrinth:search', async (_event, payload = {}) => {
    try {
      const projectType = String(payload.projectType || 'mod');
      if (!CONTENT_TYPES.has(projectType)) {
        throw new Error('Choose a mod, resource pack, or shader.');
      }
      const instance = modpackManager.requireInstance(String(payload.targetVersion || ''));
      return await searchProjects({
        query: payload.query,
        projectType,
        gameVersion: instance.gameVersion,
        loader: projectType === 'mod' ? instance.loader : '',
        offset: payload.offset,
        limit: 20,
      });
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('content:list', async (_event, versionId) => {
    try {
      return await modpackManager.listContent(String(versionId || ''));
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('content:install', async (_event, payload = {}) => {
    if (contentJob) {
      throw new Error('Another Modrinth download is already running. Wait for it to finish.');
    }
    contentJob = { projectId: String(payload.projectId || ''), startedAt: Date.now() };
    try {
      const projectType = String(payload.projectType || '');
      if (!CONTENT_TYPES.has(projectType)) throw new Error('Unknown content type.');
      const result = await modpackManager.installContent(payload);
      return result;
    } catch (error) {
      log(`Could not add Modrinth content: ${error.message}`, 'error');
      throw new Error(error.message);
    } finally {
      contentJob = null;
    }
  });

  ipcMain.handle('content:remove', async (_event, payload = {}) => {
    try {
      return await modpackManager.removeContent(payload);
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('java:detect', async () => {
    try {
      return await refreshJava();
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('client:error', async (_event, payload) => {
    const message = String((payload && payload.message) || 'Unknown renderer error');
    const stack = String((payload && payload.stack) || '');
    log(`Renderer error: ${message}${stack ? `\n${stack}` : ''}`, 'error');
    if (process.env.ECLIPSE_CLIENT_SMOKE_UI === '1') process.exitCode = 1;
    return true;
  });

  ipcMain.handle('dialog:choose-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose your Minecraft folder',
      defaultPath: resolvedGameDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:choose-java', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a Java executable',
      defaultPath: settings.javaPath || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : undefined),
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java executable', extensions: ['exe'] }]
          : undefined,
    });
    if (result.canceled || !result.filePaths[0]) return null;

    let chosen = result.filePaths[0];
    if (process.platform === 'win32' && path.basename(chosen).toLowerCase() === 'javaw.exe') {
      const javaExe = path.join(path.dirname(chosen), 'java.exe');
      if (fs.existsSync(javaExe)) chosen = javaExe;
    }

    const info = await probeJava(chosen);
    if (!info) throw new Error('That file does not appear to be a working Java executable.');
    return info;
  });

  ipcMain.handle('shell:open-path', async (_event, target) => {
    if (!target || typeof target !== 'string') throw new Error('Invalid folder.');
    const resolved = path.resolve(target);
    const gameDir = resolvedGameDir();
    if (!isInsideOrEqual(dataRoot, resolved) && !isInsideOrEqual(gameDir, resolved)) {
      throw new Error('Refusing to open an unknown folder.');
    }
    await ensureDir(resolved);
    const error = await shell.openPath(resolved);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('shell:open-url', async (_event, url) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('Invalid link.');
    }
    if (parsed.protocol !== 'https:' || !allowedExternalHost(parsed.hostname)) {
      throw new Error('That link is not allowed.');
    }
    await shell.openExternal(parsed.toString());
    return true;
  });

  ipcMain.handle('window:control', async (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      send('window:maximized', win.isMaximized());
    } else if (action === 'close') win.close();
    else throw new Error('Unknown window action.');
    return true;
  });

  ipcMain.handle('accounts:add-offline', async (_event, name) => {
    try {
      const accounts = await accountManager.addOffline(name);
      send('accounts:updated', accounts);
      return accounts;
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('accounts:rename-offline', async (_event, payload) => {
    try {
      const id = payload && payload.id;
      const name = payload && payload.name;
      const accounts = await accountManager.renameOffline(id, name);
      send('accounts:updated', accounts);
      return accounts;
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('accounts:select', async (_event, id) => {
    try {
      const accounts = await accountManager.select(id);
      send('accounts:updated', accounts);
      return accounts;
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('accounts:remove', async (_event, id) => {
    try {
      const accounts = await accountManager.remove(id);
      send('accounts:updated', accounts);
      return accounts;
    } catch (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle('accounts:sign-in-microsoft', async () => {
    try {
      const account = await accountManager.signInMicrosoft(mainWindow);
      send('accounts:updated', accountManager.list());
      return { account, accounts: accountManager.list() };
    } catch (error) {
      throw new Error(error.message);
    }
  });
}

function runUiSmokeTest() {
  if (!mainWindow) return;
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const launcher = window.__eclipseClient;
          const modrinthNav = document.querySelector('[data-page="modrinth"]');
          if (modrinthNav) modrinthNav.click();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return {
            ready: Boolean(launcher && launcher.state && launcher.state.ready),
            title: document.title,
            pages: Array.from(document.querySelectorAll('[data-page-panel]')).map((panel) => panel.dataset.pagePanel),
            versionRows: document.querySelectorAll('.version-row').length,
            playLabel: (document.querySelector('#playLabel') || {}).textContent || '',
            javaSummary: (document.querySelector('#javaSummary') || {}).textContent || '',
            accountName: (document.querySelector('#sidebarName') || {}).textContent || '',
            modrinthPage: Boolean(document.querySelector('[data-page-panel="modrinth"]')),
            createModpackButton: Boolean(document.querySelector('#createModpackBtn')),
            importButtons: document.querySelectorAll('[data-import-mrpack]').length,
            loaderChoices: document.querySelectorAll('#modpackLoader option').length,
            fastLaunchToggle: Boolean(document.querySelector('#fastLaunchToggle')),
            performanceJvmToggle: Boolean(document.querySelector('#performanceJvmToggle')),
            deletePackButton: Boolean(document.querySelector('#contentDeletePack')),
            modrinthActive: Boolean(document.querySelector('#page-modrinth.active')),
            modrinthLayout: getComputedStyle(document.querySelector('.content-layout')).display,
            modrinthTargetOptions: document.querySelectorAll('#contentTarget option').length,
            modrinthTarget: (document.querySelector('#contentTarget') || {}).value || '',
            modrinthResultCards: document.querySelectorAll('#modrinthResults .mod-card').length,
            theme: document.documentElement.dataset.theme || '',
            themeChoices: Array.from(document.querySelectorAll('[data-theme-choice]')).map((button) => button.dataset.themeChoice),
            themeCurrent: (document.querySelector('#themeCurrent') || {}).textContent || ''
          };
        })()`);
        console.log(`UI_SMOKE_RESULT ${JSON.stringify(result)}`);
        if (
          !result.ready ||
          !result.pages.includes('play') ||
          !result.pages.includes('versions') ||
          !result.pages.includes('modrinth') ||
          !result.pages.includes('settings') ||
          !result.modrinthPage ||
          !result.createModpackButton ||
          !result.importButtons ||
          result.loaderChoices !== 3 ||
          !result.fastLaunchToggle ||
          !result.performanceJvmToggle ||
          !result.deletePackButton ||
          !result.modrinthActive ||
          result.modrinthLayout !== 'grid' ||
          result.modrinthTargetOptions < 1 ||
          !['eclipse', 'aurora', 'ember', 'daylight', 'midnight', 'frost', 'sakura', 'solar'].includes(result.theme) ||
          result.themeChoices.length !== 8 ||
          !result.themeCurrent
        ) {
          throw new Error('UI did not reach a usable state');
        }
      } catch (error) {
        console.error('UI_SMOKE_FAILED', error);
        process.exitCode = 1;
      } finally {
        setTimeout(() => app.quit(), 250);
      }
    }, 4000);
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: THEME_WINDOW_BG[settings.theme] || THEME_WINDOW_BG.eclipse,
    title: 'Eclipse Client',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => send('window:maximized', true));
  mainWindow.on('unmaximize', () => send('window:maximized', false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow && mainWindow.webContents.getURL();
    if (current && url !== current) event.preventDefault();
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

async function bootstrap() {
  await ensureDir(dataRoot);
  await paths.ensureBaseDirs();

  settingsStore = new JsonStore(path.join(dataRoot, 'settings.json'), DEFAULT_SETTINGS);
  settings = await settingsStore.load();
  settings.theme = THEMES.has(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme;

  accountManager = new AccountManager({
    store: new JsonStore(path.join(dataRoot, 'accounts.json'), {
      selectedId: '',
      profiles: [],
    }),
    log,
  });
  await accountManager.init();

  manifestState = await readManifestCache();
  modpackManager = new ModpackManager({
    dataRoot,
    paths,
    log,
    getManifestEntry,
    resolveInstallerJava: async (meta) => (await chooseJavaFor(meta)).path,
    onProgress: (progress) => send('modpack:progress', progress),
  });
  await modpackManager.init();
  installedState = await scanInstalled();
  log('Eclipse Client launcher started.', 'debug');
  registerIpc();
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    await bootstrap();
  } catch (error) {
    dialog.showErrorBox('Eclipse Client could not start', String(error && error.stack ? error.stack : error));
    app.quit();
    return;
  }

  createWindow();
  if (process.env.ECLIPSE_CLIENT_SMOKE_UI === '1') runUiSmokeTest();
  refreshCatalog(false).catch(() => {});
  refreshJava().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

process.on('uncaughtException', (error) => {
  log(`Uncaught error: ${error && error.stack ? error.stack : error}`, 'error');
});

process.on('unhandledRejection', (error) => {
  log(`Unhandled rejection: ${error && error.stack ? error.stack : error}`, 'error');
});
