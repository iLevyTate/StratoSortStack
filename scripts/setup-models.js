#!/usr/bin/env node
/**
 * Model Setup Script
 *
 * Downloads recommended GGUF models for node-llama-cpp.
 * Supports --check mode to verify model availability and --download mode to fetch models.
 *
 * Usage:
 *   node scripts/setup-models.js          # Interactive mode
 *   node scripts/setup-models.js --check  # Check if models are available
 *   node scripts/setup-models.js --auto   # Download recommended models automatically
 *   node scripts/setup-models.js --download # Same as --auto
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { createWriteStream, createReadStream } = require('fs');
const { getRecommendedModels } = require('../src/shared/modelRegistry');

// SECURITY: mirror ModelDownloadManager's download hardening so the
// postinstall path has the same supply-chain guarantees as the in-app
// downloader. Any drift here is a regression worth catching in review.
const REQUIRED_SHA256_REGEX = /^[a-f0-9]{64}$/i;
const ALLOWED_MODEL_DOWNLOAD_HOSTS = Object.freeze(['huggingface.co', 'hf.co']);
const MAX_REDIRECTS = 5;

function isValidSha256(value) {
  return typeof value === 'string' && REQUIRED_SHA256_REGEX.test(value.trim());
}

function isAllowedDownloadHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return ALLOWED_MODEL_DOWNLOAD_HOSTS.some(
    (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`)
  );
}

function validateDownloadUrl(rawUrl, filename) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid download URL for ${filename}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Blocked non-HTTPS model download for ${filename} (got ${parsedUrl.protocol}//${parsedUrl.host})`
    );
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(`Blocked credentialed download URL for ${filename}`);
  }
  if (!isAllowedDownloadHost(parsedUrl.hostname)) {
    throw new Error(`Blocked download from untrusted host for ${filename}: ${parsedUrl.hostname}`);
  }
  return parsedUrl;
}

function verifyChecksum(filePath, expectedHash) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex').toLowerCase();
      const expected = String(expectedHash || '')
        .trim()
        .toLowerCase();
      resolve({ ok: actual === expected, actual, expected });
    });
    stream.on('error', reject);
  });
}

function buildRecommendedModels() {
  const recommended = getRecommendedModels();
  const models = {};

  for (const [name, info] of Object.entries(recommended)) {
    models[name] = {
      type: info.type,
      displayName: info.displayName,
      description: info.description,
      size: info.size,
      url: info.url,
      checksum: info.checksum || info.sha256 || null
    };

    if (info.clipModel) {
      models[info.clipModel.name] = {
        type: 'vision-helper',
        displayName: 'Vision Projector (mmproj)',
        description: `Required for ${info.displayName}`,
        size: info.clipModel.size,
        url: info.clipModel.url,
        checksum: info.clipModel.checksum || info.clipModel.sha256 || null
      };
    }
  }

  return models;
}

// Model registry (derived from shared model registry)
const RECOMMENDED_MODELS = buildRecommendedModels();

/**
 * Resolve the app name the way Electron does: `app.name` prefers package.json
 * `productName` and falls back to `name`. The running app resolves models via
 * `app.getPath('userData')` => "<APPDATA>/StratoSort Core/models" — using the
 * npm `name` here ("stratosort-core") downloaded gigabytes into a directory
 * the app never reads.
 */
function getAppName() {
  try {
    const pkg = require('../package.json');
    return pkg.productName || pkg.name || 'StratoSort Core';
  } catch {
    return 'StratoSort Core';
  }
}

/**
 * Get the models directory, matching Electron's `app.getPath('userData')/models`.
 *
 * Platform conventions (mirrors Electron's path resolution):
 *   Windows: %APPDATA%/<appName>/models
 *   macOS:   ~/Library/Application Support/<appName>/models
 *   Linux:   $XDG_CONFIG_HOME/<appName>/models  (defaults to ~/.config)
 */
function getModelsPath() {
  const appName = getAppName();
  const home = process.env.HOME || process.env.USERPROFILE;

  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      appName,
      'models'
    );
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName, 'models');
  } else {
    // Electron uses XDG_CONFIG_HOME (not XDG_DATA_HOME) for app.getPath('userData')
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName, 'models');
  }
}

// Format bytes to human-readable
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const MIN_SIZE_RATIO = 0.9;

// Check if model exists and is likely complete
async function getModelStatus(modelPath, expectedSize) {
  try {
    const stat = await fs.stat(modelPath);
    if (!stat?.isFile?.() || stat.size <= 0) {
      return { exists: false, size: 0, complete: false };
    }

    if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
      return { exists: true, size: stat.size, complete: true };
    }

    const complete = stat.size >= expectedSize * MIN_SIZE_RATIO;
    return { exists: true, size: stat.size, complete };
  } catch {
    return { exists: false, size: 0, complete: false };
  }
}

// Download a file with progress.
//
// SECURITY (supply chain):
//   - Every URL (including every redirect target) is validated against the
//     HTTPS + host allowlist before any bytes are read.
//   - Redirects are resolved relative to the current URL and re-validated.
//   - We NEVER follow a redirect that leaves https:// or the host allowlist,
//     even if the server returns 3xx to a http://evil.example URL.
//   - Bytes are written to `<destPath>.partial`. The caller (downloadModels)
//     verifies SHA-256 against the expected checksum BEFORE renaming to
//     `destPath`. On checksum mismatch / non-retryable error the partial is
//     unlinked so the next run starts clean.
//   - Max redirect depth is bounded to prevent infinite chains.
async function downloadFile(initialUrl, destPath, filename, redirectsLeft = MAX_REDIRECTS) {
  validateDownloadUrl(initialUrl, filename); // fail before opening a write stream

  const partialPath = destPath + '.partial';

  let startByte = 0;
  try {
    const stat = await fs.stat(partialPath);
    if (stat?.isFile?.() && stat.size > 0) {
      startByte = stat.size;
    }
  } catch {
    startByte = 0;
  }

  return new Promise((resolve, reject) => {
    const file = createWriteStream(partialPath, { flags: startByte > 0 ? 'a' : 'w' });
    let downloadedBytes = startByte;
    let totalBytes = 0;
    let lastLogTime = 0;
    let settled = false;

    const fail = (err, { cleanup = true } = {}) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        if (cleanup) {
          fs.unlink(partialPath).catch(() => {});
        }
        reject(err);
      });
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      file.close(() => resolve({ partialPath }));
    };

    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    const request = https.get(initialUrl, { headers }, (response) => {
      const status = response.statusCode;

      // Validated redirect handling: only https + allowlisted hosts, bounded depth.
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const location = response.headers.location;
        if (!location) {
          fail(new Error(`Redirect without Location header from ${initialUrl}`));
          return;
        }
        if (redirectsLeft <= 0) {
          fail(new Error(`Exceeded max redirects (${MAX_REDIRECTS}) for ${filename}`));
          return;
        }
        let resolvedRedirect;
        try {
          resolvedRedirect = new URL(location, initialUrl).toString();
        } catch {
          fail(new Error(`Invalid redirect target for ${filename}: ${location}`));
          return;
        }
        try {
          validateDownloadUrl(resolvedRedirect, filename);
        } catch (err) {
          // Do NOT cleanup partial here: the redirect may fail because of a
          // transient policy violation (host outage, etc). Preserve partial
          // so a later retry can resume from the same byte offset.
          fail(err, { cleanup: false });
          return;
        }
        response.resume(); // drain
        // Close the current write stream; the recursive call opens a fresh one.
        settled = true;
        file.close(() => {
          downloadFile(resolvedRedirect, destPath, filename, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        });
        return;
      }

      // If server ignored Range, we have to restart clean (server sends a
      // full body starting at byte 0 with status 200).
      if (startByte > 0 && status === 200) {
        settled = true;
        file.close(() => {
          fs.unlink(partialPath)
            .catch(() => {})
            .then(() => downloadFile(initialUrl, destPath, filename, redirectsLeft))
            .then(resolve)
            .catch(reject);
        });
        return;
      }

      if (status !== 200 && status !== 206) {
        fail(new Error(`HTTP ${status}: ${response.statusMessage} for ${filename}`));
        return;
      }

      const contentLength = parseInt(response.headers['content-length'], 10) || 0;
      const contentRange = response.headers['content-range'];
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        totalBytes = match ? parseInt(match[1], 10) : startByte + contentLength;
      } else {
        totalBytes = startByte + contentLength;
      }

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastLogTime > 2000) {
          const progress = totalBytes
            ? ((downloadedBytes / totalBytes) * 100).toFixed(1)
            : 'unknown';
          process.stdout.write(
            `\r  Progress: ${formatSize(downloadedBytes)} / ${formatSize(totalBytes)} (${progress}%)    `
          );
          lastLogTime = now;
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        process.stdout.write('\n');
        succeed();
      });

      file.on('error', (error) => fail(error));
      response.on('error', (error) => fail(error));
    });

    request.on('error', (error) => fail(error));

    // Allow large files to download over slower connections (5 minute inactivity window).
    request.setTimeout(300000, () => {
      request.destroy(new Error('Download timeout'));
    });
  });
}

// Main functions
async function checkModels() {
  console.log('Checking for GGUF models...\n');

  const modelsPath = getModelsPath();
  let allFound = true;

  for (const [name, info] of Object.entries(RECOMMENDED_MODELS)) {
    const modelPath = path.join(modelsPath, name);
    const status = await getModelStatus(modelPath, info.size);

    if (status.complete) {
      console.log(`✅ ${info.displayName} (${name})`);
      continue;
    }

    if (status.exists) {
      console.log(
        `⚠️  ${info.displayName} (${name}) - Incomplete (${formatSize(status.size)} of ${formatSize(info.size)})`
      );
    } else {
      console.log(`❌ ${info.displayName} (${name}) - Not found`);
    }
    allFound = false;
  }

  console.log('\nModels directory:', modelsPath);

  if (allFound) {
    console.log('\n✅ All recommended models are available.');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some models are missing. Run with --download to fetch them.');
    process.exit(1);
  }
}

async function downloadModels() {
  console.log('Downloading recommended GGUF models...\n');

  const modelsPath = getModelsPath();

  await fs.mkdir(modelsPath, { recursive: true });

  // Pre-flight: every model MUST have a valid SHA-256 and a valid HTTPS
  // allowlisted URL. We fail fast before touching the network so a bad
  // registry entry (missing checksum, wrong host) doesn't silently ship.
  const failedPreflight = [];
  for (const [name, info] of Object.entries(RECOMMENDED_MODELS)) {
    if (!isValidSha256(info.checksum)) {
      failedPreflight.push(`${name}: missing or invalid SHA-256 checksum in model registry`);
      continue;
    }
    try {
      validateDownloadUrl(info.url, name);
    } catch (err) {
      failedPreflight.push(`${name}: ${err.message}`);
    }
  }
  if (failedPreflight.length > 0) {
    console.error('❌ Refusing to download: model registry failed integrity preflight:');
    for (const msg of failedPreflight) console.error(`   - ${msg}`);
    process.exit(1);
  }

  let totalSize = 0;
  const toDownload = [];

  for (const [name, info] of Object.entries(RECOMMENDED_MODELS)) {
    const modelPath = path.join(modelsPath, name);
    const status = await getModelStatus(modelPath, info.size);

    if (!status.complete) {
      toDownload.push({ name, info, modelPath, existingSize: status.size });
      totalSize += info.size;
    } else {
      console.log(`✅ ${info.displayName} - Already downloaded`);
    }
  }

  if (toDownload.length === 0) {
    console.log('\n✅ All models already downloaded!');
    return;
  }

  console.log(
    `\n📥 Need to download ${toDownload.length} model(s), total size: ${formatSize(totalSize)}\n`
  );

  const failures = [];

  for (const { name, info, modelPath, existingSize } of toDownload) {
    console.log(`\n📥 Downloading ${info.displayName}...`);
    console.log(`   Size: ${formatSize(info.size)}`);
    console.log(`   URL:  ${info.url}`);
    console.log(`   SHA-256 (expected): ${info.checksum}`);
    if (existingSize > 0) {
      console.log(`   Resuming from: ${formatSize(existingSize)}`);
    }

    const partialPath = modelPath + '.partial';
    let completed = false;
    let lastError = null;

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts && !completed; attempt += 1) {
      try {
        await downloadFile(info.url, modelPath, name);

        // SECURITY: verify the actual bytes match the registry checksum
        // before promoting `.partial` to the final filename. This replaces
        // the previous size-only heuristic which could accept corrupted or
        // tampered payloads of the correct length.
        const verify = await verifyChecksum(partialPath, info.checksum);
        if (!verify.ok) {
          await fs.unlink(partialPath).catch(() => {});
          lastError = new Error(
            `SHA-256 mismatch for ${name}: expected ${verify.expected}, got ${verify.actual}`
          );
          if (attempt < maxAttempts) {
            console.log('   ⚠️  Checksum mismatch detected, retrying clean...');
          }
          continue;
        }

        await fs.rename(partialPath, modelPath);
        completed = true;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          console.log(`   ⚠️  Attempt ${attempt} failed: ${err.message} — retrying...`);
        }
      }
    }

    if (completed) {
      console.log(`✅ ${info.displayName} downloaded and verified (SHA-256 OK)`);
    } else {
      const msg = lastError ? lastError.message : 'unknown error';
      console.error(`❌ Failed to download ${name}: ${msg}`);
      failures.push({ name, error: msg });
    }
  }

  console.log('\n✅ Model download complete!');
  console.log(`Models saved to: ${modelsPath}`);
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} model(s) failed integrity checks — see log above.`);
    process.exit(1);
  }
}

// Parse arguments and run
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    await checkModels();
  } else if (args.includes('--auto') || args.includes('--download')) {
    await downloadModels();
  } else {
    // Interactive mode - just check for now
    console.log('Stratosort Model Setup\n');
    console.log('Usage:');
    console.log('  --check     Check if recommended models are available');
    console.log('  --download  Download recommended models');
    console.log('  --auto      Same as --download\n');
    await checkModels();
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
