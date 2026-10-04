const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha512Base64(contents) {
  return crypto.createHash('sha512').update(contents).digest('base64');
}

/**
 * Build an electron-builder channel file in the exact shape it emits: a
 * `files:` list plus the legacy `path`/`sha512` pair mirroring the first entry.
 * @param {string} version
 * @param {Array<{ name: string, bytes: Buffer }>} artifacts
 */
function channelFile(version, artifacts) {
  const lines = [`version: ${version}`, 'files:'];
  for (const artifact of artifacts) {
    lines.push(`  - url: ${artifact.name}`);
    lines.push(`    sha512: ${sha512Base64(artifact.bytes)}`);
    lines.push(`    size: ${artifact.bytes.length}`);
  }
  lines.push(`path: ${artifacts[0].name}`);
  lines.push(`sha512: ${sha512Base64(artifacts[0].bytes)}`);
  lines.push("releaseDate: '2026-06-08T00:00:00.000Z'");
  return `${lines.join('\n')}\n`;
}

/**
 * Write artifacts to `dir` and return them for channelFile().
 * @param {string} dir
 * @param {Record<string, number>} sizesByName
 */
function writeArtifacts(dir, sizesByName) {
  return Object.entries(sizesByName).map(([name, size]) => {
    const bytes = Buffer.alloc(size, name.length);
    fs.writeFileSync(path.join(dir, name), bytes);
    return { name, bytes };
  });
}

module.exports = { channelFile, sha512Base64, writeArtifacts };
