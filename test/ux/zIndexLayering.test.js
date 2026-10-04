/**
 * Guards toast vs modal stacking.
 *
 * 2026-07-12 decision (QA follow-up audit): toasts stack ABOVE modals. This
 * reverses the earlier Gemini CSV / "First impressions" call that put
 * notifications under Knowledge OS — with toasts below the modal scrim, undo
 * confirmations and save/background errors were completely invisible while
 * Settings or Knowledge OS was open. Toasts are transient and corner-anchored,
 * so they briefly overlap a modal edge rather than blocking work. Page
 * tooltips got their own token (--z-tooltip) so they still stay UNDER modal
 * scrims.
 */
const path = require('path');
const fs = jest.requireActual('fs');

describe('z-index layering (styles.css)', () => {
  let css;

  const token = (name) => {
    const match = css.match(new RegExp(`${name}:\\s*(\\d+)`));
    expect(match).not.toBeNull();
    return Number(match[1]);
  };

  beforeAll(() => {
    const stylesPath = path.join(process.cwd(), 'src/renderer/styles.css');
    css = fs.readFileSync(stylesPath, 'utf8');
  });

  test('toast container stacks above modals (feedback stays visible)', () => {
    expect(token('--z-toast')).toBeGreaterThan(token('--z-modal'));
    expect(token('--z-toast')).toBeGreaterThan(token('--z-modal-consent'));
  });

  test('toast container stays below the skip link', () => {
    expect(token('--z-toast')).toBeLessThan(token('--z-skip-link'));
  });

  test('cloud AI consent stacks above modal (nested Settings configure flow)', () => {
    expect(token('--z-modal-consent')).toBeGreaterThan(token('--z-modal'));
  });

  test('page tooltips stay below modal scrims', () => {
    expect(token('--z-tooltip')).toBeLessThan(token('--z-modal'));
  });

  test('tooltip-enhanced uses the tooltip token, not the toast token', () => {
    const tooltipBlock = css.match(/\.tooltip-enhanced\s*\{[^}]+\}/);
    expect(tooltipBlock).not.toBeNull();
    expect(tooltipBlock[0]).toContain('var(--z-tooltip)');
    expect(tooltipBlock[0]).not.toContain('var(--z-toast)');
  });

  test('every z-* token consumed as a class has a matching @utility (Tailwind 4 has no --z-* namespace)', () => {
    // Without an @utility definition a z-<token> class compiles to NOTHING and
    // the element renders at z-index auto — the token comparisons above would
    // then assert an invariant no element actually gets (this happened: modals
    // sat at z-auto from PR #349 until the utilities were added).
    const srcDir = path.join(process.cwd(), 'src/renderer');
    const classRe =
      /className[^\n]*?\bz-(modal-consent|modal|toast|header|overlay|tooltip|skip-link)\b/;
    const usedTokens = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
          for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            const m = line.match(classRe);
            if (m) usedTokens.add(m[1]);
          }
        }
      }
    };
    walk(srcDir);
    expect(usedTokens.size).toBeGreaterThan(0);
    for (const tokenName of usedTokens) {
      expect(css).toMatch(
        new RegExp(`@utility z-${tokenName}\\s*\\{\\s*z-index:\\s*var\\(--z-${tokenName}\\)`)
      );
    }
  });
});
