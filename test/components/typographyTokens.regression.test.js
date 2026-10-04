/**
 * Typography token ratchets (F-148).
 *
 * tailwind.config.js is not loaded by the Tailwind 4 build (F-146), so any
 * non-default font-size utility the code references must have a --text-*
 * token in the styles.css @theme block or it silently renders at the
 * inherited size (preflight zeroes heading sizes). Typography's
 * variant="display" — the phase hero titles — did exactly that until F-148.
 */

// The suite-wide fs mock is memfs — scan the real repository tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const RENDERER_ROOT = path.join(__dirname, '..', '..', 'src', 'renderer');
const styles = fs.readFileSync(path.join(RENDERER_ROOT, 'styles.css'), 'utf8');

describe('font-size tokens (F-148)', () => {
  test('@theme defines text-display for the Typography display variant', () => {
    expect(styles).toMatch(/--text-display:\s*3rem/);
    expect(styles).toMatch(/--text-display--line-height:\s*1\.1/);
  });

  test('@theme defines text-micro for below-xs chips (U-T3)', () => {
    expect(styles).toMatch(/--text-micro:\s*0\.7rem/);
    expect(styles).toMatch(/--text-micro--line-height:\s*1rem/);
  });

  test('no renderer source hand-rolls text-[11px] (text-micro exists)', () => {
    const walk = (dir, files = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath, files);
        else if (/\.(jsx|js)$/.test(entry.name)) files.push(fullPath);
      }
      return files;
    };
    const offenders = [];
    for (const file of walk(RENDERER_ROOT)) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('text-[11px]')) {
        offenders.push(path.relative(RENDERER_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
