// @ts-check
// src/main/services/GPUMonitor.js

const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../../shared/logger');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { getNvidiaSmiCommand } = require('../../shared/platformUtils');

const execFileAsync = promisify(execFile);

function inferWindowsBackendFromName(/** @type {any} */ _name) {
  // Adapter names from CIM/WMIC only prove the GPU is visible to Windows.
  // They do not prove the CUDA runtime is installed or usable. Restrict CUDA
  // detection to successful nvidia-smi probes and keep Windows fallbacks on
  // the safer Vulkan path.
  return 'vulkan';
}

function getWindowsVendorScore(/** @type {any} */ name) {
  const normalized = String(name || '').toLowerCase();
  if (!normalized) return 0;
  if (normalized.includes('nvidia')) return 3;
  if (normalized.includes('amd') || normalized.includes('radeon')) return 2;
  if (normalized.includes('intel')) return 1;
  return 0;
}

/**
 * Run a shell command asynchronously, returning stdout as string.
 * Swallows errors and returns null on failure.
 */
async function runCommand(/** @type {any} */ cmd, /** @type {any} */ args = [], options = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: TIMEOUTS.HEALTH_CHECK,
      ...options
    });
    return stdout;
  } catch {
    return null;
  }
}

function parseNvidiaSmiGpuInfo(/** @type {any} */ output) {
  if (!output || typeof output !== 'string') return null;
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  const [rawName, rawVram] = firstLine.split(',');
  const name = (rawName || '').trim() || 'NVIDIA GPU';
  const vramMB = Number.parseInt((rawVram || '').trim(), 10);
  if (!Number.isFinite(vramMB) || vramMB < 0) {
    return null;
  }

  return {
    type: 'cuda',
    name,
    vramBytes: vramMB * 1024 * 1024,
    vramMB
  };
}

const logger = createLogger('GPUMonitor');

class GPUMonitor {
  constructor() {
    this._platform = process.platform;
    this._gpuInfo = null;
    this._detectPromise = null;
  }

  /**
   * Detect GPU and get info.
   *
   * Results are cached after the first successful detection because GPU
   * hardware does not change during a session.  Pass `{ force: true }` to
   * re-probe (e.g. after a driver update or hot-plug event).
   *
   * Concurrent callers are deduplicated: only one platform detection runs
   * at a time and subsequent callers share the in-flight result.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] - Bypass the cache and re-detect
   * @returns {Promise<Record<string, any>>} GPU info
   */
  async detectGPU(options = {}) {
    if (this._gpuInfo && !options.force) {
      return this._gpuInfo;
    }
    if (this._detectPromise && !options.force) {
      return this._detectPromise;
    }

    this._detectPromise = this._doDetectGPU();
    try {
      const info = await this._detectPromise;
      this._gpuInfo = info;
      return info;
    } finally {
      this._detectPromise = null;
    }
  }

  /** @private */
  async _doDetectGPU() {
    try {
      if (this._platform === 'darwin') {
        return await this._detectMacGPU();
      } else if (this._platform === 'win32') {
        return await this._detectWindowsGPU();
      } else {
        return await this._detectLinuxGPU();
      }
    } catch (error) {
      logger.warn('[GPU] Detection failed', error);
      return { type: 'cpu', name: 'CPU (No GPU detected)' };
    }
  }

  async _detectMacGPU() {
    try {
      const output = await runCommand('system_profiler', ['SPDisplaysDataType', '-json']);
      if (!output) return { type: 'cpu', name: 'CPU' };
      const data = JSON.parse(output);
      const gpu = data.SPDisplaysDataType?.[0];

      if (gpu?.sppci_model?.toLowerCase().includes('apple')) {
        const memOutput = await runCommand('sysctl', ['hw.memsize']);
        const totalMem = parseInt(memOutput?.split(':')[1]?.trim(), 10) || 0;
        const vramEstimate = Math.round(totalMem * 0.75);

        return {
          type: 'metal',
          name: gpu.sppci_model,
          vramBytes: vramEstimate,
          vramMB: Math.round(vramEstimate / 1024 / 1024),
          isAppleSilicon: true
        };
      }

      const rawVram = String(gpu?.sppci_vram || '');
      const vramNum = parseInt(rawVram, 10) || 0;
      const vramMB = /GB/i.test(rawVram) ? vramNum * 1024 : vramNum;

      return {
        type: 'metal',
        name: gpu?.sppci_model || 'Unknown GPU',
        vramBytes: vramMB * 1024 * 1024,
        vramMB,
        isAppleSilicon: false
      };
    } catch {
      return { type: 'cpu', name: 'CPU' };
    }
  }

  async _detectWindowsGPU() {
    // Try nvidia-smi first (use platform-specific executable for Windows)
    const nvidiaSmiCmd = getNvidiaSmiCommand();
    const nvidiaSmi = await runCommand(nvidiaSmiCmd, [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits'
    ]);
    if (nvidiaSmi) {
      const parsedNvidia = parseNvidiaSmiGpuInfo(nvidiaSmi);
      if (parsedNvidia) {
        return parsedNvidia;
      }
    }

    // wmic is deprecated and often returns empty/malformed data for integrated GPUs
    const ps = await runCommand('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json'
    ]);

    if (ps) {
      try {
        const data = JSON.parse(ps);
        // Handle single object or array of objects
        const gpus = Array.isArray(data) ? data : [data];

        let bestGPU = null;
        let bestVendorScore = -1;
        let bestRamBytes = -1;

        for (const gpu of gpus) {
          const gpuName = gpu?.Name || 'Unknown GPU';
          const vendorScore = getWindowsVendorScore(gpuName);
          // capped at ~4GB. Values of 0 or exactly 4294967295 (0xFFFFFFFF)
          // typically indicate truncation for GPUs with >4GB VRAM. In that
          // case, fall through to nvidia-smi or report 0 rather than a
          // misleading number.
          let ramBytes = parseInt(gpu.AdapterRAM, 10) || 0;
          if (ramBytes === 4294967295 || ramBytes < 0) {
            // Truncated uint32 -- treat as unknown
            ramBytes = 0;
            // Upgrade to warn level: downstream VRAM-budget code (model
            // size planning, fallback decisions) needs to know the reported
            // 0 doesn't mean "no VRAM" but "VRAM size unknown" — those are
            // very different outcomes. The debug-level log was invisible in
            // production. The structured marker `vramReportUnreliable: true`
            // lets a future DegradedStateTracker hook flag the GPU as
            // partially-detected without changing GPU selection logic.
            logger.warn('[GPUMonitor] AdapterRAM truncated (uint32 overflow); VRAM size unknown', {
              name: gpuName,
              rawValue: gpu.AdapterRAM,
              vramReportUnreliable: true
            });
          }
          if (
            vendorScore > bestVendorScore ||
            (vendorScore === bestVendorScore && ramBytes > bestRamBytes)
          ) {
            bestVendorScore = vendorScore;
            bestRamBytes = ramBytes;
            bestGPU = {
              type: inferWindowsBackendFromName(gpuName),
              name: gpuName,
              vramBytes: ramBytes,
              vramMB: Math.round(ramBytes / 1024 / 1024)
            };
          }
        }
        if (bestGPU) return bestGPU;
      } catch (e) {
        logger.debug('[GPUMonitor] PowerShell JSON parse failed', { error: e.message });
      }
    }

    // Fall back to WMIC with CSV format for robust parsing (legacy support)
    const wmic = await runCommand('wmic', [
      'path',
      'win32_VideoController',
      'get',
      'name,adapterram',
      '/format:csv'
    ]);

    if (wmic) {
      // WMIC CSV output: Node,AdapterRAM,Name (alphabetical column order)
      const lines = wmic
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim());

      let bestGPU = null;
      let bestVendorScore = -1;
      let bestRamBytes = -1;

      for (const line of lines) {
        // Skip header or invalid lines
        if (!line.includes(',') || line.toLowerCase().includes('adapterram')) continue;

        const parts = line.split(',');
        // Node, AdapterRAM, Name
        if (parts.length < 3) continue;

        const ramStr = parts[1];
        const name = parts.slice(2).join(','); // Name might contain commas
        let ramBytes = parseInt(ramStr, 10);

        if (ramBytes === 4294967295 || ramBytes < 0) {
          ramBytes = 0;
        }

        const vendorScore = getWindowsVendorScore(name);
        if (
          !isNaN(ramBytes) &&
          (vendorScore > bestVendorScore ||
            (vendorScore === bestVendorScore && ramBytes > bestRamBytes))
        ) {
          bestVendorScore = vendorScore;
          bestRamBytes = ramBytes;
          bestGPU = {
            type: inferWindowsBackendFromName(name),
            name: name || 'Unknown GPU',
            vramBytes: ramBytes,
            vramMB: Math.round(ramBytes / 1024 / 1024)
          };
        }
      }

      if (bestGPU) return bestGPU;
    }

    return { type: 'cpu', name: 'CPU' };
  }

  async _detectLinuxGPU() {
    // Try nvidia-smi (use platform-specific executable)
    const nvidiaSmiCmd = getNvidiaSmiCommand();
    const nvidiaSmi = await runCommand(nvidiaSmiCmd, [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits'
    ]);
    if (nvidiaSmi) {
      const parsedNvidia = parseNvidiaSmiGpuInfo(nvidiaSmi);
      if (parsedNvidia) {
        return parsedNvidia;
      }
    }

    // Try lspci for AMD/Intel
    const lspci = await runCommand('lspci', [], { shell: true });
    if (lspci) {
      const vgaLine = lspci.split('\n').find((l) => /vga/i.test(l));
      if (vgaLine) {
        return {
          type: 'vulkan',
          name: vgaLine.split(':').pop()?.trim() || 'Unknown GPU',
          vramBytes: 0,
          vramMB: 0
        };
      }
    }

    return { type: 'cpu', name: 'CPU' };
  }

  /**
   * Get current GPU memory usage (NVIDIA only)
   */
  async getGPUMemoryUsage() {
    if (this._platform !== 'win32' && this._platform !== 'linux') {
      // macOS doesn't have easy VRAM monitoring
      return null;
    }

    const nvidiaSmiCmd = getNvidiaSmiCommand();
    const output = await runCommand(nvidiaSmiCmd, [
      '--query-gpu=memory.used,memory.total',
      '--format=csv,noheader,nounits'
    ]);
    if (!output) return null;

    const [used, total] = output
      .trim()
      .split(',')
      .map((s) => parseInt(s.trim(), 10));

    // reporting 0 MB used would incorrectly return null with `!used`.
    if (isNaN(used) || isNaN(total) || total <= 0) return null;

    return {
      usedMB: used,
      totalMB: total,
      percentUsed: Math.round((used / total) * 100)
    };
  }
}

// Singleton
/** @type {GPUMonitor|null} */
let instance = null;
function getInstance() {
  if (!instance) {
    instance = new GPUMonitor();
  }
  return instance;
}

module.exports = { GPUMonitor, getInstance };
