#!/usr/bin/env node
/**
 * Real-file test harness for the v3.1.1 audio/video pipeline.
 *
 * Exercises the actual ffmpeg subprocess (MediaTranscoder.transcodeToWhisperPcm
 * for audio PCM, extractKeyframes for video) against user-provided mp3/mp4
 * files. Whisper transcription + vision-LLM captioning are stubbed so this
 * runs without the native binding or the multi-GB vision GGUF.
 *
 * Usage: node scratch/run-real-media.js [--audio <path>] [--video <path>]
 *
 * Output: structured JSON-like dump of every interesting field plus paths
 * to the keyframes written to disk so a human can spot-check them.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
process.chdir(REPO_ROOT);

// `runtimePaths.js` does an unconditional `require('electron')` at module
// load. Outside an Electron host that throws "Electron failed to install
// correctly" before MediaTranscoder's runtime try/catch ever runs.
// Pre-populate the require cache with a minimal `app` shim. The userData
// path must match what `electron-builder` produced for the real install,
// otherwise services like WhisperService look for `ggml-base.en.bin` in
// the wrong directory and fail. This mirrors Electron's own resolution
// (Win: %APPDATA%\<productName>; macOS: ~/Library/Application Support/
// <productName>; Linux: $XDG_CONFIG_HOME or ~/.config/<productName>) so
// `npm run setup:whisper-model` and `node scripts/run-real-media.js`
// agree on where the model lives.
function _resolveElectronUserData() {
  // scripts/setup-whisper-model.js (lines 67-86) computes userData using
  // require('../package.json').name. Match that exactly so the model the
  // setup script installs is the model this harness loads. Note this is
  // intentionally NOT productName-based — the setup script was written
  // pre-productName-rename and currently resolves to `stratosort-core`
  // (lowercase) on Windows: %APPDATA%\stratosort-core\models\whisper.
  let appName = 'stratosort-core';
  try {
    const pkg = require(path.join(REPO_ROOT, 'package.json'));
    appName = pkg.name || appName;
  } catch {
    /* fall back to the literal default */
  }
  const productName = appName;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, productName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', productName);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, productName);
}
const _ELECTRON_USER_DATA = _resolveElectronUserData();

const electronShim = {
  app: {
    getAppPath: () => REPO_ROOT,
    getPath: (name) => {
      if (name === 'userData') return _ELECTRON_USER_DATA;
      if (name === 'home') return os.homedir();
      if (name === 'temp') return os.tmpdir();
      return path.join(_ELECTRON_USER_DATA, name || 'misc');
    },
    isPackaged: false,
    getVersion: () => '3.1.1-harness'
  }
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: electronShim
};

// Import production code paths exactly as the app does. No mocks at the
// transcoder layer — that's the whole point of running real files.
const {
  transcodeToWhisperPcm,
  extractKeyframes,
  resolveFfmpegPath
} = require('../src/main/services/MediaTranscoder');
const { analyzeMediaFile, classifyMediaFile } = require('../src/main/analysis/mediaAnalysis');

function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k === '--audio') {
      out.audio = v;
      i++;
    } else if (k === '--video') {
      out.video = v;
      i++;
    }
  }
  return out;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function header(s) {
  console.log('\n' + '='.repeat(72));
  console.log(s);
  console.log('='.repeat(72));
}

// Real Whisper switch. Set STRATOSORT_USE_REAL_WHISPER=1 (and have
// `npm run setup:whisper-model` already produced the ggml file) to swap
// the stub out for the production WhisperService and get actual
// transcripts. Off by default so the harness still runs in environments
// without the native binding (sandbox CI, build-only checks, etc.).
async function makeWhisper() {
  if (process.env.STRATOSORT_USE_REAL_WHISPER === '1') {
    // Lazy-require so a missing native binding only errors when the
    // user explicitly opted in.
    const { WhisperService } = require('../src/main/services/WhisperService');
    const svc = new WhisperService();
    console.log('[harness] Using REAL WhisperService (will load ggml model on first call)');
    return svc;
  }
  console.log(
    '[harness] Using STUB Whisper (set STRATOSORT_USE_REAL_WHISPER=1 for real transcripts)'
  );
  return makeFakeWhisper();
}

// Stub Whisper that produces a deterministic transcript matching the
// duration of the real PCM. This lets us exercise the orchestrator's
// transcript-formatting + multimodal-merge + extractedText paths against
// real PCM lengths without the native binding.
function makeFakeWhisper() {
  return {
    transcribeMedia: async (filePath, opts) => {
      // Use real PCM to derive duration: caller has already transcoded,
      // but we transcode again here to keep WhisperService isolated. The
      // scratch is small for a typical clip.
      const { pcm, durationSeconds } = await transcodeToWhisperPcm(filePath, {
        signal: opts?.signal
      });
      // Synthesize 3 evenly-spaced segments so the merge has something
      // to interleave with keyframe captions.
      const segments = [];
      const tick = durationSeconds / 3;
      const phrases = [
        '[stub] segment one — this is a synthetic transcript',
        '[stub] segment two — real PCM was decoded',
        '[stub] segment three — multimodal merge exercised'
      ];
      for (let i = 0; i < 3; i++) {
        const start = i * tick;
        const end = i === 2 ? durationSeconds : (i + 1) * tick;
        segments.push({ start, end, text: phrases[i] });
      }
      return {
        text: phrases.join(' '),
        segments,
        language: opts?.language || 'en',
        durationSeconds,
        cached: false,
        _stub_pcmBytes: pcm.length
      };
    }
  };
}

// Stub vision caption fn that returns a deterministic caption per frame
// path so we can verify the merge attaches captions to the right
// timestamps. Real vision-LLM captioning needs llama-server + multimodal
// GGUF and is out of scope for this harness.
async function fakeCaption(framePath) {
  const base = path.basename(framePath);
  return `[stub] visual content of ${base}`;
}

// Stub the LLM analyzer so we get a deterministic "category" without
// loading a model.
async function fakeAnalyzeText(text, _fileName, _smartFolders, _date, _naming, _opts) {
  return {
    category: 'real-file-test',
    keywords: ['stub', 'real-pcm'],
    confidence: 75,
    purpose: 'real-file-harness',
    _seenTextLength: text.length
  };
}

async function testTranscode(label, filePath) {
  header(`[${label}] transcodeToWhisperPcm — ${filePath}`);
  const stat = await fs.stat(filePath);
  console.log(`  file:        ${filePath}`);
  console.log(`  size:        ${fmtBytes(stat.size)}`);
  console.log(`  classify:    ${classifyMediaFile(filePath)}`);
  console.log(`  ffmpeg path: ${resolveFfmpegPath()}`);

  const t0 = Date.now();
  const { pcm, sampleRate, channels, durationSeconds } = await transcodeToWhisperPcm(filePath);
  const ms = Date.now() - t0;
  console.log(`  → pcm bytes:        ${fmtBytes(pcm.length)}`);
  console.log(`  → sampleRate:       ${sampleRate} Hz`);
  console.log(`  → channels:         ${channels}`);
  console.log(`  → durationSeconds:  ${durationSeconds.toFixed(3)} s`);
  console.log(`  → wall-clock:       ${ms} ms`);
  // Sanity: PCM length should match duration * sampleRate * 2 bytes (s16le).
  const expectedBytes = Math.round(durationSeconds * sampleRate * 2);
  const drift = Math.abs(pcm.length - expectedBytes);
  console.log(`  → expected bytes:   ${fmtBytes(expectedBytes)} (drift ${drift} bytes)`);
  if (drift > sampleRate * 4) {
    console.log(`  ⚠ unexpected PCM/duration drift > 2 seconds of audio`);
  }
  return { pcm, durationSeconds };
}

async function testKeyframes(label, videoPath) {
  header(`[${label}] extractKeyframes — ${videoPath}`);
  const outputDir = path.join(REPO_ROOT, 'scratch', 'keyframes-' + Date.now());
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`  outputDir: ${outputDir}`);

  const t0 = Date.now();
  const frames = await extractKeyframes(videoPath, outputDir, {
    maxFrames: 8,
    sceneThreshold: 0.4
  });
  const ms = Date.now() - t0;
  console.log(`  → extracted: ${frames.length} keyframes`);
  console.log(`  → wall-clock: ${ms} ms`);
  for (const f of frames) {
    let size = 'missing';
    try {
      const s = await fs.stat(f.framePath);
      size = fmtBytes(s.size);
    } catch {
      /* per-frame stat is best-effort; show 'missing' if the file is gone */
    }
    console.log(
      `     t=${String(f.timestamp).padStart(7)}s  ${size}  ${path.basename(f.framePath)}`
    );
  }
  return { frames, outputDir };
}

async function testOrchestrator(label, filePath, kind) {
  header(`[${label}] analyzeMediaFile (orchestrator)`);
  const whisperService = await makeWhisper();
  const t0 = Date.now();
  const result = await analyzeMediaFile(
    filePath,
    {
      whisperService,
      analyzeTextWithLlama: fakeAnalyzeText,
      // For audio/video parity reuse the production extractKeyframes for
      // video — that's the actual code path users hit. For audio the
      // keyframe step is skipped by mediaAnalysis itself.
      extractKeyframes,
      captionImage: fakeCaption
    },
    {
      smartFolders: [{ name: 'Real File Harness' }],
      maxKeyframes: 8,
      maxCaptionedKeyframes: kind === 'video' ? 4 : 0,
      captionKeyframes: kind === 'video',
      language: 'en'
    }
  );
  const ms = Date.now() - t0;

  console.log(`  wall-clock: ${ms} ms`);
  console.log('');
  console.log('  --- Result fields the renderer reads ---');
  console.log(`  mediaKind:          ${result.mediaKind}`);
  console.log(`  category:           ${result.category}`);
  console.log(`  confidence:         ${result.confidence}`);
  console.log(`  keywords:           ${JSON.stringify(result.keywords)}`);
  console.log(`  durationSeconds:    ${result.durationSeconds}`);
  console.log(`  detectedLanguage:   ${result.detectedLanguage}`);
  console.log(`  extractionMethod:   ${result.extractionMethod}`);
  console.log(`  contentLength:      ${result.contentLength}`);
  console.log(`  transcript (chars): ${result.transcript ? result.transcript.length : 0}`);
  console.log(
    `  transcriptSegments: ${result.transcriptSegments ? result.transcriptSegments.length : 0}`
  );
  console.log(`  keyframes:          ${result.keyframes ? result.keyframes.length : 0}`);
  console.log(
    `  multimodalText:     ${result.multimodalText ? `${result.multimodalText.length} chars` : 'null'}`
  );
  console.log(
    `  extractedText:      ${result.extractedText ? `${result.extractedText.length} chars` : 'null'}`
  );
  console.log('');
  if (result.transcript && result.transcript.length > 0) {
    // Cap the preview so a 30-min voice memo doesn't flood the terminal.
    const preview =
      result.transcript.length > 800
        ? result.transcript.slice(0, 800) + ` … [+${result.transcript.length - 800} more chars]`
        : result.transcript;
    console.log('  --- transcript preview ---');
    console.log(
      preview
        .split('\n')
        .map((l) => '     ' + l)
        .join('\n')
    );
    console.log('');
  }
  if (result.keyframes && result.keyframes.length) {
    console.log('  --- Keyframes (returned to renderer) ---');
    for (const kf of result.keyframes) {
      console.log(`     t=${kf.timestamp}s  caption=${JSON.stringify(kf.caption)}`);
    }
    console.log('');
  }
  if (result.multimodalText) {
    console.log('  --- multimodalText (LLM saw this) ---');
    console.log(
      result.multimodalText
        .split('\n')
        .map((l) => '     ' + l)
        .join('\n')
    );
    console.log('');
  }
  // Critical search-pipeline parity check: extractedText is what
  // semantic.js + SearchService key on. Without it set, media files
  // are silently absent from the search index.
  if (!result.extractedText || result.extractedText.length === 0) {
    console.log('  ✗ extractedText is empty — media files will NOT appear in chunk search.');
  } else {
    console.log(
      `  ✓ extractedText populated (${result.extractedText.length} chars) — search index will see this file.`
    );
  }
  return result;
}

async function main() {
  const args = parseArgs();
  if (!args.audio && !args.video) {
    console.error('Usage: node scratch/run-real-media.js [--audio <path>] [--video <path>]');
    process.exit(2);
  }

  console.log(`ffmpeg path resolved by MediaTranscoder: ${resolveFfmpegPath()}`);
  console.log(`Node: ${process.version}`);
  console.log(`OS:   ${os.platform()} ${os.release()}`);

  if (args.audio) {
    const p = path.resolve(args.audio);
    if (!fsSync.existsSync(p)) {
      console.error(`Audio file not found: ${p}`);
      process.exit(1);
    }
    await testTranscode('AUDIO', p);
    await testOrchestrator('AUDIO', p, 'audio');
  }

  if (args.video) {
    const p = path.resolve(args.video);
    if (!fsSync.existsSync(p)) {
      console.error(`Video file not found: ${p}`);
      process.exit(1);
    }
    await testTranscode('VIDEO', p);
    const { outputDir } = await testKeyframes('VIDEO', p);
    console.log(`  (keyframe JPEGs left at ${outputDir} for spot-check)`);
    await testOrchestrator('VIDEO', p, 'video');
  }

  console.log('\n' + '='.repeat(72));
  console.log('Done.');
}

main().catch((err) => {
  console.error('\n✗ Harness failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
