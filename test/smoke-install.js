'use strict';

/**
 * End-to-end downloader smoke test against the live Mojang API.
 *
 * Usage:
 *   node test/smoke-install.js [version]
 *   ECLIPSE_CLIENT_SMOKE_ROOT=.tmp/other-mc node test/smoke-install.js 1.20.1
 */

const fs = require('fs');
const path = require('path');
const { LauncherPaths } = require('../src/core/paths');
const { fetchManifest, findVersion } = require('../src/core/manifest');
const { Installer } = require('../src/core/installer');
const { buildLaunchCommand } = require('../src/core/launch');
const { detectJavaInstallations, selectJava } = require('../src/core/java');
const { offlineUuid, formatBytes } = require('../src/core/utils');

async function main() {
  const root = path.resolve(process.env.ECLIPSE_CLIENT_SMOKE_ROOT || '.tmp/smoke-minecraft');
  const paths = new LauncherPaths(root);
  console.log(`Smoke data directory: ${paths.root}`);

  const manifest = await fetchManifest();
  const versionId = process.argv[2] || manifest.latest.release;
  const entry = findVersion(manifest, versionId);
  if (!entry) throw new Error(`Version ${versionId} was not found in Mojang's manifest`);
  console.log(`Installing Minecraft ${versionId} (${entry.type})`);

  let lastStage = '';
  let lastPrint = 0;
  const installer = new Installer({
    paths,
    concurrency: Number(process.env.ECLIPSE_CLIENT_CONCURRENCY) || 12,
    log: (message) => console.log(`[launcher] ${message}`),
    onProgress: (progress) => {
      if (progress.stage === 'metadata') return;
      const now = Date.now();
      if (progress.stage !== lastStage || now - lastPrint > 2000) {
        lastStage = progress.stage;
        lastPrint = now;
        const bytes =
          progress.bytesTotal > 0
            ? `${formatBytes(progress.bytesDone || 0)} / ${formatBytes(progress.bytesTotal)}`
            : '';
        console.log(
          `${progress.percent || 0}%  ${progress.label || progress.stage}  ${
            progress.filesDone || 0
          }/${progress.filesTotal || 0} files ${bytes}`,
        );
      }
    },
  });

  const started = Date.now();
  const result = await installer.ensure(versionId, { entry, gameDir: paths.root });
  console.log(`Installed in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const marker = JSON.parse(fs.readFileSync(paths.completionMarker(versionId), 'utf8'));
  console.log(`Marker: ${JSON.stringify(marker)}`);

  const javaInstallations = await detectJavaInstallations();
  console.log(
    `Detected Java: ${javaInstallations
      .map((java) => `${java.major} (${java.vendor}, ${java.path})`)
      .join('; ') || 'none'}`,
  );
  const requiredMajor = result.meta.javaVersion?.majorVersion || 8;
  const java = selectJava(javaInstallations, requiredMajor);
  if (!java) throw new Error(`No compatible Java ${requiredMajor} installation found`);

  const command = buildLaunchCommand({
    meta: result.meta,
    paths,
    versionId,
    account: {
      name: 'SmokeTest',
      uuid: offlineUuid('SmokeTest'),
      accessToken: '0',
      type: 'offline',
    },
    settings: {
      memoryMb: 2048,
      customResolution: false,
      resolutionWidth: 1280,
      resolutionHeight: 720,
    },
    javaPath: java.path,
    gameDir: paths.root,
    assetIndex: result.assetIndex,
    verifyFiles: true,
  });

  const unresolved = command.args.filter((arg) => arg.includes('${'));
  if (unresolved.length) throw new Error(`Unresolved placeholders: ${unresolved.join(', ')}`);
  const classpathEntries = command.classpath.split(path.delimiter).filter(Boolean);
  const missing = classpathEntries.filter((entryPath) => !fs.existsSync(entryPath));
  if (missing.length) throw new Error(`Missing classpath entries: ${missing.join(', ')}`);

  console.log(
    `Launch command OK: ${command.args.length} args, ${classpathEntries.length} classpath entries, Java ${java.version} (${java.vendor})`,
  );
  console.log(`Assets root: ${command.assetRoot}`);
  console.log(`Natives: ${command.nativesDirectory}`);
  console.log('SMOKE TEST PASSED');
}

main().catch((error) => {
  console.error('SMOKE TEST FAILED');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
