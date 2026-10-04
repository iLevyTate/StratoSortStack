const {
  evaluateCommercialCompliance,
  summarizeUnwaivedItems
} = require('../scripts/compliance/verify-commercial-compliance');
const {
  BUNDLED_RENDERER_DEPS,
  getDependencyInventory,
  MANUAL_LICENSE_OVERRIDES,
  resolveBundledRendererClosure,
  resolveLockClosure
} = require('../scripts/compliance/commercial-compliance-lib');
const { buildProductionLicenses } = require('../scripts/compliance/generate-production-licenses');
const packageJson = jest.requireActual('../package.json');
const packageLock = jest.requireActual('../package-lock.json');

describe('commercial compliance verification', () => {
  test('passes when unknown items are fully waived', () => {
    const report = {
      dependencySummary: { allowed: 1, review_required: 0, high_risk: 0, unknown: 1 },
      modelSummary: { allowed: 1, review_required: 0, high_risk: 0, unknown: 1 },
      dependencies: [{ packageName: 'querystring-es3', riskLevel: 'unknown' }],
      models: [{ artifactName: 'unknown-test-model.gguf', riskLevel: 'unknown' }]
    };
    const waivers = {
      dependencies: { high_risk: [], unknown: ['querystring-es3'] },
      models: { high_risk: [], unknown: ['unknown-test-model.gguf'] }
    };

    const result = evaluateCommercialCompliance(report, waivers);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('fails when unknown or high-risk items are not waived', () => {
    const report = {
      dependencySummary: { allowed: 0, review_required: 0, high_risk: 1, unknown: 1 },
      modelSummary: { allowed: 0, review_required: 0, high_risk: 0, unknown: 1 },
      dependencies: [
        { packageName: 'danger-lib', riskLevel: 'high_risk' },
        { packageName: 'mystery-lib', riskLevel: 'unknown' }
      ],
      models: [{ artifactName: 'mystery-model.gguf', riskLevel: 'unknown' }]
    };
    const waivers = {
      dependencies: { high_risk: [], unknown: [] },
      models: { high_risk: [], unknown: [] }
    };

    const result = evaluateCommercialCompliance(report, waivers);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { category: 'dependencies', riskLevel: 'high_risk', name: 'danger-lib' },
      { category: 'dependencies', riskLevel: 'unknown', name: 'mystery-lib' },
      { category: 'models', riskLevel: 'unknown', name: 'mystery-model.gguf' }
    ]);
    expect(summarizeUnwaivedItems(result.failures)).toContain('dependencies.high_risk: danger-lib');
    expect(summarizeUnwaivedItems(result.failures)).toContain('models.unknown: mystery-model.gguf');
  });

  test('skips dev-only and optional-only deps from failure set', () => {
    // Dev-only and platform-specific optional packages are not bundled into the
    // shipped installer, so even if their license is unknown/high_risk they
    // cannot create a redistribution obligation. The verifier must skip them.
    const report = {
      dependencySummary: { allowed: 0, review_required: 0, high_risk: 1, unknown: 1 },
      modelSummary: { allowed: 0, review_required: 0, high_risk: 0, unknown: 0 },
      dependencies: [
        { packageName: 'dev-tool', riskLevel: 'high_risk', lockfileDev: true },
        { packageName: 'platform-binary', riskLevel: 'unknown', lockfileOptional: true }
      ],
      models: []
    };
    const waivers = {
      dependencies: { high_risk: [], unknown: [] },
      models: { high_risk: [], unknown: [] }
    };

    const result = evaluateCommercialCompliance(report, waivers);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('gates dev-only deps that webpack bundles into the renderer', () => {
    const report = {
      dependencies: [
        { packageName: 'ui-lib', riskLevel: 'high_risk', lockfileDev: true, bundledRenderer: true }
      ],
      models: []
    };
    const waivers = {
      dependencies: { high_risk: [], unknown: [] },
      models: { high_risk: [], unknown: [] }
    };

    const result = evaluateCommercialCompliance(report, waivers);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      { category: 'dependencies', riskLevel: 'high_risk', name: 'ui-lib' }
    ]);
  });
});

describe('bundled renderer dependency closure', () => {
  // Synthetic v3 lockfile: `ui` is hoisted, `ui` needs a nested `shared@2`
  // while the root `shared@1` belongs to an unrelated dev tool, and `peer` is
  // an installed peer dependency.
  const lock = {
    packages: {
      '': { devDependencies: { ui: '1.0.0', tool: '1.0.0' } },
      'node_modules/ui': {
        version: '1.0.0',
        dev: true,
        dependencies: { leaf: '1.0.0', shared: '2.0.0' },
        peerDependencies: { peer: '1.0.0', 'missing-peer': '1.0.0' }
      },
      'node_modules/ui/node_modules/shared': { version: '2.0.0', dev: true },
      'node_modules/leaf': { version: '1.0.0', dev: true },
      'node_modules/shared': { version: '1.0.0', dev: true },
      'node_modules/peer': { version: '1.0.0', dev: true },
      'node_modules/tool': { version: '1.0.0', dev: true, dependencies: { shared: '1.0.0' } }
    }
  };

  test('walks dependencies and installed peers with node-style nested resolution', () => {
    const { closure, missingRoots } = resolveLockClosure(lock, ['ui']);

    expect([...closure].sort()).toEqual([
      'node_modules/leaf',
      'node_modules/peer',
      'node_modules/ui',
      'node_modules/ui/node_modules/shared'
    ]);
    expect(missingRoots).toEqual([]);
  });

  test('reports roots that are absent from the lockfile', () => {
    const { closure, missingRoots } = resolveLockClosure(lock, ['ui', 'gone']);

    expect(closure.has('node_modules/ui')).toBe(true);
    expect(missingRoots).toEqual(['gone']);
  });

  test('marks closure rows bundledRenderer and leaves other dev rows untouched', () => {
    const rows = getDependencyInventory({}, lock, resolveLockClosure(lock, ['ui']).closure);
    const byName = Object.fromEntries(rows.map((r) => [r.packageName, r]));

    expect(byName.ui.bundledRenderer).toBe(true);
    expect(byName['ui/node_modules/shared'].bundledRenderer).toBe(true);
    expect(byName.tool).not.toHaveProperty('bundledRenderer');
    expect(byName.shared).not.toHaveProperty('bundledRenderer');
  });

  test('every BUNDLED_RENDERER_DEPS entry is a devDependency present in the real lockfile', () => {
    for (const name of BUNDLED_RENDERER_DEPS) {
      expect(packageJson.devDependencies).toHaveProperty(name);
      expect(packageLock.packages).toHaveProperty(`node_modules/${name}`);
    }
    expect(() => resolveBundledRendererClosure(packageLock)).not.toThrow();
  });

  test('resolveBundledRendererClosure fails loudly on a stale allowlist entry', () => {
    const { packages } = packageLock;
    const withoutReact = Object.fromEntries(
      Object.entries(packages).filter(([p]) => p !== 'node_modules/react')
    );

    expect(() => resolveBundledRendererClosure({ packages: withoutReact })).toThrow(/react/);
  });

  test('production license report ships runtime rows plus the bundled closure only', () => {
    const report = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      dependencies: [
        { packageName: 'runtime', version: '1.0.0', license: 'MIT', riskLevel: 'allowed' },
        {
          packageName: 'ui',
          version: '1.0.0',
          license: 'MIT',
          riskLevel: 'allowed',
          lockfileDev: true,
          bundledRenderer: true
        },
        {
          packageName: 'tool',
          version: '1.0.0',
          license: 'GPL-3.0',
          riskLevel: 'high_risk',
          lockfileDev: true
        }
      ]
    };

    const output = buildProductionLicenses(report);

    expect(Object.keys(output.packages)).toEqual(['runtime@1.0.0', 'ui@1.0.0']);
    expect(output.packages['ui@1.0.0'].bundledRenderer).toBe(true);
    expect(output.packages['runtime@1.0.0']).toEqual({ license: 'MIT', riskLevel: 'allowed' });
  });
});

describe('manual license overrides (getDependencyInventory)', () => {
  // Builds a synthetic lockfile from one known override key plus a control set.
  function inventoryFor(packages) {
    return getDependencyInventory({}, { packages });
  }

  test('resolves lockfile-UNKNOWN packages to their hand-verified license', () => {
    // querystring-es3@0.2.1 is one of the real overrides — its package.json uses
    // the legacy `licenses: [...]` array that npm omits from the lockfile.
    const rows = inventoryFor({
      'node_modules/querystring-es3': { version: '0.2.1' } // no `license` field
    });
    const row = rows.find((r) => r.packageName === 'querystring-es3');

    expect(row.license).toBe('MIT');
    expect(row.riskLevel).toBe('allowed');
    expect(typeof row.licenseManualSource).toBe('string');
    expect(row.licenseManualSource.length).toBeGreaterThan(0);
  });

  test('leaves genuinely-unknown packages classified as unknown with no manual source', () => {
    const rows = inventoryFor({
      'node_modules/mystery-lib': { version: '9.9.9' }
    });
    const row = rows.find((r) => r.packageName === 'mystery-lib');

    expect(row.license).toBe('UNKNOWN');
    expect(row.riskLevel).toBe('unknown');
    expect(row).not.toHaveProperty('licenseManualSource');
  });

  test('does not apply an override when the version differs (forces re-verification on bump)', () => {
    const rows = inventoryFor({
      'node_modules/querystring-es3': { version: '0.3.0' } // bumped past the keyed version
    });
    const row = rows.find((r) => r.packageName === 'querystring-es3');

    expect(row.riskLevel).toBe('unknown');
    expect(row).not.toHaveProperty('licenseManualSource');
  });

  test('does not override a package that already declares a license in the lockfile', () => {
    const rows = inventoryFor({
      'node_modules/querystring-es3': { version: '0.2.1', license: 'MIT' }
    });
    const row = rows.find((r) => r.packageName === 'querystring-es3');

    expect(row.license).toBe('MIT');
    expect(row.riskLevel).toBe('allowed');
    expect(row).not.toHaveProperty('licenseManualSource');
  });

  test('every override entry is keyed name@version and supplies a verifiable source', () => {
    for (const [key, value] of Object.entries(MANUAL_LICENSE_OVERRIDES)) {
      expect(key).toMatch(/@[^@]+$/); // ends with @<version>
      expect(typeof value.license).toBe('string');
      expect(value.license.length).toBeGreaterThan(0);
      expect(typeof value.source).toBe('string');
      expect(value.source.length).toBeGreaterThan(0);
    }
  });
});
