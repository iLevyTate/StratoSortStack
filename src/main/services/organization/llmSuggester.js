// @ts-check
/**
 * LLM Suggester
 *
 * LLM-powered organization suggestions.
 * Extracted from OrganizationSuggestionService for better maintainability.
 *
 * @module services/organization/llmSuggester
 */

const { createLogger } = require('../../../shared/logger');
const { TIMEOUTS } = require('../../../shared/performanceConstants');
const { withAbortableTimeout, throwIfAborted } = require('../../../shared/promiseUtils');
const { AI_DEFAULTS } = require('../../../shared/constants');
const { getInstance: getLlamaService } = require('../LlamaService');
const { globalDeduplicator } = require('../../utils/llmOptimization');
const { extractAndParseJSON } = require('../../utils/jsonRepair');
const { attemptJsonRepairWithLlama } = require('../../utils/llmJsonRepair');
const { isInteractiveTextRequestActive } = require('../textModelActivity');
const {
  getOrganizationGuidance,
  formatOrganizationGuidanceBlock
} = require('../../analysis/organizationGuidance');

const logger = createLogger('Organization:LLMSuggester');
// Security limits
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
const LLM_SUGGESTIONS_SCHEMA = {
  suggestions: [
    {
      folder: 'folder name',
      reasoning: 'why this makes sense',
      confidence: 0.0,
      strategy: 'organization principle used'
    }
  ]
};

async function withLinkedAbortableTimeout(
  /** @type {any} */ run,
  /** @type {{ timeoutMs: number, operationName: string, signal?: AbortSignal }} */ {
    timeoutMs,
    operationName,
    signal
  }
) {
  return withAbortableTimeout(
    async (/** @type {any} */ abortController) => {
      throwIfAborted(signal, `${operationName} cancelled`);

      let cleanup = null;
      if (signal) {
        const onAbort = () => abortController.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }

      try {
        return await run(abortController.signal);
      } finally {
        cleanup?.();
      }
    },
    timeoutMs,
    operationName
  );
}

function normalizeFolderKey(/** @type {any} */ value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function resolveConfiguredSmartFolder(
  /** @type {any} */ folderName,
  /** @type {any} */ smartFolders = []
) {
  if (!folderName || !Array.isArray(smartFolders) || smartFolders.length === 0) return null;
  const candidate = String(folderName).trim();
  if (!candidate) return null;
  const lowerCandidate = candidate.toLowerCase();

  const exact = smartFolders.find(
    (f) => f && typeof f.name === 'string' && f.name.toLowerCase() === lowerCandidate
  );
  if (exact) return exact;

  const normalizedCandidate = normalizeFolderKey(candidate);
  return (
    smartFolders.find(
      (f) => f && typeof f.name === 'string' && normalizeFolderKey(f.name) === normalizedCandidate
    ) || null
  );
}

/**
 * Returns the cloud router inference backend for organization suggestions, or null.
 *
 * Lazy-required so this module remains loadable without the IPC tree being
 * initialized (unit tests, early-boot paths).
 *
 * Only router resolution failures fall back to local: a throw here returns
 * null so the caller uses llamaService. A failure of the returned provider
 * call (e.g. BUDGET_EXCEEDED) propagates to the caller's catch, which
 * returns [] with no local re-run.
 *
 * @returns {{ fn: function }|null}
 */
function _getOrganizationRouterBackend() {
  try {
    const aiProvider = require('../../ipc/aiProvider');
    const router = aiProvider.getActiveAiRouter ? aiProvider.getActiveAiRouter() : null;
    if (!router) return null;

    const provider = router.choose({ operation: 'suggest', allowFallback: false });
    if (!provider || provider.id === 'local') return null;

    return /** @type {any} */ ({
      providerName: provider.displayName || provider.id || 'cloud',
      fn: async (
        /** @type {{ prompt?: string, temperature?: number, maxTokens?: number, signal?: AbortSignal }} */ {
          prompt,
          temperature,
          maxTokens,
          signal
        }
      ) => {
        const result = await provider.suggest(prompt, { temperature, maxTokens, signal });
        // Normalize cloud shape { text, usage } → local shape { response }
        return { response: result.text || '' };
      }
    });
  } catch {
    // Router not yet initialized or threw — fall back to local.
    return null;
  }
}

/**
 * Get LLM-powered alternative suggestions
 * @param {Record<string, any>} file - File to analyze
 * @param {Array<any>} smartFolders - Available folders
 * @param {Record<string, any>} config - LLM configuration
 * @returns {Promise<Array<any>>} LLM suggestions
 */
async function getLLMAlternativeSuggestions(file, smartFolders, config = {}) {
  try {
    const { signal } = config;
    throwIfAborted(signal, 'LLM suggestions cancelled');

    const llamaService = getLlamaService();
    const model = AI_DEFAULTS.TEXT.MODEL;
    const configuredFolders = Array.isArray(smartFolders)
      ? smartFolders.filter(
          (folder) => folder && typeof folder.name === 'string' && folder.name.trim()
        )
      : [];

    if (!llamaService) {
      return [];
    }
    if (configuredFolders.length === 0) {
      return [];
    }
    await llamaService.initialize();

    const llmTemperature = config.llmTemperature || 0.7;
    const llmMaxTokens = config.llmMaxTokens || 500;

    // Compact JSON preserves ~40% more semantic content than pretty-print
    // within the same character budget.
    const serializedAnalysis = JSON.stringify(file.analysis || {}).slice(0, 1200);

    const allowedFoldersText = configuredFolders
      .map(
        (f, idx) =>
          `${idx + 1}. "${f.name}" - ${(f.description || 'No description provided').slice(0, 140)}`
      )
      .join('\n');
    // Global user organization instructions (empty string when unset).
    const orgGuidanceStr = formatOrganizationGuidanceBlock(await getOrganizationGuidance());
    const prompt = `Given this file analysis, suggest up to 3 alternative organization approaches:

File: ${file.name}
Type: ${file.extension}
Analysis (truncated): ${serializedAnalysis}

AVAILABLE SMART FOLDERS (ONLY valid outputs):
${allowedFoldersText}${orgGuidanceStr}

RULES:
- Use ONLY folder names from the list above.
- Do NOT invent, rename, merge, or pluralize folder names.
- Return 1-3 UNIQUE suggestions (no duplicate folders).
- If uncertain, choose the closest folder from the list.
- Keep reasoning grounded in the provided file analysis only.

STRICT OUTPUT RULES:
- Return ONLY a raw JSON object.
- Do NOT wrap in markdown code fences (no backticks, no \`\`\`json).
- Do NOT include prose before or after the JSON.
- Every "folder" value MUST exactly match one allowed folder name.

Return JSON: {
  "suggestions": [
    {
      "folder": "folder name",
      "reasoning": "why this makes sense",
      "confidence": 0.0-1.0,
      "strategy": "organization principle used"
    }
  ]
}`;

    // Use deduplication to prevent duplicate LLM calls
    const deduplicationKey = globalDeduplicator.generateKey({
      fileName: file.name,
      analysis: JSON.stringify(file.analysis || {}),
      folders: configuredFolders.map((f) => f.name).join(','),
      type: 'organization-suggestions'
    });

    // When chat is active, use a shorter timeout so background suggestions
    // yield the text model sooner. Otherwise use the standard 60s budget.
    const timeoutMs = isInteractiveTextRequestActive()
      ? TIMEOUTS.AI_ANALYSIS_SHORT
      : TIMEOUTS.AI_ANALYSIS_MEDIUM;

    // Check once per call whether a cloud provider is active.
    // _getOrganizationRouterBackend() returns null for local-only users.
    const routerBackend = _getOrganizationRouterBackend();
    if (routerBackend) {
      logger.debug('[LLMSuggester] Using router-backed provider for organization suggestions', {
        provider: /** @type {any} */ (routerBackend).providerName,
        file: file?.name
      });
    } else {
      logger.debug('[LLMSuggester] Using text model', { model, timeoutMs, file: file?.name });
    }

    const response = await withLinkedAbortableTimeout(
      (/** @type {any} */ abortSignal) =>
        globalDeduplicator.deduplicate(deduplicationKey, () => {
          if (routerBackend) {
            return routerBackend.fn({
              prompt,
              temperature: llmTemperature,
              maxTokens: llmMaxTokens,
              signal: abortSignal
            });
          }
          return llamaService.generateText({
            prompt,
            temperature: llmTemperature,
            maxTokens: llmMaxTokens,
            signal: abortSignal
          });
        }),
      {
        timeoutMs,
        operationName: 'LLM organization suggestions',
        signal
      }
    );

    // Validate response size
    const responseText = response.response || '';
    const responseSize = Buffer.byteLength(responseText, 'utf8');

    if (responseSize > MAX_RESPONSE_SIZE) {
      logger.warn('[LLMSuggester] Response exceeds maximum size limit', {
        size: responseSize,
        maxSize: MAX_RESPONSE_SIZE,
        file: file.name
      });
      return [];
    }

    // Parse JSON response with robust extraction and repair
    /** @type {Record<string, any>|null} */
    let parsed = /** @type {any} */ (
      extractAndParseJSON(responseText, null, {
        source: 'llmSuggester',
        fileName: file?.name,
        model
      })
    );

    if (!parsed) {
      const repairedResponse = await attemptJsonRepairWithLlama(llamaService, responseText, {
        schema: LLM_SUGGESTIONS_SCHEMA,
        maxTokens: llmMaxTokens,
        operation: 'Organization suggestions'
      });

      if (repairedResponse) {
        parsed = extractAndParseJSON(repairedResponse, null, {
          source: 'llmSuggester.repair',
          fileName: file?.name,
          model
        });
      }
    }

    if (!parsed) {
      // One strict retry to reduce avoidable empty suggestion sets.
      const strictPrompt = `${prompt}

STRICT OUTPUT REQUIREMENT:
- Return ONLY valid JSON.
- Do NOT include markdown fences, prose, or extra tokens.
- Every "folder" value MUST exactly match one of the allowed folder names listed above.
- Use exactly this shape: {"suggestions":[{"folder":"name","reasoning":"text","confidence":0.0,"strategy":"text"}]}`;
      const strictRetryKey = globalDeduplicator.generateKey({
        fileName: file.name,
        analysis: JSON.stringify(file.analysis || {}),
        folders: configuredFolders.map((f) => f.name).join(','),
        type: 'organization-suggestions',
        retry: 'strict-json'
      });
      const strictResponse = await withLinkedAbortableTimeout(
        (/** @type {any} */ abortSignal) =>
          globalDeduplicator.deduplicate(strictRetryKey, () => {
            if (routerBackend) {
              return routerBackend.fn({
                prompt: strictPrompt,
                temperature: 0.1,
                maxTokens: llmMaxTokens,
                signal: abortSignal
              });
            }
            return llamaService.generateText({
              prompt: strictPrompt,
              temperature: 0.1,
              maxTokens: llmMaxTokens,
              signal: abortSignal
            });
          }),
        {
          timeoutMs,
          operationName: 'LLM organization suggestions strict retry',
          signal
        }
      );
      parsed = extractAndParseJSON(strictResponse?.response || '', null, {
        source: 'llmSuggester.strict-retry',
        fileName: file?.name,
        model
      });
    }

    if (!parsed) {
      logger.warn('[LLMSuggester] Failed to parse JSON response', {
        responseLength: responseText.length,
        responsePreview: responseText.slice(0, 500)
      });
      return [];
    }

    if (!Array.isArray(parsed.suggestions)) {
      logger.warn('[LLMSuggester] Response missing suggestions array');
      return [];
    }

    const seenFolderNames = new Set();
    return parsed.suggestions
      .filter((/** @type {any} */ s) => {
        if (!s || typeof s !== 'object') {
          logger.warn('[LLMSuggester] Skipping suggestion with invalid shape');
          return false;
        }
        // Ensure folder is a valid string
        if (typeof s.folder !== 'string' || !s.folder.trim()) {
          logger.warn('[LLMSuggester] Skipping suggestion with invalid folder', {
            folder: s.folder,
            type: typeof s.folder
          });
          return false;
        }
        return true;
      })
      .map((/** @type {any} */ s) => {
        const resolvedFolder = resolveConfiguredSmartFolder(s.folder, configuredFolders);
        if (!resolvedFolder) {
          logger.warn('[LLMSuggester] Dropping hallucinated/non-configured folder suggestion', {
            folder: s.folder,
            file: file?.name
          });
          return null;
        }
        const dedupeKey = String(resolvedFolder.name || '').toLowerCase();
        if (seenFolderNames.has(dedupeKey)) {
          return null;
        }
        seenFolderNames.add(dedupeKey);

        const rawConf = Number.isFinite(s.confidence) ? s.confidence : Number(s.confidence);
        const normalizedRawConf = Number.isFinite(rawConf) ? rawConf : 0.5;
        const reasoning = typeof s.reasoning === 'string' ? s.reasoning.trim() : '';
        const strategy = typeof s.strategy === 'string' ? s.strategy.trim() : '';
        const normalizedConf = normalizedRawConf > 1 ? normalizedRawConf / 100 : normalizedRawConf;
        const clampedConf = Math.max(0, Math.min(1, normalizedConf));
        return {
          folder: resolvedFolder.name,
          path: resolvedFolder.path,
          folderId: resolvedFolder.id,
          isSmartFolder: true,
          score: clampedConf,
          confidence: clampedConf,
          reasoning,
          strategy,
          method: 'llm_creative'
        };
      })
      .filter(Boolean);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    logger.warn('[LLMSuggester] LLM suggestions failed:', error.message);
    return [];
  }
}

module.exports = {
  getLLMAlternativeSuggestions,
  MAX_RESPONSE_SIZE
};
