#!/usr/bin/env node
/**
 * Restore node-llama-cpp GPU binaries if they were renamed (headless / no-GPU-driver
 * workaround documented in docs/DEBUGGING_GUIDE.md).
 * Run this to re-enable GPU acceleration after using the CPU-only workaround.
 *
 * Usage: node scripts/restore-gpu-binaries.js
 */

const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
// The headless workaround only backs up the Linux and Windows GPU addons
// because those are the platforms that crash in headless / no-driver VMs.
// macOS @node-llama-cpp packages (mac-arm64-metal, mac-x64) do NOT need
// to be renamed: Metal falls back gracefully when no GPU is present, and
// renaming the universal binary would break normal dev on Apple Silicon.
// Restoration lists the same paths so it's a true inverse of the workaround.
const ADDON_PATTERNS = [
  // Windows
  '@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/llama-addon.node',
  '@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/llama-addon.node',
  // Linux
  '@node-llama-cpp/linux-x64-cuda/bins/linux-x64-cuda/llama-addon.node',
  '@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/llama-addon.node'
];

function restoreIfBackedUp(addonPath) {
  const fullPath = path.join(NODE_MODULES, addonPath);
  const bakPath = fullPath + '.bak';
  if (fs.existsSync(bakPath) && !fs.existsSync(fullPath)) {
    fs.renameSync(bakPath, fullPath);
    return true;
  }
  return false;
}

function main() {
  let restored = 0;
  for (const pattern of ADDON_PATTERNS) {
    if (restoreIfBackedUp(pattern)) {
      console.log(`Restored: ${pattern}`);
      restored++;
    }
  }
  if (restored > 0) {
    console.log(`\nRestored ${restored} GPU binary(ies). Restart the app to use GPU acceleration.`);
  } else {
    console.log('No backed-up GPU binaries found. GPU addons are already in place.');
  }
}

main();
