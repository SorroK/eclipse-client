'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { runCommand } = require('./utils');

function parseJavaVersionString(version) {
  if (!version) return 0;
  const match = String(version).match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  let major = Number(match[1]);
  if (major === 1 && match[2]) major = Number(match[2]);
  return Number.isFinite(major) ? major : 0;
}

function parseJavaOutput(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const properties = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{2,}([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/);
    if (match) properties[match[1]] = match[2];
  }

  let version = properties['java.version'];
  if (!version) {
    const match = text.match(/version "([^"]+)"/i);
    if (match) version = match[1];
  }
  if (!version) return null;

  let vendor = properties['java.vendor'] || '';
  if (!vendor) {
    if (/Zulu/i.test(text)) vendor = 'Azul Zulu';
    else if (/Temurin|Adoptium/i.test(text)) vendor = 'Eclipse Temurin';
    else if (/Microsoft/i.test(text)) vendor = 'Microsoft OpenJDK';
    else if (/Corretto/i.test(text)) vendor = 'Amazon Corretto';
    else if (/OpenJDK/i.test(text)) vendor = 'OpenJDK';
    else vendor = 'Java';
  }

  const major = parseJavaVersionString(version);
  if (!major) return null;

  return {
    version,
    major,
    vendor: String(vendor).trim(),
    arch: properties['os.arch'] || process.arch,
  };
}

async function probeJava(javaPath) {
  const result = await runCommand(javaPath, ['-XshowSettings:properties', '-version'], {
    timeout: 9000,
  });
  const info = parseJavaOutput(result.stdout, result.stderr);
  if (!info) return null;
  return {
    path: javaPath,
    ...info,
  };
}

function javaExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'java.exe' : 'java';
}

async function findJavaFiles(root, maxDepth, source, collected, state, platform = process.platform) {
  const queue = [{ dir: root, depth: 0 }];
  const exeName = javaExecutableName(platform);
  const exePattern = platform === 'win32' ? /^java\.exe$/i : /^java$/;

  while (queue.length && state.visited < 2500 && collected.length < 40) {
    const current = queue.shift();
    state.visited += 1;
    let entries;
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && exePattern.test(entry.name)) {
        collected.push({ path: fullPath, source });
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  // Keep the local variable referenced so callers can annotate sources if needed.
  void exeName;
}

function windowsBaseDirectories() {
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const home = os.homedir();

  return {
    jdkRoots: [
      path.join(programFiles, 'Java'),
      path.join(programFiles, 'Eclipse Adoptium'),
      path.join(programFiles, 'Eclipse Foundation'),
      path.join(programFiles, 'Zulu'),
      path.join(programFiles, 'Microsoft'),
      path.join(programFiles, 'BellSoft'),
      path.join(programFiles, 'Amazon Corretto'),
      path.join(programFiles, 'IBM'),
      path.join(programFiles, 'Semeru'),
      path.join(programFiles, 'Liberica'),
      path.join(programFiles, 'AdoptOpenJDK'),
      path.join(localAppData, 'Programs', 'Eclipse Adoptium'),
      path.join(localAppData, 'Programs', 'Microsoft'),
      path.join(home, '.jdks'),
      path.join(home, '.sdkman', 'candidates', 'java'),
    ],
    runtimeRoots: [
      path.join(programFilesX86, 'Minecraft Launcher', 'runtime'),
      path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
      path.join(home, '.minecraft', 'runtime'),
    ],
  };
}

function unixJavaDirectories(platform) {
  const roots = [
    { dir: '/usr/lib/jvm', depth: 3, source: 'Installed JDK' },
    { dir: '/usr/java', depth: 3, source: 'Installed JDK' },
    { dir: path.join(os.homedir(), '.sdkman', 'candidates', 'java'), depth: 3, source: 'SDKMAN' },
    { dir: path.join(os.homedir(), '.jdks'), depth: 2, source: 'Installed JDK' },
    { dir: path.join(os.homedir(), '.minecraft', 'runtime'), depth: 5, source: 'Mojang runtime' },
  ];
  if (platform === 'darwin') {
    roots.push({ dir: '/Library/Java/JavaVirtualMachines', depth: 4, source: 'Installed JDK' });
  }
  return roots;
}

/**
 * Find Java installations from PATH, JAVA_HOME, common JDK folders and
 * Mojang's own runtime directories. Every candidate is verified by running it.
 */
async function detectJavaInstallations(options = {}) {
  const platform = options.platform || process.platform;
  const extraPaths = options.extraPaths || [];
  const executable = javaExecutableName(platform);
  const exact = [];
  const roots = [];
  const state = { visited: 0 };

  if (process.env.JAVA_HOME) {
    exact.push({ path: path.join(process.env.JAVA_HOME, 'bin', executable), source: 'JAVA_HOME' });
  }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    exact.push({ path: path.join(dir, executable), source: 'PATH' });
  }

  for (const extra of extraPaths) {
    if (extra) exact.push({ path: extra, source: 'Custom' });
  }

  if (platform === 'win32') {
    const { jdkRoots, runtimeRoots } = windowsBaseDirectories();
    for (const dir of jdkRoots) roots.push({ dir, depth: 3, source: 'Installed JDK' });
    for (const dir of runtimeRoots) roots.push({ dir, depth: 6, source: 'Mojang runtime' });
  } else {
    roots.push(...unixJavaDirectories(platform));
  }

  const collected = [];
  for (const candidate of exact) {
    try {
      const stat = await fsp.stat(candidate.path);
      if (stat.isFile()) collected.push(candidate);
    } catch {
      /* not present */
    }
  }

  for (const root of roots) {
    try {
      const stat = await fsp.stat(root.dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    await findJavaFiles(root.dir, root.depth, root.source, collected, state, platform);
  }

  // Deduplicate by real path where possible.
  const unique = new Map();
  for (const candidate of collected) {
    let resolved = candidate.path;
    try {
      resolved = await fsp.realpath(candidate.path);
    } catch {
      continue;
    }
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!unique.has(key)) unique.set(key, { path: resolved, source: candidate.source });
  }

  const candidates = Array.from(unique.values()).slice(0, 24);
  const probed = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await probeJava(candidate.path);
        if (!info) return null;
        return { ...info, source: candidate.source };
      } catch {
        return null;
      }
    }),
  );

  return probed
    .filter(Boolean)
    .sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
}

/**
 * Pick the most appropriate installed Java for a required major version.
 * Java 8-era versions require exactly 8; modern versions accept the closest
 * version at or above their minimum.
 */
function selectJava(installations, requiredMajor) {
  if (!Array.isArray(installations) || !installations.length) return null;
  const required = Number(requiredMajor) || 8;

  if (required <= 8) {
    return installations
      .filter((entry) => entry.major === 8)
      .sort((a, b) => String(b.version).localeCompare(String(a.version)))[0] || null;
  }

  const compatible = installations
    .filter((entry) => entry.major >= required)
    .sort((a, b) => {
      if (a.major !== b.major) return a.major - b.major;
      return String(b.version).localeCompare(String(a.version));
    });

  return compatible[0] || null;
}

module.exports = {
  parseJavaVersionString,
  parseJavaOutput,
  probeJava,
  detectJavaInstallations,
  selectJava,
};
