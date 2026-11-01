// @ts-check
/**
 * Rewrite the changelog part of a published release's notes from CHANGELOG.md.
 *
 * release.yml writes a release's notes once, when it publishes: a fixed
 * "## Release Notes" preamble (download, signing and install notes) followed
 * by the tag's CHANGELOG.md section. A CHANGELOG.md correction made after the
 * release ships never reaches the release page (5.1.0's page kept promising
 * smaller downloads, which only 5.1.1 delivered). update-release-notes.yml
 * runs this script on the release's current notes, so the page says what
 * CHANGELOG.md says now.
 *
 * Only the version's section is replaced: from its "## [X.Y.Z]" heading (or
 * the "## vX.Y.Z" heading release.yml writes when CHANGELOG.md has no section)
 * up to the next "## " heading. The preamble and anything after the section
 * are kept.
 *
 * Usage:
 *   node scripts/update-release-notes.js --tag=vX.Y.Z --body=<current.md> --output=<new.md> [--changelog=CHANGELOG.md]
 *
 * Fails without writing anything when CHANGELOG.md has no section for the
 * version or the current notes have no heading for it.
 */

const fs = require('fs');
const path = require('path');

const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

/** @param {string} text */
function toLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop blank lines from the end of a line list.
 * @param {string[]} lines
 */
function trimTrailingBlankLines(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

/**
 * The version's CHANGELOG.md section, heading included, as release.yml
 * extracts it: from "## [X.Y.Z]" up to the next "## [" heading. Returns null
 * when CHANGELOG.md has no section for the version.
 * @param {string} changelog
 * @param {string} version X.Y.Z
 */
function extractChangelogSection(changelog, version) {
  const lines = toLines(changelog);
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## [')) {
      end = i;
      break;
    }
  }
  return trimTrailingBlankLines(lines.slice(start, end)).join('\n');
}

/**
 * Replace the version's section in a release body with `section`, keeping
 * the lines before its heading and from the next "## " heading on.
 * @param {string} body current release notes
 * @param {string} version X.Y.Z
 * @param {string} section new section, heading included
 * @returns {{ notes: string, changed: boolean }}
 */
function replaceChangelogSection(body, version, section) {
  const lines = toLines(body);
  const escaped = escapeRegExp(version);
  const heading = new RegExp(`^## (\\[${escaped}\\]|v?${escaped}\\s*$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(
      `the release notes have no "## [${version}]" or "## v${version}" heading to replace`
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start);
  const after = trimTrailingBlankLines(lines.slice(end));
  const replaced = [...before, ...toLines(section)];
  if (after.length > 0) replaced.push('', ...after);
  const notes = `${trimTrailingBlankLines(replaced).join('\n')}\n`;
  const current = `${trimTrailingBlankLines(lines).join('\n')}\n`;
  return { notes, changed: notes !== current };
}

/**
 * New release notes for `tag` from the current notes and CHANGELOG.md.
 * @param {{ tag: string, body: string, changelog: string }} input
 */
function buildReleaseNotes({ tag, body, changelog }) {
  const match = TAG_RE.exec(tag);
  if (!match) throw new Error(`--tag must match v<major>.<minor>.<patch>; received '${tag}'`);
  const version = match[1];
  const section = extractChangelogSection(changelog, version);
  if (section === null) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  return replaceChangelogSection(body, version, section);
}

function run() {
  /** @type {Record<string, string>} */
  const args = { changelog: 'CHANGELOG.md' };
  for (const arg of process.argv.slice(2)) {
    const match = /^--(tag|body|output|changelog)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown argument '${arg}'`);
    args[match[1]] = match[2];
  }
  for (const name of ['tag', 'body', 'output']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const { notes, changed } = buildReleaseNotes({
    tag: args.tag,
    body: fs.readFileSync(args.body, 'utf8'),
    changelog: fs.readFileSync(args.changelog, 'utf8')
  });
  fs.writeFileSync(args.output, notes);
  console.log(
    `${args.tag}: ${changed ? 'notes updated from' : 'notes already match'} ` +
      `${path.basename(args.changelog)}; wrote ${args.output}`
  );
}

module.exports = { buildReleaseNotes, extractChangelogSection, replaceChangelogSection };

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Release notes update failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
