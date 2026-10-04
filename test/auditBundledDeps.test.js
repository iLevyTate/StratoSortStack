/**
 * @jest-environment node
 */

const { findBundledAdvisories } = require('../scripts/audit-bundled-deps');

describe('audit-bundled-deps advisory filter', () => {
  const bundled = new Set(['node_modules/react', 'node_modules/ui/node_modules/shared']);

  const auditJson = {
    vulnerabilities: {
      react: {
        severity: 'high',
        range: '<19.0.0',
        nodes: ['node_modules/react'],
        via: [{ url: 'https://github.com/advisories/GHSA-react', title: 'React RCE' }, 'react-dom']
      },
      shared: {
        severity: 'critical',
        range: '*',
        nodes: ['node_modules/shared', 'node_modules/ui/node_modules/shared'],
        via: [{ url: 'https://github.com/advisories/GHSA-shared' }]
      },
      'dev-only': {
        severity: 'critical',
        range: '*',
        nodes: ['node_modules/dev-only'],
        via: [{ url: 'https://github.com/advisories/GHSA-dev' }]
      },
      lucide: {
        severity: 'moderate',
        range: '*',
        nodes: ['node_modules/react'],
        via: [{ url: 'https://github.com/advisories/GHSA-mod' }]
      }
    }
  };

  test('reports only high/critical advisories whose nodes are in the bundled closure', () => {
    const findings = findBundledAdvisories(auditJson, bundled);

    expect(findings.map((f) => f.name)).toEqual(['react', 'shared']);
    expect(findings[1].nodes).toEqual(['node_modules/ui/node_modules/shared']);
    expect(findings[0].advisories).toEqual(['https://github.com/advisories/GHSA-react']);
  });

  test('returns nothing for a clean report', () => {
    expect(findBundledAdvisories({}, bundled)).toEqual([]);
    expect(findBundledAdvisories({ vulnerabilities: {} }, bundled)).toEqual([]);
  });
});
