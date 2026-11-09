'use strict';

const { fetchJson, validateVersionId } = require('./utils');

const FABRIC_META_BASE = 'https://meta.fabricmc.net/v2';
const LOADER_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

function parseMavenCoordinate(value) {
  const parts = String(value || '').split(':');
  if (parts.length < 3 || parts.length > 5) return null;
  const [group, artifact, version, classifier, extension] = parts;
  if (!group || !artifact || !version) return null;
  if (!/^[0-9A-Za-z_.+-]+$/.test(group)) return null;
  if (!/^[0-9A-Za-z_.+-]+$/.test(artifact) || !/^[0-9A-Za-z_.+-]+$/.test(version)) return null;
  if (classifier && !/^[0-9A-Za-z_.+-]+$/.test(classifier)) return null;
  if (extension && !/^[0-9A-Za-z]+$/.test(extension)) return null;

  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension || 'jar'}`;
  return {
    group,
    artifact,
    version,
    classifier: classifier || '',
    extension: extension || 'jar',
    path: `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`,
  };
}

function mavenLibraryDownload(library) {
  if (!library || typeof library.name !== 'string' || typeof library.url !== 'string') return null;
  const coordinate = parseMavenCoordinate(library.name);
  if (!coordinate) return null;

  let base;
  try {
    base = new URL(library.url.endsWith('/') ? library.url : `${library.url}/`);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:') return null;

  let url;
  try {
    url = new URL(coordinate.path, base).toString();
  } catch {
    return null;
  }

  const size = Number(library.size);
  return {
    name: library.name,
    rules: library.rules,
    downloads: {
      artifact: {
        path: coordinate.path,
        url,
        sha1: typeof library.sha1 === 'string' ? library.sha1 : undefined,
        size: Number.isFinite(size) && size > 0 ? size : undefined,
      },
    },
  };
}

function mavenDownloadsLibrary(library) {
  if (!library || typeof library.name !== 'string') return null;
  const artifact = library.downloads && library.downloads.artifact;
  if (!artifact || typeof artifact.path !== 'string' || !artifact.path) return null;
  const path = artifact.path.replace(/\\/g, '/');
  if (path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) {
    return null;
  }
  return {
    name: library.name,
    rules: library.rules,
    natives: library.natives,
    extract: library.extract,
    downloads: {
      artifact: {
        path,
        url: typeof artifact.url === 'string' ? artifact.url : '',
        sha1: typeof artifact.sha1 === 'string' ? artifact.sha1 : undefined,
        size: Number(artifact.size) > 0 ? Number(artifact.size) : undefined,
      },
      classifiers: library.downloads && library.downloads.classifiers,
    },
  };
}

function normalizeLoaderLibraries(libraries) {
  const normalized = [];
  const seen = new Set();
  for (const library of Array.isArray(libraries) ? libraries : []) {
    if (!library || typeof library.name !== 'string') continue;
    const entry = mavenDownloadsLibrary(library) || mavenLibraryDownload(library);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    normalized.push(entry);
  }
  return normalized;
}

const normalizeFabricLibraries = normalizeLoaderLibraries;

/**
 * Merge Mojang's metadata with a Fabric loader profile. The result is a normal
 * version document so the existing installer and launch path can use it.
 */
function mergeFabricMetadata(baseMeta, fabricProfile, options = {}) {
  if (!baseMeta || typeof baseMeta !== 'object' || !baseMeta.mainClass) {
    throw new Error('Mojang returned invalid base version metadata.');
  }
  if (!fabricProfile || typeof fabricProfile !== 'object' || !fabricProfile.mainClass) {
    throw new Error('Fabric returned an invalid loader profile.');
  }
  if (!Array.isArray(baseMeta.libraries)) {
    throw new Error('The base version has no library list.');
  }

  const versionId = validateVersionId(options.versionId);
  const profileLibraries = normalizeLoaderLibraries(fabricProfile.libraries);
  const seen = new Set();
  const libraries = [];

  for (const library of baseMeta.libraries) {
    if (!library || typeof library.name !== 'string' || seen.has(library.name)) continue;
    seen.add(library.name);
    libraries.push(library);
  }
  for (const library of profileLibraries) {
    if (seen.has(library.name)) continue;
    seen.add(library.name);
    libraries.push(library);
  }

  const baseArguments = baseMeta.arguments && typeof baseMeta.arguments === 'object'
    ? baseMeta.arguments
    : {};
  const profileArguments = fabricProfile.arguments && typeof fabricProfile.arguments === 'object'
    ? fabricProfile.arguments
    : {};
  const gameArguments = [
    ...(Array.isArray(baseArguments.game) ? baseArguments.game : []),
    ...(Array.isArray(profileArguments.game) ? profileArguments.game : []),
  ];
  const jvmArguments = [
    ...(Array.isArray(baseArguments.jvm) ? baseArguments.jvm : []),
    ...(Array.isArray(profileArguments.jvm) ? profileArguments.jvm : []),
  ];

  const merged = JSON.parse(JSON.stringify(baseMeta));
  merged.id = versionId;
  merged.type = 'release';
  merged.mainClass = fabricProfile.mainClass;
  merged.libraries = libraries;
  if (gameArguments.length || jvmArguments.length) {
    merged.arguments = { game: gameArguments, jvm: jvmArguments };
  }
  merged.releaseTime = new Date().toISOString();
  merged.time = merged.releaseTime;
  merged.inheritsFrom = undefined;

  if (!gameArguments.length && baseMeta.minecraftArguments) {
    merged.minecraftArguments = baseMeta.minecraftArguments;
  }

  const minimumJava = Number(options.minimumJava);
  const baseJava = Number(baseMeta.javaVersion && baseMeta.javaVersion.majorVersion) || 8;
  if (Number.isFinite(minimumJava) && minimumJava > baseJava) {
    merged.javaVersion = {
      ...(baseMeta.javaVersion || {}),
      majorVersion: minimumJava,
    };
  }

  const loader = ['fabric', 'forge', 'neoforge'].includes(String(options.loader || '').toLowerCase())
    ? String(options.loader).toLowerCase()
    : 'fabric';
  merged.launcher = {
    ...(baseMeta.launcher || {}),
    eclipse: {
      kind: 'modpack',
      name: String(options.name || ''),
      loader,
      loaderVersion: String(options.loaderVersion || ''),
      installerVersion: String(options.installerVersion || ''),
      gameVersion: String(options.gameVersion || baseMeta.id || ''),
      createdAt: merged.releaseTime,
    },
  };

  return merged;
}

async function fetchFabricLoaders(gameVersion) {
  const id = validateVersionId(gameVersion);
  const raw = await fetchJson(`${FABRIC_META_BASE}/versions/loader/${encodeURIComponent(id)}`, {
    timeoutMs: 20000,
  });
  if (!Array.isArray(raw)) throw new Error('Fabric returned an unexpected loader list.');

  return raw
    .filter((entry) => entry && entry.loader && typeof entry.loader.version === 'string')
    .map((entry) => ({
      version: entry.loader.version,
      stable: Boolean(entry.loader.stable),
      maven: entry.loader.maven || null,
      minimumJava:
        Number(entry.launcherMeta && entry.launcherMeta.min_java_version) || 0,
    }));
}

function pickFabricLoader(loaders) {
  if (!Array.isArray(loaders) || !loaders.length) return null;
  return loaders.find((entry) => entry.stable) || loaders[0];
}

async function fetchFabricProfile(gameVersion, loaderVersion) {
  const game = validateVersionId(gameVersion);
  const loader = String(loaderVersion || '');
  if (!LOADER_VERSION_PATTERN.test(loader)) throw new Error('Invalid Fabric loader version.');

  const raw = await fetchJson(
    `${FABRIC_META_BASE}/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(loader)}/profile/json`,
    { timeoutMs: 20000 },
  );
  if (!raw || typeof raw !== 'object' || !raw.mainClass || !Array.isArray(raw.libraries)) {
    throw new Error('Fabric returned an invalid loader profile.');
  }
  if (raw.inheritsFrom && raw.inheritsFrom !== game) {
    throw new Error('Fabric returned a profile for a different Minecraft version.');
  }
  return raw;
}

module.exports = {
  FABRIC_META_BASE,
  LOADER_VERSION_PATTERN,
  parseMavenCoordinate,
  mavenLibraryDownload,
  normalizeFabricLibraries,
  normalizeLoaderLibraries,
  mergeFabricMetadata,
  fetchFabricLoaders,
  pickFabricLoader,
  fetchFabricProfile,
};
