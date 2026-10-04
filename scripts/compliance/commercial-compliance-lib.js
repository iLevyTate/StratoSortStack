const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeLicense(value) {
  if (!value || typeof value !== 'string') return 'UNKNOWN';
  return value.trim();
}

function classifyLicense(licenseValue) {
  const license = normalizeLicense(licenseValue);
  const upper = license.toUpperCase();
  const hasOr = upper.includes(' OR ');
  const hasStrongCopyleft =
    upper.includes('AGPL') ||
    upper.includes('SSPL') ||
    upper.includes('BUSL') ||
    upper.includes('COMMONS CLAUSE') ||
    upper.includes('NONCOMMERCIAL') ||
    upper.includes('POLYFORM') ||
    upper.includes('CC-BY-NC');
  const hasLesserGpl = upper.includes('LGPL');
  const hasGpl = upper.includes('GPL') && !hasLesserGpl;
  const hasWeakCopyleft =
    hasLesserGpl || upper.includes('MPL') || upper.includes('EPL') || upper.includes('CDDL');
  const hasUnknown = upper === 'UNKNOWN' || upper === 'UNLICENSED' || upper.includes('SEE LICENSE');

  if (hasStrongCopyleft) return 'high_risk';
  if (hasGpl && !hasOr) return 'high_risk';
  if (hasGpl && hasOr) return 'review_required';
  if (hasWeakCopyleft) return 'review_required';
  if (hasUnknown) return 'unknown';
  return 'allowed';
}

// Packages whose real license npm does not record in package-lock.json — either
// they predate SPDX strings and use the deprecated `licenses: [{ type }]` array
// (npm's lockfile generator only captures the modern `license` string), or they
// are optional platform-binary shards npm never installs on this host so it
// cannot read their package.json. Each license below is verified by hand from
// the package's own metadata (evidence in `source`) so the commercial inventory
// classifies them instead of leaving an `unknown` audit blind spot. Keyed by
// `packageName@version` so a version bump re-surfaces as `unknown` and forces
// re-verification rather than silently inheriting a stale grant.
const MANUAL_LICENSE_OVERRIDES = {
  '@antoniomuso/lz4-napi-linux-x64-musl@2.9.0': {
    license: 'MIT',
    source:
      'Optional linux-musl binary shard of lz4-napi; sibling shard @antoniomuso/lz4-napi-win32-x64-msvc@2.9.0 and parent lz4-napi@2.9.0 both declare "license": "MIT".'
  },
  'eslint-import-resolver-webpack/node_modules/enhanced-resolve@0.9.1': {
    license: 'MIT',
    source:
      'package.json declares the legacy `licenses: [{ type: "MIT" }]` array; the same package reads "MIT" at every other version in the tree.'
  },
  'querystring-es3@0.2.1': {
    license: 'MIT',
    source:
      'package.json declares the legacy `licenses: [{ type: "MIT" }]` array and bundles a MIT License.md.'
  },
  'json-bignum@0.0.3': {
    license: 'MIT',
    source:
      'Transitive via embedding-atlas → @uwdata/mosaic-core → @duckdb/duckdb-wasm → apache-arrow. package.json declares the legacy `licenses: [{ type: "MIT" }]` array whose url points at the package\'s MIT LICENSE.'
  }
};

// Renderer libraries live in devDependencies so electron-builder does not copy
// their node_modules into the installer — webpack bundles them into the renderer
// chunk instead (webpack.config.js renderer `externals: {}`). npm therefore marks
// them `dev: true` in package-lock.json even though they ship. Every package
// listed here, plus its transitive lockfile closure, is treated as shipped by the
// compliance gate, the license inventory and `npm run audit:bundled`.
// Keep in sync with the renderer imports; a stale entry fails the build.
const BUNDLED_RENDERER_DEPS = [
  // embedding-atlas imports these peers from the chunk that also holds
  // EmbeddingView, so webpack must resolve them even though only the
  // non-mosaic view is used.
  '@uwdata/mosaic-core',
  '@uwdata/mosaic-sql',
  '@xyflow/react',
  'elkjs',
  'embedding-atlas',
  'framer-motion',
  'lucide-react',
  'prop-types',
  'react',
  'react-dom',
  'react-redux',
  'react-window'
];

// Installed peers are followed too: webpack resolves them exactly like regular
// dependencies, so erring toward a superset keeps the gate conservative.
const LOCK_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

// Node-style resolution inside a v2/v3 lockfile: look for `<from>/node_modules/<name>`,
// then walk up one `node_modules/<pkg>` segment at a time to the hoisted root.
function resolveLockPath(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const parent = base.lastIndexOf('/node_modules/');
    if (parent === -1) break;
    base = base.slice(0, parent);
  }
  const hoisted = `node_modules/${name}`;
  return packages[hoisted] ? hoisted : null;
}

/**
 * Lockfile paths reachable from the given root package names (inclusive).
 * Missing roots are returned separately so callers can fail loudly instead of
 * silently narrowing the closure when the allowlist drifts from package.json.
 */
function resolveLockClosure(packageLock, rootNames) {
  const packages = packageLock.packages || {};
  const closure = new Set();
  const missingRoots = [];
  const queue = [];
  for (const name of rootNames) {
    const resolved = resolveLockPath(packages, '', name);
    if (resolved) queue.push(resolved);
    else missingRoots.push(name);
  }
  while (queue.length > 0) {
    const pkgPath = queue.pop();
    if (closure.has(pkgPath)) continue;
    closure.add(pkgPath);
    const meta = packages[pkgPath];
    for (const field of LOCK_DEP_FIELDS) {
      for (const depName of Object.keys(meta[field] || {})) {
        const resolved = resolveLockPath(packages, pkgPath, depName);
        if (resolved && !closure.has(resolved)) queue.push(resolved);
      }
    }
  }
  return { closure, missingRoots };
}

function resolveBundledRendererClosure(packageLock) {
  const { closure, missingRoots } = resolveLockClosure(packageLock, BUNDLED_RENDERER_DEPS);
  if (missingRoots.length > 0) {
    throw new Error(
      `BUNDLED_RENDERER_DEPS entries missing from package-lock.json: ${missingRoots.join(', ')}. ` +
        'Remove them from scripts/compliance/commercial-compliance-lib.js if the renderer no longer imports them.'
    );
  }
  return closure;
}

function classifyProjectLicense(licenseText) {
  const text = String(licenseText || '').toLowerCase();
  if (text.includes('polyform') && text.includes('noncommercial')) {
    return {
      riskLevel: 'allowed',
      reason:
        'Project license is PolyForm Noncommercial 1.0.0 for personal/noncommercial use. Commercial rights are sold separately; third-party dependency obligations remain governed by their own licenses.',
      detectedLicense: 'PolyForm Noncommercial 1.0.0 (commercial license sold separately)'
    };
  }
  if (text.includes('non-commercial') || text.includes('noncommercial')) {
    return {
      riskLevel: 'high_risk',
      reason: 'Project license is currently non-commercial.',
      detectedLicense: 'Custom non-commercial (PolyForm-based)'
    };
  }
  const isProprietary =
    text.includes('all rights reserved') &&
    (text.includes('proprietary and confidential') ||
      text.includes('no license granted') ||
      text.includes('no license, express or implied, is granted'));
  if (isProprietary) {
    return {
      riskLevel: 'allowed',
      reason:
        'Project license is proprietary all-rights-reserved (internal use). No third-party commercial distribution rights are granted, so the project itself poses no compliance risk; third-party dependency obligations remain governed by their own licenses.',
      detectedLicense: 'Proprietary (All Rights Reserved, internal use)'
    };
  }
  return {
    riskLevel: 'review_required',
    reason: 'Unable to automatically determine project commercial grant.',
    detectedLicense: 'Unknown'
  };
}

function getModelEntries(modelCatalog) {
  return Object.entries(modelCatalog).flatMap(([modelName, modelInfo]) => {
    const entries = [
      {
        modelName,
        artifactName: modelName,
        type: modelInfo.type,
        url: modelInfo.url
      }
    ];
    if (modelInfo.clipModel) {
      entries.push({
        modelName,
        artifactName: modelInfo.clipModel.name,
        type: modelInfo.type,
        url: modelInfo.clipModel.url
      });
    }
    return entries;
  });
}

function getLicenseMetaByUrl(modelLicenseMatrix) {
  const byUrl = new Map();
  for (const item of modelLicenseMatrix.models || []) {
    byUrl.set(item.url, item);
  }
  return byUrl;
}

/**
 * @param {Set<string>} bundledPaths lockfile paths (e.g. `node_modules/react`)
 *   that ship despite being `dev: true`; see resolveBundledRendererClosure.
 */
function getDependencyInventory(packageJson, packageLock, bundledPaths = new Set()) {
  const directRuntime = new Set(Object.keys(packageJson.dependencies || {}));
  const directDev = new Set(Object.keys(packageJson.devDependencies || {}));
  const packages = packageLock.packages || {};
  const dependencyRows = [];

  for (const [pkgPath, pkgMeta] of Object.entries(packages)) {
    if (!pkgPath.startsWith('node_modules/')) continue;

    const packageName = pkgPath.replace(/^node_modules\//, '');
    const version = pkgMeta.version || 'UNKNOWN';
    let license = normalizeLicense(pkgMeta.license);
    let licenseManualSource;
    if (license === 'UNKNOWN') {
      const override = MANUAL_LICENSE_OVERRIDES[`${packageName}@${version}`];
      if (override) {
        license = override.license;
        licenseManualSource = override.source;
      }
    }
    const row = {
      packageName,
      version,
      license,
      riskLevel: classifyLicense(license),
      directRuntime: directRuntime.has(packageName),
      directDev: directDev.has(packageName),
      // Lockfile-level flags. `dev: true` means the package only reaches the
      // dependency tree from a devDependency — it is not copied into the
      // shipped installer, so it cannot create a redistribution obligation
      // unless webpack bundles it (see `bundledRenderer`). `optional: true`
      // typically marks platform-specific optional binaries (e.g. lz4-napi
      // musl variants); whether such a package is shipped depends on the build
      // target platform, so it is reported but not counted as a
      // release-blocking failure here.
      lockfileDev: pkgMeta.dev === true,
      lockfileOptional: pkgMeta.optional === true
    };
    // Only present when the license came from MANUAL_LICENSE_OVERRIDES (the
    // lockfile had no SPDX string), documenting why the row is not `unknown`.
    if (licenseManualSource) row.licenseManualSource = licenseManualSource;
    // Only present for the BUNDLED_RENDERER_DEPS closure: shipped inside the
    // webpack renderer bundle, so gated like a runtime dependency.
    if (bundledPaths.has(pkgPath)) row.bundledRenderer = true;
    dependencyRows.push(row);
  }

  dependencyRows.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return dependencyRows;
}

function summarizeByRisk(rows) {
  return rows.reduce(
    (acc, row) => {
      acc[row.riskLevel] = (acc[row.riskLevel] || 0) + 1;
      return acc;
    },
    { allowed: 0, review_required: 0, high_risk: 0, unknown: 0 }
  );
}

function buildCommercialComplianceReport() {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageLockPath = path.join(repoRoot, 'package-lock.json');
  const electronBuilderPath = path.join(repoRoot, 'electron-builder.json');
  const licensePath = path.join(repoRoot, 'LICENSE');
  const modelRegistryPath = path.join(repoRoot, 'src', 'shared', 'modelRegistry.js');
  const modelLicenseMatrixPath = path.join(repoRoot, 'docs', 'commercial-model-licenses.json');

  const packageJson = readJson(packageJsonPath);
  const packageLock = readJson(packageLockPath);
  const electronBuilder = readJson(electronBuilderPath);
  const licenseText = readText(licensePath);
  const modelRegistry = require(modelRegistryPath);
  const modelLicenseMatrix = readJson(modelLicenseMatrixPath);

  const projectLicense = classifyProjectLicense(licenseText);
  const dependencies = getDependencyInventory(
    packageJson,
    packageLock,
    resolveBundledRendererClosure(packageLock)
  );
  const dependencySummary = summarizeByRisk(dependencies);
  const modelEntries = getModelEntries(modelRegistry.MODEL_CATALOG || {});
  const modelLicenseByUrl = getLicenseMetaByUrl(modelLicenseMatrix);

  const models = modelEntries.map((entry) => {
    const matrixItem = modelLicenseByUrl.get(entry.url) || null;
    return {
      ...entry,
      evidenceFound: Boolean(matrixItem),
      license: matrixItem ? matrixItem.license : 'UNKNOWN',
      commercialUse: matrixItem ? matrixItem.commercialUse : 'unknown',
      riskLevel: matrixItem ? matrixItem.riskLevel : 'unknown',
      obligations: matrixItem ? matrixItem.obligations : ['Manual review required.'],
      source: matrixItem ? matrixItem.source : null
    };
  });

  const modelSummary = summarizeByRisk(models);

  const artifacts = {
    asarUnpack: electronBuilder.asarUnpack || [],
    packagedFiles: electronBuilder.files || [],
    extraResources: electronBuilder.extraResources || []
  };

  const now = new Date().toISOString();
  return {
    generatedAt: now,
    projectLicense,
    dependencySummary,
    modelSummary,
    dependencies,
    models,
    artifacts,
    notes: [
      'Risk classification is a triage aid and not legal advice.',
      'Model and binary license obligations should be validated by legal before commercial release.'
    ]
  };
}

module.exports = {
  BUNDLED_RENDERER_DEPS,
  buildCommercialComplianceReport,
  classifyLicense,
  getDependencyInventory,
  MANUAL_LICENSE_OVERRIDES,
  resolveBundledRendererClosure,
  resolveLockClosure,
  summarizeByRisk,
  repoRoot
};
