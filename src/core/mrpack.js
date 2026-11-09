'use strict';

const path = require('path');
const { normalizeLoader } = require('./loaders');

const MAX_FILES = 20000;
const MAX_OVERRIDE_BYTES = 2 * 1024 * 1024 * 1024;
const RESERVED_PATHS = new Set([
  'instance.json',
  'eclipse-content.json',
  'modrinth.index.json',
]);
const MODPACK_HOSTS = new Set([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
]);
const LOADER_KEYS = ['fabric-loader', 'forge', 'neoforge'];

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Normalize a path from a zip archive or modrinth.index.json. Returns a POSIX
 * relative path and rejects absolute paths, traversal, and reserved metadata.
 */
function normalizePackPath(value, options = {}) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/');
  if (!raw || raw.includes('\u0000')) throw new Error('The modpack contains an empty file path.');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || path.posix.isAbsolute(raw)) {
    throw new Error('The modpack contains an absolute file path.');
  }
  let normalized = path.posix.normalize(raw);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error('The modpack contains a file path outside its game folder.');
  }
  if (options.file !== false && normalized.endsWith('/')) {
    throw new Error('The modpack contains a download entry without a file name.');
  }
  if (options.reserved !== false && RESERVED_PATHS.has(normalized.toLowerCase())) {
    throw new Error(`The modpack tried to overwrite launcher metadata (${normalized}).`);
  }
  return normalized;
}

function mrpackDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('The modpack contains an invalid download link.');
  }
  if (url.protocol !== 'https:') throw new Error('The modpack contains an insecure download link.');
  if (!MODPACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`The modpack uses an untrusted download host (${url.hostname}).`);
  }
  return url.toString();
}

function normalizeHashes(raw) {
  if (!raw || typeof raw !== 'object') return { sha1: '', sha512: '' };
  return {
    sha1: typeof raw.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(raw.sha1) ? raw.sha1.toLowerCase() : '',
    sha512:
      typeof raw.sha512 === 'string' && /^[0-9a-f]{128}$/i.test(raw.sha512)
        ? raw.sha512.toLowerCase()
        : '',
  };
}

function normalizeMrpackIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('This is not a valid Modrinth modpack.');
  }
  if (Number(raw.formatVersion) !== 1) {
    throw new Error(`Unsupported .mrpack format version: ${String(raw.formatVersion || 'unknown')}.`);
  }
  if (String(raw.game || '').toLowerCase() !== 'minecraft') {
    throw new Error('Only Minecraft .mrpack files can be imported.');
  }

  const dependencies = raw.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('This modpack does not list its Minecraft or loader dependencies.');
  }
  const gameVersion = cleanText(dependencies.minecraft, 64);
  if (!gameVersion) throw new Error('This modpack does not specify a Minecraft version.');

  if (dependencies['quilt-loader']) {
    throw new Error('Quilt modpacks are not supported yet. Use a Fabric, Forge, or NeoForge pack.');
  }
  const declared = LOADER_KEYS.filter((key) => dependencies[key]);
  if (declared.length > 1) {
    throw new Error('This modpack declares more than one mod loader.');
  }
  if (!declared.length) {
    throw new Error('This modpack does not declare Fabric, Forge, or NeoForge.');
  }
  const loader = normalizeLoader(declared[0] === 'fabric-loader' ? 'fabric' : declared[0]);
  const loaderVersion = cleanText(dependencies[declared[0]], 64);
  if (!loaderVersion) throw new Error('This modpack does not specify a mod loader version.');

  const sourceFiles = Array.isArray(raw.files) ? raw.files : [];
  if (sourceFiles.length > MAX_FILES) {
    throw new Error('This modpack contains too many files to import safely.');
  }
  const seen = new Set();
  const files = [];
  for (const item of sourceFiles) {
    if (!item || typeof item !== 'object') continue;
    const env = item.env && typeof item.env === 'object' ? item.env : {};
    if (String(env.client || '').toLowerCase() === 'unsupported') continue;

    const filePath = normalizePackPath(item.path);
    if (seen.has(filePath.toLowerCase())) {
      throw new Error(`This modpack lists the same file twice (${filePath}).`);
    }
    seen.add(filePath.toLowerCase());

    const downloads = (Array.isArray(item.downloads) ? item.downloads : [])
      .map((url) => {
        try {
          return mrpackDownloadUrl(url);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!downloads.length) {
      throw new Error(`The modpack file ${filePath} has no trusted download link.`);
    }
    const hashes = normalizeHashes(item.hashes);
    if (!hashes.sha1 && !hashes.sha512) {
      throw new Error(`The modpack file ${filePath} is missing its checksum.`);
    }
    const size = Number(item.fileSize);
    files.push({
      path: filePath,
      downloads,
      sha1: hashes.sha1 || undefined,
      sha512: hashes.sha512 || undefined,
      size: Number.isFinite(size) && size >= 0 ? size : undefined,
    });
  }

  return {
    name: cleanText(raw.name, 80) || 'Imported modpack',
    versionId: cleanText(raw.versionId, 80) || '1.0.0',
    gameVersion,
    loader,
    loaderVersion,
    files,
  };
}

function contentTypeForPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('mods/')) return 'mod';
  if (normalized.startsWith('resourcepacks/')) return 'resourcepack';
  if (normalized.startsWith('shaderpacks/')) return 'shader';
  return '';
}

function overrideByteBudget(entries) {
  let total = 0;
  for (const entry of entries) {
    if (!entry || entry.isDirectory) continue;
    total += Number(entry.header && entry.header.size) || 0;
    if (total > MAX_OVERRIDE_BYTES) {
      throw new Error('This modpack is too large to extract safely.');
    }
  }
  return total;
}

module.exports = {
  MAX_FILES,
  MAX_OVERRIDE_BYTES,
  RESERVED_PATHS,
  MODPACK_HOSTS,
  cleanText,
  normalizePackPath,
  mrpackDownloadUrl,
  normalizeHashes,
  normalizeMrpackIndex,
  contentTypeForPath,
  overrideByteBudget,
};
