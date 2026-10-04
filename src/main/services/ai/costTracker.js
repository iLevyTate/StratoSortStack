// @ts-check
'use strict';

const path = require('node:path');
const { promises: fsp } = require('node:fs');
const crypto = require('node:crypto');
const { AIProviderError } = require('./errors');
const { swallow } = require('../../../shared/promiseUtils');

/**
 * CostTracker — per-month token totals + optional spend-cap enforcement.
 *
 * Pricing is hard-coded (USD per 1M tokens, input/output) and lives below.
 * Adding a new model requires updating this table; the design intentionally
 * fails LOUD when a model is missing rather than silently estimating $0,
 * which would mask spend cap breaches.
 *
 * Storage: a single JSON file at the configured `filePath`. Records are
 * keyed by `YYYY-MM` so the file naturally grows by ~one entry per month
 * per provider. Atomic writes via a temp-file + rename. Loaded lazily on
 * first read.
 *
 * Privacy: only cloud providers (anthropic, openaiCompatible) are tracked.
 * Local provider records are no-ops — there is no spend to track and we
 * don't want even the appearance of telemetry over local activity.
 */

const PRICING_PER_M_TOKENS = Object.freeze({
  // Anthropic Claude (USD per 1M tokens)
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI (USD per 1M tokens)
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 }
});

// Conservative ceiling for unknown models so cap enforcement still bites.
// Matches the most expensive supported model (opus). If a user pastes a
// custom model name, it's better to overstate than understate.
const UNKNOWN_MODEL_PRICING = Object.freeze({ input: 15, output: 75 });

// Self-hosted endpoints that should always cost $0 regardless of model name.
// Without this, an Ollama / LM Studio / vLLM user routed via openaiCompatible
// gets billed at UNKNOWN_MODEL_PRICING (Opus rates) against their cap and
// hits BUDGET_EXCEEDED on phantom spend.
const _LOCAL_HOST_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i,
  /^https?:\/\/[a-z0-9-]+\.local(?::\d+)?(?:\/|$)/i // .local mDNS
];

function _isLocalEndpoint(/** @type {any} */ baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  return _LOCAL_HOST_PATTERNS.some((re) => re.test(baseUrl));
}

function _monthKey(/** @type {any} */ date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

class CostTracker {
  /** @param {{ filePath?: string, getSettings?: (...args: any[]) => any, now?: () => Date, logger?: any }} [deps] */
  constructor({ filePath, getSettings, now = () => new Date(), logger } = {}) {
    if (!filePath) throw new Error('CostTracker: filePath is required');
    if (typeof getSettings !== 'function') {
      throw new Error('CostTracker: getSettings function is required');
    }
    this._filePath = filePath;
    this._getSettings = getSettings;
    this._now = now;
    this._logger = logger || {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
    /** @type {Record<string, Record<string, any>>} */
    this._data = {};
    this._loaded = false;
    // Single-flight chain that serializes recordUsage. Without this, two
    // parallel calls both read the same _data, mutate, and race on _persist
    // — losing one of the writes and silently exceeding monthly spend caps.
    this._writeChain = Promise.resolve();
    // Single-flight load() so concurrent first-callers share one readFile.
    this._loadingPromise = null;
    // Track persistence/load health. When degraded, enforceCap() fails closed
    // (refuses cloud calls) so silent persist failures can't bypass the cap.
    // _persistFailureCount counts CONSECUTIVE failures; resets on success.
    this._loadError = null;
    this._persistFailureCount = 0;
  }

  /** @param {{ provider: string, model: string, inputTokens?: number, outputTokens?: number, baseUrl?: string|null }} args */
  static estimateCost({ provider, model, inputTokens = 0, outputTokens = 0, baseUrl = null }) {
    if (provider === 'local') return 0;
    // Self-hosted endpoints (Ollama, LM Studio, vLLM, etc.) reached via the
    // openaiCompatible provider are free locally — don't bill them at Opus
    // rates against the spend cap.
    if (provider === 'openaiCompatible' && _isLocalEndpoint(baseUrl)) return 0;
    const pricing =
      /** @type {Record<string, { input: number, output: number }>} */ (PRICING_PER_M_TOKENS)[
        model
      ] || UNKNOWN_MODEL_PRICING;
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  async load() {
    // Single-flight: concurrent callers share the same in-flight promise so
    // we don't race two readFile calls.
    if (this._loaded) return;
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = (async () => {
      try {
        const raw = await fsp.readFile(this._filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this._data = parsed;
        }
      } catch (err) {
        // ENOENT (fresh install / first run) is expected and benign.
        if (err.code === 'ENOENT') {
          this._loaded = true;
          this._loadError = null;
          return;
        }
        // Anything else (corrupted JSON, EACCES, EIO) is NOT benign. The
        // previous behavior was to swallow and set _loaded=true, which
        // caused subsequent recordUsage to start from empty _data and a
        // later persist would overwrite real on-disk usage with zeros.
        // Fail-loud: log, leave _loaded=false, record _loadError so
        // enforceCap() refuses cloud calls until the file is fixed.
        this._loadError = err;
        this._logger.error('[ai] costTracker load failed; refusing to start fresh', {
          error: err.message
        });
        throw err;
      }
      this._loaded = true;
      this._loadError = null;
    })();
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  // Health snapshot for IPC GET_USAGE / status indicators.
  getHealth() {
    return {
      loaded: this._loaded,
      loadError: this._loadError ? this._loadError.message : null,
      persistFailureCount: this._persistFailureCount,
      degraded: !this._loaded || this._persistFailureCount > 0
    };
  }

  /** @param {{ provider: string, model: string, inputTokens?: number, outputTokens?: number }} args */
  async recordUsage({ provider, model, inputTokens = 0, outputTokens = 0 }) {
    if (provider === 'local') return; // intentional no-op

    // Serialize all recordUsage operations through a single-flight chain.
    // Two parallel calls would otherwise both read the same pre-call totals
    // and one of the two _persist writes would overwrite the other.
    // Use .then(task, task) so a transient ENOSPC on one call doesn't
    // permanently deadlock subsequent calls.
    const task = async () => {
      if (!this._loaded) await this.load();
      // Read baseUrl INSIDE the chain so estimateCost sees the current value
      // even if settings changed between enqueue and execute. Self-hosted
      // endpoints (Ollama, LM Studio, vLLM via openaiCompatible) bill at $0
      // instead of UNKNOWN_MODEL_PRICING.
      const baseUrl = (() => {
        try {
          return this._getSettings()?.providers?.[provider]?.baseUrl || null;
        } catch {
          return null;
        }
      })();

      const key = _monthKey(this._now());
      const month = this._data[key] || {};
      const prevEntry = month[provider];
      // Snapshot the previous totals before mutation so we can roll back if
      // _persist fails. Without this, a failed persist leaves the in-memory
      // counters incremented but the on-disk file unchanged — the next
      // recordUsage call adds the same delta AGAIN, double-counting it
      // when the eventual persist succeeds.
      const snapshot = prevEntry
        ? { ...prevEntry }
        : { inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
      const entry = { ...snapshot };

      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.estCostUsd += CostTracker.estimateCost({
        provider,
        model,
        inputTokens,
        outputTokens,
        baseUrl
      });

      month[provider] = entry;
      this._data[key] = month;

      try {
        await this._persist();
        // Persist succeeded: clear the consecutive-failure counter.
        this._persistFailureCount = 0;
      } catch (err) {
        // Roll the in-memory mutation back so the next recordUsage call
        // doesn't double-count this one when its persist eventually
        // succeeds. Without this, a transient ENOSPC / EACCES leaves the
        // counter in a broken state where the same usage is re-added on
        // every retry.
        if (prevEntry) {
          month[provider] = snapshot;
        } else {
          delete month[provider];
          if (Object.keys(month).length === 0) {
            delete this._data[key];
          }
        }
        // Track consecutive persist failures so enforceCap can fail-closed
        // on cloud calls instead of letting silent persist failures bypass
        // the cap by leaving _data behind on-disk.
        this._persistFailureCount += 1;
        // Sanitize the error before logging — fs errors can include
        // absolute paths.
        const sanitized = String(err.message || err).replace(/[A-Z]:\\[^\s]+/gi, '<path>');
        this._logger.error('[ai] costTracker persist failed; usage rolled back', {
          provider,
          consecutiveFailures: this._persistFailureCount,
          error: sanitized
        });
        throw err;
      }
    };
    const next = this._writeChain.then(task, task);
    // Don't let a failure in one record poison subsequent calls.
    this._writeChain = next.catch(() => {});
    return next;
  }

  getMonthlyUsage() {
    return this._data;
  }

  /**
   * Pre-call cap enforcement. Throws BUDGET_EXCEEDED when the running monthly
   * spend for `provider` is already at or above the configured cap. This is
   * intentionally a "soft pre-check" — we do not estimate the upcoming call's
   * cost, because input length is known but output length is not. Once spend
   * crosses the cap on a call, the next call is blocked.
   */
  /**
   * Synchronous best-effort cap check. Reads in-memory _data without queuing
   * through the write chain, so two parallel callers can both pass even when
   * the second call would push spend over the cap.
   *
   * Prefer `enforceCapAtomic` for new code — it queues through _writeChain so
   * the check observes all committed recordUsage writes ahead of it. This sync
   * variant remains for callers that genuinely need a synchronous answer
   * (e.g. cost-display in UI snapshots) and accept the race-window trade-off.
   */
  /** @param {{ provider: string }} args */
  enforceCap({ provider }) {
    if (provider === 'local') return;
    this._enforceCapImpl(provider);
  }

  /**
   * Atomic cap check: queues through the same single-flight chain as
   * recordUsage so the check observes all prior writes. Concurrent callers
   * serialize; the second-in-line sees the first's recorded spend and can
   * fail-closed on its own pre-call check rather than racing past it.
   *
   * The chain serialization does NOT prevent a single call from exceeding the
   * cap by its own delta (output tokens are unknown until the LLM responds);
   * it prevents the multi-call race where N parallel callers each see "still
   * under cap" and collectively exceed it by ~N call-widths.
   *
   * @param {{ provider: string }} args
   * @returns {Promise<void>}
   */
  async enforceCapAtomic({ provider }) {
    if (provider === 'local') return;
    const task = async () => {
      // Ensure load completes before reading _data.
      if (!this._loaded) await this.load();
      this._enforceCapImpl(provider);
    };
    const next = this._writeChain.then(task, task);
    // Don't poison the chain on rejection (BUDGET_EXCEEDED is expected flow).
    this._writeChain = next.catch(() => {});
    return next;
  }

  _enforceCapImpl(/** @type {any} */ provider) {
    const cap = this._getSettings()?.providers?.[provider]?.spendCapMonthlyUsd;
    if (cap === undefined || cap === null) return;
    if (typeof cap !== 'number' || cap < 0) return;

    // Fail-closed when the tracker is degraded: a corrupt JSON file (load
    // failure) or repeated persist failures mean _data may not reflect
    // actual spend. Letting the call through could exceed the cap silently.
    // The threshold of 3 consecutive persist failures tolerates transient
    // FS hiccups while still blocking persistent breakage.
    if (this._loadError) {
      throw new AIProviderError(
        'BUDGET_EXCEEDED',
        `Spend tracking unavailable (load failed). Cap cannot be verified for ${provider}.`
      );
    }
    if (this._persistFailureCount >= 3) {
      throw new AIProviderError(
        'BUDGET_EXCEEDED',
        `Spend tracking degraded (${this._persistFailureCount} consecutive persist failures). Cap cannot be verified for ${provider}.`
      );
    }

    const key = _monthKey(this._now());
    const spent = this._data[key]?.[provider]?.estCostUsd || 0;
    if (spent >= cap) {
      throw new AIProviderError(
        'BUDGET_EXCEEDED',
        `Monthly spend cap reached for ${provider} ($${cap}). Disable the cap or wait until next month.`
      );
    }
  }

  async _persist() {
    const dir = path.dirname(this._filePath);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      // Non-fatal: directory may already exist or filesystem is mocked
    }
    const tempPath = `${this._filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    let handle;
    try {
      handle = await fsp.open(tempPath, 'w');
      await handle.writeFile(JSON.stringify(this._data, null, 2), 'utf8');
      try {
        await handle.sync();
      } catch {
        // Some filesystems don't support fsync; best-effort durability
      }
      await handle.close();
      handle = null;
      await fsp.rename(tempPath, this._filePath);
    } catch (err) {
      if (handle) {
        await swallow(handle.close(), this._logger, 'cleanup:costTracker.handle');
      }
      await swallow(fsp.unlink(tempPath), this._logger, 'cleanup:costTracker.tempPath');
      throw err;
    }
  }
}

module.exports = { CostTracker, PRICING_PER_M_TOKENS };
