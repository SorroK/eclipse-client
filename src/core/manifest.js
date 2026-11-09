'use strict';

const { fetchJson } = require('./utils');

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

function normalizeManifest(raw) {
  if (!raw || !Array.isArray(raw.versions)) {
    throw new Error('Mojang returned an unexpected version manifest');
  }

  const versions = raw.versions
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.url === 'string')
    .map((entry) => ({
      id: entry.id,
      type: entry.type || 'release',
      url: entry.url,
      sha1: entry.sha1 || null,
      releaseTime: entry.releaseTime || entry.time || null,
      time: entry.time || entry.releaseTime || null,
      complianceLevel: entry.complianceLevel || 0,
    }));

  if (!versions.length) throw new Error('Mojang version manifest contained no versions');

  return {
    latest: {
      release: raw.latest && raw.latest.release ? raw.latest.release : versions[0].id,
      snapshot:
        raw.latest && raw.latest.snapshot
          ? raw.latest.snapshot
          : versions.find((entry) => entry.type === 'snapshot')?.id || '',
    },
    versions,
  };
}

async function fetchManifest() {
  return normalizeManifest(await fetchJson(VERSION_MANIFEST_URL, { timeoutMs: 20000 }));
}

function findVersion(manifest, versionId) {
  if (!manifest || !Array.isArray(manifest.versions)) return null;
  return manifest.versions.find((entry) => entry.id === versionId) || null;
}

function summarizeManifest(manifest) {
  if (!manifest) return null;
  return {
    latest: manifest.latest,
    versions: manifest.versions,
  };
}

module.exports = {
  VERSION_MANIFEST_URL,
  normalizeManifest,
  fetchManifest,
  findVersion,
  summarizeManifest,
};
