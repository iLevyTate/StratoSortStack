// @ts-check
const path = require('path');
const { createLogger } = require('../../shared/logger');
const { STABILITY_THRESHOLDS } = require('../../shared/performanceConstants');

const logger = createLogger('SystemAnalytics');
const PIPELINE_WINDOW_SIZE = 200;
const PIPELINE_DEGRADE_MIN_SAMPLES = 20;
const PIPELINE_DEGRADE_FALLBACK_RATE = 0.5;
const PIPELINE_DEGRADE_ERROR_RATE = 0.25;
const STABILITY_WINDOW_SIZE = 400;
const MAX_SANITIZED_ERROR_MESSAGE = 500;

/**
 * Replace absolute paths with their basenames so full filesystem layout
 * doesn't leak over IPC. Full detail is still preserved in local logs
 * (`recordFailure` keeps the raw stack internally).
 */
function redactPathsInErrorMessage(/** @type {any} */ message) {
  if (typeof message !== 'string' || !message) return message;
  return message
    .replace(/[A-Za-z]:\\(?:[^\s"'<>]+\\)*[^\s"'<>]+/g, (abs) => path.basename(abs))
    .replace(/\/(?:[^\s"'<>/]+\/)+[^\s"'<>/]+/g, (abs) => path.basename(abs))
    .slice(0, MAX_SANITIZED_ERROR_MESSAGE);
}

/**
 * Sanitize the entries returned by `collectMetrics().recentErrors` before
 * they cross the IPC boundary. We strip `stack` entirely (implementation
 * detail + absolute paths) and basename-redact `message` so a renderer-side
 * diagnostics view still gets actionable text without exposing the install
 * path, project tree, or internal module layout.
 */
function sanitizeRecentErrorsForIpc(/** @type {any} */ errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => ({
    timestamp: entry?.timestamp ?? null,
    message: redactPathsInErrorMessage(entry?.message ?? '')
  }));
}

function createPipelineStats() {
  return /** @type {any} */ ({
    total: 0,
    primary: 0,
    fallback: 0,
    error: 0,
    recent: [],
    lastDegradedAt: null
  });
}

function createStabilityStats() {
  return /** @type {any} */ ({
    search: {
      requests: 0,
      fallbacks: 0,
      byReason: Object.create(null),
      recent: []
    },
    organization: {
      routingDecisions: 0,
      uncategorizedFallbacks: 0,
      recent: []
    }
  });
}

function pushRecent(
  /** @type {any} */ queue,
  /** @type {any} */ value,
  maxSize = STABILITY_WINDOW_SIZE
) {
  queue.push(value);
  if (queue.length > maxSize) {
    queue.splice(0, queue.length - maxSize);
  }
}

// Cap on unique "reason" labels held in `stability.search.byReason`. Callers
// pass strings that originate from error codes, adapter names, or (worst
// case) raw error messages; without a ceiling, a renderer that emits many
// distinct strings grows the counter map unboundedly over a long session.
const MAX_BY_REASON_KEYS = 64;
const BY_REASON_OVERFLOW = '__overflow__';
const BY_REASON_VALUE_MAX_LEN = 64;

/**
 * Normalize a search-fallback reason into a low-cardinality label.
 *
 * - Coerces non-strings, collapses whitespace, lowercases.
 * - Strips volatile suffixes like `:1234`, `(42ms)`, trailing UUIDs/hashes
 *   so a "reason" plus a rotating id doesn't fan out into thousands of keys.
 * - Clamps length to keep a long error message from blowing the map entry.
 */
function normalizeReasonKey(/** @type {any} */ reason) {
  if (reason == null) return 'unknown';
  let normalized = String(reason).trim();
  if (!normalized) return 'unknown';
  normalized = normalized
    .replace(/[\s\u00a0]+/g, '_')
    .replace(/[:/][0-9a-f]{6,}\b/gi, '')
    .replace(/\b\d{4,}\b/g, 'N')
    .replace(/\([^)]{0,64}\)/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.length > BY_REASON_VALUE_MAX_LEN) {
    normalized = normalized.slice(0, BY_REASON_VALUE_MAX_LEN);
  }
  return normalized;
}

/**
 * Increment a counter bucket, capping total distinct keys. Overflows fall
 * into a single `__overflow__` bucket so the caller still gets signal that
 * "some other reason" is happening without a map explosion.
 */
function incrementCappedBucket(/** @type {any} */ bucket, /** @type {any} */ reason) {
  const key = normalizeReasonKey(reason);
  if (Object.prototype.hasOwnProperty.call(bucket, key)) {
    bucket[key] += 1;
    return key;
  }
  // Not a known key; enforce the cap. Object.create(null) buckets have no
  // inherited properties so Object.keys length is accurate.
  const currentKeys = Object.keys(bucket);
  if (currentKeys.length >= MAX_BY_REASON_KEYS) {
    bucket[BY_REASON_OVERFLOW] = (bucket[BY_REASON_OVERFLOW] || 0) + 1;
    return BY_REASON_OVERFLOW;
  }
  bucket[key] = 1;
  return key;
}

// Expose only the STRATOSORT_* namespace so the renderer Diagnostics panel
// can show which feature flags / overrides are active without leaking
// unrelated environment variables.
function collectStratosortEnv() {
  const snapshot = {};
  const env = process.env || {};
  const snap = /** @type {Record<string, any>} */ (snapshot);
  for (const key of Object.keys(env)) {
    if (!key.startsWith('STRATOSORT_')) continue;
    const value = env[key];
    if (value === undefined) continue;
    snap[key] = String(value);
  }
  return snap;
}

/** @type {any} */
const systemAnalytics = {
  startTime: Date.now(),
  processedFiles: 0,
  successfulOperations: 0,
  failedOperations: 0,
  totalProcessingTime: 0,
  errors: [],
  llamaHealth: { status: 'unknown', lastCheck: null },
  stability: createStabilityStats(),
  pipeline: {
    document: createPipelineStats(),
    image: createPipelineStats(),
    embedding: createPipelineStats()
  },

  recordProcessingTime(/** @type {any} */ duration) {
    this.totalProcessingTime += duration;
    this.processedFiles++;
  },

  recordSuccess() {
    this.successfulOperations++;
  },

  recordFailure(/** @type {any} */ error) {
    this.failedOperations++;
    this.errors.push({
      timestamp: Date.now(),
      message: error.message || error.toString(),
      stack: error.stack
    });
    if (this.errors.length > 100) {
      this.errors = this.errors.slice(-100);
    }
  },

  recordPipelineOutcome(/** @type {any} */ pipelineName, /** @type {any} */ outcome, details = {}) {
    if (!pipelineName || !this.pipeline[pipelineName]) return;
    const normalizedOutcome =
      outcome === 'primary' || outcome === 'fallback' || outcome === 'error' ? outcome : 'error';
    const bucket = this.pipeline[pipelineName];
    bucket.total += 1;
    bucket[normalizedOutcome] += 1;

    bucket.recent.push({
      timestamp: Date.now(),
      outcome: normalizedOutcome,
      reason: /** @type {any} */ (details).reason || null
    });
    if (bucket.recent.length > PIPELINE_WINDOW_SIZE) {
      bucket.recent.splice(0, bucket.recent.length - PIPELINE_WINDOW_SIZE);
    }

    const recentTotal = bucket.recent.length;
    if (recentTotal < PIPELINE_DEGRADE_MIN_SAMPLES) return;

    const recentFallback = bucket.recent.filter(
      (/** @type {any} */ entry) => entry.outcome === 'fallback'
    ).length;
    const recentError = bucket.recent.filter(
      (/** @type {any} */ entry) => entry.outcome === 'error'
    ).length;
    const fallbackRate = recentFallback / recentTotal;
    const errorRate = recentError / recentTotal;
    const degraded =
      fallbackRate >= PIPELINE_DEGRADE_FALLBACK_RATE || errorRate >= PIPELINE_DEGRADE_ERROR_RATE;

    if (!degraded) return;

    const now = Date.now();
    if (bucket.lastDegradedAt && now - bucket.lastDegradedAt < 30000) {
      return;
    }
    bucket.lastDegradedAt = now;

    logger.warn('[ANALYTICS] Pipeline degradation detected', {
      pipeline: pipelineName,
      recentTotal,
      fallbackRate: Number(fallbackRate.toFixed(3)),
      errorRate: Number(errorRate.toFixed(3))
    });
  },

  recordSearchRequest(details = {}) {
    this.stability.search.requests += 1;
    pushRecent(this.stability.search.recent, {
      timestamp: Date.now(),
      type: 'request',
      mode: /** @type {any} */ (details).mode || 'hybrid'
    });
  },

  recordSearchFallback(reason = 'unknown') {
    this.stability.search.fallbacks += 1;
    const normalizedReason = incrementCappedBucket(this.stability.search.byReason, reason);
    pushRecent(this.stability.search.recent, {
      timestamp: Date.now(),
      type: 'fallback',
      reason: normalizedReason
    });
  },

  recordOrganizationRouting({ resolvedToUncategorized = false, reason = 'unknown' } = {}) {
    this.stability.organization.routingDecisions += 1;
    if (resolvedToUncategorized) {
      this.stability.organization.uncategorizedFallbacks += 1;
    }
    pushRecent(this.stability.organization.recent, {
      timestamp: Date.now(),
      type: 'routing',
      reason,
      resolvedToUncategorized: Boolean(resolvedToUncategorized)
    });
  },

  getStabilitySummary() {
    const search = this.stability.search;
    const organization = this.stability.organization;

    const searchFallbackRate = search.requests > 0 ? search.fallbacks / search.requests : 0;
    const uncategorizedRate =
      organization.routingDecisions > 0
        ? organization.uncategorizedFallbacks / organization.routingDecisions
        : 0;

    return {
      search: {
        requests: search.requests,
        fallbacks: search.fallbacks,
        fallbackRate: searchFallbackRate,
        byReason: { ...search.byReason },
        threshold: STABILITY_THRESHOLDS.SEARCH_FALLBACK_RATE_WARN,
        thresholdBreached: searchFallbackRate >= STABILITY_THRESHOLDS.SEARCH_FALLBACK_RATE_WARN
      },
      organization: {
        routingDecisions: organization.routingDecisions,
        uncategorizedFallbacks: organization.uncategorizedFallbacks,
        uncategorizedRate,
        threshold: STABILITY_THRESHOLDS.UNCATEGORIZED_ROUTING_RATE_WARN,
        thresholdBreached: uncategorizedRate >= STABILITY_THRESHOLDS.UNCATEGORIZED_ROUTING_RATE_WARN
      }
    };
  },

  getPipelineSummary() {
    const summarize = (/** @type {any} */ name) => {
      const bucket = this.pipeline[name] || createPipelineStats();
      const recentTotal = bucket.recent.length || 0;
      const recentFallback = bucket.recent.filter(
        (/** @type {any} */ entry) => entry.outcome === 'fallback'
      ).length;
      const recentError = bucket.recent.filter(
        (/** @type {any} */ entry) => entry.outcome === 'error'
      ).length;
      const recentPrimary = bucket.recent.filter(
        (/** @type {any} */ entry) => entry.outcome === 'primary'
      ).length;
      // Aggregate the non-primary reasons in the recent window so the
      // Diagnostics panel can explain *why* a pipeline is falling back
      // (e.g. vector_primary_empty vs fallback_model:*) instead of only
      // showing an opaque rate.
      /** @type {Record<string, number>} */
      const fallbackReasons = {};
      for (const entry of bucket.recent) {
        if (entry.outcome === 'primary' || !entry.reason) continue;
        fallbackReasons[entry.reason] = (fallbackReasons[entry.reason] || 0) + 1;
      }
      return {
        total: bucket.total,
        primary: bucket.primary,
        fallback: bucket.fallback,
        error: bucket.error,
        primaryRate: bucket.total > 0 ? bucket.primary / bucket.total : 0,
        fallbackRate: bucket.total > 0 ? bucket.fallback / bucket.total : 0,
        errorRate: bucket.total > 0 ? bucket.error / bucket.total : 0,
        fallbackReasons,
        recent: {
          total: recentTotal,
          primary: recentPrimary,
          fallback: recentFallback,
          error: recentError,
          primaryRate: recentTotal > 0 ? recentPrimary / recentTotal : 0,
          fallbackRate: recentTotal > 0 ? recentFallback / recentTotal : 0,
          errorRate: recentTotal > 0 ? recentError / recentTotal : 0
        },
        degraded:
          recentTotal >= PIPELINE_DEGRADE_MIN_SAMPLES &&
          (recentFallback / recentTotal >= PIPELINE_DEGRADE_FALLBACK_RATE ||
            recentError / recentTotal >= PIPELINE_DEGRADE_ERROR_RATE)
      };
    };

    return {
      document: summarize('document'),
      image: summarize('image'),
      embedding: summarize('embedding')
    };
  },

  async collectMetrics() {
    const uptime = Date.now() - this.startTime;
    const avgProcessingTime =
      this.processedFiles > 0 ? this.totalProcessingTime / this.processedFiles : 0;

    /** @type {any} */
    const metrics = {
      uptime,
      processedFiles: this.processedFiles,
      successfulOperations: this.successfulOperations,
      failedOperations: this.failedOperations,
      avgProcessingTime: Math.round(avgProcessingTime),
      errorRate: this.getFailureRate(),
      recentErrors: sanitizeRecentErrorsForIpc(this.errors.slice(-10)),
      llamaHealth: this.llamaHealth,
      pipeline: this.getPipelineSummary(),
      stability: this.getStabilitySummary()
    };

    try {
      const memUsage = process.memoryUsage();
      const percentage =
        memUsage.heapTotal > 0 ? Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100) : 0;
      metrics.memory = {
        used: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024),
        percentage
      };
    } catch (error) {
      logger.warn('Could not collect memory metrics:', error.message);
    }

    // Snapshot the effective STRATOSORT_* env so the renderer Diagnostics
    // panel can show which feature flags/overrides are actually in use. This
    // is safe to expose — the env names are deliberately namespaced and no
    // secrets are stored under this prefix.
    try {
      metrics.env = collectStratosortEnv();
    } catch (error) {
      logger.warn('Could not collect STRATOSORT env snapshot:', error.message);
      metrics.env = {};
    }

    return metrics;
  },

  getFailureRate() {
    // Failures do not increment processedFiles, so the rate must be measured
    // against total operations (successes + failures). Dividing by
    // processedFiles alone let the rate exceed 100% on failure-heavy runs.
    const totalOperations = this.successfulOperations + this.failedOperations;
    return totalOperations > 0 ? (this.failedOperations / totalOperations) * 100 : 0;
  },

  destroy() {
    this.processedFiles = 0;
    this.successfulOperations = 0;
    this.failedOperations = 0;
    this.totalProcessingTime = 0;
    this.errors = [];
    this.stability = createStabilityStats();
    this.pipeline = {
      document: createPipelineStats(),
      image: createPipelineStats(),
      embedding: createPipelineStats()
    };
    logger.info('[ANALYTICS] System analytics cleaned up');
  }
};

module.exports = systemAnalytics;
