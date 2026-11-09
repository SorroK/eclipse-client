'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { JsonStore } = require('./store');
const {
  downloadFile,
  ensureDir,
  fetchJson,
  safeJoin,
  validateVersionId,
  runCommand,
  runPool,
  stripAnsi,
} = require('../core/utils');
const {
  fetchFabricProfile,
  mergeFabricMetadata,
} = require('../core/fabric');
const {
  fetchLoaderVersions,
  pickLoaderVersion,
  loaderLabel,
  loaderInstallerUrl,
  normalizeLoader,
  validateLoaderVersion,
} = require('../core/loaders');
const {
  normalizeMrpackIndex,
  normalizePackPath,
  mrpackDownloadUrl,
  contentTypeForPath,
  overrideByteBudget,
} = require('../core/mrpack');
const {
  fetchProject,
  fetchProjectVersions,
  fetchVersion,
  pickBestVersion,
} = require('../core/modrinth');

const CONTENT_FOLDERS = {
  mod: 'mods',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
};
const CONTENT_LABELS = {
  mod: 'Mod',
  resourcepack: 'Resource pack',
  shader: 'Shader',
};
const SUPPORTED_CONTENT = new Set(Object.keys(CONTENT_FOLDERS));
const CONTENT_FILE = 'eclipse-content.json';
const MAX_DEPENDENCY_DEPTH = 4;
const MAX_DEPENDENCIES = 14;

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugForId(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function safeFileName(original, fallback) {
  let name = path.basename(String(original || '').replace(/\\/g, '/'));
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!name) name = fallback;
  if (name.length > 180) {
    const extension = path.extname(name).slice(0, 16);
    name = `${name.slice(0, 180 - extension.length)}${extension}`;
  }
  return name;
}

function uniqueFileName(fileName, usedNames) {
  if (!usedNames.has(fileName.toLowerCase())) return fileName;
  const extension = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    if (!usedNames.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error('Could not find a safe file name for this download.');
}

function modrinthDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Modrinth supplied an invalid download link.');
  }
  if (url.protocol !== 'https:') throw new Error('Modrinth supplied an insecure download link.');
  const host = url.hostname.toLowerCase();
  if (host !== 'cdn.modrinth.com' && !host.endsWith('.modrinth.com')) {
    throw new Error('Modrinth supplied a download link from an unknown host.');
  }
  return url.toString();
}

function normalizeStoredInstance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let id;
  try {
    id = validateVersionId(raw.id);
  } catch {
    return null;
  }
  const name = cleanName(raw.name);
  const gameVersion = String(raw.gameVersion || '').trim();
  const loaderVersion = String(raw.loaderVersion || '').trim();
  const loader = String(raw.loader || '').trim().toLowerCase();
  if (!name || !gameVersion || !['fabric', 'forge', 'neoforge'].includes(loader) || !loaderVersion) {
    return null;
  }
  try {
    validateVersionId(gameVersion);
  } catch {
    return null;
  }
  return {
    id,
    name,
    kind: 'modpack',
    loader,
    loaderVersion,
    gameVersion,
    createdAt: raw.createdAt || new Date().toISOString(),
    source: raw.source && typeof raw.source === 'object' ? raw.source : { type: 'custom' },
  };
}

class ModpackManager {
  constructor(options) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.paths = options.paths;
    this.log = options.log || (() => {});
    this.getManifestEntry = options.getManifestEntry;
    this.root = path.join(this.dataRoot, 'instances');
    this.store = new JsonStore(path.join(this.dataRoot, 'modpacks.json'), {
      instances: [],
    });
    this.instances = [];
    this.loaderCache = new Map();
    this.loaderInstallersDir = path.join(this.dataRoot, 'cache', 'loaders');
    this.resolveInstallerJava = options.resolveInstallerJava || null;
    this.onProgress = options.onProgress || (() => {});
  }

  emitProgress(payload) {
    try {
      this.onProgress(payload);
    } catch {
      /* the window may have gone away */
    }
  }

  async init() {
    await ensureDir(this.root);
    const data = await this.store.load();
    const seen = new Set();
    this.instances = [];
    for (const raw of Array.isArray(data.instances) ? data.instances : []) {
      const instance = normalizeStoredInstance(raw);
      if (!instance || seen.has(instance.id)) continue;
      seen.add(instance.id);
      this.instances.push(instance);
    }
    if (this.instances.length !== (Array.isArray(data.instances) ? data.instances.length : 0)) {
      await this.save();
    }
  }

  async save() {
    this.store.data.instances = this.instances;
    await this.store.save();
  }

  list() {
    return this.instances.map((instance) => this.publicInstance(instance));
  }

  publicInstance(instance) {
    return {
      ...instance,
      gameDir: this.gameDir(instance.id),
    };
  }

  find(id) {
    if (typeof id !== 'string' || !id) return null;
    return this.instances.find((instance) => instance.id === id) || null;
  }

  requireInstance(id) {
    const instance = this.find(id);
    if (!instance) throw new Error('That modpack no longer exists.');
    return instance;
  }

  gameDir(id) {
    return path.join(this.root, validateVersionId(id));
  }

  versionJson(id) {
    return this.paths.versionJson(id);
  }

  contentFile(instance) {
    return path.join(this.gameDir(instance.id), CONTENT_FILE);
  }

  async ensureContentFolders(instance) {
    const gameDir = this.gameDir(instance.id);
    await ensureDir(gameDir);
    await Promise.all(
      Object.values(CONTENT_FOLDERS).map((folder) => ensureDir(path.join(gameDir, folder))),
    );
  }

  async nextId(name, gameVersion) {
    const namePart = slugForId(name) || 'modpack';
    const versionPart = slugForId(gameVersion) || 'minecraft';
    const base = `eclipse-${namePart}-${versionPart}`.slice(0, 60).replace(/-+$/g, '');
    let id = base;
    let suffix = 2;
    while (
      this.instances.some((instance) => instance.id === id) ||
      fs.existsSync(this.paths.versionDir(id))
    ) {
      id = `${base.slice(0, 60 - String(suffix).length - 1)}-${suffix}`;
      suffix += 1;
    }
    validateVersionId(id);
    return id;
  }

  async create(input = {}) {
    const name = cleanName(input.name);
    if (name.length < 2 || name.length > 48) {
      throw new Error('Modpack names must be between 2 and 48 characters.');
    }
    const gameVersion = String(input.gameVersion || '').trim();
    try {
      validateVersionId(gameVersion);
    } catch {
      throw new Error('Choose a valid Minecraft version for the modpack.');
    }
    const loader = normalizeLoader(input.loader || 'fabric');
    const label = loaderLabel(loader);

    const entry = await this.getManifestEntry(gameVersion);
    if (!entry || !entry.url) {
      throw new Error(`Minecraft ${gameVersion} is not available from Mojang right now.`);
    }

    const loaders = await this.loaderVersions(loader, gameVersion);
    const requestedLoader = String(input.loaderVersion || '').trim();
    if (requestedLoader) validateLoaderVersion(requestedLoader);
    const selected = requestedLoader
      ? loaders.find((candidate) => candidate.version === requestedLoader)
      : pickLoaderVersion(loaders);
    if (!selected) {
      throw new Error(
        requestedLoader
          ? `${label} loader ${requestedLoader} is not available for Minecraft ${gameVersion}.`
          : `${label} does not publish a loader for Minecraft ${gameVersion}.`,
      );
    }

    const baseMeta = await fetchJson(entry.url, { timeoutMs: 30000 });
    let profile;
    let installerVersion = '';
    if (loader === 'fabric') {
      this.emitProgress({
        phase: 'metadata',
        label: `Fetching Fabric ${selected.version} metadata…`,
        percent: 5,
        indeterminate: true,
      });
      profile = await fetchFabricProfile(gameVersion, selected.version);
    } else {
      const installed = await this.installLoaderProfile(
        loader,
        { ...selected, gameVersion },
        baseMeta,
      );
      profile = installed.profile;
      installerVersion = installed.installerVersion;
    }

    const id = await this.nextId(name, gameVersion);
    const createdAt = new Date().toISOString();
    this.emitProgress({
      phase: 'metadata',
      label: `Packaging ${label} ${selected.version}…`,
      percent: 22,
      indeterminate: true,
    });
    const meta = mergeFabricMetadata(baseMeta, profile, {
      versionId: id,
      name,
      gameVersion,
      loader,
      loaderVersion: selected.version,
      installerVersion,
      minimumJava: selected.minimumJava,
    });
    meta.launcher.eclipse.createdAt = createdAt;

    const versionDir = this.paths.versionDir(id);
    try {
      await ensureDir(versionDir);
      const versionFile = this.paths.versionJson(id);
      const temp = `${versionFile}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(meta, null, 2), 'utf8');
      await fsp.rename(temp, versionFile);

      const source = input.source && typeof input.source === 'object' && !Array.isArray(input.source)
        ? { ...input.source }
        : { type: 'custom' };
      const instance = {
        id,
        name,
        kind: 'modpack',
        loader,
        loaderVersion: selected.version,
        gameVersion,
        createdAt,
        source,
      };
      await this.ensureContentFolders(instance);
      await this.writeInstanceFile(instance, baseMeta.id);
      this.instances.push(instance);
      await this.save();
      this.log(`Created ${label} modpack "${name}" (${id}) for Minecraft ${gameVersion}.`);
      this.emitProgress({
        phase: 'complete',
        label: `${label} pack ready`,
        percent: 100,
        indeterminate: false,
      });
      return this.publicInstance(instance);
    } catch (error) {
      await fsp.rm(versionDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async writeInstanceFile(instance, baseVersion) {
    const file = path.join(this.gameDir(instance.id), 'instance.json');
    const temp = `${file}.tmp`;
    await fsp.writeFile(
      temp,
      JSON.stringify({ ...instance, baseVersion }, null, 2),
      'utf8',
    );
    await fsp.rename(temp, file);
  }

  async installLoaderProfile(loader, descriptor, baseMeta) {
    const label = loaderLabel(loader);
    if (!this.resolveInstallerJava) {
      throw new Error(`Eclipse Client could not find Java to run the ${label} installer.`);
    }
    if (!descriptor || !descriptor.installerVersion) {
      throw new Error(`${label} did not provide installer information.`);
    }

    const installerVersion = validateLoaderVersion(descriptor.installerVersion);
    const installerUrl = loaderInstallerUrl(loader, descriptor);
    const fileName = `${loader}-${installerVersion}-installer.jar`;
    const installerPath = safeJoin(this.loaderInstallersDir, fileName);
    await ensureDir(this.loaderInstallersDir);
    await ensureDir(this.paths.libraries);
    await ensureDir(this.paths.versions);

    const profilesFile = path.join(this.paths.root, 'launcher_profiles.json');
    if (!fs.existsSync(profilesFile)) {
      await fsp.writeFile(
        profilesFile,
        JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
        'utf8',
      );
    }

    this.emitProgress({
      phase: 'loader',
      label: `Downloading ${label} ${descriptor.version} installer…`,
      percent: 4,
      indeterminate: true,
    });
    await downloadFile(installerUrl, installerPath);

    let javaPath;
    try {
      const resolved = await this.resolveInstallerJava(baseMeta);
      javaPath = typeof resolved === 'string' ? resolved : resolved && resolved.path;
    } catch (error) {
      throw new Error(`The ${label} installer needs a compatible Java runtime: ${error.message}`);
    }
    if (!javaPath) throw new Error(`No Java runtime is available for the ${label} installer.`);

    this.emitProgress({
      phase: 'loader',
      label: `Running the ${label} installer. This can take a minute…`,
      percent: 8,
      indeterminate: true,
    });
    this.log(`Running the official ${label} ${descriptor.version} installer...`);
    const startedAt = Date.now();
    const result = await runCommand(
      javaPath,
      ['-jar', installerPath, '--installClient', this.paths.root],
      { timeout: 10 * 60 * 1000 },
    );
    if (!result.ok) {
      const detail = stripAnsi(`${result.stdout || ''}\n${result.stderr || ''}`).trim().slice(-1600);
      this.log(`${label} installer output:\n${detail || '(no output)'}`, 'error');
      throw new Error(
        `The ${label} installer failed${result.error ? ` (${result.error})` : ''}. ${
          detail.split('\n').slice(-3).join(' ') || 'No installer output was returned.'
        }`,
      );
    }

    const profile = await this.findInstalledLoaderProfile(loader, descriptor, startedAt);
    this.emitProgress({
      phase: 'loader',
      label: `${label} ${descriptor.version} installed`,
      percent: 18,
      indeterminate: true,
    });
    this.log(`Installed ${label} profile ${profile.id}.`);
    return { profile, installerVersion };
  }

  async findInstalledLoaderProfile(loader, descriptor, startedAt) {
    const dirs = await fsp.readdir(this.paths.versions, { withFileTypes: true });
    const gameVersion = String(descriptor.gameVersion || '');
    const expectedIds = new Set([
      `${gameVersion}-forge-${descriptor.version}`,
      `neoforge-${descriptor.installerVersion}`,
      `${gameVersion}-neoforge-${descriptor.version}`,
    ]);
    const candidates = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let profile;
      try {
        profile = JSON.parse(
          await fsp.readFile(path.join(this.paths.versions, dir.name, `${dir.name}.json`), 'utf8'),
        );
      } catch {
        continue;
      }
      if (!profile || profile.id !== dir.name || !profile.mainClass) continue;
      if (profile.inheritsFrom !== gameVersion) continue;
      if (profile.launcher && profile.launcher.eclipse) continue;
      const hint = `${profile.id} ${profile.mainClass}`.toLowerCase();
      if (loader === 'forge' && !hint.includes('forge')) continue;
      if (loader === 'neoforge' && !hint.includes('neoforge') && !hint.includes('forge')) continue;
      let modified = 0;
      try {
        modified = (await fsp.stat(path.join(this.paths.versions, dir.name, `${dir.name}.json`))).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({
        profile,
        modified,
        expected: expectedIds.has(profile.id),
        fresh: modified >= startedAt - 5000,
      });
    }

    candidates.sort((left, right) => {
      if (left.expected !== right.expected) return left.expected ? -1 : 1;
      return right.modified - left.modified;
    });
    const chosen = candidates.find((candidate) => candidate.fresh) || candidates[0];
    if (!chosen) {
      throw new Error(
        `The ${loaderLabel(loader)} installer finished, but Eclipse Client could not find the generated game profile.`,
      );
    }
    return chosen.profile;
  }

  async loaderVersions(loader, gameVersion) {
    const kind = normalizeLoader(loader);
    const id = validateVersionId(gameVersion);
    const cacheKey = `${kind}:${id}`;
    const cached = this.loaderCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.loaders;

    const loaders = await fetchLoaderVersions(kind, id);
    if (!Array.isArray(loaders) || !loaders.length) {
      throw new Error(`${loaderLabel(kind)} does not publish a loader for Minecraft ${id}.`);
    }
    this.loaderCache.set(cacheKey, { loaders, fetchedAt: Date.now() });
    return loaders;
  }

  async fabricVersions(gameVersion) {
    return this.loaderVersions('fabric', gameVersion);
  }

  normalizeContentEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.projectType || '');
    if (!SUPPORTED_CONTENT.has(type)) return null;
    const fileName = safeFileName(raw.fileName, '');
    if (!fileName) return null;
    const folder = CONTENT_FOLDERS[type];
    const id = String(raw.id || raw.versionId || '');
    if (!id) return null;
    return {
      id,
      projectId: String(raw.projectId || ''),
      projectSlug: String(raw.projectSlug || ''),
      projectTitle: String(raw.projectTitle || fileName),
      projectType: type,
      versionId: String(raw.versionId || id),
      versionNumber: String(raw.versionNumber || ''),
      fileName,
      path: `${folder}/${fileName}`,
      iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : '',
      size: Number(raw.size) || 0,
      sha1: String(raw.sha1 || ''),
      source: raw.source === 'mrpack' ? 'mrpack' : 'modrinth',
      installedAt: raw.installedAt || new Date().toISOString(),
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    };
  }

  async readContent(instance) {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.contentFile(instance), 'utf8'));
      const entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
        .map((entry) => this.normalizeContentEntry(entry))
        .filter(Boolean);
      return entries;
    } catch {
      return [];
    }
  }

  async writeContent(instance, entries) {
    await ensureDir(this.gameDir(instance.id));
    const file = this.contentFile(instance);
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    await fsp.rename(temp, file);
  }

  contentPath(instance, entry) {
    const folder = CONTENT_FOLDERS[entry.projectType];
    if (!folder) throw new Error('Unknown content type.');
    const fileName = safeFileName(entry.fileName, '');
    const directory = path.join(this.gameDir(instance.id), folder);
    const destination = safeJoin(directory, fileName);
    if (!destination.startsWith(path.resolve(directory) + path.sep)) {
      throw new Error('Refusing unsafe content path.');
    }
    return destination;
  }

  async listContent(versionId) {
    const instance = this.requireInstance(versionId);
    const entries = await this.readContent(instance);
    return entries.map((entry) => {
      let exists = false;
      try {
        exists = fs.statSync(this.contentPath(instance, entry)).isFile();
      } catch {
        exists = false;
      }
      return { ...entry, exists };
    });
  }

  async installContent(input = {}) {
    const instance = this.requireInstance(String(input.targetVersion || ''));
    const requestedType = String(input.projectType || '');
    if (!SUPPORTED_CONTENT.has(requestedType)) {
      throw new Error('Choose a mod, resource pack, or shader to install.');
    }
    if (requestedType === 'mod' && !['fabric', 'forge', 'neoforge'].includes(instance.loader)) {
      throw new Error('This modpack is not running a mod loader.');
    }

    const project = await fetchProject(String(input.projectId || input.slug || ''));
    if (project.projectType !== requestedType) {
      throw new Error('That Modrinth project is a different kind of content.');
    }

    const versions = await fetchProjectVersions(project.id, {
      gameVersion: instance.gameVersion,
      loader: requestedType === 'mod' ? instance.loader : undefined,
    });
    const version = pickBestVersion(versions);
    if (!version) {
      throw new Error(
        `${project.title} has no ${CONTENT_LABELS[requestedType].toLowerCase()} for Minecraft ${instance.gameVersion} yet.`,
      );
    }

    await this.ensureContentFolders(instance);
    const entries = await this.readContent(instance);
    const added = [];
    const warnings = [];
    const usedIds = new Set(entries.map((entry) => entry.id));

    const installOne = async (item, itemProject, dependency) => {
      if (!item || !itemProject) return false;
      if (SUPPORTED_CONTENT.has(itemProject.projectType) === false) return false;
      if (usedIds.has(item.id)) return false;
      if (entries.some((entry) => entry.versionId === item.id)) return false;

      const type = itemProject.projectType;
      if (type === 'mod' && !['fabric', 'forge', 'neoforge'].includes(instance.loader)) {
        warnings.push(`${itemProject.title} was skipped because this pack has no mod loader.`);
        return false;
      }
      const folder = CONTENT_FOLDERS[type];
      if (!folder) return false;

      let fileName = safeFileName(item.fileName, `${itemProject.slug || 'content'}.jar`);
      const usedNames = new Set(
        entries
          .filter((entry) => entry.projectId !== itemProject.id)
          .map((entry) => entry.fileName.toLowerCase()),
      );
      fileName = uniqueFileName(fileName, usedNames);
      const destination = safeJoin(path.join(this.gameDir(instance.id), folder), fileName);
      const url = modrinthDownloadUrl(item.url);

      this.log(
        `Downloading ${CONTENT_LABELS[type].toLowerCase()} "${itemProject.title}" for ${instance.name}...`,
      );
      await downloadFile(url, destination, {
        sha1: item.sha1 || undefined,
        size: item.fileSize || undefined,
      });

      const previous = entries.filter(
        (entry) => entry.projectId === itemProject.id && entry.projectType === type,
      );
      for (const old of previous) {
        try {
          const oldPath = this.contentPath(instance, old);
          if (oldPath !== destination) await fsp.rm(oldPath, { force: true });
        } catch {
          /* leave an untracked file alone */
        }
        const index = entries.indexOf(old);
        if (index >= 0) entries.splice(index, 1);
      }

      const entry = {
        id: item.id,
        projectId: itemProject.id,
        projectSlug: itemProject.slug,
        projectTitle: itemProject.title,
        projectType: type,
        versionId: item.id,
        versionNumber: item.versionNumber,
        fileName,
        path: `${folder}/${fileName}`,
        iconUrl: itemProject.iconUrl,
        size: item.fileSize,
        sha1: item.sha1,
        installedAt: new Date().toISOString(),
        dependencies: item.dependencies,
      };
      entries.push(entry);
      usedIds.add(item.id);
      added.push({
        ...entry,
        dependency: Boolean(dependency),
      });
      await this.writeContent(instance, entries);
      return true;
    };

    await installOne(version, project, false);

    if (requestedType === 'mod') {
      const installedProjects = new Set([project.id]);
      const installDependencies = async (dependencies, depth) => {
        if (depth >= MAX_DEPENDENCY_DEPTH || added.length >= MAX_DEPENDENCIES) return;
        for (const dependency of dependencies || []) {
          if (dependency.dependencyType !== 'required') continue;
          if (added.length >= MAX_DEPENDENCIES) {
            warnings.push('Some required dependencies were skipped because the limit was reached.');
            return;
          }
          if (!dependency.projectId && !dependency.versionId) continue;

          let dependencyVersion = null;
          try {
            if (dependency.versionId) {
              dependencyVersion = await fetchVersion(dependency.versionId);
            }
            const projectId = dependency.projectId || (dependencyVersion && dependencyVersion.projectId);
            if (!projectId || installedProjects.has(projectId)) continue;
            const dependencyProject = await fetchProject(projectId);
            if (dependencyProject.projectType !== 'mod') continue;
            installedProjects.add(projectId);
            if (!dependencyVersion) {
              const compatible = await fetchProjectVersions(projectId, {
                gameVersion: instance.gameVersion,
                loader: instance.loader,
              });
              dependencyVersion = pickBestVersion(compatible);
            }
            if (!dependencyVersion) {
              warnings.push(`${dependencyProject.title} has no compatible version for this pack.`);
              continue;
            }
            const installed = await installOne(dependencyVersion, dependencyProject, true);
            if (installed) {
              await installDependencies(dependencyVersion.dependencies, depth + 1);
            }
          } catch (error) {
            warnings.push(`Could not add a required dependency: ${error.message}`);
          }
        }
      };
      await installDependencies(version.dependencies, 0);
    }

    await this.writeContent(instance, entries);
    this.log(
      added.length
        ? `Added ${added.length} item${added.length === 1 ? '' : 's'} from Modrinth to "${instance.name}".`
        : `"${project.title}" was already present in "${instance.name}".`,
      added.length ? 'info' : 'debug',
    );
    return {
      content: await this.listContent(instance.id),
      added,
      warnings,
    };
  }

  async importMrpack(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Choose a .mrpack file to import.');
    }
    const resolved = path.resolve(filePath);
    if (path.extname(resolved).toLowerCase() !== '.mrpack') {
      throw new Error('Choose a Modrinth .mrpack file.');
    }
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw new Error('That .mrpack file could not be opened.');
    }
    if (!stat.isFile()) throw new Error('Choose a .mrpack file, not a folder.');
    if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error('That .mrpack file is too large.');

    let zip;
    try {
      zip = new AdmZip(resolved);
    } catch (error) {
      throw new Error(`That .mrpack archive is invalid: ${error.message}`);
    }
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('That archive has no modrinth.index.json and is not a modpack.');
    if ((Number(indexEntry.header && indexEntry.header.size) || 0) > 16 * 1024 * 1024) {
      throw new Error('That modpack index is unexpectedly large.');
    }
    let rawIndex;
    try {
      rawIndex = JSON.parse(zip.readAsText(indexEntry));
    } catch (error) {
      throw new Error(`That modpack index is not valid JSON: ${error.message}`);
    }
    const pack = normalizeMrpackIndex(rawIndex);
    const packName = pack.name.length >= 2 ? pack.name.slice(0, 48) : `${pack.name} pack`;

    this.log(`Importing .mrpack "${packName}" (${loaderLabel(pack.loader)} ${pack.loaderVersion})...`);
    this.emitProgress({
      phase: 'import',
      label: `Preparing ${packName}…`,
      percent: 2,
      indeterminate: true,
    });

    let created = null;
    try {
      created = await this.create({
        name: packName,
        gameVersion: pack.gameVersion,
        loader: pack.loader,
        loaderVersion: pack.loaderVersion,
        source: {
          type: 'mrpack',
          fileName: path.basename(resolved),
          packVersion: pack.versionId,
          importedAt: new Date().toISOString(),
        },
      });
      const instance = this.requireInstance(created.id);
      const gameDir = this.gameDir(instance.id);
      const totalFiles = pack.files.length;
      let completedFiles = 0;

      this.emitProgress({
        phase: 'files',
        label: totalFiles
          ? `Downloading modpack files (0/${totalFiles})…`
          : 'Applying modpack files…',
        percent: totalFiles ? 30 : 75,
        filesDone: 0,
        filesTotal: totalFiles,
        indeterminate: false,
      });

      await runPool(pack.files, 6, async (file) => {
        const destination = safeJoin(gameDir, file.path);
        await downloadFile(mrpackDownloadUrl(file.downloads[0]), destination, {
          sha1: file.sha1,
          sha512: file.sha512,
          size: file.size,
        });
        completedFiles += 1;
        this.emitProgress({
          phase: 'files',
          label: `Downloading modpack files (${completedFiles}/${totalFiles})…`,
          percent: 30 + Math.round((45 * completedFiles) / Math.max(1, totalFiles)),
          filesDone: completedFiles,
          filesTotal: totalFiles,
          indeterminate: false,
        });
      });

      const prefixes = ['overrides/', 'client-overrides/'];
      let overrideIndex = 0;
      for (const prefix of prefixes) {
        const entries = zip
          .getEntries()
          .filter((entry) => entry.entryName.replace(/\\/g, '/').startsWith(prefix));
        overrideByteBudget(entries);
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const relative = normalizePackPath(
            entry.entryName.replace(/\\/g, '/').slice(prefix.length),
          );
          const destination = safeJoin(gameDir, relative);
          await ensureDir(path.dirname(destination));
          await fsp.writeFile(destination, entry.getData());
          overrideIndex += 1;
          if (overrideIndex % 12 === 0) {
            this.emitProgress({
              phase: 'overrides',
              label: `Applying pack overrides (${overrideIndex})…`,
              percent: 78,
              indeterminate: true,
            });
          }
        }
      }

      await this.scanImportedContent(instance);
      instance.source = {
        ...instance.source,
        importedAt: new Date().toISOString(),
        files: totalFiles,
      };
      await this.save();
      await this.writeInstanceFile(instance, pack.gameVersion);
      this.emitProgress({
        phase: 'complete',
        label: `${packName} imported`,
        percent: 100,
        indeterminate: false,
      });
      this.log(`Imported "${packName}" with ${totalFiles} files and ${overrideIndex} overrides.`);
      return {
        instance: this.publicInstance(instance),
        modpacks: this.list(),
        importedFiles: totalFiles,
      };
    } catch (error) {
      if (created) {
        await this.remove(created.id).catch(() => {});
        this.log(`Import failed; removed the incomplete "${packName}" pack.`, 'warn');
      }
      this.emitProgress({
        phase: 'error',
        label: 'Import failed',
        percent: 0,
        indeterminate: false,
      });
      throw error;
    }
  }

  async scanImportedContent(instance) {
    const entries = [];
    const now = new Date().toISOString();
    for (const [type, folder] of Object.entries(CONTENT_FOLDERS)) {
      const directory = path.join(this.gameDir(instance.id), folder);
      let files;
      try {
        files = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!file.isFile()) continue;
        const fileName = safeFileName(file.name, '');
        if (!fileName || fileName !== file.name) continue;
        let size = 0;
        try {
          size = (await fsp.stat(path.join(directory, fileName))).size;
        } catch {
          continue;
        }
        const id = `mrpack-${crypto.createHash('sha1').update(`${folder}/${fileName}`).digest('hex').slice(0, 20)}`;
        entries.push({
          id,
          projectId: '',
          projectSlug: '',
          projectTitle: fileName,
          projectType: type,
          versionId: id,
          versionNumber: instance.source.packVersion || '',
          fileName,
          size,
          sha1: '',
          source: 'mrpack',
          installedAt: now,
          dependencies: [],
        });
      }
    }
    await this.writeContent(instance, entries);
    return entries;
  }

  async remove(versionId) {
    const instance = this.requireInstance(String(versionId || ''));
    this.instances = this.instances.filter((entry) => entry.id !== instance.id);
    await this.save();
    await fsp.rm(this.gameDir(instance.id), { recursive: true, force: true });
    await fsp.rm(this.paths.versionDir(instance.id), { recursive: true, force: true });
    this.log(`Deleted modpack "${instance.name}" (${instance.id}).`);
    return { modpacks: this.list(), removed: instance.id };
  }

  async removeContent(input = {}) {
    const instance = this.requireInstance(String(input.targetVersion || ''));
    const entryId = String(input.entryId || '');
    const entries = await this.readContent(instance);
    const entry = entries.find((item) => item.id === entryId || item.versionId === entryId);
    if (!entry) throw new Error('That content item is no longer installed.');

    const target = this.contentPath(instance, entry);
    await fsp.rm(target, { force: true });
    const next = entries.filter((item) => item !== entry);
    await this.writeContent(instance, next);
    this.log(`Removed ${CONTENT_LABELS[entry.projectType].toLowerCase()} "${entry.projectTitle}" from "${instance.name}".`);
    return { content: await this.listContent(instance.id), removed: entry };
  }
}

module.exports = {
  ModpackManager,
  CONTENT_FOLDERS,
  CONTENT_LABELS,
  safeFileName,
  uniqueFileName,
  normalizeStoredInstance,
  modrinthDownloadUrl,
};
