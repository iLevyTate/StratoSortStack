/**
 * Semantic spacing-token ratchets (U-T9 pilot + F-147).
 *
 * The gap-compact/cozy/default/relaxed/spacious utilities MUST be declared
 * with `@utility` (not plain classes in @layer utilities): handwritten
 * classes never get Tailwind variants, so the `lg:gap-*` responsive upgrades
 * at every phase root compiled to NOTHING until 2026-07-03 — the same silent
 * no-op class as F-146.
 */

// The suite-wide fs mock is memfs — scan the real repository tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const RENDERER_ROOT = path.join(__dirname, '..', '..', 'src', 'renderer');
const styles = fs.readFileSync(path.join(RENDERER_ROOT, 'styles.css'), 'utf8');

const TOKENS = ['compact', 'cozy', 'default', 'relaxed', 'spacious'];

describe('semantic spacing utilities (F-147/F-149)', () => {
  test.each(TOKENS)('--spacing-%s lives in @theme so the full family compiles', (token) => {
    // @theme placement is what generates p-*/m-*/space-*/gap-* (+variants)
    // for these names; a plain :root var generates NOTHING (F-149: 14 dead
    // call sites), and handwritten gap classes get no variants (F-147).
    const themeStart = styles.indexOf('@theme {');
    const firstRoot = styles.indexOf(':root {');
    const tokenIdx = styles.indexOf(`--spacing-${token}:`);
    expect(tokenIdx).toBeGreaterThan(themeStart);
    expect(tokenIdx).toBeLessThan(firstRoot);
    expect(styles).not.toMatch(new RegExp(`^\\s*\\.gap-${token}\\s*\\{`, 'm'));
    expect(styles).not.toContain(`@utility gap-${token}`);
  });

  test('token values keep the numeric-scale identity the U-T9 pilot relies on', () => {
    // gap-compact === gap-2, gap-cozy === gap-3, gap-default === gap-4.
    expect(styles).toMatch(/--spacing-compact:\s*0\.5rem/);
    expect(styles).toMatch(/--spacing-cozy:\s*0\.75rem/);
    expect(styles).toMatch(/--spacing-default:\s*1rem/);
    expect(styles).toMatch(/--spacing-relaxed:\s*1\.5rem/);
    expect(styles).toMatch(/--spacing-spacious:\s*2rem/);
  });
});

describe('app-wide semantic-gap adoption (U-T4, piloted as U-T9)', () => {
  function walkSourceFiles(dir, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkSourceFiles(fullPath, files);
      else if (/\.(jsx|js)$/.test(entry.name)) files.push(fullPath);
    }
    return files;
  }

  test('no numeric gap with a token equivalent remains in renderer components', () => {
    // gap-2/3/4/6/8 === compact/cozy/default/relaxed/spacious (values pinned
    // above). gap-1/1.5/2.5/5 have no token and stay numeric by design.
    const offenders = [];
    for (const file of walkSourceFiles(RENDERER_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (/(?<![:\w-])(?:(?:sm|md|lg|xl|2xl):)?gap-[23468](?![\w.-])/.test(line)) {
          offenders.push(`${path.relative(RENDERER_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
