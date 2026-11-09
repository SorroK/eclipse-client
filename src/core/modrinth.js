'use strict';

const { fetchJson } = require('./utils');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const PROJECT_TYPES = new Set(['mod', 'resourcepack', 'shader', 'modpack']);
const PROJECT_REF_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const VERSION_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

function normalizeProjectType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!PROJECT_TYPES.has(type)) throw new Error('Unknown Modrinth project type.');
  return type;
}

function validateProjectRef(value) {
  const ref = String(value || '').trim();
  if (!PROJECT_REF_PATTERN.test(ref)) throw new Error('Invalid Modrinth project.');
  return ref;
}

function validateVersionId(value) {
  const id = String(value || '').trim();
  if (!VERSION_ID_PATTERN.test(id)) throw new Error('Invalid Modrinth version.');
  return id;
}

function buildSearchFacets({ projectType, gameVersion, loader }) {
  const type = normalizeProjectType(projectType);
  const facets = [[`project_type:${type}`]];
  const version = String(gameVersion || '').trim();
  if (version) facets.push([`versions:${version}`]);

  const loaderName = String(loader || '').trim().toLowerCase();
  if (type === 'mod' && loaderName) {
    facets.push([`categories:${loaderName}`]);
  }
  return JSON.stringify(facets);
}

function imageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    if (url.hostname !== 'cdn.modrinth.com' && url.hostname !== 'cdn-raw.modrinth.com') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeSearchHit(hit) {
  if (!hit || typeof hit !== 'object' || typeof hit.project_id !== 'string') return null;
  return {
    id: hit.project_id,
    slug: String(hit.slug || ''),
    projectType: String(hit.project_type || ''),
    title: String(hit.title || 'Untitled'),
    description: String(hit.description || ''),
    author: String(hit.author || ''),
    iconUrl: imageUrl(hit.icon_url),
    downloads: Number(hit.downloads) || 0,
    follows: Number(hit.follows) || 0,
    categories: Array.isArray(hit.categories) ? hit.categories.map(String) : [],
    gameVersions: Array.isArray(hit.versions) ? hit.versions.map(String) : [],
    dateModified: hit.date_modified || null,
  };
}

async function searchProjects(options = {}) {
  const projectType = normalizeProjectType(options.projectType || 'mod');
  const query = String(options.query || '').trim().slice(0, 120);
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || '').trim();
  const limit = Math.min(30, Math.max(1, Number(options.limit) || 20));
  const offset = Math.min(10000, Math.max(0, Math.round(Number(options.offset) || 0)));

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
    facets: buildSearchFacets({ projectType, gameVersion, loader }),
  });

  const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`, {
    timeoutMs: 20000,
  });
  if (!data || !Array.isArray(data.hits)) {
    throw new Error('Modrinth returned an unexpected search response.');
  }

  return {
    hits: data.hits.map(normalizeSearchHit).filter(Boolean),
    totalHits: Number(data.total_hits) || 0,
    offset,
    limit,
  };
}

function normalizeDependency(dependency) {
  if (!dependency || typeof dependency !== 'object') return null;
  const type = String(dependency.dependency_type || '');
  if (!['required', 'optional', 'incompatible', 'embedded'].includes(type)) return null;
  return {
    versionId: dependency.version_id || null,
    projectId: dependency.project_id || null,
    fileName: dependency.file_name || null,
    dependencyType: type,
  };
}

function normalizeProjectVersion(version) {
  if (!version || typeof version !== 'object' || typeof version.id !== 'string') return null;
  const files = (Array.isArray(version.files) ? version.files : [])
    .filter((file) => file && typeof file.url === 'string' && typeof file.filename === 'string')
    .filter((file) => {
      try {
        return new URL(file.url).protocol === 'https:';
      } catch {
        return false;
      }
    });
  if (!files.length) return null;
  const file = files.find((entry) => entry.primary) || files[0];

  return {
    id: version.id,
    projectId: String(version.project_id || ''),
    name: String(version.name || ''),
    versionNumber: String(version.version_number || ''),
    versionType: String(version.version_type || 'release'),
    gameVersions: Array.isArray(version.game_versions) ? version.game_versions.map(String) : [],
    loaders: Array.isArray(version.loaders) ? version.loaders.map(String) : [],
    datePublished: version.date_published || null,
    downloads: Number(version.downloads) || 0,
    fileName: String(file.filename || ''),
    fileSize: Number(file.size) || 0,
    sha1: file.hashes && file.hashes.sha1 ? String(file.hashes.sha1) : '',
    url: String(file.url || ''),
    dependencies: (Array.isArray(version.dependencies) ? version.dependencies : [])
      .map(normalizeDependency)
      .filter(Boolean),
  };
}

async function fetchProject(projectRef) {
  const ref = validateProjectRef(projectRef);
  const raw = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(ref)}`, {
    timeoutMs: 20000,
  });
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
    throw new Error('Modrinth returned an unexpected project.');
  }
  return {
    id: raw.id,
    slug: String(raw.slug || ''),
    title: String(raw.title || 'Untitled'),
    description: String(raw.description || ''),
    projectType: String(raw.project_type || ''),
    iconUrl: imageUrl(raw.icon_url),
    body: String(raw.body || ''),
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
    gameVersions: Array.isArray(raw.game_versions) ? raw.game_versions.map(String) : [],
    loaders: Array.isArray(raw.loaders) ? raw.loaders.map(String) : [],
  };
}

async function fetchProjectVersions(projectRef, options = {}) {
  const ref = validateProjectRef(projectRef);
  const params = new URLSearchParams();
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || '').trim().toLowerCase();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const raw = await fetchJson(
    `${MODRINTH_API}/project/${encodeURIComponent(ref)}/version${suffix}`,
    { timeoutMs: 20000 },
  );
  if (!Array.isArray(raw)) throw new Error('Modrinth returned an unexpected version list.');

  return raw.map(normalizeProjectVersion).filter(Boolean);
}

async function fetchVersion(versionId) {
  const id = validateVersionId(versionId);
  const raw = await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(id)}`, {
    timeoutMs: 20000,
  });
  const version = normalizeProjectVersion(raw);
  if (!version) throw new Error('Modrinth returned an unusable version file.');
  return version;
}

function pickBestVersion(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  const release = versions.find((version) => version.versionType === 'release');
  return release || versions[0];
}

function displayProjectType(type) {
  switch (type) {
    case 'resourcepack':
      return 'Resource pack';
    case 'shader':
      return 'Shader';
    case 'modpack':
      return 'Modpack';
    default:
      return 'Mod';
  }
}

module.exports = {
  MODRINTH_API,
  PROJECT_TYPES,
  normalizeProjectType,
  validateProjectRef,
  validateVersionId,
  buildSearchFacets,
  imageUrl,
  normalizeSearchHit,
  normalizeProjectVersion,
  searchProjects,
  fetchProject,
  fetchProjectVersions,
  fetchVersion,
  pickBestVersion,
  displayProjectType,
};
