#!/usr/bin/env node
/**
 * Whisper Model Setup
 *
 * Downloads the GGML model file required by WhisperService into the
 * Electron userData/models/whisper directory. Mirrors the supply-chain
 * hardening of scripts/setup-models.js (HTTPS-only, host allowlist,
 * partial+rename, sha256 verification) but adapts for whisper.cpp:
 *
 *   - Models are GGML .bin files, not GGUF.
 *   - Hugging Face stores them in Git LFS, so the canonical sha256 is
 *     read from the LFS pointer at /raw/main/<file>. No checksum is
 *     hardcoded — the pointer always reflects the current upload.
 *
 * Usage:
 *   node scripts/setup-whisper-model.js                 # default model (base.en.bin)
 *   node scripts/setup-whisper-model.js --check         # report status, exit 0 / non-zero
 *   node scripts/setup-whisper-model.js --auto          # download default
 *   node scripts/setup-whisper-model.js --model=ggml-small.en.bin
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { createReadStream, createWriteStream } = require('fs');

const REQUIRED_SHA256_REGEX = /^[a-f0-9]{64}$/i;
const ALLOWED_HOSTS = Object.freeze(['huggingface.co', 'hf.co']);
const MAX_REDIRECTS = 5;
const HF_REPO = 'ggerganov/whisper.cpp';
const DEFAULT_MODEL = 'ggml-base.en.bin';
// Default Silero VAD GGML companion. Whisper.cpp's built-in VAD support
// expects a Silero VAD model; the v5.1.2 build is the current pin. Users
// can override via `--vad-model=` if they want a different version.
const DEFAULT_VAD_MODEL = 'ggml-silero-v5.1.2.bin';
// Permissive but still safe: anchors on `ggml-` and `.bin`, charset stops
// path traversal (no `/` or `\`), allows `.`, `-`, `_` for variants like
// `ggml-base.en.bin`, `ggml-small.en-q5_1.bin`, `ggml-silero-v5.1.2.bin`.
const SUPPORTED_MODEL_PATTERN = /^ggml-[a-zA-Z0-9._-]+\.bin$/;

function isAllowedHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function validateUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for ${label}: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTPS URL for ${label}: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error(`Blocked credentialed URL for ${label}: ${rawUrl}`);
  }
  if (!isAllowedHost(url.hostname)) {
    throw new Error(`Blocked untrusted host for ${label}: ${url.hostname}`);
  }
  return url;
}

function getAppName() {
  // Electron's app.name prefers productName ("StratoSort Stack") — the app
  // reads models from that userData directory, not the npm package name.
  try {
    const pkg = require('../package.json');
    return pkg.productName || pkg.name || 'StratoSort Stack';
  } catch {
    return 'StratoSort Stack';
  }
}

function getWhisperDir() {
  const appName = getAppName();
  const home = process.env.HOME || process.env.USERPROFILE;
  let userData;
  if (process.platform === 'win32') {
    userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
  } else if (process.platform === 'darwin') {
    userData = path.join(home, 'Library', 'Application Support', appName);
  } else {
    userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName);
  }
  return path.join(userData, 'models', 'whisper');
}

function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  const validated = validateUrl(url, 'metadata');
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: validated.hostname,
        path: validated.pathname + validated.search,
        headers: { 'User-Agent': 'StratoSort-WhisperSetup/1.0' }
      },
      (res) => {
        if (
          (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects fetching LFS pointer'));
            return;
          }
          const next = new URL(res.headers.location, validated).toString();
          res.resume();
          fetchText(next, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error('Timeout fetching LFS pointer'));
    });
    req.on('error', reject);
  });
}

/**
 * Parse the Git-LFS pointer text returned by /raw/main/<file>.
 * Format:
 *   version https://git-lfs.github.com/spec/v1
 *   oid sha256:<HASH>
 *   size <BYTES>
 *
 * @returns {{ sha256: string, size: number }}
 */
function parseLfsPointer(text, filename) {
  const lines = text.split(/\r?\n/);
  let sha256 = null;
  let size = null;
  for (const line of lines) {
    const oidMatch = line.match(/^oid sha256:([a-f0-9]{64})\s*$/i);
    if (oidMatch) sha256 = oidMatch[1].toLowerCase();
    const sizeMatch = line.match(/^size (\d+)\s*$/);
    if (sizeMatch) size = Number(sizeMatch[1]);
  }
  if (!sha256 || !REQUIRED_SHA256_REGEX.test(sha256)) {
    throw new Error(`LFS pointer for ${filename} did not contain a valid sha256`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`LFS pointer for ${filename} did not contain a valid size`);
  }
  return { sha256, size };
}

async function fetchExpectedMetadata(filename) {
  const pointerUrl = `https://huggingface.co/${HF_REPO}/raw/main/${encodeURIComponent(filename)}`;
  const text = await fetchText(pointerUrl);
  return parseLfsPointer(text, filename);
}

function downloadToFile(url, destPath, expectedSize, onProgress) {
  return new Promise((resolve, reject) => {
    const validated = validateUrl(url, 'download');
    const partialPath = `${destPath}.partial`;
    const tmpFile = createWriteStream(partialPath, { flags: 'w' });
    let downloaded = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      tmpFile.close(() => {
        fs.unlink(partialPath).catch(() => {});
        reject(err);
      });
    };

    const followRedirects = (target, redirectsLeft) => {
      const u = validateUrl(target, 'download-redirect');
      const req = https.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { 'User-Agent': 'StratoSort-WhisperSetup/1.0' }
        },
        (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              fail(new Error('Too many redirects'));
              res.resume();
              return;
            }
            const next = new URL(res.headers.location, u).toString();
            res.resume();
            followRedirects(next, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`HTTP ${res.statusCode} downloading ${target}`));
            res.resume();
            return;
          }
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress) onProgress(downloaded, expectedSize);
          });
          res.pipe(tmpFile);
          tmpFile.on('finish', () => {
            if (settled) return;
            settled = true;
            tmpFile.close(() => resolve(partialPath));
          });
          tmpFile.on('error', fail);
          res.on('error', fail);
        }
      );
      req.setTimeout(60000, () => req.destroy(new Error('Download timeout')));
      req.on('error', fail);
    };

    followRedirects(validated.toString(), MAX_REDIRECTS);
  });
}

function verifyChecksum(filePath, expected) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex').toLowerCase();
      resolve({ ok: actual === expected.toLowerCase(), actual });
    });
    stream.on('error', reject);
  });
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseArgs(argv) {
  const args = {
    check: false,
    auto: false,
    model: DEFAULT_MODEL,
    vad: false,
    vadModel: DEFAULT_VAD_MODEL
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--check') args.check = true;
    else if (raw === '--auto' || raw === '--download') args.auto = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--vad') args.vad = true;
    else if (raw.startsWith('--model=')) args.model = raw.slice('--model='.length);
    else if (raw.startsWith('--vad-model=')) {
      args.vad = true;
      args.vadModel = raw.slice('--vad-model='.length);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/setup-whisper-model.js [options]

Options:
  --check               Verify the model is present and exit non-zero if missing.
  --auto, --download    Download the model without prompting.
  --model=<filename>    Specify a different GGML filename (default: ${DEFAULT_MODEL}).
  --vad                 Also fetch the Silero VAD companion model
                        (default: ${DEFAULT_VAD_MODEL}).
  --vad-model=<file>    Override the VAD model filename. Implies --vad.
  -h, --help            Print this help.

Examples:
  node scripts/setup-whisper-model.js --auto
  node scripts/setup-whisper-model.js --check --vad
  node scripts/setup-whisper-model.js --model=ggml-small.en-q5_1.bin --vad --auto
`);
}

async function ensureModelPresent(modelPath, expected) {
  try {
    const stat = await fs.stat(modelPath);
    if (!stat.isFile() || stat.size !== expected.size) return { present: false };
    const { ok } = await verifyChecksum(modelPath, expected.sha256);
    return { present: ok, sha256Mismatch: !ok, size: stat.size };
  } catch {
    return { present: false };
  }
}

/**
 * Download + verify a single GGML file. Extracted so the main flow can run
 * it once for the whisper model and (optionally) again for the VAD
 * companion without duplicating the prompt / error-path logic. Returns
 * 'present' if the file was already verified on disk, 'installed' if
 * downloaded fresh, or 'aborted' if the user declined an interactive
 * prompt. Throws on hard errors (process exits in main).
 */
async function setupOneModel(filename, whisperDir, args, label) {
  if (!SUPPORTED_MODEL_PATTERN.test(filename)) {
    throw new Error(
      `Refusing to operate on suspicious ${label} filename "${filename}". ` +
        'Expected pattern: ggml-<name>.bin (e.g. ggml-base.en.bin).'
    );
  }
  const modelPath = path.join(whisperDir, filename);
  console.log(`\n[${label}]`);
  console.log(`  file:    ${filename}`);
  console.log(`  target:  ${modelPath}`);

  const expected = await fetchExpectedMetadata(filename);
  console.log(`  size:    ${formatSize(expected.size)} (${expected.size} bytes)`);
  console.log(`  sha256:  ${expected.sha256}`);

  const status = await ensureModelPresent(modelPath, expected);
  if (status.present) {
    console.log(`  status:  present and verified`);
    return 'present';
  }
  if (status.sha256Mismatch) {
    console.warn('  status:  checksum mismatch — re-downloading');
    await fs.unlink(modelPath).catch(() => {});
  }

  if (args.check) {
    throw new Error(`${label} model is missing at ${modelPath}`);
  }

  if (!args.auto && process.stdout.isTTY) {
    process.stdout.write(`  Download ${label} now? [y/N] `);
    const answer = await new Promise((resolve) => {
      process.stdin.once('data', (d) => resolve(d.toString().trim().toLowerCase()));
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('  Aborted.');
      return 'aborted';
    }
  }

  const downloadUrl = `https://huggingface.co/${HF_REPO}/resolve/main/${encodeURIComponent(filename)}`;
  console.log(`  Downloading from ${downloadUrl} ...`);

  const partialPath = await downloadToFile(
    downloadUrl,
    modelPath,
    expected.size,
    (downloaded, total) => {
      if (!process.stdout.isTTY) return;
      const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
      process.stdout.write(`\r  ${formatSize(downloaded)} / ${formatSize(total)} (${pct}%)`);
    }
  );
  if (process.stdout.isTTY) process.stdout.write('\n');

  const partialStat = await fs.stat(partialPath);
  if (partialStat.size !== expected.size) {
    await fs.unlink(partialPath).catch(() => {});
    throw new Error(
      `Size mismatch after download: got ${partialStat.size}, expected ${expected.size}`
    );
  }

  const { ok, actual } = await verifyChecksum(partialPath, expected.sha256);
  if (!ok) {
    await fs.unlink(partialPath).catch(() => {});
    throw new Error(`Checksum mismatch: got ${actual}, expected ${expected.sha256}`);
  }

  await fs.rename(partialPath, modelPath);
  console.log(`  installed`);
  return 'installed';
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const whisperDir = getWhisperDir();
  await fs.mkdir(whisperDir, { recursive: true });

  console.log(`StratoSort whisper model setup`);
  console.log(`  dir:     ${whisperDir}`);

  // Always set up the main whisper model.
  try {
    await setupOneModel(args.model.trim(), whisperDir, args, 'whisper');
  } catch (err) {
    console.error(`whisper setup failed: ${err.message}`);
    process.exit(args.check ? 2 : 1);
  }

  // Optionally fetch the Silero VAD companion. VAD is opt-in: it speeds up
  // long-form transcription 2-5x and reduces hallucination on silent
  // stretches, but the binding only loads it when WhisperService is told
  // to enable VAD, so the companion is unnecessary for users who run
  // whisper without VAD.
  if (args.vad) {
    try {
      await setupOneModel(args.vadModel.trim(), whisperDir, args, 'vad');
    } catch (err) {
      console.error(`vad setup failed: ${err.message}`);
      process.exit(args.check ? 2 : 1);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseLfsPointer,
  fetchExpectedMetadata,
  ensureModelPresent,
  validateUrl,
  isAllowedHost,
  parseArgs,
  getWhisperDir,
  setupOneModel,
  SUPPORTED_MODEL_PATTERN,
  DEFAULT_MODEL,
  DEFAULT_VAD_MODEL,
  HF_REPO
};
