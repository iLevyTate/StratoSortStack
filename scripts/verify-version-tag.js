#!/usr/bin/env node
/**
 * Verifies that package.json::version is consistent with the latest annotated
 * git tag reachable from HEAD. Designed to surface the "bumped version but
 * never tagged a release" drift pattern without blocking normal development.
 *
 * Policy (asymmetric, same shape as scripts/verify-env-docs.js):
 *   - package.json equal to latest tag           → silent OK
 *   - package.json ahead of latest tag           → WARN with tag reminder
 *   - package.json behind latest tag             → FAIL (lockfile rolled back?)
 *   - no annotated v* tag reachable              → silent OK (first release)
 *   - not in a git checkout / git unavailable    → silent OK (CI tarball etc.)
 *
 * Wired into `npm run ci`. Run standalone: `npm run verify:version-tag`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error('package.json has no readable "version" field');
  }
  return pkg.version;
}

function readLatestTag() {
  // --match 'v*' avoids picking up unrelated tags (nightly-*, lint-pin-*, etc.)
  // --abbrev=0 returns just the tag name, no commit-distance suffix
  // We allow lightweight tags too (no --tags vs --annotate distinction needed
  // for this codebase, where releases are all annotated v* tags).
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    // No matching tag reachable, or git unavailable, or not a checkout. Either
    // way, the policy says silent OK — there's nothing to compare against.
    return null;
  }
}

/**
 * Parse "3.1.0" or "v3.1.0" → [3, 1, 0]. Strips an optional leading 'v'.
 * Pre-release/build metadata (-rc.1, +sha) is ignored for comparison —
 * adequate for this codebase's release scheme. If you later adopt
 * pre-releases, swap to the `semver` package.
 */
function parseSemver(s) {
  const stripped = s.replace(/^v/, '').split(/[-+]/)[0];
  const parts = stripped.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Cannot parse semver from "${s}"`);
  }
  return parts;
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function main() {
  const pkgVersion = readPackageVersion();
  const latestTag = readLatestTag();

  if (!latestTag) {
    console.log(`verify:version-tag: package.json @ ${pkgVersion}, no v* tags reachable — OK.`);
    return;
  }

  const cmp = compareSemver(parseSemver(pkgVersion), parseSemver(latestTag));

  if (cmp === 0) {
    console.log(
      `verify:version-tag: package.json @ ${pkgVersion} matches latest tag ${latestTag} — OK.`
    );
    return;
  }

  if (cmp < 0) {
    console.error(
      `FAIL: package.json @ ${pkgVersion} is BEHIND latest tag ${latestTag}. ` +
        `This is suspicious — was the lockfile or version field rolled back? ` +
        `If intentional, bump package.json to a version > ${latestTag}.`
    );
    process.exit(1);
  }

  // cmp > 0: ahead of latest tag. Normal dev state, but worth a visible nag.
  console.warn(
    `WARN: package.json @ ${pkgVersion} is ahead of latest tag ${latestTag}. ` +
      `When ready to ship, tag with:\n  git tag -a v${pkgVersion} -m "Release ${pkgVersion}"\n  git push origin v${pkgVersion}`
  );
}

main();
