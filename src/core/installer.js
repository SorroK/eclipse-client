'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const {
  downloadFile,
  fetchJson,
  ensureDir,
  pathExists,
  isAllowedByRules,
  platformName,
  archName,
  safeJoin,
  sha1File,
  formatBytes,
  validateVersionId,
  runPool,
} = require('./utils');
const { getAssetRoot } = require('./launch');

const RESOURCE_BASE = 'https://resources.download.minecraft.net';
const STAGE_LABELS = {
  metadata: 'Reading version data',
  client: 'Downloading game client',
  library: 'Downloading libraries',
  native: 'Downloading native libraries',
  logging: 'Downloading logging config',
  asset: 'Downloading assets',
  natives: 'Extracting native libraries',
  assets_prep: 'Preparing legacy assets',
  complete: 'Install complete',
};

class Installer {
  constructor(options) {
    this.paths = options.paths;
    this.log = options.log || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.platform = options.platform || process.platform;
    this.concurrency = options.concurrency || 8;
    this.lastEmit = 0;
  }

  emitProgress(payload, force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 110) return;
    this.lastEmit = now;
    try {
      this.onProgress(payload);
    } catch {
      /* UI may be gone */
    }
  }

  async isInstalled(versionId) {
    const id = validateVersionId(versionId);
    return (
      (await pathExists(this.paths.completionMarker(id))) &&
      (await pathExists(this.paths.versionJson(id))) &&
      (await pathExists(this.paths.clientJar(id)))
    );
  }

  async readAssetIndex(meta) {
    if (!meta || !meta.assetIndex || !meta.assetIndex.id) return null;
    const indexFile = this.paths.assetIndex(meta.assetIndex.id);
    try {
      return JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async getExisting(versionId) {
    const id = validateVersionId(versionId);
    const meta = JSON.parse(await fsp.readFile(this.paths.versionJson(id), 'utf8'));
    const assetIndex = await this.readAssetIndex(meta);
    let installedAt = null;
    try {
      const marker = JSON.parse(await fsp.readFile(this.paths.completionMarker(id), 'utf8'));
      installedAt = marker.installedAt || null;
    } catch {
      /* marker is optional for the summary */
    }
    return {
      versionId: id,
      meta,
      assetIndex,
      assetRoot: getAssetRoot(this.paths, meta, assetIndex),
      nativesDirectory: this.paths.nativesDir(id),
      installedAt,
      resumable: false,
    };
  }

  async isLaunchReady(versionId) {
    const id = validateVersionId(versionId);
    try {
      if (!(await this.isInstalled(id))) return false;
      const meta = JSON.parse(await fsp.readFile(this.paths.versionJson(id), 'utf8'));
      if (meta.assetIndex && meta.assetIndex.id) {
        if (!(await pathExists(this.paths.assetIndex(meta.assetIndex.id)))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async canUseExisting(versionId) {
    const id = validateVersionId(versionId);
    try {
      if (!(await this.isLaunchReady(id))) return false;
      const meta = JSON.parse(await fsp.readFile(this.paths.versionJson(id), 'utf8'));
      const context = this.ruleContext();
      const required = [];
      for (const library of meta.libraries || []) {
        if (!isAllowedByRules(library.rules, context)) continue;
        const artifact = library.downloads && library.downloads.artifact;
        if (!artifact || !artifact.path) continue;
        required.push(safeJoin(this.paths.libraries, artifact.path));
      }
      const present = await Promise.all(required.map((file) => pathExists(file)));
      if (present.includes(false)) return false;
      return pathExists(this.paths.clientJar(id));
    } catch {
      return false;
    }
  }

  /**
   * Returns a launch-ready summary, installing or repairing the version if
   * anything essential is missing.
   */
  async ensure(versionId, options = {}) {
    if (await this.canUseExisting(versionId)) return this.getExisting(versionId);
    return this.install(versionId, options);
  }

  ruleContext() {
    return {
      osName: platformName(this.platform),
      osVersion: require('os').release(),
      arch: archName(process.arch),
      features: {},
    };
  }

  async resolveMeta(versionId, entry) {
    const versionFile = this.paths.versionJson(versionId);
    try {
      const local = JSON.parse(await fsp.readFile(versionFile, 'utf8'));
      if (local && local.mainClass) return local;
    } catch {
      /* Fall through to the network */
    }

    if (!entry || !entry.url) {
      throw new Error(
        `Minecraft ${versionId} is not installed and no metadata is available. Refresh the version list and try again.`,
      );
    }

    this.log(`Fetching metadata for Minecraft ${versionId}...`);
    const meta = await fetchJson(entry.url, { timeoutMs: 30000 });
    if (!meta || typeof meta !== 'object' || !meta.mainClass) {
      throw new Error(`Mojang returned invalid metadata for Minecraft ${versionId}`);
    }
    await ensureDir(path.dirname(versionFile));
    await fsp.writeFile(versionFile, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async ensureAssetIndex(meta, signal) {
    if (!meta.assetIndex || !meta.assetIndex.url) return null;
    const assetId = meta.assetIndex.id;
    const destination = this.paths.assetIndex(assetId);
    const expectedSha1 = meta.assetIndex.sha1;

    if (await pathExists(destination)) {
      try {
        if (!expectedSha1 || (await sha1File(destination)) === String(expectedSha1).toLowerCase()) {
          return JSON.parse(await fsp.readFile(destination, 'utf8'));
        }
      } catch {
        /* Re-download below */
      }
    }

    this.emitProgress(
      {
        stage: 'metadata',
        label: 'Fetching asset index',
        indeterminate: true,
        percent: 0,
      },
      true,
    );
    this.log(`Fetching asset index ${assetId}...`);
    await downloadFile(meta.assetIndex.url, destination, {
      sha1: expectedSha1,
      size: meta.assetIndex.size,
      signal,
    });
    return JSON.parse(await fsp.readFile(destination, 'utf8'));
  }

  buildPlan(meta, assetIndex, versionId, gameDir) {
    const context = this.ruleContext();
    const tasks = [];
    const seenDestinations = new Set();
    const nativeJars = [];
    let order = 0;

    const addTask = (task) => {
      if (!task || !task.url || !task.dest) return;
      if (seenDestinations.has(task.dest)) return;
      seenDestinations.add(task.dest);
      tasks.push(task);
    };

    const client = meta.downloads && meta.downloads.client;
    if (!client || !client.url) {
      throw new Error(`Minecraft ${versionId} metadata does not contain a game client download`);
    }
    addTask({
      url: client.url,
      dest: this.paths.clientJar(versionId),
      sha1: client.sha1,
      size: client.size,
      kind: 'client',
      label: 'game client',
      order: order++,
    });

    const classpath = [];
    for (const library of meta.libraries || []) {
      if (!isAllowedByRules(library.rules, context)) continue;

      const artifact = library.downloads && library.downloads.artifact;
      if (artifact && artifact.path) {
        const destination = safeJoin(this.paths.libraries, artifact.path);
        if (artifact.url) {
          addTask({
            url: artifact.url,
            dest: destination,
            sha1: artifact.sha1,
            size: artifact.size,
            kind: 'library',
            label: artifact.path.split('/').pop(),
            order: order++,
          });
        }
        classpath.push(destination);
      }

      const nativeClassifier = library.natives && library.natives[platformName(this.platform)];
      if (nativeClassifier) {
        const nativeArtifact =
          library.downloads &&
          library.downloads.classifiers &&
          library.downloads.classifiers[nativeClassifier];
        if (nativeArtifact && nativeArtifact.path && nativeArtifact.url) {
          const destination = safeJoin(this.paths.libraries, nativeArtifact.path);
          addTask({
            url: nativeArtifact.url,
            dest: destination,
            sha1: nativeArtifact.sha1,
            size: nativeArtifact.size,
            kind: 'native',
            label: nativeArtifact.path.split('/').pop(),
            order: order++,
          });
          nativeJars.push({
            jar: destination,
            name: library.name,
            exclude: (library.extract && library.extract.exclude) || [],
          });
        }
      }
    }

    const loggingFile = meta.logging && meta.logging.client && meta.logging.client.file;
    if (loggingFile && loggingFile.url && loggingFile.id) {
      addTask({
        url: loggingFile.url,
        dest: this.paths.logConfig(loggingFile.id),
        sha1: loggingFile.sha1,
        size: loggingFile.size,
        kind: 'logging',
        label: loggingFile.id,
        order: order++,
      });
    }

    let assetObjectCount = 0;
    if (assetIndex && assetIndex.objects) {
      for (const [name, object] of Object.entries(assetIndex.objects)) {
        if (!object || typeof object.hash !== 'string' || !/^[0-9a-f]{40}$/i.test(object.hash)) {
          continue;
        }
        const hash = object.hash.toLowerCase();
        const destination = this.paths.assetObject(hash);
        assetObjectCount += 1;
        addTask({
          url: `${RESOURCE_BASE}/${hash.slice(0, 2)}/${hash}`,
          dest: destination,
          sha1: hash,
          size: object.size,
          kind: 'asset',
          label: name,
          order: order++,
        });
      }
    }

    tasks.sort((a, b) => a.order - b.order);
    const totalBytes = tasks.reduce((sum, task) => sum + (Number(task.size) || 0), 0);

    return {
      tasks,
      nativeJars,
      classpath,
      assetObjectCount,
      totalBytes,
      gameDir,
      assetRoot: getAssetRoot(this.paths, meta, assetIndex),
    };
  }

  async downloadTasks(versionId, plan, signal) {
    let filesDone = 0;
    let bytesDone = 0;
    const totalFiles = plan.tasks.length;

    for (const task of plan.tasks) {
      const stat = await fsp.stat(task.dest).catch(() => null);
      if (stat && stat.isFile() && (!task.size || stat.size === task.size)) {
        task.skip = true;
        filesDone += 1;
        bytesDone += Number(task.size) || stat.size;
      }
    }

    const totalBytes = plan.totalBytes;
    const stageForKind = {
      client: 'client',
      library: 'library',
      native: 'native',
      logging: 'logging',
      asset: 'asset',
    };
    let currentStage = plan.tasks.find((task) => !task.skip)?.kind || 'asset';
    let currentFile = '';

    const emit = (force = false) => {
      const percent =
        totalBytes > 0
          ? Math.min(99, Math.round((bytesDone / totalBytes) * 100))
          : Math.min(99, Math.round((filesDone / Math.max(1, totalFiles)) * 100));
      this.emitProgress(
        {
          versionId,
          stage: stageForKind[currentStage] || 'asset',
          label: STAGE_LABELS[stageForKind[currentStage]] || 'Downloading files',
          percent,
          bytesDone,
          bytesTotal: totalBytes,
          filesDone,
          filesTotal: totalFiles,
          currentFile,
          indeterminate: false,
          totalBytesLabel: formatBytes(totalBytes),
          doneBytesLabel: formatBytes(bytesDone),
        },
        force,
      );
    };

    this.log(
      `Install plan: ${totalFiles} files (${formatBytes(totalBytes)}); ${
        plan.tasks.filter((task) => task.skip).length
      } already present.`,
    );
    emit(true);

    const pending = plan.tasks.filter((task) => !task.skip);
    await runPool(
      pending,
      this.concurrency,
      async (task) => {
        currentStage = task.kind;
        currentFile = task.label;
        await downloadFile(task.url, task.dest, {
          sha1: task.sha1,
          size: task.size,
          signal,
          onProgress: () => {
            bytesDone += Number(task.size) || 0;
            filesDone += 1;
            emit();
          },
        });
      },
      { signal },
    );

    filesDone = totalFiles;
    bytesDone = totalBytes;
    emit(true);
    return { filesDone, bytesDone };
  }

  async extractNatives(versionId, nativeJars) {
    if (!nativeJars.length) return;
    const nativesDirectory = this.paths.nativesDir(versionId);
    await ensureDir(nativesDirectory);
    this.log(`Extracting ${nativeJars.length} native libraries...`);

    for (const nativeJar of nativeJars) {
      let zip;
      try {
        zip = new AdmZip(nativeJar.jar);
      } catch (error) {
        throw new Error(`Could not read native library ${path.basename(nativeJar.jar)}: ${error.message}`);
      }

      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName.replace(/\\/g, '/');
        if (!entryName || entryName.includes('\u0000')) continue;
        const excluded = [...(nativeJar.exclude || []), 'META-INF/'].some((pattern) =>
          entryName.startsWith(String(pattern).replace(/\\/g, '/')),
        );
        if (excluded) continue;

        let destination;
        try {
          destination = safeJoin(nativesDirectory, entryName);
        } catch {
          continue;
        }
        await ensureDir(path.dirname(destination));
        await fsp.writeFile(destination, entry.getData());
      }
    }
  }

  async prepareLegacyAssets(meta, assetIndex, gameDir, signal) {
    if (!assetIndex) return;
    const targets = [];
    if (assetIndex.virtual && meta.assets) {
      targets.push(this.paths.virtualAssets(meta.assets));
    }
    if (assetIndex.map_to_resources) {
      targets.push(path.join(gameDir, 'resources'));
    }
    if (!targets.length) return;

    const entries = Object.entries(assetIndex.objects || {});
    this.log(`Preparing ${entries.length} legacy asset files...`);
    this.emitProgress(
      {
        stage: 'assets_prep',
        label: STAGE_LABELS.assets_prep,
        percent: 99,
        indeterminate: true,
      },
      true,
    );

    for (const [name, object] of entries) {
      if (signal && signal.aborted) throw new Error('Installation cancelled');
      const source = this.paths.assetObject(object.hash);
      if (!(await pathExists(source))) {
        throw new Error(`Legacy asset ${name} is missing from the object cache`);
      }
      for (const targetRoot of targets) {
        let destination;
        try {
          destination = safeJoin(targetRoot, name);
        } catch {
          continue;
        }
        await ensureDir(path.dirname(destination));
        const existing = await fsp.stat(destination).catch(() => null);
        if (existing && existing.isFile() && existing.size === object.size) continue;
        try {
          await fsp.link(source, destination);
        } catch {
          await fsp.copyFile(source, destination);
        }
      }
    }
  }

  async install(versionId, options = {}) {
    const id = validateVersionId(versionId);
    const gameDir = options.gameDir || this.paths.root;
    const signal = options.signal;
    await this.paths.ensureBaseDirs();
    await ensureDir(gameDir);

    this.emitProgress(
      {
        versionId: id,
        stage: 'metadata',
        label: STAGE_LABELS.metadata,
        percent: 0,
        indeterminate: true,
      },
      true,
    );

    const meta = await this.resolveMeta(id, options.entry);
    if (meta.assetIndex && meta.assetIndex.id) {
      await ensureDir(this.paths.assetIndexes);
    }
    const assetIndex = await this.ensureAssetIndex(meta, signal);
    const plan = this.buildPlan(meta, assetIndex, id, gameDir);

    this.log(
      `Installing Minecraft ${id}: ${plan.tasks.length} files, ${plan.assetObjectCount} assets, ${formatBytes(
        plan.totalBytes,
      )} total.`,
    );

    await this.downloadTasks(id, plan, signal);
    await this.extractNatives(id, plan.nativeJars);
    await this.prepareLegacyAssets(meta, assetIndex, gameDir, signal);

    const nativesDirectory = this.paths.nativesDir(id);
    for (const subdirectory of ['java', 'jna', 'lwjgl', 'netty']) {
      await ensureDir(path.join(nativesDirectory, subdirectory));
    }

    const installedAt = new Date().toISOString();
    await fsp.writeFile(
      this.paths.completionMarker(id),
      JSON.stringify(
        {
          versionId: id,
          installedAt,
          assetIndex: meta.assets || null,
        },
        null,
        2,
      ),
      'utf8',
    );

    this.emitProgress(
      {
        versionId: id,
        stage: 'complete',
        label: STAGE_LABELS.complete,
        percent: 100,
        bytesDone: plan.totalBytes,
        bytesTotal: plan.totalBytes,
        filesDone: plan.tasks.length,
        filesTotal: plan.tasks.length,
        currentFile: '',
        indeterminate: false,
        installed: true,
      },
      true,
    );
    this.log(`Minecraft ${id} is ready to launch.`);

    return {
      versionId: id,
      meta,
      assetIndex,
      assetRoot: getAssetRoot(this.paths, meta, assetIndex),
      nativesDirectory,
      installedAt,
      resumable: true,
    };
  }
}

module.exports = { Installer, STAGE_LABELS };
