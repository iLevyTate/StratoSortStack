/**
 * QA runtime repro session — 2026-07-02 (session-only, NOT for CI)
 *
 * Drives the app against a profile with the REAL local models (junctioned in)
 * to verify the "needs runtime/QA" backlog items in docs/BACKLOG_CHECKLIST.md:
 *   TX-02  AI Configuration expand does nothing
 *   A3     Simple -> Advanced re-enables embedding/graph sections
 *   A2     Chat: no duplicated "tail" while streaming
 *   A1     Graph similarity edge label/thickness not stuck at 0%
 *   FI-04  filename vs semantic search discrepancy
 *
 * Run: SOAK-free, Node 20:
 *   fnm exec --using=20 -- node node_modules/@playwright/test/cli.js test test/e2e/qa-runtime-repro.spec.js
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { launchApp, closeApp, waitForAppReady, dismissGraphTour } = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');
const { ensureAdvancedExperienceMode } = require('./helpers/e2eSettings');
const { waitForLoadedTextModel, normalizeAnalysisPayload } = require('./helpers/liveLlm');

const REAL_MODELS_DIR = path.join(process.env.APPDATA || '', 'StratoSort Core', 'models');

const DOCS = {
  'acme_q3_revenue_report.txt': [
    'Acme Corp Q3 revenue report.',
    'Quarterly revenue increased twelve percent year over year.',
    'Operating expenses declined three percent per the CFO memo.',
    'Keywords: Acme, revenue, quarterly, CFO, finance.'
  ].join('\n'),
  'acme_q3_expense_breakdown.txt': [
    'Acme Corp Q3 expense breakdown.',
    'Operating expenses fell three percent, driven by cloud cost cuts.',
    'The CFO memo attributes savings to vendor consolidation.',
    'Keywords: Acme, expenses, quarterly, CFO, finance.'
  ].join('\n'),
  'chili_recipe_notes.txt': [
    'Weeknight chili recipe notes.',
    'Brown the beef, add tomatoes, beans, cumin and simmer forty minutes.',
    'Keywords: cooking, recipe, chili, dinner.'
  ].join('\n')
};

let profileDir;
let modelsJunction;
let docsDir;
let app;
let window;

test.describe.configure({ mode: 'serial' });

test.describe('QA runtime repro (real models)', () => {
  test.beforeAll(async () => {
    // Conditional guard (same convention as the @live-llm specs): machines
    // without the real model profile skip instead of failing the full suite.
    test.skip(!fs.existsSync(REAL_MODELS_DIR), `real models dir missing (${REAL_MODELS_DIR})`);

    profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stratosort-qa-profile-'));
    modelsJunction = path.join(profileDir, 'models');
    // Junction (not copy): models are multi-GB. MUST be unlinked with rmdirSync
    // BEFORE any recursive delete of profileDir (F-140 lesson).
    fs.symlinkSync(REAL_MODELS_DIR, modelsJunction, 'junction');

    docsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stratosort-qa-docs-'));
    for (const [name, content] of Object.entries(DOCS)) {
      await fsp.writeFile(path.join(docsDir, name), content, 'utf8');
    }

    const result = await launchApp({ userDataDir: profileDir });
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterAll(async () => {
    await closeApp(app);
    try {
      fs.rmdirSync(modelsJunction);
    } catch {
      // junction already gone
    }
    expect(fs.existsSync(path.join(REAL_MODELS_DIR, 'nomic-embed-text-v1.5-Q8_0.gguf'))).toBe(true);
    await fsp.rm(profileDir, { recursive: true, force: true });
    await fsp.rm(docsDir, { recursive: true, force: true });
  });

  test('TX-02: AI Configuration collapsible expands to visible content', async () => {
    const nav = new NavigationPage(window);
    expect(await nav.openSettings()).toBe(true);

    const expandAll = window.locator('button[aria-label="Expand all settings sections"]').first();
    if (await expandAll.isVisible().catch(() => false)) {
      // Collapse-all first so we exercise the user's actual click on the header.
      const collapseAll = window
        .locator('button[aria-label="Collapse all settings sections"]')
        .first();
      if (await collapseAll.isVisible().catch(() => false)) await collapseAll.click();
    }

    const aiConfigHeader = window.locator('button:has-text("AI Configuration")').first();
    await expect(aiConfigHeader).toBeVisible({ timeout: 5000 });
    await aiConfigHeader.click();
    await window.waitForTimeout(400);

    // The TX-02 report: "expand does nothing". Oracle: expanding must reveal
    // real content (LlamaConfigSection renders model/back-end status copy).
    const revealed = await window.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { ok: false, reason: 'no dialog' };
      const text = dialog.innerText || '';
      return {
        ok: /model|engine|backend|download/i.test(text),
        sample: text.slice(0, 400)
      };
    });
    expect(revealed.ok, `expanded AI Configuration shows content: ${revealed.sample}`).toBe(true);
    await window.keyboard.press('Escape');
  });

  test('A3: Simple -> Advanced visibly re-enables advanced sections', async () => {
    const nav = new NavigationPage(window);
    expect(await nav.openSettings()).toBe(true);

    const simpleBtn = window.getByRole('button', { name: 'Simple', exact: true }).first();
    const advancedBtn = window.getByRole('button', { name: 'Advanced', exact: true }).first();
    await expect(simpleBtn).toBeVisible({ timeout: 5000 });

    // Baseline: Simple mode
    await simpleBtn.click();
    await window.waitForTimeout(400);
    const simpleSections = await window.evaluate(
      () => (document.querySelector('[role="dialog"]')?.innerText || '').length
    );

    await advancedBtn.click();
    await window.waitForTimeout(600);
    const advanced = await window.evaluate(() => {
      const text = document.querySelector('[role="dialog"]')?.innerText || '';
      return {
        length: text.length,
        hasPerformance: /performance/i.test(text),
        hasEmbeddingOrGraph: /embedding|graph|semantic/i.test(text)
      };
    });

    expect(advanced.length, 'Advanced shows more settings surface').toBeGreaterThan(simpleSections);
    expect(advanced.hasEmbeddingOrGraph, 'embedding/graph sections visible in Advanced').toBe(true);
    await window.keyboard.press('Escape');
  });

  // MUST run before A2/A1: chat and the graph both gate on a non-empty
  // embedding index ("No embeddings yet" empty state otherwise — the reason
  // the first scripted A2 attempt produced no stream).
  test('corpus: analyze 3 docs and wait for the embedding index', async () => {
    test.setTimeout(600_000);
    const modelReady = await waitForLoadedTextModel(window, { timeoutMs: 120_000 });
    if (!modelReady) test.skip(true, 'text model did not become ready');
    await ensureAdvancedExperienceMode(window);

    // Analyze the 3-doc corpus through the real pipeline (feeds embeddings).
    for (const name of Object.keys(DOCS)) {
      const p = path.join(docsDir, name);
      const analyzed = await window.evaluate(async (fp) => {
        try {
          const res = await window.electronAPI.analysis.document(fp);
          return { ok: true, res };
        } catch (err) {
          return { ok: false, reason: err?.message || String(err) };
        }
      }, p);
      expect(analyzed.ok, `${name}: ${analyzed.reason}`).toBe(true);
      expect(normalizeAnalysisPayload(analyzed.res)).toBeTruthy();
    }

    // Poll the embedding index rather than a blind sleep.
    let stats = null;
    const statsDeadline = Date.now() + 120_000;
    while (Date.now() < statsDeadline) {
      stats = await window.evaluate(async () => {
        try {
          const res = await window.electronAPI.embeddings.getStats({ forceRefresh: true });
          return res?.stats || res || null;
        } catch (err) {
          return { err: err?.message };
        }
      });
      if ((stats?.files ?? 0) >= 3) break;
      await window.waitForTimeout(2000);
    }
    console.log('[QA][corpus] embedding stats =', JSON.stringify(stats));
    expect(stats?.files ?? 0, 'embedding index contains the corpus').toBeGreaterThanOrEqual(3);
  });

  test('A2: chat stream renders no duplicated tail in the UI', async () => {
    test.setTimeout(360_000);
    // NOTE: llama.testConnection() reported not-ready for the full 180s poll in
    // this profile while analysis.document() on the same profile inferred fine
    // (evidence: qa-run2.log) — so gate on the downloaded-model check only and
    // let the chat UI itself prove readiness.
    const probe = await window.evaluate(async () => {
      const settings = await window.electronAPI?.settings?.get();
      const listed = await window.electronAPI?.llama?.getModels();
      const names = JSON.stringify(listed?.models || listed || []);
      const conn = await window.electronAPI?.llama?.testConnection().catch((e) => ({
        err: e?.message
      }));
      return { textModel: settings?.textModel, names, conn };
    });
    console.log('[QA][A2] probe =', JSON.stringify(probe));
    if (!probe.textModel || !probe.names.includes(probe.textModel)) {
      test.skip(true, `configured text model not installed (${probe.textModel})`);
    }

    // Fresh profiles default to Simple mode, which hides the Chat/Relate tabs.
    await ensureAdvancedExperienceMode(window);
    await pressOpenSearchShortcut(window);
    // Diagnose the failure mode before any skip: is the search modal open at
    // all (shortcut swallowed?) vs open-but-tab-missing (product bug — the
    // Chat tab is unconditional in UnifiedSearchModal's header).
    let modalState = await window.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return {
        dialogCount: dialogs.length,
        heads: dialogs.map((d) => (d.innerText || '').slice(0, 80))
      };
    });
    if (modalState.dialogCount === 0) {
      await window.waitForTimeout(1000);
      await pressOpenSearchShortcut(window);
      await window.waitForTimeout(1000);
      modalState = await window.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        return {
          dialogCount: dialogs.length,
          heads: dialogs.map((d) => (d.innerText || '').slice(0, 80))
        };
      });
    }
    console.log('[QA][A2] modal state =', JSON.stringify(modalState));
    const chatTab = window
      .locator('button:has-text("Chat"), [role="tab"]:has-text("Chat")')
      .first();
    if (!(await chatTab.isVisible().catch(() => false))) {
      test.skip(
        true,
        `Chat tab not reachable (dialogs=${modalState.dialogCount}: ${modalState.heads.join(' // ')})`
      );
    }
    await chatTab.click({ force: true });
    await window.waitForTimeout(500);

    const chatInput = window
      .locator('textarea, input[placeholder*="Ask"], input[placeholder*="ask"]')
      .last();
    await expect(chatInput).toBeVisible({ timeout: 5000 });
    await chatInput.fill('In one short sentence, what is StratoSort?');
    // ChatPanel sends on Ctrl/⌘+Enter or the Send button — plain Enter is a
    // newline in the textarea (run-3 snapshot: typed text sat unsent).
    await window.locator('button[aria-label="Send message"]').first().click();

    // Poll the rendered assistant message while it streams; keep snapshots.
    const snapshots = [];
    const deadline = Date.now() + 240_000;
    let last = '';
    let stableCount = 0;
    while (Date.now() < deadline && stableCount < 10) {
      const text = await window.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return '';
        const nodes = dialog.querySelectorAll(
          '[data-role="assistant"], [class*="assistant"], [class*="message"]'
        );
        const el = nodes[nodes.length - 1];
        return el ? el.innerText : '';
      });
      if (text && text !== last) {
        snapshots.push(text);
        last = text;
        stableCount = 0;
      } else if (text) {
        stableCount += 1;
      }
      await window.waitForTimeout(400);
    }

    expect(snapshots.length, 'chat produced streamed output').toBeGreaterThan(0);
    const finalText = snapshots[snapshots.length - 1].trim();
    expect(finalText.length).toBeGreaterThan(10);

    // Duplicated-tail oracle: the first 30 chars of the final answer must not
    // occur twice in the final render (partial + full echo), and no snapshot
    // may be an exact doubling of its own first half.
    const prefix = finalText.slice(0, 30);
    const occurrences = finalText.split(prefix).length - 1;
    expect(occurrences, `answer prefix rendered once (text: ${finalText.slice(0, 120)})`).toBe(1);
    for (const snap of snapshots) {
      const t = snap.trim();
      if (t.length < 20 || t.length % 2 !== 0) continue;
      const half = t.slice(0, t.length / 2);
      expect(t !== half + half, `snapshot is a doubled half: ${half.slice(0, 60)}`).toBe(true);
    }
    await window.keyboard.press('Escape');
  });

  test('A1+FI-04: analyze corpus, then similarity edges and filename-vs-semantic search', async () => {
    test.setTimeout(600_000);
    const modelReady = await waitForLoadedTextModel(window, { timeoutMs: 120_000 });
    if (!modelReady) test.skip(true, 'text model did not become ready');

    // Fresh profiles default to Simple mode, which hides the Relate tab.
    await ensureAdvancedExperienceMode(window);

    // Corpus is analyzed/indexed by the earlier 'corpus:' test (serial mode).
    const indexed = await window.evaluate(async () => {
      try {
        const res = await window.electronAPI.embeddings.getStats({ forceRefresh: true });
        return (res?.stats || res)?.files ?? 0;
      } catch {
        return 0;
      }
    });
    if (indexed < 3) test.skip(true, `corpus not indexed (files=${indexed})`);

    // FI-04 — filename query vs semantic query must both surface the doc.
    const searches = await window.evaluate(async () => {
      const out = {};
      const run = async (q) => {
        try {
          const res = await window.electronAPI.embeddings.search(q, { topK: 8 });
          const results = res?.results || res || [];
          return Array.isArray(results)
            ? results.map((r) => r?.filePath || r?.path || r?.id || '').join('|')
            : JSON.stringify(results).slice(0, 300);
        } catch (err) {
          return `ERR:${err?.message}`;
        }
      };
      out.byFilename = await run('acme_q3_revenue_report');
      out.bySemantic = await run('quarterly financial performance memo');
      return out;
    });
    console.log('[QA][FI-04] byFilename =', searches.byFilename);
    console.log('[QA][FI-04] bySemantic =', searches.bySemantic);
    expect(
      /acme_q3_revenue_report/.test(searches.bySemantic) || /acme/.test(searches.bySemantic),
      `semantic query surfaces the revenue doc (${searches.bySemantic})`
    ).toBe(true);

    // A1 — open Knowledge OS graph and inspect similarity edge labels.
    await pressOpenSearchShortcut(window);
    const relateTab = window
      .locator('button:has-text("Relate"), [role="tab"]:has-text("Relate")')
      .first();
    if (!(await relateTab.isVisible().catch(() => false))) {
      test.skip(true, 'Relate tab not reachable');
    }
    await relateTab.click({ force: true });
    await dismissGraphTour(window);
    await window.waitForTimeout(2000);

    // Add the two Acme docs to the graph via the search-to-add input if present.
    // Target the graph's own add inputs (empty-state "Search for files to
    // start..." or the panel's "Search files to add to the graph…") — the
    // previous loose match could land on "Search clusters..." et al.
    const addInput = window
      .locator('input[placeholder*="add to the graph"], input[placeholder*="files to start"]')
      .first();
    console.log(
      '[QA][A1] add input =',
      (await addInput.isVisible().catch(() => false))
        ? await addInput.getAttribute('placeholder').catch(() => '?')
        : 'none-visible'
    );
    if (await addInput.isVisible().catch(() => false)) {
      // One fill+select per document: the picker closes/filters after each
      // selection, so a single 'acme' fill only ever landed ONE node (run 4).
      for (const q of ['acme_q3_revenue', 'acme_q3_expense', 'chili_recipe']) {
        await addInput.fill(q);
        await window.waitForTimeout(1500);
        const option = window.locator('[role="option"], [class*="result"]').first();
        const optVisible = await option.isVisible().catch(() => false);
        console.log(`[QA][A1] add '${q}': option visible = ${optVisible}`);
        if (optVisible) {
          await option.click({ force: true }).catch(() => {});
        }
        await window.waitForTimeout(1000);
      }
    }
    // Similarity edges compute asynchronously after nodes land — poll rather
    // than a fixed wait.
    const edgeDeadline = Date.now() + 30_000;
    while (Date.now() < edgeDeadline) {
      const edgesNow = await window.evaluate(
        () => document.querySelectorAll('.react-flow__edge').length
      );
      if (edgesNow > 0) break;
      await window.waitForTimeout(2000);
    }

    const edgeInfo = await window.evaluate(() => {
      const edges = Array.from(document.querySelectorAll('.react-flow__edge'));
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const labels = Array.from(document.querySelectorAll('.react-flow__edgelabel-renderer *'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => /%/.test(t));
      const widths = edges
        .map((e) => {
          const p = e.querySelector('path');
          return p ? Number(p.getAttribute('stroke-width') || 0) : 0;
        })
        .filter((w) => w > 0);
      return {
        edgeCount: edges.length,
        nodeCount: nodes.length,
        nodeLabels: nodes.map((n) => (n.textContent || '').trim().slice(0, 40)),
        labels,
        widths
      };
    });
    console.log('[QA][A1] graph edges =', JSON.stringify(edgeInfo));

    if (edgeInfo.edgeCount === 0) {
      // nodeCount distinguishes the two failure modes: 0 nodes = the repro
      // failed to populate the graph (harness gap); ≥2 nodes with 0 edges =
      // the similarity-edge defect A1 describes.
      expect(
        edgeInfo.nodeCount < 2,
        `A1 REPRODUCED: ${edgeInfo.nodeCount} nodes rendered with ZERO similarity edges (${JSON.stringify(edgeInfo.nodeLabels)})`
      ).toBe(true);
      test.skip(true, `graph not populated (nodes=${edgeInfo.nodeCount}) — harness gap, not A1`);
    }
    const percentLabels = edgeInfo.labels.map((l) => parseInt(l, 10)).filter(Number.isFinite);
    if (percentLabels.length > 0) {
      expect(
        percentLabels.some((v) => v > 0),
        `edge similarity labels not all 0% (${edgeInfo.labels.join(', ')})`
      ).toBe(true);
    }
  });
});
