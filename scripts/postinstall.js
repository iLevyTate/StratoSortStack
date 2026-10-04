const { spawnSync } = require('child_process');

function parseBool(value) {
  return String(value).toLowerCase() === 'true';
}

function main(
  { env = process.env, platform = process.platform, spawnSyncImpl = spawnSync, log = console } = {
    env: process.env,
    platform: process.platform,
    spawnSyncImpl: spawnSync,
    log: console
  }
) {
  const isCI = parseBool(env.CI);
  const skipAppDeps = parseBool(env.SKIP_APP_DEPS);

  // Rebuild native modules (including node-llama-cpp and sharp)
  if (!isCI && !skipAppDeps) {
    log.log('[postinstall] Rebuilding native modules for Electron...');
    const result = spawnSyncImpl('npx', ['--no', 'electron-builder', 'install-app-deps'], {
      stdio: 'inherit',
      shell: platform === 'win32'
    });

    if (result.status !== 0) {
      // Locally (not CI) a failed rebuild means `require('node-llama-cpp')`
      // will load a mismatched ABI and the app will crash at first model
      // load with a confusing native error. Fail fast so the developer
      // fixes toolchain issues now rather than after `npm run dev`.
      // CI stays on the soft path because its runners may intentionally
      // skip native rebuilds or be in environments where the rebuild is
      // handled in a later job.
      log.error('[postinstall] Native module rebuild failed');
      const err = new Error(
        'electron-builder install-app-deps failed (exit code ' + result.status + ')'
      );
      err.code = 'POSTINSTALL_REBUILD_FAILED';
      err.exitCode = result.status;
      throw err;
    }
    log.log('[postinstall] Native modules ready');
  }

  // Download recommended GGUF models and vision runtime binary (best-effort).
  // In-process AI stack (node-llama-cpp + Orama) requires local model files.
  // Vision analysis requires the llama-server binary (bundled in production builds).
  // Audio/video analysis (Whisper transcription, vision-LLM keyframe captioning)
  // requires the bundled LGPL ffmpeg binary; non-fatal because the resolver
  // also accepts STRATOSORT_FFMPEG_PATH and PATH-resolved system ffmpeg as
  // fallbacks (and because macOS/Linux LGPL ffmpeg downloads aren't wired yet,
  // a hard failure here would block macOS/Linux dev installs entirely).
  // Skipped on CI: every CI job runs `npm ci`, and pulling multi-GB GGUF
  // models from Hugging Face on each of them is slow, flaky, and pointless —
  // no CI job loads a model (the whisper E2E spec is explicitly designed to
  // pass without one). Release/dist workflows that need runtime binaries
  // invoke the setup scripts directly.
  if (isCI) {
    log.log('[postinstall] CI detected — skipping model/runtime downloads');
  } else {
    const setupScripts = [
      { script: 'scripts/setup-vision-runtime.js', args: [] },
      { script: 'scripts/setup-ffmpeg-runtime.js', args: [] },
      { script: 'scripts/setup-models.js', args: ['--download'] },
      { script: 'scripts/setup-whisper-model.js', args: ['--auto'] }
    ];
    for (const { script, args } of setupScripts) {
      try {
        const result = spawnSyncImpl(process.execPath, [script, ...args], {
          stdio: 'inherit',
          env: { ...env, FORCE_COLOR: '1' }
        });
        if (result.status !== 0) {
          log.warn(
            `[postinstall] ${script} failed (non-fatal) — models can be downloaded from the app`
          );
        }
      } catch (e) {
        log.warn(`[postinstall] Failed to run ${script}: ${e.message}`);
      }
    }
  }

  // On macOS, patch the Electron.app Info.plist so the dock label and Activity
  // Monitor show "StratoSort Core" instead of "Electron" during development.
  if (platform === 'darwin') {
    try {
      const { main: patchMac } = require('./patch-electron-mac');
      patchMac();
    } catch (e) {
      log.warn(`[postinstall] macOS Electron patch skipped: ${e.message}`);
    }
  }

  // Present the runtime-prereq matrix so the developer SEES what's installed,
  // failed to download, or has the wrong CUDA runtime — instead of finding
  // out after `npm run dev` silently falls back to CPU or returns
  // "Whisper model not found" when the GGML file is missing. Skipped on CI (no
  // models, no GPU, no benefit) and via SKIP_RUNTIME_VERIFY for users
  // who want a quieter postinstall.
  const skipRuntimeVerify = parseBool(env.SKIP_RUNTIME_VERIFY);
  if (!isCI && !skipRuntimeVerify) {
    log.log('\n[postinstall] Verifying runtime prerequisites on this machine...');
    try {
      const result = spawnSyncImpl(process.execPath, ['scripts/verify-runtime-prereqs.js'], {
        stdio: 'inherit',
        env: { ...env, FORCE_COLOR: '1' }
      });
      if (result.status !== 0) {
        log.warn(
          '[postinstall] Some runtime prereqs are missing or failed to load.\n' +
            '  Review the matrix above. Run `npm run verify:runtime-prereqs` to recheck after fixes.'
        );
      }
    } catch (e) {
      log.warn(`[postinstall] verify-runtime-prereqs skipped: ${e.message}`);
    }
  }

  log.log('\n[StratoSort] Setup complete!');
  log.log('  Run: npm run dev');
  log.log('  The app will use local AI engine (node-llama-cpp + Orama).\n');

  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[postinstall] ${error.code || 'ERROR'}: ${error.message}`);
    process.exit(typeof error.exitCode === 'number' && error.exitCode !== 0 ? error.exitCode : 1);
  }
}

module.exports = { main };
