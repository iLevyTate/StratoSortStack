#!/usr/bin/env node
/**
 * Vision Runtime Setup Script
 *
 * Downloads the platform-specific llama-server binary from llama.cpp releases
 * and places it in assets/runtime/ for bundling with the production installer.
 *
 * The VisionService checks this path first (via resolveRuntimePath) before
 * attempting a runtime download, so bundling the binary eliminates the need
 * for users to download it separately.
 *
 * Usage:
 *   node scripts/setup-vision-runtime.js            # Download for current platform
 *   node scripts/setup-vision-runtime.js --check     # Check if runtime is present
 *   node scripts/setup-vision-runtime.js --force      # Re-download even if present
 *
 * Environment:
 *   SKIP_VISION_RUNTIME=true    Skip download (for CI or fast dev iteration)
 *   STRATOSORT_LLAMA_CPP_TAG    Override the llama.cpp release tag (default: b9000)
 *   STRATOSORT_LLAMA_CPP_URL    Override the download URL entirely
 *   STRATOSORT_VISION_RUNTIME_PLATFORM   Override host OS for which binary to fetch:
 *                                        win32 | darwin | linux (default: process.platform).
 *                                        Use when packaging on one OS for another (run before electron-builder).
 *   STRATOSORT_VISION_RUNTIME_ARCH       Override process.arch (e.g. x64 | arm64) for the download.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const { GPUMonitor } = require('../src/main/services/GPUMonitor');

// Must match VisionService.js constants exactly
const LLAMA_CPP_RELEASE_TAG = process.env.STRATOSORT_LLAMA_CPP_TAG || 'b9000';
const LLAMA_CPP_BASE_URL = 'https://github.com/ggml-org/llama.cpp/releases/download';

// SECURITY: Only allow downloads from github.com and its CDN. GitHub
// release downloads redirect to either objects.githubusercontent.com
// (older) or release-assets.githubusercontent.com (newer, started rolling
// out in 2024-2025) — both must be allowed because the redirect target
// depends on the asset/region. Plus the raw GitHub API for completeness.
// An attacker who sets STRATOSORT_LLAMA_CPP_URL or controls a redirect
// response could otherwise steer the installer to an arbitrary binary.
const ALLOWED_RUNTIME_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com'
]);
const MAX_REDIRECTS = 5;

function isAllowedRuntimeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.toLowerCase();
  return ALLOWED_RUNTIME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function validateRuntimeUrl(rawUrl, context = 'runtime download') {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${context} URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked non-HTTPS ${context} URL (got ${parsed.protocol}//${parsed.host}): ${rawUrl}`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked credentialed ${context} URL`);
  }
  if (!isAllowedRuntimeHost(parsed.hostname)) {
    throw new Error(`Blocked ${context} from untrusted host: ${parsed.hostname}`);
  }
  return parsed;
}
function getTargetPlatform() {
  const p = process.env.STRATOSORT_VISION_RUNTIME_PLATFORM;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  return process.platform;
}

function getTargetArch() {
  const a = process.env.STRATOSORT_VISION_RUNTIME_ARCH;
  if (a === 'x64' || a === 'arm64' || a === 'ia32') return a;
  return process.arch;
}

const SERVER_BINARY_NAME = getTargetPlatform() === 'win32' ? 'llama-server.exe' : 'llama-server';

const RUNTIME_DIR = path.join(__dirname, '..', 'assets', 'runtime');
const MANIFEST_PATH = path.join(RUNTIME_DIR, 'runtime.json');

// --- Asset config ---
// On Windows, selects GPU-accelerated builds (CUDA > Vulkan > CPU) when available.
// The llama.cpp CUDA release zips are self-contained with all required DLLs bundled.

function inferArchiveType(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}

function parseCudaVersion(name) {
  const match = /cuda-(\d+)\.(\d+)/i.exec(name);
  if (!match) return 0;
  return Number(match[1]) * 100 + (Number(match[2]) || 0);
}

/**
 * Pick the best CUDA asset for Windows.
 * Prefers full `llama-...-win-cuda-...` archives (score +1000) over
 * `cudart-llama-...` archives which only contain CUDA runtime DLLs.
 * Among candidates, higher CUDA version scores higher.
 */
function pickWinCudaAsset(assets, archToken) {
  const candidates = assets
    .filter((asset) => {
      const name = asset?.name || '';
      return name.includes('win-cuda') && name.includes(archToken) && name.endsWith('.zip');
    })
    .map((asset) => {
      const name = asset.name || '';
      const isCudart = name.startsWith('cudart-llama-');
      const versionScore = parseCudaVersion(name);
      // Prefer full server archives (llama-...) over cudart-only packages
      return { asset, score: (isCudart ? 0 : 1000) + versionScore };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.asset || null;
}

function pickWinVulkanAsset(assets, archToken) {
  return (
    assets.find((asset) => {
      const name = asset?.name || '';
      return name.includes('win-vulkan') && name.includes(archToken) && name.endsWith('.zip');
    }) || null
  );
}

function pickWinCpuAsset(assets, tag, archToken) {
  const expected = `llama-${tag}-bin-win-cpu-${archToken}.zip`;
  return assets.find((asset) => asset?.name === expected) || null;
}

// Fetch the asset list from GitHub's release API.
//
// Previous behaviour resolved `[]` on *any* failure (network error, non-200,
// JSON parse). That silently masked upstream issues: the script would fall
// through to the hard-coded CPU asset URL and print "downloading X" as if
// everything were fine. We now distinguish "no release" from "API failed"
// and surface the failure loudly so release-packaging pipelines don't ship
// without the expected binary.
async function fetchReleaseAssets(tag) {
  const url = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'StratoSort',
          Accept: 'application/vnd.github+json'
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          if (res.statusCode === 404) {
            // A missing release tag is a real condition callers must handle,
            // distinct from "API down" — return empty list and let the
            // caller decide whether to fail.
            resolve([]);
            return;
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `GitHub release API returned HTTP ${res.statusCode} for tag ${tag}: ${res.statusMessage || 'unknown error'}`
              )
            );
            return;
          }
          let json;
          try {
            json = JSON.parse(data);
          } catch (err) {
            reject(
              new Error(`GitHub release API returned invalid JSON for tag ${tag}: ${err.message}`)
            );
            return;
          }
          resolve(Array.isArray(json?.assets) ? json.assets : []);
        });
      }
    );
    req.on('error', (err) =>
      reject(new Error(`GitHub release API request failed: ${err.message}`))
    );
    req.setTimeout(10000, () => {
      req.destroy(new Error(`GitHub release API timed out after 10s (tag ${tag})`));
    });
  });
}

async function getAssetConfig(tag = LLAMA_CPP_RELEASE_TAG, gpuInfo = null) {
  const overrideUrl = process.env.STRATOSORT_LLAMA_CPP_URL;
  if (overrideUrl && overrideUrl.trim()) {
    // SECURITY: validate before using — the override env var is an
    // attacker-influential input and silently accepting http:// or an
    // arbitrary host is a supply-chain hole.
    validateRuntimeUrl(overrideUrl.trim(), 'STRATOSORT_LLAMA_CPP_URL override');
    const archiveType = inferArchiveType(overrideUrl);
    if (!archiveType) {
      throw new Error('Unsupported llama.cpp runtime archive format');
    }
    return {
      tag: 'custom',
      assetName: path.basename(overrideUrl),
      archiveType,
      url: overrideUrl.trim()
    };
  }

  const platform = getTargetPlatform();
  const arch = getTargetArch();

  if (platform === 'win32') {
    const archToken = arch === 'arm64' ? 'arm64' : 'x64';
    const assets = await fetchReleaseAssets(tag);

    // CUDA/Vulkan selection only makes sense when fetching *on* Windows; otherwise pick CPU zip.
    const winGpu = process.platform === 'win32' ? gpuInfo : { type: 'cpu' };

    let selected = null;
    if (winGpu?.type === 'cuda') {
      selected = pickWinCudaAsset(assets, archToken);
    } else if (winGpu?.type === 'vulkan') {
      selected = pickWinVulkanAsset(assets, archToken);
    }
    if (!selected) {
      selected = pickWinCpuAsset(assets, tag, archToken);
    }

    const assetName = selected?.name
      ? selected.name
      : arch === 'arm64'
        ? `llama-${tag}-bin-win-cpu-arm64.zip`
        : `llama-${tag}-bin-win-cpu-x64.zip`;
    return {
      tag,
      assetName,
      archiveType: 'zip',
      url: selected?.browser_download_url || `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };
  }

  if (platform === 'darwin') {
    const assetName =
      arch === 'arm64'
        ? `llama-${tag}-bin-macos-arm64.tar.gz`
        : `llama-${tag}-bin-macos-x64.tar.gz`;
    return {
      tag,
      assetName,
      archiveType: 'tar.gz',
      url: `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };
  }

  if (platform === 'linux') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Unsupported Linux architecture for vision runtime: ${arch}`);
    }
    const archToken = arch === 'arm64' ? 'arm64' : 'x64';
    const assetName = `llama-${tag}-bin-ubuntu-${archToken}.tar.gz`;
    return {
      tag,
      assetName,
      archiveType: 'tar.gz',
      url: `${LLAMA_CPP_BASE_URL}/${tag}/${assetName}`
    };
  }

  throw new Error(`Unsupported platform for vision runtime: ${platform}`);
}

// --- Download ---

function downloadFile(url, destination, redirectsLeft = MAX_REDIRECTS) {
  // SECURITY: validate BEFORE issuing the request so an http:// or
  // off-allowlist URL never reaches the network stack.
  validateRuntimeUrl(url, 'vision runtime download');

  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'StratoSort' } }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.destroy();
        if (redirectsLeft <= 0) {
          reject(new Error(`Exceeded max redirects (${MAX_REDIRECTS}) downloading ${url}`));
          return;
        }
        let resolvedRedirect;
        try {
          resolvedRedirect = new URL(response.headers.location, url).toString();
        } catch {
          reject(new Error(`Invalid redirect target from ${url}: ${response.headers.location}`));
          return;
        }
        try {
          validateRuntimeUrl(resolvedRedirect, 'vision runtime redirect');
        } catch (err) {
          reject(err);
          return;
        }
        downloadFile(resolvedRedirect, destination, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        response.resume();
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedBytes = 0;
      let lastLogTime = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastLogTime > 2000) {
          const pct = totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : '?';
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalMb = totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) : '?';
          process.stdout.write(`\r  Progress: ${mb} MB / ${totalMb} MB (${pct}%)    `);
          lastLogTime = now;
        }
      });

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          process.stdout.write('\n');
          resolve();
        });
      });
      fileStream.on('error', (error) => {
        fsp.unlink(destination).catch(() => {});
        reject(error);
      });
    });

    request.on('error', reject);
    request.setTimeout(300000, () => {
      request.destroy();
      reject(new Error('Download timeout (5 minutes)'));
    });
  });
}

// --- Extraction ---

async function findBinaryInDir(rootDir, binaryName, maxDepth = 5) {
  async function walk(dir, depth) {
    if (depth < 0) return null;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
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
        const found = await walk(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(rootDir, maxDepth);
}

function isPathInsideDir(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  return normalizedCandidate.startsWith(rootWithSep);
}

async function extractArchive(archivePath, extractDir, archiveType) {
  const resolvedDir = path.resolve(extractDir);

  if (archiveType === 'zip') {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(archivePath);
    // Zip-slip defense: walk every entry and abort before extraction if any
    // entry is absolute or resolves outside the destination. This mirrors the
    // runtime check in VisionService.extractArchive so behaviour is identical
    // between the installer-bundled and runtime-downloaded paths.
    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      if (path.isAbsolute(name)) {
        throw new Error(`Archive entry is absolute path (zip-slip): ${name}`);
      }
      const resolved = path.resolve(resolvedDir, name);
      if (!isPathInsideDir(resolvedDir, resolved)) {
        throw new Error(`Archive entry escapes destination (zip-slip): ${name}`);
      }
    }
    zip.extractAllTo(resolvedDir, true);
    return;
  }

  if (archiveType === 'tar.gz') {
    const tar = require('tar');
    await tar.x({
      file: archivePath,
      cwd: resolvedDir,
      filter: (entryPath) => {
        if (path.isAbsolute(entryPath)) {
          throw new Error(`Archive entry is absolute path (tar-slip): ${entryPath}`);
        }
        const resolved = path.resolve(resolvedDir, entryPath);
        if (!isPathInsideDir(resolvedDir, resolved)) {
          throw new Error(`Archive entry escapes destination (tar-slip): ${entryPath}`);
        }
        return true;
      }
    });
    return;
  }

  throw new Error(`Unsupported archive type: ${archiveType}`);
}

// --- Manifest ---

async function readManifest() {
  try {
    const data = await fsp.readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeManifest(tag, binaryPath) {
  await fsp.writeFile(
    MANIFEST_PATH,
    JSON.stringify(
      { tag, binaryPath, platform: getTargetPlatform(), arch: getTargetArch() },
      null,
      2
    )
  );
}

// --- Commands ---

async function checkRuntime() {
  const binaryPath = path.join(RUNTIME_DIR, SERVER_BINARY_NAME);
  const manifest = await readManifest();
  const gpuInfo = await new GPUMonitor().detectGPU();

  if (
    fs.existsSync(binaryPath) &&
    manifest?.tag &&
    manifest?.platform === getTargetPlatform() &&
    manifest?.arch === getTargetArch()
  ) {
    console.log(`Vision runtime present: ${SERVER_BINARY_NAME} (tag: ${manifest.tag})`);
    console.log(`  Path: ${binaryPath}`);
    console.log(`  GPU: ${gpuInfo?.name || 'none'} (${gpuInfo?.type || 'cpu'})`);
    const stat = await fsp.stat(binaryPath);
    console.log(`  Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    return true;
  }

  console.log(`Vision runtime NOT found at: ${binaryPath}`);
  const asset = await getAssetConfig(undefined, gpuInfo);
  console.log(`  Expected tag: ${asset.tag}`);
  console.log(`  Would download: ${asset.url}`);
  return false;
}

async function downloadRuntime({ force = false } = {}) {
  const gpuInfo = await new GPUMonitor().detectGPU();
  console.log(`  GPU detected: ${gpuInfo?.name || 'none'} (${gpuInfo?.type || 'cpu'})`);
  const asset = await getAssetConfig(undefined, gpuInfo);
  const binaryDest = path.join(RUNTIME_DIR, SERVER_BINARY_NAME);

  // Idempotency: skip if manifest matches and binary exists. Compare
  // platform AND arch, not just the tag — sequential dual-arch builds on
  // one machine reuse this directory, and a tag-only check would silently
  // ship the wrong-arch binary in the second leg.
  if (!force) {
    const manifest = await readManifest();
    if (
      manifest?.tag === asset.tag &&
      manifest?.platform === getTargetPlatform() &&
      manifest?.arch === getTargetArch() &&
      fs.existsSync(binaryDest)
    ) {
      console.log(
        `Vision runtime already present (tag: ${asset.tag}, ${getTargetPlatform()}-${getTargetArch()}). Use --force to re-download.`
      );
      return;
    }
  }

  console.log(`Downloading vision runtime (${asset.assetName})...`);
  console.log(`  Tag: ${asset.tag}`);
  console.log(`  URL: ${asset.url}`);

  // Ensure directories
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });

  const archivePath = path.join(RUNTIME_DIR, asset.assetName);
  const extractDir = path.join(RUNTIME_DIR, '_extract_tmp');

  try {
    // Download archive
    await downloadFile(asset.url, archivePath);

    // Extract to temp directory
    await fsp.mkdir(extractDir, { recursive: true });
    console.log('  Extracting...');
    await extractArchive(archivePath, extractDir, asset.archiveType);

    // Find the binary in the extracted tree
    const foundBinary = await findBinaryInDir(extractDir, SERVER_BINARY_NAME);
    if (!foundBinary) {
      throw new Error(`${SERVER_BINARY_NAME} not found in extracted archive`);
    }

    const binaryDir = path.dirname(foundBinary);
    const entries = await fsp.readdir(binaryDir, { withFileTypes: true });

    // Copy the binary plus sibling DLLs to runtime root.
    // llama-server.exe depends on colocated DLLs in the release package.
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lowerName = entry.name.toLowerCase();
      const shouldCopy =
        lowerName === SERVER_BINARY_NAME.toLowerCase() ||
        lowerName.endsWith('.dll') ||
        lowerName.endsWith('.pdb');
      if (!shouldCopy) continue;
      await fsp.copyFile(path.join(binaryDir, entry.name), path.join(RUNTIME_DIR, entry.name));
    }

    // Set executable permission on non-Windows
    if (process.platform !== 'win32') {
      try {
        await fsp.chmod(binaryDest, 0o755);
      } catch {
        // Non-fatal
      }
    }

    // Write manifest
    await writeManifest(asset.tag, binaryDest);

    const stat = await fsp.stat(binaryDest);
    console.log(
      `Vision runtime ready: ${SERVER_BINARY_NAME} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`
    );
  } finally {
    // Clean up archive and temp directory
    await fsp.unlink(archivePath).catch(() => {});
    await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Main ---

async function main() {
  // Skip if env var set (for CI or fast dev iteration)
  if (process.env.SKIP_VISION_RUNTIME === 'true' || process.env.SKIP_VISION_RUNTIME === '1') {
    console.log('[setup-vision-runtime] Skipped (SKIP_VISION_RUNTIME is set)');
    return;
  }

  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const present = await checkRuntime();
    process.exit(present ? 0 : 1);
  } else if (args.includes('--force')) {
    await downloadRuntime({ force: true });
  } else {
    await downloadRuntime();
  }
}

main().catch((error) => {
  console.error(`[setup-vision-runtime] Error: ${error.message}`);
  // Non-fatal exit for postinstall integration
  process.exit(1);
});
