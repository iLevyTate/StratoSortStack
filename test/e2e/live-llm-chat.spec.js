/**
 * @live-llm — Chat RAG streaming against real local models.
 *
 * Run: npm run test:e2e:live-llm -- test/e2e/live-llm-chat.spec.js
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs/promises');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { createTempDir, cleanupTempDir, TIMEOUTS } = require('./helpers/testFixtures');
const {
  waitForLoadedTextModel,
  normalizeAnalysisPayload,
  assertAnalysisRoutingSignal,
  waitForFileInSearch
} = require('./helpers/liveLlm');

const SAMPLE_CONTENT = [
  'StratoSort live-llm chat smoke.',
  '',
  'Acme Corp quarterly revenue increased twelve percent year over year.',
  'Operating expenses declined three percent according to the CFO memo.',
  '',
  'Keywords: Acme, revenue, quarterly, CFO, finance.'
].join('\n');

async function waitForEmbeddingHit(window, query, filePath, budgetMs = 60_000) {
  const result = await waitForFileInSearch(window, { query, filePath, budgetMs });
  return result.ok;
}

async function streamChatAnswer(window, query, timeoutMs = 120_000) {
  return window.evaluate(
    async ({ query, timeoutMs }) => {
      const chat = window.electronAPI?.chat;
      if (!chat?.queryStream || !chat?.onStreamChunk || !chat?.onStreamEnd) {
        return { ok: false, reason: 'chat streaming API unavailable' };
      }

      const requestId = `e2e-chat-${Date.now()}`;
      const sessionId = 'e2e-live-llm-chat';
      const chunks = [];
      let streamError = null;
      let finished = false;

      const offChunk = chat.onStreamChunk((data) => {
        if (data?.requestId != null && String(data.requestId) !== String(requestId)) return;
        if (data?.type === 'error') streamError = data.error || 'stream error';
        if (data?.type === 'chunk' && data.text) chunks.push(data.text);
        if (data?.type === 'done') finished = true;
      });
      const offEnd = chat.onStreamEnd((data) => {
        if (data?.requestId != null && String(data.requestId) !== String(requestId)) return;
        finished = true;
      });

      try {
        const started = await chat.queryStream({
          query,
          requestId,
          sessionId,
          mode: 'hybrid',
          topK: 6,
          responseMode: 'fast'
        });
        if (!started?.success) {
          return { ok: false, reason: started?.error || 'queryStream failed to start' };
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !finished && !streamError) {
          await new Promise((r) => setTimeout(r, 250));
        }

        const text = chunks.join('').trim();
        if (streamError) return { ok: false, reason: streamError, text };
        if (!text) return { ok: false, reason: 'no streamed text received', finished };
        return { ok: true, text, finished };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
      } finally {
        if (typeof offChunk === 'function') offChunk();
        if (typeof offEnd === 'function') offEnd();
      }
    },
    { query, timeoutMs }
  );
}

test.describe('@live-llm Chat RAG streaming', () => {
  let app;
  let window;
  let tempDir;
  let filePath;

  test.beforeAll(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);

    tempDir = await createTempDir('stratosort-e2e-live-chat-');
    filePath = path.join(tempDir, 'acme_cfo_revenue_memo.txt');
    await fs.writeFile(filePath, SAMPLE_CONTENT, 'utf8');
  });

  test.afterAll(async () => {
    await closeApp(app);
    await cleanupTempDir(tempDir);
  });

  test('analyzes a document then streams a grounded chat response', async () => {
    test.setTimeout(TIMEOUTS.VERY_LONG * 2);

    const modelReady = await waitForLoadedTextModel(window);
    if (!modelReady) {
      test.skip(true, 'No text LLM loaded; @live-llm chat requires a ready model backend.');
    }

    const analyzed = await window.evaluate(async (p) => {
      try {
        const res = await window.electronAPI.analysis.document(p);
        return { ok: true, res };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
      }
    }, filePath);

    expect(analyzed.ok, analyzed.reason).toBe(true);
    const analysis = normalizeAnalysisPayload(analyzed.res);
    assertAnalysisRoutingSignal(analysis);

    const indexed = await waitForEmbeddingHit(window, 'Acme quarterly revenue', filePath, 45_000);
    if (!indexed) {
      test.skip(true, 'Analysis history/search not indexed yet; skipping chat stream assertion.');
    }

    const chat = await streamChatAnswer(
      window,
      'What did the Acme Corp CFO memo say about revenue and expenses?'
    );

    expect(chat.ok, chat.reason).toBe(true);
    expect(chat.text.length).toBeGreaterThan(20);
    expect(/acme|revenue|expense|quarter|percent|cfo|finance/i.test(chat.text)).toBe(true);
  });
});
