#!/usr/bin/env node
// @ts-check
/**
 * Tesseract traineddata Runtime Setup
 *
 * Downloads the OCR language model (`<lang>.traineddata.gz`) into
 * assets/runtime/tessdata/ so packaged builds run OCR **fully offline**.
 * Without a bundled copy, tesseract.js fetches the model from
 * cdn.jsdelivr.net on first OCR — a network round-trip that breaks the
 * privacy-first / offline-first guarantee. The resolver that consumes this
 * output is src/main/utils/tesseractJsPaths.js (`resolveBundledTessdata`),
 * which prefers a bundled `<lang>.traineddata[.gz]` over the userData cache
 * over the CDN.
 *
 * Source: the exact asset tesseract.js v7 would otherwise download itself —
 *   https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/<variant>/<lang>.traineddata.gz
 * (see node_modules/tesseract.js/src/worker-script/index.js — the node
 * langPath default). Using tesseract.js's own source guarantees the gzip
 * framing the runtime expects. Distributed under the Apache-2.0 license
 * (tessdata_fast/tessdata); no viral clause, safe for closed-source bundling.
 *
 * Usage:
 *   node scripts/setup-tessdata-runtime.js            # download for default lang (eng) if missing
 *   node scripts/setup-tessdata-runtime.js --check    # report presence, exit non-zero if missing
 *   node scripts/setup-tessdata-runtime.js --force    # re-download even if present
 *   node scripts/setup-tessdata-runtime.js --lang=deu # a different language model
 *
 * Environment:
 *   SKIP_TESSDATA_RUNTIME=true        Skip download entirely (CI / fast dev)
 *   STRATOSORT_TESSDATA_URL           Override the download URL entirely (host-allowlisted)
 *   STRATOSORT_TESSDATA_VARIANT       tesseract.js-data variant dir (default: '4.0.0')
 *   STRATOSORT_TESSDATA_SHA256        Pin the expected sha256 (verified when set; warned when absent)
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { createWriteStream, createReadStream } = require('fs');

const DEFAULT_LANG = 'eng';
const DEFAULT_VARIANT = process.env.STRATOSORT_TESSDATA_VARIANT || '4.0.0';
// SECURITY: host allowlist. STRATOSORT_TESSDATA_URL is attacker-influential —
// silently accepting http:// or an arbitrary host would be a supply-chain hole.
// jsdelivr fronts the @tesseract.js-data npm packages tesseract.js itself uses.
const ALLOWED_HOSTS = Object.freeze(['cdn.jsdelivr.net']);
const MAX_REDIRECTS = 5;
// Anchors on a language code, no path separators — stops traversal via --lang=.
const SUPPORTED_LANG_PATTERN = /^[a-z]{2,8}(_[a-z]{2,8})?$/i;
const REQUIRED_SHA256_REGEX = /^[a-f0-9]{64}$/i;

const TESSDATA_DIR = path.join(__dirname, '..', 'assets', 'runtime', 'tessdata');

/** @param {string} hostname */
function isAllowedHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** @param {string} rawUrl @param {string} label */
function validateUrl(rawUrl, label) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for ${label}: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error(`Blocked non-HTTPS URL for ${label}: ${rawUrl}`);
  if (url.username || url.password)
    throw new Error(`Blocked credentialed URL for ${label}: ${rawUrl}`);
  if (!isAllowedHost(url.hostname))
    throw new Error(`Blocked untrusted host for ${label}: ${url.hostname}`);
  return url;
}

/** @param {string} lang */
function downloadUrlFor(lang) {
  if (process.env.STRATOSORT_TESSDATA_URL && process.env.STRATOSORT_TESSDATA_URL.trim()) {
    return process.env.STRATOSORT_TESSDATA_URL.trim();
  }
  return `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/${DEFAULT_VARIANT}/${lang}.traineddata.gz`;
}

/**
 * A bundled model is present if either the gzipped release asset OR an
 * un-gzipped copy (e.g. staged from the userData cache during dev) exists —
 * the resolver in tesseractJsPaths.js accepts both.
 * @param {string} lang
 * @returns {string|null} the path that exists, or null
 */
function findBundled(lang) {
  const gz = path.join(TESSDATA_DIR, `${lang}.traineddata.gz`);
  const raw = path.join(TESSDATA_DIR, `${lang}.traineddata`);
  if (fs.existsSync(gz)) return gz;
  if (fs.existsSync(raw)) return raw;
  return null;
}

/** @param {string} filePath @param {string} expected */
function verifyChecksum(filePath, expected) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === expected.toLowerCase()));
    stream.on('error', reject);
  });
}

/** @param {string} url @param {string} destPath */
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const partialPath = `${destPath}.partial`;
    const tmpFile = createWriteStream(partialPath, { flags: 'w' });
    let settled = false;
    const fail = (/** @type {Error} */ err) => {
      if (settled) return;
      settled = true;
      tmpFile.close(() => {
        fsp.unlink(partialPath).catch(() => {});
        reject(err);
      });
    };
    /** @param {string} target @param {number} redirectsLeft */
    const follow = (target, redirectsLeft) => {
      const u = validateUrl(target, 'download');
      const req = https.get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { 'User-Agent': 'StratoSort-TessdataSetup/1.0' }
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
            res.resume();
            follow(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`HTTP ${res.statusCode} downloading ${target}`));
            res.resume();
            return;
          }
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
    follow(url, MAX_REDIRECTS);
  });
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { check: false, force: false, help: false, lang: DEFAULT_LANG };
  for (const raw of argv.slice(2)) {
    if (raw === '--check') args.check = true;
    else if (raw === '--force') args.force = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--lang=')) args.lang = raw.slice('--lang='.length);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/setup-tessdata-runtime.js [options]

Options:
  --check           Verify the model is present and exit non-zero if missing.
  --force           Re-download even if a bundled copy exists.
  --lang=<code>     Language model to fetch (default: ${DEFAULT_LANG}).
  -h, --help        Print this help.

Env: SKIP_TESSDATA_RUNTIME, STRATOSORT_TESSDATA_URL, STRATOSORT_TESSDATA_VARIANT,
     STRATOSORT_TESSDATA_SHA256`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const lang = args.lang.trim();
  if (!SUPPORTED_LANG_PATTERN.test(lang)) {
    console.error(`Refusing suspicious --lang value "${lang}". Expected e.g. eng, deu, chi_sim.`);
    process.exit(1);
  }

  if (process.env.SKIP_TESSDATA_RUNTIME === 'true') {
    console.log('[tessdata] SKIP_TESSDATA_RUNTIME=true — skipping.');
    return;
  }

  const target = path.join(TESSDATA_DIR, `${lang}.traineddata.gz`);
  const existing = findBundled(lang);

  if (args.check) {
    if (existing) {
      console.log(`[tessdata] present: ${existing}`);
      return;
    }
    console.error(`[tessdata] MISSING: no ${lang}.traineddata[.gz] under ${TESSDATA_DIR}`);
    process.exit(2);
  }

  if (existing && !args.force) {
    console.log(`[tessdata] already present: ${existing}`);
    return;
  }

  await fsp.mkdir(TESSDATA_DIR, { recursive: true });
  const url = downloadUrlFor(lang);
  validateUrl(url, 'download'); // fail fast on a bad override before the request
  console.log(`[tessdata] downloading ${lang} from ${url}`);
  const partialPath = await downloadToFile(url, target);

  const stat = await fsp.stat(partialPath);
  if (stat.size <= 0) {
    await fsp.unlink(partialPath).catch(() => {});
    throw new Error('Downloaded traineddata is empty');
  }

  const expectedSha = process.env.STRATOSORT_TESSDATA_SHA256;
  if (expectedSha && REQUIRED_SHA256_REGEX.test(expectedSha)) {
    const ok = await verifyChecksum(partialPath, expectedSha);
    if (!ok) {
      await fsp.unlink(partialPath).catch(() => {});
      throw new Error(`Checksum mismatch for ${lang}.traineddata.gz`);
    }
  } else {
    console.warn(
      '[tessdata] Downloading WITHOUT sha256 verification (set STRATOSORT_TESSDATA_SHA256 to pin).'
    );
  }

  await fsp.rename(partialPath, target);
  console.log(`[tessdata] installed: ${target} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[tessdata] setup failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  validateUrl,
  isAllowedHost,
  findBundled,
  downloadUrlFor,
  TESSDATA_DIR,
  DEFAULT_LANG,
  SUPPORTED_LANG_PATTERN
};
