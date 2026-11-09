'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const USER_AGENT = 'EclipseClient/1.0.0';
const DEFAULT_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(target) {
  try {
    const stat = await fsp.stat(target);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

function platformName(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'osx';
  return 'linux';
}

function archName(arch = process.arch) {
  if (arch === 'ia32') return 'x86';
  if (arch === 'arm64') return 'arm64';
  return 'x64';
}

/**
 * Evaluate a single Mojang rule against the current environment.
 */
function ruleMatches(rule, context) {
  if (!rule || typeof rule !== 'object') return false;

  if (rule.os) {
    const os = rule.os;
    if (os.name && os.name !== context.osName) return false;
    if (os.arch && os.arch !== context.arch) return false;
    if (os.version) {
      try {
        if (!new RegExp(os.version).test(context.osVersion || '')) return false;
      } catch {
        return false;
      }
    }
  }

  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if (Boolean(context.features && context.features[feature]) !== Boolean(expected)) return false;
    }
  }

  return true;
}

/**
 * Minecraft rules are sequential: every matching rule overwrites the allow
 * state, starting from disallowed when rules exist.
 */
function isAllowedByRules(rules, context) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, context)) allowed = rule.action === 'allow';
  }
  return allowed;
}

function validateVersionId(versionId) {
  if (typeof versionId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(versionId)) {
    throw new Error(`Invalid version id: ${String(versionId)}`);
  }
  return versionId;
}

function validateAssetId(assetId) {
  if (typeof assetId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(assetId)) {
    throw new Error(`Invalid asset index id: ${String(assetId)}`);
  }
  return assetId;
}

/**
 * Join a root and metadata-provided relative path, refusing traversal.
 */
function safeJoin(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe path outside ${resolvedRoot}`);
  }
  return target;
}

function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}

function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid download URL: ${String(rawUrl)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`Refusing non-HTTPS download: ${rawUrl}`);
  return parsed;
}

/**
 * Download a file atomically, optionally checking its SHA-1 and size.
 * Retries transient failures and leaves no partial files behind.
 */
async function downloadFile(url, destination, options = {}) {
  const {
    sha1,
    sha512,
    size,
    signal,
    retries = DEFAULT_RETRIES,
    onProgress,
  } = options;

  assertSafeUrl(url);
  await ensureDir(path.dirname(destination));
  const partPath = `${destination}.part`;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) throw new Error('Download cancelled');
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow',
        signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (typeof size === 'number' && size >= 0 && buffer.length !== size) {
        throw new Error(`size mismatch (expected ${size}, received ${buffer.length})`);
      }
      if (sha1 && sha1Hex(buffer) !== String(sha1).toLowerCase()) {
        throw new Error('SHA-1 checksum mismatch');
      }
      if (sha512 && sha512Hex(buffer) !== String(sha512).toLowerCase()) {
        throw new Error('SHA-512 checksum mismatch');
      }

      await fsp.writeFile(partPath, buffer);
      await fsp.rm(destination, { force: true });
      await fsp.rename(partPath, destination);
      if (onProgress) onProgress(buffer.length);
      return buffer.length;
    } catch (error) {
      lastError = error;
      await fsp.rm(partPath, { force: true }).catch(() => {});
      if (signal && signal.aborted) throw new Error('Download cancelled');
      if (attempt < retries) await sleep(350 * attempt + Math.floor(Math.random() * 250));
    }
  }

  const display = url.length > 90 ? `${url.slice(0, 87)}...` : url;
  const reason = lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(`Could not download ${display} — ${reason}`);
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  assertSafeUrl(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
  return response.json();
}

async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  assertSafeUrl(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, application/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
  return response.text();
}

async function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(file, args, {
        windowsHide: true,
        env: options.env || process.env,
        timeout: 0,
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout, stderr, error: error.message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: null, stdout, stderr, error: 'Timed out' });
    }, options.timeout || 8000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * Bounded worker pool. Stops scheduling new work after the first failure and
 * waits for in-flight jobs to settle before rejecting.
 */
async function runPool(items, concurrency, worker, options = {}) {
  let nextIndex = 0;
  let firstError = null;
  const signal = options.signal;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (firstError || (signal && signal.aborted)) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        firstError = firstError || error;
        return;
      }
    }
  });

  await Promise.all(workers);
  if (firstError) throw firstError;
  if (signal && signal.aborted) throw new Error('Cancelled');
}

/**
 * Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name) implementation.
 */
function offlineUuid(name) {
  const digest = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

module.exports = {
  USER_AGENT,
  sleep,
  ensureDir,
  pathExists,
  fileSize,
  platformName,
  archName,
  ruleMatches,
  isAllowedByRules,
  validateVersionId,
  validateAssetId,
  safeJoin,
  sha1Hex,
  sha1File,
  sha512Hex,
  sha512File,
  downloadFile,
  fetchJson,
  fetchText,
  runCommand,
  runPool,
  offlineUuid,
  randomToken,
  stripAnsi,
  formatBytes,
};
