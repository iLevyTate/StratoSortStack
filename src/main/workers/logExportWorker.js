// @ts-check
'use strict';
// Packages userData/logs as JSONL plain text (and crash-dumps). Sanitizer preserves line-oriented logs.

const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');
const { isTextLogFile, sanitizeLogContent } = require('../utils/logExportSanitizer');
const { sanitizeExportText } = require('../../shared/exportRedaction');

const logger = createLogger('LogExportWorker');

const SANITIZE_FAILURE_PLACEHOLDER = `[REDACTED] This file could not be sanitized for export; content omitted for safety.
`;

// Retention values mirror ErrorHandler.cleanupCrashDumps defaults. Update
// BOTH places if either changes; the README baked into the export is what
// users see when they hand the zip to support, so it must match reality.
const CRASH_DUMP_RETENTION_DAYS = 30;
const CRASH_DUMP_MAX_FILES = 20;

/**
 * Build the human-readable README that ships inside every exported log zip
 * alongside the crash-dumps placeholder. Pure function so it can be asserted
 * on directly in tests without spinning the worker.
 */
function buildCrashDumpReadme({
  retentionDays = CRASH_DUMP_RETENTION_DAYS,
  maxFiles = CRASH_DUMP_MAX_FILES
} = {}) {
  return [
    'Binary crash dumps (.dmp / .ips, plus CrashReporter metadata files) are',
    'NOT included in this shareable export.',
    '',
    'Why:',
    '  - Dumps contain raw process memory and file path fragments that may',
    '    reveal filenames, directory structure, or contents the user is',
    '    working with. StratoSort treats them as local-only diagnostics.',
    '',
    'Where they live (locally, on this machine only):',
    '  - Inside the app userData folder, under `crash-dumps/`.',
    '  - electron-crashReporter is configured with `uploadToServer: false`,',
    '    so the app never transmits them off-device.',
    '',
    'Retention policy:',
    `  - Files older than ${retentionDays} days are deleted at next startup.`,
    `  - At most ${maxFiles} files are kept (oldest are pruned beyond that cap).`,
    '  - Dump filenames themselves can include timestamps but are not shared',
    '    outside the machine.',
    '',
    'If support needs a specific crash artifact:',
    '  - They will provide separate, out-of-band instructions (e.g. a secure',
    '    upload link). Please do not add .dmp files to this zip manually; the',
    '    redaction pass that protects the logs does not run on binary dumps.',
    ''
  ].join('\n');
}

/** @param {any} zip */
function addCrashDumpExportNotice(zip) {
  zip.addFile('crash-dumps/README.txt', Buffer.from(buildCrashDumpReadme(), 'utf8'));
}

module.exports = {
  // Exported for tests; the worker's main-line code runs on require when
  // spawned via `new Worker(workerPath)`, so this export block is a no-op
  // in production and only matters for Jest-driven assertions.
  buildCrashDumpReadme,
  CRASH_DUMP_RETENTION_DAYS,
  CRASH_DUMP_MAX_FILES
};

/** @param {string} relativePath */
function normalizeZipPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/**
 * @param {any} zip
 * @param {string} sourceDir
 * @param {string} zipPrefix
 */
function addFolderToZipSanitized(zip, sourceDir, zipPrefix) {
  const stack = [sourceDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(sourceDir, absolutePath);
      const zipPath = `${zipPrefix}/${normalizeZipPath(relativePath)}`;

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileBuffer = fs.readFileSync(absolutePath);
      if (!isTextLogFile(absolutePath)) {
        zip.addFile(zipPath, fileBuffer);
        continue;
      }

      try {
        const sanitizedText = sanitizeLogContent(fileBuffer.toString('utf8'));
        zip.addFile(zipPath, Buffer.from(sanitizedText, 'utf8'));
      } catch (error) {
        logger.warn('[LogExportWorker] Failed to sanitize text log file; exporting placeholder', {
          error: error?.message || String(error)
        });
        const safeDetail = sanitizeExportText(error?.message || String(error));
        zip.addFile(zipPath, Buffer.from(`${SANITIZE_FAILURE_PLACEHOLDER}${safeDetail}\n`, 'utf8'));
      }
    }
  }
}

/** @param {any} errorMessage */
function fail(errorMessage) {
  logger.error('[LogExportWorker] Export failed', { error: errorMessage });
  parentPort.postMessage({ success: false, error: errorMessage });
}

// Only execute the worker main loop when we're actually running inside a
// Worker (parentPort is non-null). Tests require this module directly on
// the main thread to assert on pure helpers like buildCrashDumpReadme; in
// that case parentPort is null and we must not try to postMessage.
if (parentPort) {
  try {
    if (!workerData || typeof workerData !== 'object') {
      fail('Missing worker data');
    } else if (!workerData.logsDir || !workerData.outPath) {
      fail('logsDir and outPath are required');
    } else if (!fs.existsSync(workerData.logsDir)) {
      fail(`Logs directory does not exist: ${workerData.logsDir}`);
    } else {
      const outDir = path.dirname(workerData.outPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      const zip = new AdmZip();
      addFolderToZipSanitized(zip, workerData.logsDir, 'logs');
      if (workerData.crashDumpsDir && fs.existsSync(workerData.crashDumpsDir)) {
        addCrashDumpExportNotice(zip);
      }
      zip.writeZip(workerData.outPath);
      logger.info('[LogExportWorker] Export completed', {
        outPath: workerData.outPath
      });
      parentPort.postMessage({ success: true });
    }
  } catch (err) {
    fail(err?.message || String(err));
  }
}
