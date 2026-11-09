'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isAllowedByRules,
  platformName,
  archName,
  safeJoin,
  offlineUuid,
} = require('./utils');

function clampMemory(megabytes) {
  const value = Number(megabytes);
  if (!Number.isFinite(value)) return 4096;
  return Math.min(32768, Math.max(1024, Math.round(value / 512) * 512));
}

function clampResolution(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(7680, Math.max(320, Math.round(number)));
}

function createRuleContext(platform, features) {
  return {
    osName: platformName(platform),
    osVersion: os.release(),
    arch: archName(process.arch),
    features: features || {},
  };
}

function expandArguments(argumentsList, context) {
  const output = [];
  for (const item of argumentsList || []) {
    if (typeof item === 'string') {
      output.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (!isAllowedByRules(item.rules || [], context)) continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const value of values) {
      if (typeof value === 'string') output.push(value);
    }
  }
  return output;
}

function substituteVariables(value, variables) {
  return String(value).replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) return String(variables[key]);
    return match;
  });
}

function splitLegacyArguments(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Where --assetsDir should point. Virtual asset indexes (very old versions)
 * need a folder laid out by resource name, not the modern object cache.
 */
function getAssetRoot(paths, meta, assetIndex) {
  const assetId = (meta && meta.assets) || (assetIndex && assetIndex.id);
  if (assetIndex && assetIndex.virtual && assetId) return paths.virtualAssets(assetId);
  return paths.assets;
}

function getClasspathEntries(meta, paths, versionId, context) {
  const entries = [];
  const seen = new Set();

  for (const library of meta.libraries || []) {
    if (!isAllowedByRules(library.rules, context)) continue;
    const artifact = library.downloads && library.downloads.artifact;
    if (!artifact || !artifact.path) continue;
    const destination = safeJoin(paths.libraries, artifact.path);
    if (seen.has(destination)) continue;
    seen.add(destination);
    entries.push(destination);
  }

  const clientJar = paths.clientJar(versionId);
  if (!seen.has(clientJar)) entries.push(clientJar);
  return entries;
}

/**
 * Build the complete Java command line, including classpath, natives,
 * authentication placeholders, conditional game arguments and memory flags.
 */
function buildLaunchCommand(options) {
  const {
    meta,
    paths,
    versionId,
    account,
    settings = {},
    javaPath = 'java',
    gameDir,
    assetIndex = null,
    launcherVersion = '1.0.0',
    platform = process.platform,
    verifyFiles = true,
  } = options;

  if (!meta || typeof meta.mainClass !== 'string') {
    throw new Error('Version metadata is missing a main class');
  }
  if (!gameDir) throw new Error('Game directory is required');

  const memory = clampMemory(settings.memoryMb);
  const resolutionWidth = clampResolution(settings.resolutionWidth, 1280);
  const resolutionHeight = clampResolution(settings.resolutionHeight, 720);
  const useCustomResolution = Boolean(settings.customResolution);
  const features = {
    has_custom_resolution: useCustomResolution,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
    is_demo_user: false,
  };
  const context = createRuleContext(platform, features);
  const classpathEntries = getClasspathEntries(meta, paths, versionId, context);
  const classpath = classpathEntries.join(platform === 'win32' ? ';' : ':');

  if (verifyFiles) {
    const missing = classpathEntries.filter((entry) => {
      try {
        return !fs.statSync(entry).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length) {
      throw new Error(
        `Minecraft ${versionId} is missing ${missing.length} library file(s). Reinstall the version and try again.`,
      );
    }
  }

  const nativesDirectory = paths.nativesDir(versionId);
  for (const subdirectory of ['', 'java', 'jna', 'lwjgl', 'netty']) {
    fs.mkdirSync(path.join(nativesDirectory, subdirectory), { recursive: true });
  }

  const assetRoot = getAssetRoot(paths, meta, assetIndex);
  if (verifyFiles && meta.assetIndex && meta.assetIndex.id) {
    const indexFile = paths.assetIndex(meta.assetIndex.id);
    if (!fs.existsSync(indexFile)) {
      throw new Error(`Minecraft ${versionId} is missing its asset index. Reinstall the version and try again.`);
    }
  }

  const profile = account || {};
  const playerName = profile.name || 'Player';
  const playerUuid = profile.uuid || offlineUuid(playerName);
  const accessToken = profile.accessToken || '0';
  const userType = profile.type === 'msa' ? 'msa' : 'legacy';

  const variables = {
    auth_player_name: playerName,
    profile_name: playerName,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: assetRoot,
    game_assets: assetRoot,
    assets_index_name: meta.assets || (assetIndex && assetIndex.id) || '',
    auth_uuid: playerUuid,
    auth_access_token: accessToken,
    auth_session: `token:${accessToken}:${playerUuid}`,
    auth_xuid: profile.xuid || '',
    clientid: profile.clientId || '',
    user_type: userType,
    version_type: meta.type || 'release',
    user_properties: profile.userProperties || '{}',
    natives_directory: nativesDirectory,
    classpath,
    classpath_separator: platform === 'win32' ? ';' : ':',
    launcher_name: 'Eclipse Client',
    launcher_version: launcherVersion,
    library_directory: paths.libraries,
    resolution_width: String(resolutionWidth),
    resolution_height: String(resolutionHeight),
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: '',
  };

  const jvmArguments = [`-Xms${Math.min(memory, 2048)}M`, `-Xmx${memory}M`];
  if (settings.performanceJvm !== false) {
    jvmArguments.push(
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+PerfDisableSharedMem',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:InitiatingHeapOccupancyPercent=15',
    );
  }

  const logging = meta.logging && meta.logging.client;
  if (logging && logging.file && logging.file.id) {
    const logConfigPath = paths.logConfig(logging.file.id);
    if (fs.existsSync(logConfigPath)) {
      const argumentTemplate = logging.argument || '-Dlog4j.configurationFile=${path}';
      jvmArguments.push(substituteVariables(argumentTemplate, { path: logConfigPath }));
    }
  }

  if (Array.isArray(meta.arguments && meta.arguments.jvm)) {
    const metadataJvmArguments = expandArguments(meta.arguments.jvm, context).map((argument) =>
      substituteVariables(argument, variables),
    );
    jvmArguments.push(...metadataJvmArguments);
    const hasClasspath = metadataJvmArguments.some(
      (argument) => argument === '-cp' || argument === '-classpath',
    );
    if (!hasClasspath) {
      jvmArguments.push(`-Djava.library.path=${nativesDirectory}`, '-cp', classpath);
    }
  } else {
    jvmArguments.push(`-Djava.library.path=${nativesDirectory}`, '-cp', classpath);
  }

  if (!jvmArguments.some((argument) => argument.startsWith('-Dminecraft.launcher.brand='))) {
    jvmArguments.push('-Dminecraft.launcher.brand=EclipseClient');
  }
  if (!jvmArguments.some((argument) => argument.startsWith('-Dminecraft.launcher.version='))) {
    jvmArguments.push(`-Dminecraft.launcher.version=${launcherVersion}`);
  }

  let gameArguments;
  if (meta.arguments && Array.isArray(meta.arguments.game) && meta.arguments.game.length) {
    gameArguments = expandArguments(meta.arguments.game, context);
  } else {
    gameArguments = splitLegacyArguments(meta.minecraftArguments);
  }
  gameArguments = gameArguments.map((argument) => substituteVariables(argument, variables));

  if (useCustomResolution && !gameArguments.includes('--width')) {
    gameArguments.push('--width', String(resolutionWidth), '--height', String(resolutionHeight));
  }

  return {
    javaPath,
    args: [...jvmArguments, meta.mainClass, ...gameArguments],
    classpath,
    assetRoot,
    nativesDirectory,
    cwd: gameDir,
    memoryMb: memory,
    requiredJavaMajor:
      meta.javaVersion && Number(meta.javaVersion.majorVersion)
        ? Number(meta.javaVersion.majorVersion)
        : 8,
  };
}

module.exports = {
  buildLaunchCommand,
  getAssetRoot,
  getClasspathEntries,
  createRuleContext,
  expandArguments,
  substituteVariables,
  splitLegacyArguments,
  clampMemory,
  clampResolution,
};
