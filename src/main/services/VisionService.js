// @ts-check
/**
 * VisionService — image understanding via a bundled `llama-server` subprocess.
 *
 * Owns the lifecycle of the local vision-model HTTP server (start, restart,
 * health probe, GPU/CPU backend selection) and exposes image-analysis calls
 * over its REST API. On any startup or decode failure, raises the
 * `vision.unavailable` degradation flag so the UI can fall back to OCR-only
 * analysis instead of hanging callers.
 *
 * Subprocess + HTTP only — never linked into the renderer or main bundle.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { app } = require('electron');
const { createLogger } = require('../../shared/logger');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { resolveRuntimePath } = require('../utils/runtimePaths');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { delay, createBackgroundWorkTracker } = require('../../shared/promiseUtils');
const { isVisionDecodePressureError } = require('./visionErrorClassification');
const { GPUMonitor } = require('./GPUMonitor');
const { resolveVisionRuntimeBackend } = require('../utils/llamaBackendSelector');

// Registration name for the vision llama-server child in ModelMemoryManager.
// 'vision' is reserved for an in-process vision model LlamaService would own;
// the child process is a separate consumer with its own dispose path.
const VISION_RUNTIME_MEMORY_TYPE = 'vision-runtime';
// Fallback footprint when the model files cannot be measured; matches the
// manager's long-standing fixed estimate for vision.
const VISION_RUNTIME_FALLBACK_BYTES = 5 * 1024 * 1024 * 1024;

const logger = createLogger('VisionService');
let loggedRuntimeVariant = false;

/** @type {any} */
let _detectedGpuInfo = null;
/** @type {any} */
let _gpuInfoPromise = null;

const VISION_DEGRADED_CODE = 'vision.unavailable';

// After a runtime startup failure, fail image requests fast for this long
// instead of re-attempting a 10-30s spawn (or waiting out the 300s analysis
// timeout) per queued image. Observed in production: one SIGTERM'd startup
// turned an 8-image batch into ~40 minutes of serial timeouts.
const VISION_STARTUP_FAILURE_COOLDOWN_MS = 60_000;
// Consecutive startup failures double the cooldown (60s, 2m, 4m, ...) up to
// this cap, so a permanently broken runtime (missing binary, dead GPU) stops
// paying a doomed spawn/probe attempt every minute across a long image batch.
// Never latches permanently: a successful startup resets the streak, so a
// user repairing the runtime mid-session recovers within one cooldown window.
const VISION_STARTUP_FAILURE_COOLDOWN_MAX_MS = 900_000;

function _maybeRaiseVisionUnavailable(/** @type {any} */ error, /** @type {any} */ reason) {
  if (!error || typeof error !== 'object') return;
  try {
    const tracker = require('./DegradedStateTracker').getInstance();
    const isMultimodalGap = error.code === 'VISION_NO_MULTIMODAL';
    tracker.raise({
      code: VISION_DEGRADED_CODE,
      subsystem: 'vision',
      severity: 'error',
      message: isMultimodalGap
        ? 'Image analysis is degraded: the vision runtime started but cannot decode images ' +
          '(multimodal projector failed to load). Image files will fall back to OCR-only ' +
          "analysis. Re-run 'npm run setup:vision-runtime' or check the app log for the " +
          'projector load error.'
        : 'Image analysis is unavailable: the vision runtime cannot start. Image files ' +
          "fall back to OCR-only analysis. Run 'npm run setup:vision-runtime' or check the " +
          'app log for the resolved error.',
      detail: { reason, errorMessage: String(error.message || '').slice(0, 200) }
    });
  } catch {
    /* tracker is best-effort; never throw from a service error path */
  }
}

function _clearVisionUnavailable() {
  try {
    require('./DegradedStateTracker').getInstance().clear(VISION_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

function createUtf8ChunkDecoder(/** @type {any} */ onText) {
  const decoder = new StringDecoder('utf8');

  return {
    push(/** @type {any} */ chunk) {
      const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (text) {
        onText(text);
      }
    },
    end() {
      const text = decoder.end();
      if (text) {
        onText(text);
      }
    }
  };
}

async function getDetectedGpuInfo() {
  if (_detectedGpuInfo) return _detectedGpuInfo;
  if (_gpuInfoPromise) return _gpuInfoPromise;

  _gpuInfoPromise = (async () => {
    try {
      const monitor = new GPUMonitor();
      const info = await monitor.detectGPU();
      _detectedGpuInfo = info || { type: 'cpu', name: 'CPU' };
    } catch (error) {
      logger.debug('[VisionService] Shared GPU detection failed', { error: error?.message });
      _detectedGpuInfo = { type: 'cpu', name: 'CPU' };
    } finally {
      _gpuInfoPromise = null;
    }
    return _detectedGpuInfo;
  })();

  return _gpuInfoPromise;
}

/**
 * Called by LlamaService after `initLlamaWithBackend` confirms which backend
 * actually loaded successfully. On Windows non-ARM the WMI/CIM fallback in
 * GPUMonitor conservatively reports `type: 'vulkan'` for NVIDIA hardware
 * (only nvidia-smi confirms CUDA), so the vision runtime would default to
 * Vulkan even when the main LLM is happily running on CUDA — two driver
 * stacks active at once.
 *
 * Treat this confirmation as a strict upgrade: only ever promote the
 * detected type from a less-specific value (vulkan / cpu) to a more-specific
 * one (cuda / metal). Never downgrade.
 */
function confirmGpuBackend(/** @type {any} */ backend) {
  const normalized = typeof backend === 'string' ? backend.toLowerCase() : null;
  if (!normalized || normalized === 'cpu' || normalized === 'auto' || normalized === 'false') {
    return;
  }
  if (!_detectedGpuInfo) {
    _detectedGpuInfo = { type: normalized, name: normalized };
    return;
  }
  // Only promote vulkan/unknown → cuda/metal; never demote a confirmed strong
  // backend to a weaker hint.
  const current = String(_detectedGpuInfo.type || '').toLowerCase();
  const isUpgrade =
    (current === 'vulkan' && normalized === 'cuda') ||
    (current !== normalized && (normalized === 'cuda' || normalized === 'metal'));
  if (isUpgrade) {
    _detectedGpuInfo = { ..._detectedGpuInfo, type: normalized };
  }
}

const LLAMA_CPP_RELEASE_TAG = process.env.STRATOSORT_LLAMA_CPP_TAG || 'b9000';
const LLAMA_CPP_BASE_URL = 'https://github.com/ggml-org/llama.cpp/releases/download';
const SERVER_BINARY_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

/**
 * Known SHA-256 digests for the default `LLAMA_CPP_RELEASE_TAG` assets.
 *
 * Without these, the `expectedSha256` plumbing in `downloadFile` runs with
 * `undefined` for the default GitHub URLs and the binary that ultimately
 * gets executed is unverified — a regression vs. the documented
 * "SHA-256 verification — present and enforced" contract for the new
 * download flow. Keys are `${tag}/${assetName}` so an operator bumping
 * `STRATOSORT_LLAMA_CPP_TAG` to a newer release just needs to add a row.
 *
 * Maintenance: when `LLAMA_CPP_RELEASE_TAG` is updated above, regenerate
 * this map from the upstream `sha256sum.txt` of the release. Missing entries
 * fall back to "no pin" behavior with a warn-level log so the absence is
 * visible in diagnostics. We intentionally do NOT throw — that would brick
 * future tag bumps before the table is updated — but the log makes the
 * unverified state observable.
 */
const LLAMA_CPP_KNOWN_SHA256 = Object.freeze({
  // Tag b9000 — digests from the upstream GitHub release asset manifest
  // (gh api repos/ggml-org/llama.cpp/releases/tags/b9000, asset `digest`
  // fields). Covers every asset getVisionRuntimeAssetConfig can request,
  // including both supported CUDA versions. Keep this map updated alongside
  // LLAMA_CPP_RELEASE_TAG bumps.
  // Format: '${tag}/${assetName}': '<64-char hex>'
  'b9000/llama-b9000-bin-win-cpu-arm64.zip':
    'bdb73edd8b05b9d5a0ba860e98e312f5c8aa591300a851b6c2d7359a139536f3',
  'b9000/llama-b9000-bin-win-cpu-x64.zip':
    '8294e287933d3212aa93a32e1ceb800722bede14d9692d405679d4ba77cf05db',
  'b9000/llama-b9000-bin-win-cuda-12.4-x64.zip':
    '5fc0ce2cdd5b626edd057441fcf0ac3a9982d92edc442747eff651dcb7ffedc0',
  'b9000/cudart-llama-bin-win-cuda-12.4-x64.zip':
    '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
  'b9000/llama-b9000-bin-win-cuda-13.1-x64.zip':
    'ef8dc3b39295a586b7da641765b19b5c3561c8c6649df0cba825dae1e8fcbec4',
  'b9000/cudart-llama-bin-win-cuda-13.1-x64.zip':
    'f96935e7e385e3b2d0189239077c10fe8fd7e95690fea4afec455b1b6c7e3f18',
  'b9000/llama-b9000-bin-win-vulkan-x64.zip':
    '6900d078dc7b7ddcb7f56a5db7eee14e82b68854dabec9f0cd12124f98c63812',
  'b9000/llama-b9000-bin-macos-arm64.tar.gz':
    'e4531e819dd9fe4add199db998df55cf8bd20e18a67cbd1449b49409dc01c642',
  'b9000/llama-b9000-bin-macos-x64.tar.gz':
    '82b81368266b6290509c221484df073624c5325239d6f375d60589fa760519bc',
  'b9000/llama-b9000-bin-ubuntu-x64.tar.gz':
    '4cd8ffbb0425c49c50b56ff6b3d0a9add9ad1ae469611b9edd038e20d6cdab36',
  'b9000/llama-b9000-bin-ubuntu-arm64.tar.gz':
    '575bc6c6d7171475846b96476470612d1158870506fb52fd11cf0d9cceb511b4',
  'b9000/llama-b9000-bin-ubuntu-vulkan-x64.tar.gz':
    'da366675f5e8b53f9b42cf46a15e1b42af9a3fa0e1f78fe8ff3766b7b7e756e2',
  'b9000/llama-b9000-bin-ubuntu-vulkan-arm64.tar.gz':
    '020c4815e3851f307bda06b1ab70babfc982dceeb0d95814a61cfe45ff5fa51c'
});

function _getKnownSha256(/** @type {any} */ tag, /** @type {any} */ assetName) {
  if (!tag || !assetName) return null;
  return (
    /** @type {Record<string, string>} */ (LLAMA_CPP_KNOWN_SHA256)[`${tag}/${assetName}`] || null
  );
}

/**
 * Hosts we trust to serve the vision runtime archive. GitHub releases are the
 * canonical source; `objects.githubusercontent.com` is the CDN redirect target
 * for download URLs. Operators can extend this list for mirrored builds via the
 * `STRATOSORT_LLAMA_CPP_ALLOWED_HOSTS` environment variable (comma-separated).
 *
 * Security note: without this allowlist, `STRATOSORT_LLAMA_CPP_URL` would allow
 * an attacker with env-var access to point the download at an arbitrary host
 * and then run whatever binary they serve. Enforcing an allowlist closes that
 * attack surface — users who want a custom mirror must explicitly opt in.
 */
const DEFAULT_ALLOWED_RUNTIME_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com'
];

function getAllowedRuntimeHosts() {
  const extra = (process.env.STRATOSORT_LLAMA_CPP_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_RUNTIME_HOSTS.map((h) => h.toLowerCase()), ...extra]);
}

/**
 * Enforce https + host allowlist on any URL used to fetch the runtime archive,
 * including every redirect hop. Throws if the URL is unsafe.
 */
function validateRuntimeDownloadUrl(/** @type {any} */ url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Vision runtime URL is not parseable: ${err.message}`, { cause: err });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Vision runtime URL must use https (got ${parsed.protocol}): ${parsed.href}`);
  }
  const allowed = getAllowedRuntimeHosts();
  const host = (parsed.hostname || '').toLowerCase();
  if (!allowed.has(host)) {
    throw new Error(
      `Vision runtime URL host "${host}" is not in the allowlist. ` +
        'Set STRATOSORT_LLAMA_CPP_ALLOWED_HOSTS to add a custom mirror.'
    );
  }
  return parsed.href;
}

async function pathExists(/** @type {any} */ targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `candidate` resolves to a path strictly inside `rootDir`.
 *
 * The runtime manifest (`runtime.json`) lives in userData and its
 * `binaryPath` is later passed to `spawn()`. Without containment, anything
 * that can write that JSON file can redirect the next vision start to an
 * arbitrary executable (e.g. cmd.exe). Constraining the path to the runtime
 * root means an attacker would have to replace the binary itself — a
 * strictly harder position than editing one JSON field.
 */
function isPathContainedIn(/** @type {any} */ rootDir, /** @type {any} */ candidate) {
  if (typeof rootDir !== 'string' || typeof candidate !== 'string') return false;
  const rel = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Vision models (4-5GB) can take several minutes to load on CPU-only systems
const DEFAULT_STARTUP_TIMEOUT_MS = TIMEOUTS.VISION_STARTUP || 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = TIMEOUTS.VISION_REQUEST || 90000;
const DEFAULT_IDLE_KEEPALIVE_MS =
  typeof TIMEOUTS.VISION_IDLE_KEEPALIVE === 'number' ? TIMEOUTS.VISION_IDLE_KEEPALIVE : 300000;
const CPU_STARTUP_TIMEOUT_MS = Math.max(DEFAULT_STARTUP_TIMEOUT_MS, 300000);
// Per-attempt timeout for the /health probe inside the startup polling loop.
// Without this, a hung socket would block each attempt until the outer loop
// wall expired (minutes on CPU builds), making failure detection wildly
// uneven. 5 s is generous for a local HTTP health check.
const VISION_HEALTH_REQUEST_TIMEOUT_MS = 5000;

function parseKeepAliveMs(/** @type {any} */ value, /** @type {any} */ fallbackMs) {
  if (value == null || value === '') return fallbackMs;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs;
  return parsed;
}

function normalizeTimeoutMs(/** @type {any} */ value, /** @type {any} */ fallbackMs) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function detectRuntimeBackendInfo(/** @type {any} */ stderrText) {
  const recent = String(stderrText || '').toLowerCase();
  if (!recent) {
    return { backend: 'unknown', gpuActive: false };
  }

  if (
    recent.includes('cuda0') ||
    recent.includes('cuda_host') ||
    recent.includes('using cuda') ||
    recent.includes('backend: cuda')
  ) {
    return { backend: 'cuda', gpuActive: true };
  }

  if (recent.includes('metal')) {
    return { backend: 'metal', gpuActive: true };
  }

  if (recent.includes('vulkan')) {
    return { backend: 'vulkan', gpuActive: true };
  }

  if (recent.includes('cpu kv buffer') || recent.includes('cpu compute buffer')) {
    return { backend: 'cpu', gpuActive: false };
  }

  return { backend: 'unknown', gpuActive: false };
}

function getRuntimeRoot(tag = LLAMA_CPP_RELEASE_TAG) {
  return path.join(app.getPath('userData'), 'runtime', 'llama.cpp', tag);
}

function inferArchiveType(/** @type {any} */ url) {
  const lower = url.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}

async function getAssetConfig(tag = LLAMA_CPP_RELEASE_TAG, preferredBackend = 'auto') {
  const overrideUrl = process.env.STRATOSORT_LLAMA_CPP_URL;
  if (overrideUrl && overrideUrl.trim()) {
    const archiveType = inferArchiveType(overrideUrl);
    if (!archiveType) {
      throw new Error('Unsupported llama.cpp runtime archive format');
    }
    // Validate the override URL against the allowlist BEFORE we commit to it.
    // validateRuntimeDownloadUrl() throws if the URL is not https or its host
    // is outside the allowlist (see `STRATOSORT_LLAMA_CPP_ALLOWED_HOSTS`).
    const safeUrl = validateRuntimeDownloadUrl(overrideUrl.trim());
    const overrideSha256 =
      typeof process.env.STRATOSORT_LLAMA_CPP_SHA256 === 'string' &&
      process.env.STRATOSORT_LLAMA_CPP_SHA256.trim()
        ? process.env.STRATOSORT_LLAMA_CPP_SHA256.trim().toLowerCase()
        : null;
    const config = {
      tag: 'custom',
      assetName: path.basename(safeUrl),
      archiveType,
      url: safeUrl,
      sha256: overrideSha256
    };
    if (!loggedRuntimeVariant) {
      loggedRuntimeVariant = true;
      logger.info('[VisionService] Selected vision runtime (override)', {
        platform: process.platform,
        arch: process.arch,
        assetName: config.assetName
      });
    }
    return config;
  }

  const platform = process.platform;
  const arch = process.arch;
  const gpuInfo = await getDetectedGpuInfo();
  const resolvedBackend = resolveVisionRuntimeBackend(
    /** @type {any} */ ({
      gpuInfo,
      preferredBackend,
      platform,
      arch
    })
  );

  if (platform === 'win32') {
    const cudaVersion = process.env.STRATOSORT_CUDA_VERSION || '12.4';
    let assetName;
    let cudartAssetName = null;
    if (arch === 'arm64') {
      assetName = `llama-${tag}-bin-win-cpu-arm64.zip`;
    } else if (resolvedBackend === 'cpu') {
      assetName = `llama-${tag}-bin-win-cpu-x64.zip`;
    } else if (resolvedBackend === 'cuda') {
      assetName = `llama-${tag}-bin-win-cuda-${cudaVersion}-x64.zip`;
      cudartAssetName = `cudart-llama-bin-win-cuda-${cudaVersion}-x64.zip`;
    } else {
      assetName = `llama-${tag}-bin-win-vulkan-x64.zip`;
    }

    /** @type {Record<string, any>} */
    const config = {
      tag,
      assetName,
      archiveType: 'zip',
      url: `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };

    if (cudartAssetName) {
      config.cudartAssetName = cudartAssetName;
      config.cudartUrl = `${LLAMA_CPP_BASE_URL}/${tag}/${cudartAssetName}`;
    }

    if (!loggedRuntimeVariant) {
      loggedRuntimeVariant = true;
      logger.info('[VisionService] Selected vision runtime', {
        platform,
        arch,
        assetName,
        ...(cudartAssetName && { cudartAssetName }),
        preferredBackend,
        resolvedBackend,
        detectedGpu: gpuInfo?.type || 'unknown'
      });
    }
    return config;
  }

  if (platform === 'darwin') {
    const assetName =
      arch === 'arm64'
        ? `llama-${tag}-bin-macos-arm64.tar.gz`
        : `llama-${tag}-bin-macos-x64.tar.gz`;
    const config = {
      tag,
      assetName,
      archiveType: 'tar.gz',
      url: `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };
    if (!loggedRuntimeVariant) {
      loggedRuntimeVariant = true;
      logger.info('[VisionService] Selected vision runtime', {
        platform,
        arch,
        assetName,
        preferredBackend,
        resolvedBackend,
        detectedGpu: gpuInfo?.type || 'unknown'
      });
    }
    return config;
  }

  if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported Linux architecture for vision runtime: ${arch}`);
    }
    const archToken = arch === 'arm64' ? 'arm64' : 'x64';
    const assetName =
      resolvedBackend === 'vulkan'
        ? `llama-${tag}-bin-ubuntu-vulkan-${archToken}.tar.gz`
        : `llama-${tag}-bin-ubuntu-${archToken}.tar.gz`;
    const config = {
      tag,
      assetName,
      archiveType: 'tar.gz',
      url: `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };
    if (!loggedRuntimeVariant) {
      loggedRuntimeVariant = true;
      logger.info('[VisionService] Selected vision runtime', {
        platform,
        arch,
        assetName,
        preferredBackend,
        resolvedBackend,
        detectedGpu: gpuInfo?.type || 'unknown'
      });
    }
    return config;
  }

  throw new Error(`Unsupported platform for vision runtime: ${platform}`);
}

// Guard against hung TCP sockets that would otherwise stall startup when the
// vision runtime download server is unreachable. Mirrors the pattern used by
// `ModelDownloadManager._downloadSingleFile` (~529-532).
const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Download a file with https, enforcing scheme/host allowlist on every URL we
 * touch (initial URL AND every redirect target), and optionally verifying a
 * SHA-256 over the received bytes. Redirect chain is capped at MAX_REDIRECTS.
 *
 * @param {string} url
 * @param {string} destination
 * @param {{ expectedSha256?: string }} [options]
 */
async function downloadFile(url, destination, options = {}, _redirectCount = 0) {
  const MAX_REDIRECTS = 10;
  const safeUrl = validateRuntimeDownloadUrl(url);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  const expectedSha256 =
    typeof options?.expectedSha256 === 'string' && options.expectedSha256
      ? options.expectedSha256.trim().toLowerCase()
      : null;
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('expectedSha256 must be a 64-character hex string');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (/** @type {any} */ fn, /** @type {any} */ value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = https.get(safeUrl, { headers: { 'User-Agent': 'StratoSort' } }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.destroy();
        if (_redirectCount >= MAX_REDIRECTS) {
          settle(
            reject,
            new Error(`Too many redirects (${MAX_REDIRECTS}) downloading vision runtime`)
          );
          return;
        }
        // Resolve relative redirects against the current URL, then re-validate
        // the new target through the allowlist. This is the critical check
        // that stops an allowlisted origin from redirecting us off-host.
        let nextUrl;
        try {
          nextUrl = new URL(response.headers.location, safeUrl).href;
        } catch (err) {
          settle(reject, new Error(`Invalid redirect target: ${err.message}`));
          return;
        }
        downloadFile(nextUrl, destination, options, _redirectCount + 1)
          .then((v) => settle(resolve, v))
          .catch((e) => settle(reject, e));
        return;
      }

      if (response.statusCode !== 200) {
        settle(reject, new Error(`Download failed with status ${response.statusCode}`));
        response.resume();
        return;
      }

      const hasher = expectedSha256 ? crypto.createHash('sha256') : null;
      if (hasher) {
        response.on('data', (chunk) => hasher.update(chunk));
      }

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close((err) => {
          if (err) {
            settle(reject, err);
            return;
          }
          if (hasher) {
            const actual = hasher.digest('hex');
            if (actual !== expectedSha256) {
              fs.unlink(destination, () => {
                settle(
                  reject,
                  new Error(
                    `SHA-256 mismatch for ${safeUrl}: expected ${expectedSha256}, got ${actual}`
                  )
                );
              });
              return;
            }
          }
          settle(resolve);
        });
      });
      fileStream.on('error', (error) => {
        response.destroy();
        fileStream.close();
        fs.unlink(destination, () => settle(reject, error));
      });
      response.on('error', (error) => {
        fileStream.destroy();
        fs.unlink(destination, () => settle(reject, error));
      });
    });

    request.on('error', (error) => settle(reject, error));
    request.setTimeout(DOWNLOAD_REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Vision runtime download timeout after ${DOWNLOAD_REQUEST_TIMEOUT_MS}ms`)
      );
    });
  });
}

/**
 * Env vars the llama-server child actually needs. Passing the full `process.env`
 * would leak StratoSort-internal secrets (tokens, feed URLs, private paths) and
 * arbitrary user shell variables into a third-party native binary, which is a
 * bad default from a least-privilege standpoint. We instead build an explicit
 * allowlist:
 *
 *   - Platform essentials (PATH, HOME/USERPROFILE, TEMP/TMP, locale, console)
 *   - Windows DLL-loader essentials (SystemRoot, SystemDrive, windir, ComSpec)
 *   - Windows DLL search auxiliaries (APPDATA, LOCALAPPDATA, PROGRAMFILES*,
 *     PROGRAMDATA) — required for CUDA/cuDNN/CLIP multimodal init on Windows.
 *     Without them, llama-server silently runs without a vision tower and
 *     `/v1/chat` requests with `image_url` fail at the server with a generic
 *     "Invalid url value" error (the model can't decode images).
 *   - GPU runtime knobs (CUDA_*, NVIDIA_*, ROCM_*, HIP_*, LD_*, DYLD_*)
 *   - LLAMA_* / STRATOSORT_LLAMA_* pass-through so operators can tune server
 *     flags without us having to mirror every one of them in code.
 *   - CUDA_PATH_V<digit>* — the NVIDIA Windows installer sets these versioned
 *     variables alongside `CUDA_PATH`; some CUDA load paths resolve via the
 *     versioned form, so the wildcard pattern in `buildLlamaChildEnv` keeps
 *     them intact across CUDA SDK upgrades without us tracking version bumps.
 */
const LLAMA_CHILD_ENV_ALLOWLIST = Object.freeze([
  // Platform basics
  'PATH',
  'Path', // Windows
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',

  // Windows DLL/linker requirements
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS',

  // Windows DLL search auxiliaries — many CUDA/cuDNN/CLIP code paths walk
  // `%PROGRAMFILES%\NVIDIA*` and `%LOCALAPPDATA%` during multimodal init.
  // Without these, llama-server's clip_model_load step silently no-ops on
  // Windows (manifests as "Invalid url value" on the next /v1/chat
  // multimodal request because the model has no vision tower loaded).
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'PROGRAMDATA',
  'PUBLIC',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',

  // Unix-y linker knobs
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',

  // GPU runtimes
  'CUDA_HOME',
  'CUDA_PATH',
  'CUDA_VISIBLE_DEVICES',
  'NVIDIA_VISIBLE_DEVICES',
  'NVIDIA_DRIVER_CAPABILITIES',
  'ROCM_PATH',
  'HIP_VISIBLE_DEVICES',
  'HSA_OVERRIDE_GFX_VERSION',

  // Vulkan loader
  'VK_ICD_FILENAMES',
  'VK_LAYER_PATH'
]);

function buildLlamaChildEnv(/** @type {any} */ extra = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of LLAMA_CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  // Pass through any LLAMA_* or STRATOSORT_LLAMA_* so operators can set
  // llama-server flags (LLAMA_ARG_*, LLAMA_LOG_*) without code changes.
  // Also pass through CUDA_PATH_V* (NVIDIA installer sets `CUDA_PATH_V12_4`
  // etc. alongside `CUDA_PATH`; some CUDA load paths resolve via the
  // versioned variable, and stripping it has been observed to break
  // multimodal/CLIP init on Windows). The pattern matches `CUDA_PATH_V`
  // followed by a digit so we don't accidentally pass through unrelated
  // user-defined `CUDA_PATH_*` knobs.
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (
      key.startsWith('LLAMA_') ||
      key.startsWith('STRATOSORT_LLAMA_') ||
      /^CUDA_PATH_V\d/i.test(key)
    ) {
      out[key] = value;
    }
  }
  // Explicit per-spawn overrides win.
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * True if `candidate` resolves inside `root` (zip-slip guard). We compare the
 * absolute, normalized paths so that `..`, symlink-style traversal, and odd
 * separators on Windows are all collapsed before the check. Using `sep + `
 * on the prefix prevents the classic `/root` vs `/root-evil` collision.
 */
function isPathInside(/** @type {any} */ root, /** @type {any} */ candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(rootWithSep);
}

async function extractArchive(
  /** @type {any} */ archivePath,
  /** @type {any} */ destination,
  /** @type {any} */ archiveType
) {
  const resolvedDestination = path.resolve(destination);
  await fs.promises.mkdir(resolvedDestination, { recursive: true });

  if (archiveType === 'zip') {
    const zip = new AdmZip(archivePath);
    // Zip-slip defense: validate every entry resolves inside the destination
    // BEFORE doing any extraction. If a single entry is malicious we abort the
    // whole archive rather than extracting a partial / compromised tree.
    for (const entry of zip.getEntries()) {
      const entryName = entry.entryName;
      if (path.isAbsolute(entryName)) {
        throw new Error(`Archive entry is absolute path (zip-slip): ${entryName}`);
      }
      const resolved = path.resolve(resolvedDestination, entryName);
      if (!isPathInside(resolvedDestination, resolved)) {
        throw new Error(`Archive entry escapes destination (zip-slip): ${entryName}`);
      }
    }
    zip.extractAllTo(resolvedDestination, true);
    return;
  }

  if (archiveType === 'tar.gz') {
    // tar's `filter` runs per entry; rejecting the entry with `false` skips it
    // but still lets the archive "succeed" silently. For security we want to
    // hard-abort, so we throw from inside the filter — tar will propagate it.
    await tar.x({
      file: archivePath,
      cwd: resolvedDestination,
      filter: (entryPath) => {
        if (path.isAbsolute(entryPath)) {
          throw new Error(`Archive entry is absolute path (tar-slip): ${entryPath}`);
        }
        const resolved = path.resolve(resolvedDestination, entryPath);
        if (!isPathInside(resolvedDestination, resolved)) {
          throw new Error(`Archive entry escapes destination (tar-slip): ${entryPath}`);
        }
        return true;
      }
    });
    return;
  }

  throw new Error(`Unsupported archive type: ${archiveType}`);
}

async function findBinary(/** @type {any} */ rootDir, /** @type {any} */ binaryName, maxDepth = 5) {
  /** @type {(dir: string, depth: number) => Promise<any>} */
  async function walk(dir, depth) {
    if (depth < 0) return null;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === binaryName) {
        return path.join(dir, entry.name);
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        /** @type {any} */
        const found = await walk(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(rootDir, maxDepth);
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {any} */ (server.address());
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function requestJson(
  /** @type {any} */ { method, port, path: endpointPath, body, timeoutMs, signal, apiKey }
) {
  const payload = body ? JSON.stringify(body) : null;
  const options = {
    method,
    hostname: '127.0.0.1',
    port,
    path: endpointPath,
    headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    }
  };

  const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB safety limit
  return new Promise((resolve, reject) => {
    /** @type {any} */
    let abortListener = null;
    const cleanupSignal = () => {
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          /* defensive */
        }
        abortListener = null;
      }
    };
    const settleResolve = (/** @type {any} */ value) => {
      cleanupSignal();
      resolve(value);
    };
    const settleReject = (/** @type {any} */ err) => {
      cleanupSignal();
      reject(err);
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.length > MAX_RESPONSE_SIZE) {
          req.destroy(new Error('Vision response exceeded 10 MB limit'));
        }
      });
      res.on('end', () => {
        if (!data) {
          settleResolve({ status: res.statusCode, json: null });
          return;
        }
        try {
          settleResolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (error) {
          settleReject(error);
        }
      });
    });

    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Vision request timed out'));
      });
    }

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Vision request aborted'));
        return;
      }
      // Removable listener: { once: true } only fires-and-removes on abort,
      // which means the success path leaves the closure attached to the
      // signal forever. Reused AbortControllers across many requests would
      // accumulate listeners unbounded. cleanupSignal() runs in both
      // settle paths so the listener is always released.
      abortListener = () => {
        req.destroy(new Error('Vision request aborted'));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    req.on('error', settleReject);
    if (payload) req.write(payload);
    req.end();
  });
}

function detectBase64Mime(/** @type {any} */ imageBase64) {
  if (typeof imageBase64 !== 'string') return null;
  if (imageBase64.startsWith('/9j/')) return 'image/jpeg';
  if (imageBase64.startsWith('iVBOR')) return 'image/png';
  if (imageBase64.startsWith('R0lG')) return 'image/gif';
  if (imageBase64.startsWith('UklGR')) return 'image/webp';
  return null;
}

function detectMimeFromPath(/** @type {any} */ filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return null;
}

class VisionService {
  constructor() {
    this._process = null;
    this._port = null;
    this._apiKey = null;
    this._binaryPath = null;
    this._binaryVariantKey = null;
    this._activeConfig = null;
    this._runtimeInit = null;
    this._runtimeInitVariantKey = null;
    this._startPromise = null;
    // True only between a successful startup health check and the next
    // shutdown/exit. Distinguishes "runtime serving" from "runtime starting":
    // _port is assigned at spawn time (before the health check), so _port
    // alone cannot tell callers whether a teardown would kill a mid-startup
    // child (observed in production as SIGTERM during startup).
    this._isReady = false;
    // Timestamp of the last runtime startup failure; analyzeImage fails fast
    // while inside the (streak-escalated) startup-failure cooldown of it.
    // 0 = no failure.
    this._startupFailureAt = 0;
    // Count of consecutive startup failures; scales the cooldown above.
    this._startupFailureStreak = 0;
    this._shutdownPromise = null;
    this._serverLock = Promise.resolve();
    this._idleShutdownTimer = null;
    this._recentStderr = '';
    this._runtimeBackendInfo = { backend: 'unknown', gpuActive: false };
    // Tri-state multimodal probe result. null = not yet probed. true =
    // `clip_model_load` observed during health check window. false =
    // mmprojRequired but the projector load lines were absent — runtime is
    // text-only and analyzeImage will fail fast rather than burn circuit
    // breaker slots on "Invalid url value" 500s.
    this._multimodalCapable = null;
    this._idleKeepAliveMs = parseKeepAliveMs(
      process.env.STRATOSORT_VISION_KEEPALIVE_MS,
      DEFAULT_IDLE_KEEPALIVE_MS
    );
    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('VisionService');
    // Requests between _ensureServer and the response. A text load must not
    // tear the server down while one is running (audit row ML-05), and the
    // memory manager must not evict it either: each request holds a ref.
    this._inFlightRequests = 0;
    /** @type {{ manager: any, type: string } | null} */
    this._memoryRegistration = null;
    /** @type {any} */
    this._memoryManagerOverride = null;
  }

  /**
   * Shared ModelMemoryManager (created lazily by LlamaService.initialize()).
   * Null until a model has been touched; registration then happens on the
   * next server start.
   * @returns {any}
   */
  _getMemoryManager() {
    if (this._memoryManagerOverride) return this._memoryManagerOverride;
    try {
      const { getInstance: getLlamaService } = require('./LlamaService');
      return getLlamaService()?._modelMemoryManager || null;
    } catch {
      return null;
    }
  }

  /**
   * Memory the llama-server child will hold for `config`: model file plus
   * projector, with the same ~30% KV/runtime overhead LlamaService assumes
   * for in-process models. Falls back to the fixed 5 GiB estimate when the
   * files cannot be measured.
   * @param {{ modelPath?: string, mmprojPath?: string|null } | null | undefined} config
   * @returns {Promise<number>}
   */
  async estimateRuntimeMemoryBytes(config) {
    let total = 0;
    for (const filePath of [config?.modelPath, config?.mmprojPath]) {
      if (!filePath) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat?.size > 0) total += stat.size;
      } catch {
        /* unreadable file: fall back below */
      }
    }
    return total > 0 ? Math.ceil(total * 1.3) : VISION_RUNTIME_FALLBACK_BYTES;
  }

  /** @returns {boolean} */
  hasInFlightRequests() {
    return this._inFlightRequests > 0;
  }

  /**
   * Resolve once no request is in flight, or after `timeoutMs`.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true when idle
   */
  async waitForIdle(timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this._inFlightRequests > 0 && Date.now() < deadline) {
      await delay(100);
    }
    return this._inFlightRequests === 0;
  }

  /**
   * Make the running child visible to the memory budget (audit row ML-01).
   * Before this the server was the one multi-GB consumer the manager could
   * not see, so a text load and a vision server sat together with no
   * objection. Eviction under pressure runs shutdown(); a request in flight
   * pins the entry via acquireRef so eviction skips it.
   * @param {any} config
   */
  async _registerWithMemoryManager(config) {
    const manager = this._getMemoryManager();
    if (!manager || typeof manager.registerExternalConsumer !== 'function') return;
    if (this._memoryRegistration) return;
    const sizeBytes = await this.estimateRuntimeMemoryBytes(config);
    try {
      const registered = manager.registerExternalConsumer({
        type: VISION_RUNTIME_MEMORY_TYPE,
        sizeBytes,
        label: `llama-server:${path.basename(String(config?.modelPath || 'vision'))}`,
        dispose: async () => {
          // The manager has already dropped the entry; shutdown() must not
          // try to unregister it again.
          this._memoryRegistration = null;
          await this.shutdown();
        }
      });
      if (registered) {
        this._memoryRegistration = { manager, type: VISION_RUNTIME_MEMORY_TYPE };
        for (let i = 0; i < this._inFlightRequests; i += 1) {
          manager.acquireRef?.(VISION_RUNTIME_MEMORY_TYPE);
        }
      }
    } catch (error) {
      logger.debug('[VisionService] Memory manager registration failed', {
        error: error?.message
      });
    }
  }

  _unregisterFromMemoryManager() {
    const registration = this._memoryRegistration;
    if (!registration) return;
    this._memoryRegistration = null;
    try {
      registration.manager.unregisterExternalConsumer?.(registration.type);
    } catch (error) {
      logger.debug('[VisionService] Memory manager unregistration failed', {
        error: error?.message
      });
    }
  }

  _beginRequest() {
    this._inFlightRequests += 1;
    this._memoryRegistration?.manager.acquireRef?.(this._memoryRegistration.type);
  }

  _endRequest() {
    this._inFlightRequests = Math.max(0, this._inFlightRequests - 1);
    this._memoryRegistration?.manager.releaseRef?.(this._memoryRegistration.type);
  }

  _extractDecodePressureHint() {
    const recent = String(this._recentStderr || '');
    if (!recent) return '';
    if (!isVisionDecodePressureError(recent)) {
      return '';
    }
    const normalized = recent.replace(/\s+/g, ' ').trim();
    const excerpt = normalized.slice(0, 240);
    return excerpt ? ` [vision-runtime: ${excerpt}]` : '';
  }

  isIdleKeepAliveEnabled() {
    return this._idleKeepAliveMs > 0;
  }

  /**
   * Stage the llama.cpp vision runtime (including bundled CUDA 12 DLLs on Windows)
   * without starting the HTTP server. WhisperService calls this before probing the
   * CUDA whisper.node variant so DLLs are on PATH even when no image has been analyzed yet.
   *
   * @param {{runtimeBackend?: string}} [options]
   * @returns {Promise<string|null>} Resolved binary path, or null when staging failed
   */
  async ensureRuntimeStaged(options = {}) {
    const backend = options.runtimeBackend || 'auto';
    if (!this._activeConfig) {
      this._activeConfig = { runtimeBackend: backend };
    }
    try {
      return await this._ensureBinary();
    } catch (error) {
      logger.debug('[VisionService] ensureRuntimeStaged failed (non-fatal)', {
        error: error?.message
      });
      return null;
    }
  }

  /**
   * Whether the vision child process is currently running and holding VRAM.
   * Callers (LlamaService text/embedding load paths) use this to detect when
   * the keep-alive timer is still holding VRAM that a subsequent text load
   * would otherwise contend with.
   *
   * Consults `_shutdownPromise` because `shutdown()` nulls `_process`
   * IMMEDIATELY (so concurrent callers don't reuse a dying server) but the
   * native child can take up to 5s to exit and actually release VRAM. Without
   * the promise check, a caller probing during the shutdown window sees
   * `_process === null` and proceeds to load a sibling model into VRAM that's
   * still held by the dying child — exactly the contention the safety net
   * exists to prevent.
   *
   * @returns {boolean}
   */
  isAlive() {
    return Boolean(this._process || this._shutdownPromise);
  }

  _clearIdleShutdownTimer() {
    if (!this._idleShutdownTimer) return;
    clearTimeout(this._idleShutdownTimer);
    this._idleShutdownTimer = null;
  }

  scheduleIdleShutdown(reason = 'idle') {
    this._clearIdleShutdownTimer();
    if (!this.isIdleKeepAliveEnabled() || !this._process) return;

    this._idleShutdownTimer = setTimeout(() => {
      this._idleShutdownTimer = null;
      // Do NOT track() here — shutdown() calls drain(), which would await
      // this very promise, creating a circular wait with a 5s timeout stall.
      this.shutdown().catch((error) => {
        logger.warn('[VisionService] Idle shutdown failed', {
          reason,
          error: error?.message
        });
      });
    }, this._idleKeepAliveMs);

    if (typeof this._idleShutdownTimer.unref === 'function') {
      this._idleShutdownTimer.unref();
    }

    logger.debug('[VisionService] Scheduled idle shutdown', {
      reason,
      keepAliveMs: this._idleKeepAliveMs
    });
  }

  async isAvailable() {
    // Cache result for 30s — binary path doesn't change at runtime
    if (this._isAvailableCache !== undefined && Date.now() - this._isAvailableCacheTime < 30_000) {
      return this._isAvailableCache;
    }

    const result = await this._checkAvailability();
    this._isAvailableCache = result;
    this._isAvailableCacheTime = Date.now();
    return result;
  }

  async _checkAvailability() {
    const envPath = process.env.STRATOSORT_LLAMA_SERVER_PATH;
    if (envPath) {
      try {
        await fs.promises.access(envPath);
        return true;
      } catch {
        // not found, fall through
      }
    }

    // Prefer downloaded GPU-enabled runtime over bundled (potentially CPU-only) binary
    try {
      const asset = await getAssetConfig();
      const runtimeRoot = getRuntimeRoot(asset.tag);
      const manifestPath = path.join(runtimeRoot, 'runtime.json');
      try {
        await fs.promises.access(manifestPath);
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        if (manifest?.binaryPath) {
          try {
            await fs.promises.access(manifest.binaryPath);
            return true;
          } catch {
            // binary path not accessible
          }
        }
      } catch {
        // manifest not found
      }
    } catch {
      // ignore availability checks that error
    }

    // Fallback to bundled binary (packaged builds)
    const packagedCandidate = resolveRuntimePath(SERVER_BINARY_NAME);
    try {
      await fs.promises.access(packagedCandidate);
      return true;
    } catch {
      return false;
    }
  }

  async _ensureBinary() {
    const requestedVariant = this._activeConfig?.runtimeBackend || 'auto';
    if (this._binaryPath && this._binaryVariantKey === requestedVariant) {
      return this._binaryPath;
    }

    // 1. Explicit env override. Deliberately trusted as-is: env vars require
    // control of the process environment, which is a stronger position than
    // writing userData. This is the documented dev/operator escape hatch for
    // custom llama-server builds.
    const envPath = process.env.STRATOSORT_LLAMA_SERVER_PATH;
    if (envPath) {
      try {
        await fs.promises.access(envPath);
        this._binaryPath = envPath;
        this._binaryVariantKey = requestedVariant;
        return envPath;
      } catch {
        logger.warn('[VisionService] STRATOSORT_LLAMA_SERVER_PATH not accessible', {
          path: envPath
        });
      }
    }

    // 2. Downloaded internal runtime in userData (from previous session or app-managed setup)
    try {
      const asset = await getAssetConfig(undefined, requestedVariant);
      const runtimeRoot = getRuntimeRoot(asset.tag);
      const manifestPath = path.join(runtimeRoot, 'runtime.json');
      if (await pathExists(manifestPath)) {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        if (
          manifest?.binaryPath &&
          isPathContainedIn(runtimeRoot, manifest.binaryPath) &&
          (await pathExists(manifest.binaryPath)) &&
          manifest.assetName === asset.assetName
        ) {
          logger.info('[VisionService] Using downloaded runtime', {
            binaryPath: manifest.binaryPath,
            asset: manifest.assetName
          });
          this._binaryPath = manifest.binaryPath;
          this._binaryVariantKey = requestedVariant;
          return manifest.binaryPath;
        }
        if (manifest?.binaryPath && !isPathContainedIn(runtimeRoot, manifest.binaryPath)) {
          logger.warn('[VisionService] Ignoring runtime manifest binaryPath outside runtime root', {
            binaryPath: manifest.binaryPath,
            runtimeRoot
          });
        }
      }
    } catch {
      // Fall through to bundled or app-managed download
    }

    // 3. Bundled binary (packaged builds)
    const packagedCandidate = resolveRuntimePath(SERVER_BINARY_NAME);
    if (await pathExists(packagedCandidate)) {
      logger.info('[VisionService] Using bundled runtime', {
        binaryPath: packagedCandidate
      });
      this._binaryPath = packagedCandidate;
      this._binaryVariantKey = requestedVariant;
      return packagedCandidate;
    }

    // 4. Download the correct internal runtime when no matching local copy exists
    if (!this._runtimeInit || this._runtimeInitVariantKey !== requestedVariant) {
      this._runtimeInit = this._downloadRuntime();
      this._runtimeInitVariantKey = requestedVariant;
    }
    try {
      await this._runtimeInit;
      if (this._binaryPath) {
        return this._binaryPath;
      }
    } catch (error) {
      this._runtimeInit = null;
      this._runtimeInitVariantKey = null;
      logger.warn('[VisionService] Download failed, rechecking bundled path', {
        error: error.message
      });
    }

    // 5. Bundled binary as last resort (e.g. download failed but build included it)
    const fallbackPackaged = resolveRuntimePath(SERVER_BINARY_NAME);
    if (await pathExists(fallbackPackaged)) {
      logger.info('[VisionService] Using bundled runtime fallback', {
        binaryPath: fallbackPackaged
      });
      this._binaryPath = fallbackPackaged;
      this._binaryVariantKey = requestedVariant;
      return fallbackPackaged;
    }

    throw new Error('Vision runtime not found: no bundled, downloaded, or env binary available');
  }

  async _downloadRuntime() {
    const asset = /** @type {any} */ (
      await getAssetConfig(undefined, this._activeConfig?.runtimeBackend || 'auto')
    );
    const runtimeRoot = getRuntimeRoot(asset.tag);
    await fs.promises.mkdir(runtimeRoot, { recursive: true });

    const manifestPath = path.join(runtimeRoot, 'runtime.json');
    try {
      const existing = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      // Re-download if the asset variant changed (e.g., cpu -> vulkan)
      if (
        existing?.binaryPath &&
        isPathContainedIn(runtimeRoot, existing.binaryPath) &&
        (await pathExists(existing.binaryPath)) &&
        existing.assetName === asset.assetName
      ) {
        this._binaryPath = existing.binaryPath;
        this._binaryVariantKey = this._activeConfig?.runtimeBackend || 'auto';
        return;
      }
      if (existing?.assetName && existing.assetName !== asset.assetName) {
        logger.info('[VisionService] Asset variant changed, re-downloading', {
          from: existing.assetName,
          to: asset.assetName
        });
      }
    } catch {
      // Ignore missing/invalid manifest
    }

    const archivePath = path.join(runtimeRoot, asset.assetName);
    // Resolve the expected SHA-256: prefer the asset's explicit pin (operator
    // env override or future signed manifest), fall back to the static
    // `LLAMA_CPP_KNOWN_SHA256` map keyed by `${tag}/${assetName}`. Without
    // the fallback, every default-URL download ran with `expectedSha256:
    // undefined` and the binary that ultimately got executed was unverified.
    const resolvedSha256 = asset.sha256 || _getKnownSha256(asset.tag, asset.assetName);
    if (!resolvedSha256) {
      logger.warn(
        '[VisionService] Downloading vision runtime WITHOUT SHA-256 verification ' +
          '(no known digest for this tag/asset); update LLAMA_CPP_KNOWN_SHA256 to fix.',
        { tag: asset.tag, asset: asset.assetName }
      );
    }
    logger.info('[VisionService] Downloading vision runtime', {
      asset: asset.assetName,
      sha256Pinned: Boolean(resolvedSha256)
    });
    await downloadFile(asset.url, archivePath, { expectedSha256: resolvedSha256 });

    try {
      await extractArchive(archivePath, runtimeRoot, asset.archiveType);
    } catch (extractionError) {
      try {
        await fs.promises.unlink(archivePath);
      } catch {
        /* ignore cleanup errors */
      }
      throw extractionError;
    }

    const binaryPath = await findBinary(runtimeRoot, SERVER_BINARY_NAME);
    if (!binaryPath) {
      throw new Error('Vision runtime binary not found after extraction');
    }

    // Download CUDA runtime DLLs alongside the binary when using a CUDA build.
    // The DLLs must live in the same directory as the binary so the dynamic
    // linker can find them at spawn time (cwd = binaryDir).
    if (asset.cudartAssetName && asset.cudartUrl) {
      const cudartArchive = path.join(runtimeRoot, asset.cudartAssetName);
      const binaryDir = path.dirname(binaryPath);
      logger.info('[VisionService] Downloading CUDA runtime DLLs', {
        asset: asset.cudartAssetName,
        targetDir: binaryDir
      });
      try {
        // Same SHA-256 resolution policy as the main binary: prefer explicit
        // pin, fall back to the known-digests map. `cudartSha256` field has
        // never been populated in this codebase — without the lookup, this
        // ran fully unverified.
        const resolvedCudartSha =
          asset.cudartSha256 || _getKnownSha256(asset.tag, asset.cudartAssetName);
        if (!resolvedCudartSha) {
          logger.warn(
            '[VisionService] Downloading CUDA runtime DLLs WITHOUT SHA-256 verification.',
            { tag: asset.tag, asset: asset.cudartAssetName }
          );
        }
        await downloadFile(asset.cudartUrl, cudartArchive, {
          expectedSha256: resolvedCudartSha
        });
        await extractArchive(cudartArchive, binaryDir, asset.archiveType);
        logger.info('[VisionService] CUDA runtime DLLs installed');
      } catch (cudartError) {
        // Non-fatal: the system may already have CUDA DLLs via the driver.
        // Log and continue — the server will fail to start if they're truly missing.
        logger.warn(
          '[VisionService] Failed to download CUDA runtime DLLs; ' +
            'CUDA may still work if the driver provides them',
          {
            error: cudartError.message
          }
        );
      } finally {
        try {
          await fs.promises.unlink(cudartArchive);
        } catch {
          /* ignore */
        }
      }
    }

    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(binaryPath, 0o755);
      } catch (error) {
        logger.debug('[VisionService] Failed to chmod vision binary', { error: error.message });
      }
    }

    this._binaryPath = binaryPath;
    this._binaryVariantKey = this._activeConfig?.runtimeBackend || 'auto';
    this._runtimeInitVariantKey = this._activeConfig?.runtimeBackend || 'auto';
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(
        {
          tag: asset.tag,
          assetName: asset.assetName,
          binaryPath
        },
        null,
        2
      )
    );

    try {
      await fs.promises.unlink(archivePath);
    } catch {
      // ignore cleanup errors
    }
  }

  _buildServerArgs(/** @type {any} */ config, /** @type {any} */ port, /** @type {any} */ apiKey) {
    const args = [
      '-m',
      config.modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-webui',
      '--parallel',
      '1'
    ];

    if (apiKey) {
      args.push('--api-key', apiKey);
    }

    if (config.mmprojPath) {
      args.push('--mmproj', config.mmprojPath);
    }

    if (typeof config.contextSize === 'number' && config.contextSize > 0) {
      args.push('--ctx-size', String(config.contextSize));
    }

    if (typeof config.threads === 'number' && config.threads > 0) {
      args.push('--threads', String(config.threads));
    }

    // Only set --n-gpu-layers when explicitly configured.
    // For "auto"/unset, let llama-server fit layers to available VRAM.
    if (typeof config.gpuLayers === 'number' && config.gpuLayers >= 0) {
      args.push('--n-gpu-layers', String(config.gpuLayers));
    }

    // Reduce decode/KV pressure on constrained VRAM profiles when provided by caller.
    if (typeof config.batchSize === 'number' && config.batchSize > 0) {
      args.push('-b', String(config.batchSize));
    }
    if (typeof config.ubatchSize === 'number' && config.ubatchSize > 0) {
      args.push('-ub', String(config.ubatchSize));
    }

    return args;
  }

  async _waitForHealth(
    /** @type {any} */ port,
    timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    /** @type {any} */ signal
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (signal?.aborted) {
        throw new Error('Vision runtime startup aborted (process exited)');
      }
      try {
        const { status, json } = await requestJson({
          method: 'GET',
          port,
          path: '/health',
          timeoutMs: VISION_HEALTH_REQUEST_TIMEOUT_MS,
          apiKey: this._apiKey
        });
        if (status === 200 && (json?.status === 'ok' || json?.status === 'OK')) {
          return;
        }
      } catch {
        // ignore until timeout
      }
      await delay(500);
    }
    throw new Error('Vision runtime failed to start in time');
  }

  _resolveStartupTimeoutMs(/** @type {any} */ config = {}) {
    if (config?.runtimeBackend === 'cpu' || config?.gpuLayers === 0) {
      return CPU_STARTUP_TIMEOUT_MS;
    }
    return DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async _startServer(/** @type {any} */ config) {
    const binaryPath = await this._ensureBinary();
    const port = await getAvailablePort();
    this._apiKey = crypto.randomBytes(32).toString('hex');
    const args = this._buildServerArgs(config, port, this._apiKey);

    logger.info('[VisionService] Starting vision runtime', {
      binaryPath,
      port,
      contextSize: config.contextSize,
      gpuLayers: typeof config.gpuLayers === 'number' ? config.gpuLayers : 'auto',
      batchSize: config.batchSize || null,
      ubatchSize: config.ubatchSize || null,
      // Surface multimodal config so future "Invalid url value" reports are
      // immediately diagnosable: if mmprojRequired=true and mmprojPath is
      // null, the spawn arg list silently omits --mmproj and the server
      // happily serves text-only chats — image requests then fail with the
      // generic 500. Logging both makes the misconfiguration visible.
      mmprojPath: config.mmprojPath || null,
      mmprojRequired: Boolean(config.mmprojRequired)
    });

    const child = spawn(binaryPath, args, {
      cwd: path.dirname(binaryPath),
      windowsHide: true,
      // Least-privilege env: only what the child actually needs. See
      // LLAMA_CHILD_ENV_ALLOWLIST for the rationale.
      env: buildLlamaChildEnv({
        LLAMA_ARG_LOG_VERBOSITY: process.env.LLAMA_ARG_LOG_VERBOSITY || '2'
      })
    });

    /** @type {any[]} */
    const stderrChunks = [];
    const stdoutDecoder = createUtf8ChunkDecoder((/** @type {any} */ text) => {
      logger.debug('[VisionService][stdout]', { message: text });
    });
    const stderrDecoder = createUtf8ChunkDecoder((/** @type {any} */ text) => {
      stderrChunks.push(text);
      this._recentStderr = `${this._recentStderr}${text}`.slice(-4000);
      logger.debug('[VisionService][stderr]', { message: text });
    });

    child.stdout?.on('data', (/** @type {any} */ data) => {
      stdoutDecoder.push(data);
    });

    child.stderr?.on('data', (/** @type {any} */ data) => {
      stderrDecoder.push(data);
    });

    // AbortController to cancel health check if process exits early
    const abortController = new AbortController();

    // Create a promise that rejects if the process exits before health is confirmed.
    // This prevents _waitForHealth from polling a dead process for 180s.
    // preventing both a stale listener and an unhandled promise rejection when the
    // process later exits normally.
    let earlyExitHandler;
    const earlyExitPromise = new Promise((_, reject) => {
      earlyExitHandler = (/** @type {any} */ code, /** @type {any} */ signal) => {
        abortController.abort(); // Signal health check to stop polling
        const stderr = stderrChunks.join('').slice(-500);
        reject(
          new Error(
            `Vision runtime exited during startup (code=${code}, signal=${signal})${stderr ? ': ' + stderr : ''}`
          )
        );
      };
      child.on('exit', earlyExitHandler);
    });
    // Suppress unhandled rejection if health check wins the race
    earlyExitPromise.catch((e) => {
      logger.debug('[VisionService] Early exit promise rejected', { error: e.message });
    });

    // Handle spawn-level errors (e.g. ENOENT when binary doesn't exist)
    child.on('error', (err) => {
      logger.error('[VisionService] Failed to spawn vision runtime', { error: err.message });
    });

    // Clean up state when the process exits (for both startup failures and runtime crashes)
    this._generalExitHandler = (/** @type {any} */ code, /** @type {any} */ signal) => {
      stdoutDecoder.end();
      stderrDecoder.end();
      logger.warn('[VisionService] Vision runtime exited', { code, signal });
      // Identity guard: a newer spawn may have already replaced this child
      // (crash-then-restart). A stale exit event from the OLD child must not
      // null out the NEW child's shared state. Mirrors the `this._process ===
      // child` guard in the health-check catch path below.
      if (this._process !== child) return;
      this._process = null;
      this._port = null;
      this._apiKey = null;
      this._isReady = false;
      this._activeConfig = null;
      this._startPromise = null;
      this._recentStderr = '';
      this._runtimeBackendInfo = { backend: 'unknown', gpuActive: false };
      this._unregisterFromMemoryManager();
      // Reset the multimodal probe result so the next spawn re-probes
      // honestly instead of inheriting a stale "true/false" from the
      // previous runtime (which may have used a different binary or env).
      this._multimodalCapable = null;
      this._binaryVariantKey = null;
      this._runtimeInitVariantKey = null;
    };
    child.on('exit', this._generalExitHandler);

    this._process = child;
    this._port = port;

    // Kill the child process if the parent exits unexpectedly (crash, SIGTERM, etc.)
    // On Windows, child processes are NOT auto-killed when the parent dies.
    // Remove any stale handler from a previous start() to prevent listener leak
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
    }
    this._exitHandler = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    process.on('exit', this._exitHandler);

    // Race health check against early exit -- if the process dies first, fail immediately
    try {
      await Promise.race([
        this._waitForHealth(port, this._resolveStartupTimeoutMs(config), abortController.signal),
        earlyExitPromise
      ]);
      // Health check succeeded -- remove the startup exit listener to avoid
      // spurious rejection when the process later exits normally.
      child.removeListener('exit', earlyExitHandler);
      this._isReady = true;
      await this._registerWithMemoryManager(config);

      // Multimodal capability probe. When the model declares mmprojRequired,
      // llama-server emits `clip_model_load:` lines during projector init.
      // If those lines are absent at /health = 200, the server has loaded
      // text-only and will reject every subsequent `image_url` request
      // with the generic "Invalid url value" 500 — burning circuit-breaker
      // failures and leaving the user without a clear cause. Capturing the
      // signal here lets `analyzeImage` short-circuit with a useful error
      // and lets a future startup-self-test surface the regression loudly.
      const startupStderrLower = stderrChunks.join('').toLowerCase();
      const multimodalLoaded = startupStderrLower.includes('clip_model_load');
      if (config.mmprojRequired && !multimodalLoaded) {
        this._multimodalCapable = false;
        logger.error('[VisionService] Multimodal capability NOT detected after health check', {
          mmprojPath: config.mmprojPath,
          mmprojRequired: true,
          port,
          hint:
            'llama-server loaded but no clip_model_load: lines were emitted. ' +
            'The bundled binary may lack multimodal support, or a missing env ' +
            'var stripped CUDA/cuDNN load paths during projector init. ' +
            'Image requests will fail with "Invalid url value".'
        });
      } else if (config.mmprojRequired) {
        this._multimodalCapable = true;
        logger.info('[VisionService] Multimodal capability confirmed', { port });
      } else {
        this._multimodalCapable = null;
      }

      // Free startup stderr buffer — no longer needed after successful health check
      stderrChunks.length = 0;
      this._runtimeBackendInfo = detectRuntimeBackendInfo(this._recentStderr);
      logger.info('[VisionService] Vision runtime ready', {
        port,
        backend: this._runtimeBackendInfo.backend,
        gpuActive: this._runtimeBackendInfo.gpuActive,
        gpuLayers: typeof config.gpuLayers === 'number' ? config.gpuLayers : 'auto',
        contextSize: config.contextSize
      });
    } catch (error) {
      // Ensure we clean up if health check fails or process exits
      child.removeListener('exit', earlyExitHandler);
      // Remove process-level exit handler to prevent stale listener leak
      if (this._exitHandler) {
        process.removeListener('exit', this._exitHandler);
        this._exitHandler = null;
      }
      if (this._process === child) {
        this._process = null;
        this._port = null;
        this._apiKey = null;
        this._isReady = false;
        this._activeConfig = null;
        this._startPromise = null;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
  }

  _configMatches(/** @type {any} */ config) {
    if (!this._activeConfig) return false;
    return (
      this._activeConfig.modelPath === config.modelPath &&
      this._activeConfig.mmprojPath === config.mmprojPath &&
      this._activeConfig.contextSize === config.contextSize &&
      this._activeConfig.threads === config.threads &&
      this._activeConfig.runtimeBackend === config.runtimeBackend &&
      this._activeConfig.gpuLayers === config.gpuLayers &&
      this._activeConfig.batchSize === config.batchSize &&
      this._activeConfig.ubatchSize === config.ubatchSize
    );
  }

  async _ensureServer(/** @type {any} */ config) {
    /** @type {(v?: any) => void} */
    let releaseLock = () => {};
    const acquireLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    // Chain the lock
    const previousLock = this._serverLock;
    this._serverLock = (async () => {
      try {
        await previousLock;
      } catch {
        // Ignore previous errors
      }
      await acquireLock;
    })();

    try {
      // Wait for any previous operation to complete
      await previousLock;

      // Wait for any pending shutdown to complete before starting
      if (this._shutdownPromise) {
        await this._shutdownPromise;
      }

      if (this._process && this._port && this._configMatches(config)) {
        return;
      }

      if (this._process) {
        await this.shutdown();
      }

      this._activeConfig = { ...config };
      // We are holding the lock, so it's safe to set _startPromise
      this._startPromise = this._startServer(config).catch((error) => {
        this._startPromise = null;
        this._activeConfig = null; // Clear stale config so retries can proceed
        throw error;
      });

      await this._startPromise;
    } finally {
      releaseLock();
    }
  }

  async analyzeImage(/** @type {any} */ options = {}) {
    const {
      imageBase64,
      imagePath,
      prompt,
      systemPrompt,
      maxTokens = 1024,
      temperature = 0.2,
      timeoutMs,
      signal,
      config
    } = options;

    if (!config?.modelPath) {
      throw new Error('Vision model not found: no model path provided');
    }

    if (config?.mmprojRequired && !config?.mmprojPath) {
      throw new Error('Vision model not found: missing multimodal projector');
    }

    // Fail fast while a recent startup failure is inside its cooldown so a
    // queued batch degrades to OCR-only in milliseconds (the message contains
    // "vision runtime" on purpose — imageAnalysis.js routes it through
    // MODEL_NOT_AVAILABLE_PATTERNS) instead of paying a doomed spawn attempt
    // or the full analysis timeout per image.
    const sinceStartupFailure = Date.now() - this._startupFailureAt;
    const startupFailureCooldownMs = Math.min(
      VISION_STARTUP_FAILURE_COOLDOWN_MS * 2 ** Math.max(0, this._startupFailureStreak - 1),
      VISION_STARTUP_FAILURE_COOLDOWN_MAX_MS
    );
    if (this._startupFailureAt > 0 && sinceStartupFailure < startupFailureCooldownMs) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          `Vision runtime unavailable: startup failed ${Math.round(sinceStartupFailure / 1000)}s ago; ` +
            `retrying after ${Math.round(startupFailureCooldownMs / 1000)}s cooldown` +
            (this._startupFailureStreak > 1
              ? ` (${this._startupFailureStreak} consecutive failures)`
              : '')
        )
      );
      err.code = 'VISION_UNAVAILABLE';
      throw err;
    }

    this._clearIdleShutdownTimer();
    try {
      await this._ensureServer(config);
    } catch (err) {
      // _ensureServer wraps spawn / HTTP-probe / GPU-detection failures.
      // Surface these as a subsystem-down signal so users see "vision
      // analysis is offline" instead of every per-image call returning a
      // bare exception. Image analysis silently falling back to OCR-only
      // (the existing graceful degradation in imageAnalysis.js) becomes
      // invisible without this.
      this._startupFailureStreak += 1;
      this._startupFailureAt = Date.now();
      _maybeRaiseVisionUnavailable(err, 'startup');
      throw err;
    }
    this._startupFailureAt = 0;
    this._startupFailureStreak = 0;

    // Validate server is still alive after _ensureServer (process may have died in between)
    if (!this._port || !this._process) {
      const err = new Error('Vision runtime is not running (server exited after startup)');
      this._startupFailureStreak += 1;
      this._startupFailureAt = Date.now();
      _maybeRaiseVisionUnavailable(err, 'exited-after-startup');
      throw err;
    }

    // If the startup probe determined the runtime can't actually decode
    // images, fail fast with a clear error rather than letting llama-server
    // return its generic "Invalid url value" 500 — that response burns a
    // circuit-breaker slot and gives no diagnostic signal. The downstream
    // image analyzer can then degrade to OCR-only.
    if (this._multimodalCapable === false) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('Vision runtime is text-only: multimodal projector failed to load at startup')
      );
      err.code = 'VISION_NO_MULTIMODAL';
      _maybeRaiseVisionUnavailable(err, 'text-only');
      throw err;
    }

    let imageData = imageBase64;
    let mimeType = null;

    if (!imageData && imagePath) {
      const buffer = await fs.promises.readFile(imagePath);
      imageData = buffer.toString('base64');
      mimeType = detectMimeFromPath(imagePath);
    }

    if (!imageData) {
      throw new Error('Vision input not found');
    }

    if (!mimeType) {
      mimeType = detectBase64Mime(imageData) || 'image/png';
    }

    // Defensive guard: llama-server's URL parser splits the data URL on `,`
    // and expects exactly 2 parts (`data:mime;base64` + payload). If
    // `imageData` ever contains a comma, the request will fail with the
    // server's generic "Invalid url value" 500 — no useful diagnostic.
    // Validating here turns that into a clear local error instead. Standard
    // base64 (RFC 4648) only uses A-Z a-z 0-9 + / =, so a comma here always
    // signals a bug upstream (e.g. Uint8Array.toString() leaking through
    // worker_threads serialization, see imageAnalysis.js).
    if (typeof imageData !== 'string' || imageData.length === 0) {
      throw new Error(`Vision input invalid: imageData is ${typeof imageData}`);
    }
    if (imageData.includes(',')) {
      throw new Error(
        'Vision input invalid: base64 contains commas — likely Uint8Array ' +
          'leaked through worker boundary instead of a Node.js Buffer'
      );
    }

    const dataUrl = `data:${mimeType};base64,${imageData}`;
    const requestTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this._beginRequest();
    try {
      const response = await requestJson({
        method: 'POST',
        port: this._port,
        path: '/v1/chat/completions',
        body: {
          model: path.basename(config.modelPath),
          messages: [
            systemPrompt
              ? { role: 'system', content: systemPrompt }
              : { role: 'system', content: 'You are a helpful vision assistant.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt || 'Describe this image.' },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: maxTokens,
          temperature
        },
        timeoutMs: requestTimeoutMs,
        signal,
        apiKey: this._apiKey
      });

      if (response?.json?.error) {
        const baseMessage = response.json.error.message || 'Vision runtime error';
        const decodePressureHint = this._extractDecodePressureHint();
        throw new Error(`${baseMessage}${decodePressureHint}`);
      }

      const content = response?.json?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Vision runtime returned empty response');
      }

      // Successful image analysis means the runtime is online + multimodal-
      // capable; clear any prior subsystem-down banner so the UI reflects
      // recovery (operator restored the projector, vision binary ships,
      // backend re-initialized after a transient GPU error).
      _clearVisionUnavailable();
      return { response: content };
    } catch (error) {
      const message = String(error?.message || '');
      if (/timed out|aborted/i.test(message)) {
        logger.warn('[VisionService] Vision request interrupted; restarting runtime', {
          error: message,
          timeoutMs: requestTimeoutMs,
          backend: this._runtimeBackendInfo?.backend || 'unknown',
          gpuActive: Boolean(this._runtimeBackendInfo?.gpuActive)
        });
        try {
          await this.shutdown();
        } catch (shutdownError) {
          logger.debug('[VisionService] Vision runtime restart cleanup failed', {
            error: shutdownError?.message
          });
        }
      }
      throw error;
    } finally {
      this._endRequest();
      this.scheduleIdleShutdown('analyzeImage');
    }
  }

  async shutdown() {
    this._clearIdleShutdownTimer();
    // Drain tracked background work before shutdown
    await this._bgWork.drain();
    // If already shutting down, return the existing promise
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }

    const proc = this._process;

    // Clear state immediately so concurrent callers don't re-use the dying server
    this._process = null;
    this._port = null;
    this._apiKey = null;
    this._isReady = false;
    this._activeConfig = null;
    this._startPromise = null;
    this._recentStderr = '';
    this._runtimeBackendInfo = { backend: 'unknown', gpuActive: false };
    this._multimodalCapable = null;
    this._binaryVariantKey = null;
    this._runtimeInitVariantKey = null;
    this._unregisterFromMemoryManager();

    // Remove the parent-exit safety handler since we're shutting down explicitly
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }

    // Remove the general exit listener from the child process to prevent stale listener leaks
    if (proc && this._generalExitHandler) {
      try {
        proc.removeListener('exit', this._generalExitHandler);
      } catch {
        /* ignore -- process may already be destroyed */
      }
      this._generalExitHandler = null;
    }

    if (proc) {
      logger.info('[VisionService] Shutting down vision runtime');

      this._shutdownPromise = (async () => {
        // Wait for the process to actually exit (max 5 s) so a subsequent
        // _startServer doesn't race against the dying instance.
        // Attach the exit listener BEFORE killing to avoid missing the event.
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            // Verify the SIGKILL actually landed before declaring shutdown
            // done. _process was already cleared for concurrent callers, so
            // a survivor here is an orphan holding the port/VRAM — surface
            // it loudly instead of silently resolving.
            const verify = setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                logger.error(
                  '[VisionService] Vision runtime survived SIGKILL; orphan process may hold GPU/port resources',
                  { pid: proc.pid }
                );
              }
              resolve();
            }, 2000);
            if (verify.unref) verify.unref();
            proc.once('exit', () => {
              clearTimeout(verify);
              resolve();
            });
          }, TIMEOUTS.HEALTH_CHECK);
          if (timeout.unref) timeout.unref();

          proc.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          // Remove other listeners to prevent leaks from _startServer
          try {
            proc.removeAllListeners('error');
            proc.stdout?.removeAllListeners();
            proc.stderr?.removeAllListeners();
          } catch {
            // ignore -- streams may already be closed
          }

          try {
            proc.kill();
          } catch {
            // ignore -- process may have already exited
          }
        });
      })().finally(() => {
        this._shutdownPromise = null;
      });

      await this._shutdownPromise;
    }
  }
}

const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: VisionService,
    serviceId: 'VISION_SERVICE',
    serviceName: 'VisionService',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

/** @internal Reset module-level caches (for testing only). */
function _resetRuntimeCache() {
  _detectedGpuInfo = null;
  _gpuInfoPromise = null;
  loggedRuntimeVariant = false;
}

module.exports = {
  VisionService,
  VISION_RUNTIME_MEMORY_TYPE,
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance,
  _resetRuntimeCache,
  _getAssetConfig: getAssetConfig,
  _createUtf8ChunkDecoder: createUtf8ChunkDecoder,
  _detectBase64Mime: detectBase64Mime,
  _detectMimeFromPath: detectMimeFromPath,
  confirmGpuBackend,
  // Exposed so WhisperService can locate the on-disk vision runtime root
  // (which holds the bundled CUDA 12 runtime DLLs whisper.node depends on)
  // without instantiating the singleton or hard-coding the tag.
  getRuntimeRoot,
  LLAMA_CPP_RELEASE_TAG
};
