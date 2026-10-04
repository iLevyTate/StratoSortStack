/**
 * Shared helpers for @live-llm Playwright specs (real node-llama-cpp inference).
 */

async function isTextBackendReady(window) {
  return window.evaluate(async () => {
    try {
      const llama = window.electronAPI?.llama;
      if (!llama || typeof llama.testConnection !== 'function') return false;
      const res = await llama.testConnection();
      return Boolean(res && (res.success === true || res.ok === true));
    } catch {
      return false;
    }
  });
}

// testConnection only proves the backend is reachable — it does NOT prove the configured
// text-generation model is installed. The e2e app runs against an isolated, initially empty
// userData, so a missing model surfaces as an empty getModels() list (not an error). Confirm
// settings.textModel is in the *installed* set so @live-llm text specs SKIP (instead of
// failing with "Model not found: <textModel>") when the model is absent.
//
// getModels() resolves to { models: [...names], categories: { text, vision, embedding }, ... }.
// Read those installed lists only — NOT `selected`, which echoes the configured name back even
// when it is not installed (that is precisely the value we must not trust here).
async function isTextModelDownloaded(window) {
  return window.evaluate(async () => {
    try {
      const llama = window.electronAPI?.llama;
      const settings = await window.electronAPI?.settings?.get();
      const textModel = settings?.textModel;
      if (!textModel || typeof textModel !== 'string') return false;
      if (!llama || typeof llama.getModels !== 'function') return false;

      const listed = await llama.getModels();
      const names = new Set();
      const add = (v) => {
        const name = typeof v === 'string' ? v : v?.name || v?.filename || '';
        if (name) names.add(String(name));
      };
      if (Array.isArray(listed)) {
        listed.forEach(add);
      } else if (listed && typeof listed === 'object') {
        if (Array.isArray(listed.models)) listed.models.forEach(add);
        for (const category of Object.values(listed.categories || {})) {
          if (Array.isArray(category)) category.forEach(add);
        }
      }

      return [...names].some((name) => name.includes(textModel) || textModel.includes(name));
    } catch {
      return false;
    }
  });
}

async function hasLoadedTextModel(window) {
  return (await isTextBackendReady(window)) && (await isTextModelDownloaded(window));
}

async function waitForLoadedTextModel(window, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  // Download status is static within a run — check it once. If the configured text model is
  // not downloaded, no amount of polling helps, so skip fast instead of burning the whole
  // test timeout (full-journey's test budget == this poll deadline, so a slow path here
  // would time the test out rather than skip it).
  if (!(await isTextModelDownloaded(window))) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTextBackendReady(window)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// Mirrors the text guard (isTextModelDownloaded): testConnection() only proves the backend is
// reachable, NOT that the configured vision model is installed. On the e2e app's isolated, empty
// userData getModels() returns an empty list, so an optimistic empty-list `return true` here made
// @live-llm vision FAIL with "Model not found: <visionModel>" instead of skipping. Confirm
// settings.visionModel is in the *installed* set (models + categories, NOT `selected`); an empty
// set now correctly yields false so the spec skips.
async function hasLoadedVisionModel(window) {
  return window.evaluate(async () => {
    try {
      const llama = window.electronAPI?.llama;
      if (!llama || typeof llama.testConnection !== 'function') return false;
      const connection = await llama.testConnection();
      if (!(connection && (connection.success === true || connection.ok === true))) {
        return false;
      }

      const settings = await window.electronAPI?.settings?.get();
      const visionModel = settings?.visionModel;
      if (!visionModel || typeof visionModel !== 'string') return false;
      if (typeof llama.getModels !== 'function') return false;

      const listed = await llama.getModels();
      const names = new Set();
      const add = (v) => {
        const name = typeof v === 'string' ? v : v?.name || v?.filename || '';
        if (name) names.add(String(name));
      };
      if (Array.isArray(listed)) {
        listed.forEach(add);
      } else if (listed && typeof listed === 'object') {
        if (Array.isArray(listed.models)) listed.models.forEach(add);
        for (const category of Object.values(listed.categories || {})) {
          if (Array.isArray(category)) category.forEach(add);
        }
      }

      return [...names].some(
        (name) =>
          name.includes(visionModel) ||
          visionModel.includes(name) ||
          name.toLowerCase().includes('llava') ||
          name.toLowerCase().includes('vision')
      );
    } catch {
      return false;
    }
  });
}

async function waitForLoadedVisionModel(window, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasLoadedVisionModel(window)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function normalizeAnalysisPayload(res) {
  return res?.data || res?.analysis || res;
}

function assertAnalysisRoutingSignal(analysis, label = 'analysis') {
  const hasSignal = Boolean(
    analysis?.category || analysis?.suggestedFolder || analysis?.purpose || analysis?.summary
  );
  if (!hasSignal) {
    throw new Error(`${label} missing routing signal (category/folder/purpose/summary)`);
  }
}

async function waitForFileInSearch(
  window,
  { query, filePath, budgetMs = 60_000, intervalMs = 500 }
) {
  return window.evaluate(
    async ({ query, filePath, budgetMs, intervalMs }) => {
      const deadline = Date.now() + budgetMs;
      const pathMatches = (value) =>
        value === filePath ||
        (typeof value === 'string' &&
          value.replace(/\\/g, '/').toLowerCase() === filePath.replace(/\\/g, '/').toLowerCase());

      while (Date.now() < deadline) {
        const history = window.electronAPI?.analysisHistory;
        if (history && typeof history.getFileHistory === 'function') {
          try {
            const entry = await history.getFileHistory(filePath);
            if (entry && (entry.analysis || entry.category || entry.summary || entry.filePath)) {
              return { ok: true, surface: 'analysisHistory.getFileHistory' };
            }
          } catch {
            // keep polling
          }
        }

        const embed = window.electronAPI?.embeddings;
        if (embed && typeof embed.search === 'function') {
          try {
            const res = await embed.search(query, { topK: 10 });
            const hits = res?.results || res?.hits || res?.data?.results || [];
            if (
              hits.some(
                (h) =>
                  pathMatches(h?.filePath) ||
                  pathMatches(h?.path) ||
                  pathMatches(h?.id) ||
                  /acme|revenue|finance|quarterly/i.test(
                    `${h?.title || ''} ${h?.snippet || ''} ${h?.summary || ''}`
                  )
              )
            ) {
              return { ok: true, surface: 'embeddings.search' };
            }
          } catch {
            // keep polling
          }
        }

        if (history && typeof history.search === 'function') {
          try {
            const res = await history.search(query, { limit: 10 });
            const rows = res?.results || res?.data || [];
            if (
              rows.some(
                (r) =>
                  pathMatches(r?.filePath) ||
                  pathMatches(r?.path) ||
                  /acme|revenue|finance|quarterly/i.test(
                    `${r?.summary || ''} ${r?.category || ''} ${r?.suggestedName || ''}`
                  )
              )
            ) {
              return { ok: true, surface: 'analysisHistory.search' };
            }
          } catch {
            // keep polling
          }
        }

        await new Promise((r) => setTimeout(r, intervalMs));
      }

      return { ok: false };
    },
    { query, filePath, budgetMs, intervalMs }
  );
}

module.exports = {
  hasLoadedTextModel,
  waitForLoadedTextModel,
  hasLoadedVisionModel,
  waitForLoadedVisionModel,
  normalizeAnalysisPayload,
  assertAnalysisRoutingSignal,
  waitForFileInSearch
};
