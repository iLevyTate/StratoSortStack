// @ts-check
/**
 * PerformanceMetrics — in-memory rolling counters for embeddings, text
 * generation, and vector search.
 *
 * Tracks count, totalLatencyMs, errors, and derived avgLatencyMs (plus
 * tokens-per-second for text generation). PerformanceService uses this
 * as its data source; the renderer reads the snapshot for the
 * Diagnostics view. No persistence by design — restarts reset the
 * counters, so the data reflects only the current session.
 */
const { TIMEOUTS } = require('../../shared/performanceConstants');

class PerformanceMetrics {
  constructor() {
    /** @type {Record<string, any>} */
    this._metrics = {
      embeddings: {
        count: 0,
        totalLatencyMs: 0,
        errors: 0,
        avgLatencyMs: 0
      },
      textGeneration: {
        count: 0,
        totalLatencyMs: 0,
        totalTokens: 0,
        errors: 0,
        avgLatencyMs: 0,
        avgTokensPerSecond: 0
      },
      vectorSearch: {
        count: 0,
        totalLatencyMs: 0,
        errors: 0,
        avgLatencyMs: 0
      },
      modelLoads: {
        count: 0,
        totalLatencyMs: 0,
        byType: {}
      },
      memory: {
        peakUsageMB: 0,
        currentUsageMB: 0
      }
    };

    // Sample memory every 30 seconds
    this._memoryInterval = setInterval(() => this._sampleMemory(), TIMEOUTS.SERVICE_STARTUP);
    if (this._memoryInterval.unref) this._memoryInterval.unref();

    // Safety net: clear interval on process exit to prevent orphaned timers
    this._exitHandler = () => this.destroy();
    process.once('exit', this._exitHandler);
  }

  /**
   * Destroy the metrics collector, clearing the interval timer.
   */
  destroy() {
    if (this._memoryInterval) {
      clearInterval(this._memoryInterval);
      this._memoryInterval = null;
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
  }

  recordEmbedding(/** @type {any} */ latencyMs, success = true) {
    if (!Number.isFinite(latencyMs)) return;
    this._metrics.embeddings.count++;
    this._metrics.embeddings.totalLatencyMs += latencyMs;
    if (!success) this._metrics.embeddings.errors++;
    this._updateAverage('embeddings');
  }

  recordTextGeneration(
    /** @type {any} */ latencyMs,
    /** @type {any} */ tokenCount,
    success = true
  ) {
    if (!Number.isFinite(latencyMs) || !Number.isFinite(tokenCount)) return;
    this._metrics.textGeneration.count++;
    this._metrics.textGeneration.totalLatencyMs += latencyMs;
    this._metrics.textGeneration.totalTokens += tokenCount;
    if (!success) this._metrics.textGeneration.errors++;
    this._updateAverage('textGeneration');

    if (this._metrics.textGeneration.totalLatencyMs > 0) {
      this._metrics.textGeneration.avgTokensPerSecond =
        (this._metrics.textGeneration.totalTokens / this._metrics.textGeneration.totalLatencyMs) *
        1000;
    }
  }

  recordVectorSearch(/** @type {any} */ latencyMs, success = true) {
    if (!Number.isFinite(latencyMs)) return;
    this._metrics.vectorSearch.count++;
    this._metrics.vectorSearch.totalLatencyMs += latencyMs;
    if (!success) this._metrics.vectorSearch.errors++;
    this._updateAverage('vectorSearch');
  }

  recordModelLoad(/** @type {any} */ modelType, /** @type {any} */ latencyMs) {
    this._metrics.modelLoads.count++;
    this._metrics.modelLoads.totalLatencyMs += latencyMs;

    if (!this._metrics.modelLoads.byType[modelType]) {
      this._metrics.modelLoads.byType[modelType] = { count: 0, totalMs: 0 };
    }
    this._metrics.modelLoads.byType[modelType].count++;
    this._metrics.modelLoads.byType[modelType].totalMs += latencyMs;
  }

  _updateAverage(/** @type {any} */ category) {
    const m = this._metrics[category];
    m.avgLatencyMs = m.count > 0 ? m.totalLatencyMs / m.count : 0;
  }

  _sampleMemory() {
    const used = process.memoryUsage();
    const currentMB = Math.round(used.heapUsed / 1024 / 1024);
    this._metrics.memory.currentUsageMB = currentMB;
    if (currentMB > this._metrics.memory.peakUsageMB) {
      this._metrics.memory.peakUsageMB = currentMB;
    }
  }

  getMetrics() {
    // structuredClone is ~3× faster than JSON.parse(JSON.stringify(...)) and
    // handles cycles + Maps/Sets correctly. getMetrics() is hot — IPC-polled
    // for the renderer telemetry view, so the per-call allocation savings
    // matter on long sessions. Fall back to JSON-clone in older test envs
    // (jsdom shims may not expose structuredClone) so unit tests run
    // identically to production.
    return typeof structuredClone === 'function'
      ? structuredClone(this._metrics)
      : JSON.parse(JSON.stringify(this._metrics));
  }

  getHealthScore() {
    // Calculate health score 0-100
    let score = 100;

    // Penalize high error rates
    const embeddingErrorRate =
      this._metrics.embeddings.errors / Math.max(this._metrics.embeddings.count, 1);
    score -= embeddingErrorRate * 30;

    // Penalize high latency
    if (this._metrics.embeddings.avgLatencyMs > 100) {
      score -= Math.min(20, (this._metrics.embeddings.avgLatencyMs - 100) / 10);
    }

    // Penalize high memory usage (>80% of system RAM)
    const os = require('os');
    const totalMemMB = Math.round(os.totalmem() / (1024 * 1024)) || 16 * 1024;
    const memoryPercent = this._metrics.memory.currentUsageMB / totalMemMB;
    if (memoryPercent > 0.8) {
      score -= (memoryPercent - 0.8) * 100;
    }

    return Math.max(0, Math.round(score));
  }

  reset() {
    this._metrics = {
      embeddings: { count: 0, totalLatencyMs: 0, errors: 0, avgLatencyMs: 0 },
      textGeneration: {
        count: 0,
        totalLatencyMs: 0,
        totalTokens: 0,
        errors: 0,
        avgLatencyMs: 0,
        avgTokensPerSecond: 0
      },
      vectorSearch: { count: 0, totalLatencyMs: 0, errors: 0, avgLatencyMs: 0 },
      modelLoads: { count: 0, totalLatencyMs: 0, byType: {} },
      memory: { peakUsageMB: 0, currentUsageMB: 0 }
    };
  }
}

// Singleton
/** @type {PerformanceMetrics|null} */
let instance = null;
function getInstance() {
  if (!instance) {
    instance = new PerformanceMetrics();
  }
  return instance;
}

function resetInstance() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

module.exports = { PerformanceMetrics, getInstance, resetInstance };
