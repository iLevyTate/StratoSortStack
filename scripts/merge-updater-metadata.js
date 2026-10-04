// @ts-check
/**
 * Merge per-architecture electron-builder channel files into the single file
 * electron-updater actually requests.
 *
 * electron-updater asks for exactly `latest-mac.yml` on darwin and `latest.yml`
 * on win32 (see electron-updater Provider.getChannelFilePrefix — only linux gets
 * an arch suffix). Our release matrix builds each arch on its own runner, so the
 * publish job has one channel file per arch; this script unions their `files:`
 * lists so the canonical file advertises every installer and the client picks
 * its own arch (MacUpdater.filterFilesForArch / Provider.findFile).
 *
 * Input order matters: `path`/`sha512`/`version`/`releaseDate` are taken from
 * the FIRST file, and Provider.findFile falls back to the FIRST `.exe` when no
 * url contains process.arch — the x64 Windows installer carries no arch token,
 * so the x64 channel file must be passed first.
 *
 * Usage:
 *   node scripts/merge-updater-metadata.js --output=<canonical.yml> <x64.yml> [<arm64.yml> ...]
 *
 * The parser deliberately handles only the flat schema electron-builder emits
 * (top-level scalars plus a `files:` list of flat maps) and fails loudly on
 * anything else, so a format change cannot silently produce a broken feed.
 */

const fs = require('fs');
const path = require('path');

const KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * @typedef {{ key: string, value: string }} Field
 * @typedef {{ url: string, fields: Field[] }} FileEntry
 * @typedef {{ scalars: Field[], files: FileEntry[] }} ChannelDocument
 */

/**
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * @param {string} text
 * @param {string} label
 * @returns {ChannelDocument}
 */
function parseChannelFile(text, label) {
  /** @type {Field[]} */
  const scalars = [];
  /** @type {FileEntry[]} */
  const files = [];
  let inFiles = false;
  /** @type {FileEntry | null} */
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      current = null;
      if (/^files:\s*$/.test(line)) {
        inFiles = true;
        continue;
      }
      inFiles = false;
      const match = line.match(KEY_RE);
      if (!match) throw new Error(`${label}: unparseable top-level line "${line}"`);
      scalars.push({ key: match[1], value: match[2] });
      continue;
    }

    if (!inFiles) {
      throw new Error(`${label}: nested content outside files: is not supported ("${line}")`);
    }

    const entryStart = line.match(/^\s*-\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (entryStart) {
      current = { url: '', fields: [{ key: entryStart[1], value: entryStart[2] }] };
      files.push(current);
    } else {
      const field = line.trim().match(KEY_RE);
      if (!field || !current) throw new Error(`${label}: unparseable files: entry line "${line}"`);
      current.fields.push({ key: field[1], value: field[2] });
    }
    const urlField = current.fields.find((f) => f.key === 'url');
    if (urlField) current.url = unquote(urlField.value);
  }

  for (const entry of files) {
    if (!entry.url) throw new Error(`${label}: files: entry without url`);
  }

  if (files.length === 0) {
    const legacyPath = scalars.find((s) => s.key === 'path');
    const legacySha = scalars.find((s) => s.key === 'sha512');
    if (!legacyPath || !legacySha) {
      throw new Error(`${label}: no files: entries and no legacy path/sha512 pair`);
    }
    files.push({
      url: unquote(legacyPath.value),
      fields: [
        { key: 'url', value: legacyPath.value },
        { key: 'sha512', value: legacySha.value }
      ]
    });
  }

  return { scalars, files };
}

/**
 * @param {ChannelDocument} doc
 * @param {string} key
 * @returns {string | undefined}
 */
function scalarValue(doc, key) {
  const field = doc.scalars.find((s) => s.key === key);
  return field ? unquote(field.value) : undefined;
}

/**
 * @param {FileEntry} entry
 * @returns {string | undefined}
 */
function entrySha512(entry) {
  const field = entry.fields.find((f) => f.key === 'sha512');
  return field ? unquote(field.value) : undefined;
}

/**
 * @param {Array<{ label: string, text: string }>} inputs
 * @returns {string} Canonical channel file contents
 */
function mergeChannelFiles(inputs) {
  if (inputs.length === 0) throw new Error('At least one channel file is required');

  const docs = inputs.map((input) => parseChannelFile(input.text, input.label));
  const versionField = docs[0].scalars.find((s) => s.key === 'version');
  const version = versionField ? unquote(versionField.value) : undefined;
  if (!versionField || !version) throw new Error(`${inputs[0].label}: missing version`);

  docs.forEach((doc, index) => {
    const other = scalarValue(doc, 'version');
    if (other !== version) {
      throw new Error(
        `Version mismatch: ${inputs[0].label} has ${version} but ${inputs[index].label} has ${other ?? '<none>'}`
      );
    }
  });

  /** @type {Map<string, FileEntry>} */
  const byUrl = new Map();
  docs.forEach((doc, index) => {
    for (const entry of doc.files) {
      const existing = byUrl.get(entry.url);
      if (!existing) {
        byUrl.set(entry.url, entry);
      } else if (entrySha512(existing) !== entrySha512(entry)) {
        throw new Error(
          `Conflicting sha512 for ${entry.url} between ${inputs[0].label} and ${inputs[index].label}`
        );
      }
    }
  });

  const lines = [`version: ${versionField.value}`, 'files:'];
  for (const entry of byUrl.values()) {
    entry.fields.forEach((field, index) => {
      lines.push(`${index === 0 ? '  - ' : '    '}${field.key}: ${field.value}`);
    });
  }
  for (const scalar of docs[0].scalars) {
    if (scalar.key !== 'version') lines.push(`${scalar.key}: ${scalar.value}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} inputPaths
 * @param {string} outputPath
 */
function mergeChannelFilePaths(inputPaths, outputPath) {
  const inputs = inputPaths.map((inputPath) => {
    if (!fs.existsSync(inputPath)) throw new Error(`Channel file missing: ${inputPath}`);
    return { label: path.basename(inputPath), text: fs.readFileSync(inputPath, 'utf8') };
  });
  const merged = mergeChannelFiles(inputs);
  fs.writeFileSync(outputPath, merged);
  return merged;
}

function run() {
  /** @type {string[]} */
  const inputs = [];
  let output = '';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }
  if (!output || inputs.length === 0) {
    throw new Error(
      'Usage: node scripts/merge-updater-metadata.js --output=<canonical.yml> <x64.yml> [<arm64.yml> ...]'
    );
  }
  mergeChannelFilePaths(inputs, output);
  console.log(`Merged ${inputs.length} channel file(s) into ${output}`);
}

module.exports = { parseChannelFile, mergeChannelFiles, mergeChannelFilePaths };

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(
      `Updater metadata merge failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}
