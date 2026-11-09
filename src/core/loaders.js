'use strict';

const { fetchJson, fetchText, validateVersionId } = require('./utils');
const { fetchFabricLoaders } = require('./fabric');

const LOADERS = {
  fabric: { id: 'fabric', label: 'Fabric', mark: 'F', modrinth: 'fabric' },
  forge: { id: 'forge', label: 'Forge', mark: 'G', modrinth: 'forge' },
  neoforge: { id: 'neoforge', label: 'NeoForge', mark: 'N', modrinth: 'neoforge' },
};
const LOADER_IDS = new Set(Object.keys(LOADERS));
const LOADER_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN_METADATA =
  'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_MAVEN_API = 'https://maven.neoforged.net/api/maven/versions/releases';

function normalizeLoader(value) {
  const loader = String(value || '').trim().toLowerCase();
  if (!LOADER_IDS.has(loader)) throw new Error('Choose Fabric, Forge, or NeoForge.');
  return loader;
}

function loaderLabel(value) {
  const loader = String(value || '').trim().toLowerCase();
  return (LOADERS[loader] && LOADERS[loader].label) || 'Loader';
}

function loaderMark(value) {
  const loader = String(value || '').trim().toLowerCase();
  return (LOADERS[loader] && LOADERS[loader].mark) || '?';
}

function loaderModrinthCategory(value) {
  const loader = String(value || '').trim().toLowerCase();
  return (LOADERS[loader] && LOADERS[loader].modrinth) || '';
}

function validateLoaderVersion(value) {
  const version = String(value || '').trim();
  if (!LOADER_VERSION_PATTERN.test(version)) throw new Error('Invalid mod loader version.');
  return version;
}

function compareVersions(left, right) {
  const a = String(left || '').split(/[._+-]/);
  const b = String(right || '').split(/[._+-]/);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || '0';
    const bv = b[index] || '0';
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    if (!Number.isFinite(an) || !Number.isFinite(bn)) {
      const compared = av.localeCompare(bv, undefined, { numeric: true });
      if (compared) return compared;
    }
  }
  return 0;
}

function sortLoaderVersions(versions) {
  return [...versions].sort((left, right) => compareVersions(right.version, left.version));
}

async function fetchForgeLoaders(gameVersion) {
  const game = validateVersionId(gameVersion);
  let promotions = null;
  let promotionsError = null;
  let mavenXml = null;

  const [promotionsResult, mavenResult] = await Promise.allSettled([
    fetchJson(FORGE_PROMOTIONS_URL, { timeoutMs: 20000 }),
    fetchText(FORGE_MAVEN_METADATA, { timeoutMs: 30000 }),
  ]);
  if (promotionsResult.status === 'fulfilled') promotions = promotionsResult.value;
  else promotionsError = promotionsResult.reason;
  if (mavenResult.status === 'fulfilled') mavenXml = mavenResult.value;

  if (
    promotions &&
    typeof promotions === 'object' &&
    !Array.isArray(promotions)
  ) {
    const source = promotions.promos && typeof promotions.promos === 'object'
      ? promotions.promos
      : promotions;
    promotions = source;
  } else {
    promotions = {};
  }

  const found = new Map();
  if (typeof mavenXml === 'string') {
    const prefix = `${game}-`;
    for (const match of mavenXml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const raw = String(match[1] || '').trim();
      if (!raw.startsWith(prefix) || !LOADER_VERSION_PATTERN.test(raw)) continue;
      const version = raw.slice(prefix.length);
      if (!LOADER_VERSION_PATTERN.test(version)) continue;
      found.set(version, {
        version,
        stable: true,
        recommended: false,
        channel: '',
        installerVersion: raw,
        artifact: 'forge',
      });
    }
  }

  for (const [key, value] of Object.entries(promotions)) {
    if (typeof value !== 'string') continue;
    const prefix = `${game}-`;
    if (!key.startsWith(prefix)) continue;
    const channel = key.slice(prefix.length);
    if (channel !== 'latest' && channel !== 'recommended') continue;
    if (!LOADER_VERSION_PATTERN.test(value)) continue;
    const existing = found.get(value) || {
      version: value,
      stable: true,
      recommended: false,
      channel: '',
      installerVersion: `${game}-${value}`,
      artifact: 'forge',
    };
    if (channel === 'recommended') {
      existing.recommended = true;
      existing.channel = 'recommended';
    } else if (!existing.channel) {
      existing.channel = 'latest';
    }
    found.set(value, existing);
  }

  if (!found.size && promotionsError) {
    throw new Error(`Could not reach Forge: ${promotionsError.message}`);
  }
  const loaders = sortLoaderVersions(Array.from(found.values()));
  if (!loaders.length) {
    throw new Error(`Forge does not publish a loader for Minecraft ${game}.`);
  }
  return loaders;
}

function neoForgePrefix(gameVersion) {
  const parts = String(gameVersion).split('.');
  if (parts.length < 2 || parts[0] !== '1') return null;
  return `${parts[1]}.${parts[2] || '0'}`;
}

async function fetchNeoForgeLoaders(gameVersion) {
  const game = validateVersionId(gameVersion);
  const legacy = game === '1.20.1';
  const artifact = legacy ? 'forge' : 'neoforge';
  const url = `${NEOFORGE_MAVEN_API}/net/neoforged/${artifact}`;
  let data;
  try {
    data = await fetchJson(url, { timeoutMs: 20000 });
  } catch (error) {
    throw new Error(`Could not reach NeoForge: ${error.message}`);
  }
  if (!data || !Array.isArray(data.versions)) {
    throw new Error('NeoForge returned an unexpected version list.');
  }

  const prefix = legacy ? `${game}-` : `${neoForgePrefix(game)}.`;
  if (!legacy && !neoForgePrefix(game)) {
    throw new Error(`NeoForge does not publish a loader for Minecraft ${game}.`);
  }

  const versions = [];
  for (const raw of data.versions) {
    if (typeof raw !== 'string' || !raw.startsWith(prefix)) continue;
    if (!LOADER_VERSION_PATTERN.test(raw)) continue;
    const version = legacy ? raw.slice(prefix.length) : raw;
    if (!LOADER_VERSION_PATTERN.test(version)) continue;
    versions.push({
      version,
      stable: true,
      recommended: false,
      channel: 'latest',
      installerVersion: raw,
      artifact,
    });
  }

  const loaders = sortLoaderVersions(versions);
  if (!loaders.length) {
    throw new Error(`NeoForge does not publish a loader for Minecraft ${game}.`);
  }
  loaders[0].recommended = true;
  return loaders;
}

async function fetchLoaderVersions(loader, gameVersion) {
  const kind = normalizeLoader(loader);
  if (kind === 'fabric') {
    try {
      return await fetchFabricLoaders(gameVersion);
    } catch (error) {
      throw new Error(`Could not reach Fabric: ${error.message}`);
    }
  }
  if (kind === 'forge') return fetchForgeLoaders(gameVersion);
  return fetchNeoForgeLoaders(gameVersion);
}

function pickLoaderVersion(loaders) {
  if (!Array.isArray(loaders) || !loaders.length) return null;
  return (
    loaders.find((entry) => entry.recommended) ||
    loaders.find((entry) => entry.stable) ||
    loaders[0]
  );
}

function loaderInstallerUrl(loader, descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('Missing mod loader installer information.');
  }
  const installerVersion = validateLoaderVersion(descriptor.installerVersion);
  const kind = normalizeLoader(loader);
  if (kind === 'forge') {
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(
      installerVersion,
    )}/forge-${encodeURIComponent(installerVersion)}-installer.jar`;
  }
  if (kind === 'neoforge') {
    const artifact = descriptor.artifact === 'forge' ? 'forge' : 'neoforge';
    return `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${encodeURIComponent(
      installerVersion,
    )}/${artifact}-${encodeURIComponent(installerVersion)}-installer.jar`;
  }
  throw new Error('Fabric does not need an installer download.');
}

module.exports = {
  LOADERS,
  LOADER_IDS,
  normalizeLoader,
  loaderLabel,
  loaderMark,
  loaderModrinthCategory,
  validateLoaderVersion,
  compareVersions,
  sortLoaderVersions,
  fetchForgeLoaders,
  fetchNeoForgeLoaders,
  fetchLoaderVersions,
  pickLoaderVersion,
  loaderInstallerUrl,
  neoForgePrefix,
};
