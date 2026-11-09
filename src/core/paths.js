'use strict';

const path = require('path');
const { safeJoin, validateVersionId, validateAssetId, ensureDir } = require('./utils');

class LauncherPaths {
  constructor(root) {
    this.root = path.resolve(root);
    this.libraries = path.join(this.root, 'libraries');
    this.assets = path.join(this.root, 'assets');
    this.assetObjects = path.join(this.assets, 'objects');
    this.assetIndexes = path.join(this.assets, 'indexes');
    this.versions = path.join(this.root, 'versions');
    this.logConfigs = path.join(this.assets, 'log_configs');
    this.cache = path.join(this.root, 'cache');
  }

  async ensureBaseDirs() {
    await Promise.all([
      ensureDir(this.libraries),
      ensureDir(this.assets),
      ensureDir(this.assetObjects),
      ensureDir(this.assetIndexes),
      ensureDir(this.versions),
      ensureDir(this.logConfigs),
      ensureDir(this.cache),
    ]);
  }

  versionDir(versionId) {
    return safeJoin(this.versions, validateVersionId(versionId));
  }

  versionJson(versionId) {
    const id = validateVersionId(versionId);
    return safeJoin(this.versionDir(id), `${id}.json`);
  }

  clientJar(versionId) {
    const id = validateVersionId(versionId);
    return safeJoin(this.versionDir(id), `${id}.jar`);
  }

  nativesDir(versionId) {
    return safeJoin(this.versionDir(versionId), 'natives');
  }

  completionMarker(versionId) {
    return safeJoin(this.versionDir(versionId), '.complete');
  }

  libraryPath(relativePath) {
    return safeJoin(this.libraries, relativePath);
  }

  assetIndex(assetId) {
    return safeJoin(this.assetIndexes, `${validateAssetId(assetId)}.json`);
  }

  assetObject(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/i.test(hash)) {
      throw new Error('Invalid asset hash');
    }
    const normalized = hash.toLowerCase();
    return safeJoin(this.assetObjects, normalized.slice(0, 2), normalized);
  }

  virtualAssets(assetId) {
    return safeJoin(this.assets, 'virtual', validateAssetId(assetId));
  }

  logConfig(fileId) {
    if (typeof fileId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(fileId)) {
      throw new Error('Invalid logging config id');
    }
    return safeJoin(this.logConfigs, fileId);
  }
}

module.exports = { LauncherPaths };
