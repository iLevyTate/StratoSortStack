// @ts-check
'use strict';
const { EventEmitter } = require('node:events');
const { AIProviderError } = require('./errors');
const { CLOUD_PROVIDERS, hasCloudConsent } = require('./schemas');

class AIRouter extends EventEmitter {
  /** @param {{ providers: Record<string, any>, getSettings: (...args: any[]) => any, logger?: any }} deps */
  constructor({ providers, getSettings, logger }) {
    super();
    if (!providers || typeof providers !== 'object') {
      throw new Error('AIRouter: providers map is required');
    }
    if (typeof getSettings !== 'function') {
      throw new Error('AIRouter: getSettings function is required');
    }
    this._providers = providers;
    this._getSettings = getSettings;
    this._logger = logger || { info: () => {}, warn: () => {}, error: () => {} };
  }

  /**
   * Pick a provider for a given operation. Precedence: the smart-folder
   * override (analysis of a file already under that folder), then the
   * per-operation choice (routing.perOperation[operation]), then
   * routing.default, then local when fallback is allowed.
   * @param {{ operation?: string, smartFolderId?: string, allowFallback?: boolean, silent?: boolean }} [args]
   * @returns {any}
   */
  choose({ operation, smartFolderId, allowFallback = true, silent = false } = {}) {
    if (!operation) throw new Error('AIRouter: operation is required');
    const settings = this._getSettings();
    const log = silent ? { info: () => {}, warn: () => {}, error: () => {} } : this._logger;

    // 1. Per-folder override
    if (smartFolderId && settings.routing?.perFolder?.[smartFolderId]) {
      const overrideName = settings.routing.perFolder[smartFolderId];
      const provider = this._providers[overrideName];
      if (this._isAvailable(provider, settings, overrideName)) {
        return provider;
      }
      const reason = this._unavailableReason(provider, settings, overrideName);
      log.warn('[ai] folder override unavailable; falling through to default', {
        folderId: smartFolderId,
        configured: overrideName,
        reason,
        operation
      });
      // Emit a structured event so the renderer can show the user a
      // banner/toast about the silent degrade — previously this was logged
      // only to the main-process JSONL, which users never see, and a folder
      // routed at "anthropic (paid cloud)" would silently flow through the
      // local LLM with no UI signal.
      this.emit('folder-override-unavailable', {
        folderId: smartFolderId,
        configuredProvider: overrideName,
        reason,
        operation
      });
      // Hard error path: when fallback is explicitly disabled the caller is
      // asking us to be strict, so refuse rather than silently slide to
      // default. Renderers and tests use allowFallback=false to surface the
      // misconfiguration to the user immediately.
      if (!allowFallback) {
        throw new AIProviderError(
          'FOLDER_OVERRIDE_UNAVAILABLE',
          `Per-folder provider "${overrideName}" is unavailable: ${reason}.`
        );
      }
    }

    // 2. Per-operation choice. An explicit decision for this kind of work
    // ("chat stays local while analysis goes to Claude"). When the chosen
    // provider is not available the only fallback is local: sliding to a
    // different cloud default would send this operation's text somewhere
    // the user did not pick for it.
    const operationName = settings.routing?.perOperation?.[operation];
    if (operationName) {
      const provider = this._providers[operationName];
      if (this._isAvailable(provider, settings, operationName)) {
        return provider;
      }
      const reason = this._unavailableReason(provider, settings, operationName);
      log.warn('[ai] operation override unavailable; using local', {
        operation,
        configured: operationName,
        reason
      });
      this.emit('operation-override-unavailable', {
        operation,
        configuredProvider: operationName,
        reason
      });
      if (!allowFallback) {
        throw new AIProviderError(
          'OPERATION_OVERRIDE_UNAVAILABLE',
          `Provider "${operationName}" chosen for ${operation} is unavailable: ${reason}.`
        );
      }
      return this._localOrThrow(settings, log, { operation, configured: operationName });
    }

    // 3. Default
    const defaultName = settings.routing?.default;
    const defaultProvider = defaultName ? this._providers[defaultName] : null;
    if (this._isAvailable(defaultProvider, settings, defaultName)) {
      return defaultProvider;
    }

    // 4. Local fallback
    if (allowFallback) {
      const local = this._providers.local;
      if (this._isAvailable(local, settings, 'local')) {
        log.info('[ai] falling back to local', { defaultName, operation });
        return local;
      }
    }

    // 5. Nothing works
    throw new AIProviderError(
      'NO_PROVIDER_READY',
      'No AI provider is ready. Configure a provider in Settings → AI.'
    );
  }

  /** @param {any} settings @param {any} log @param {Record<string, any>} detail */
  _localOrThrow(settings, log, detail) {
    const local = this._providers.local;
    if (this._isAvailable(local, settings, 'local')) {
      log.info('[ai] falling back to local', detail);
      return local;
    }
    throw new AIProviderError(
      'NO_PROVIDER_READY',
      'No AI provider is ready. Configure a provider in Settings → AI.'
    );
  }

  _isAvailable(/** @type {any} */ provider, /** @type {any} */ settings, /** @type {any} */ name) {
    if (!provider || !name) return false;
    const cfg = settings.providers?.[name];
    if (!cfg?.enabled) return false;
    if (CLOUD_PROVIDERS.includes(name) && !hasCloudConsent(settings)) return false;
    return provider.ready();
  }

  // Categorize WHY a provider isn't available so the UI can show actionable
  // messaging ("set up an API key" vs "enable in Settings" vs "unknown").
  _unavailableReason(
    /** @type {any} */ provider,
    /** @type {any} */ settings,
    /** @type {any} */ name
  ) {
    if (!name) return 'no provider name configured';
    if (!provider) return `provider "${name}" is not registered`;
    const cfg = settings.providers?.[name];
    if (!cfg?.enabled) return `provider "${name}" is disabled in Settings → AI`;
    if (!provider.ready()) {
      // The most common ready()=false cause for cloud providers is a missing
      // API key; surface that distinctly.
      return name === 'local' ? 'local model is not loaded' : 'API key is missing or invalid';
    }
    return 'unknown';
  }

  // Read-only variant of choose() that returns the provider id without
  // emitting any logs. Delegates to choose({ silent: true }) so the routing
  // logic can't drift between the two paths — previously this method
  // reimplemented the decision and was missing the local-fallback branch's
  // future cost-cap enforcement.
  /** @param {{ operation?: string, smartFolderId?: string }} [args] */
  previewChoiceId({ operation = 'analyze', smartFolderId } = {}) {
    try {
      const chosen = this.choose({ operation, smartFolderId, silent: true });
      return chosen?.id || null;
    } catch {
      return null;
    }
  }

  notifySettingsChanged() {
    this.emit('routing-changed');
  }

  listProviders() {
    const settings = this._getSettings();
    return Object.entries(this._providers).map(([id, p]) => ({
      id,
      displayName: p.displayName || id,
      enabled: !!settings.providers?.[id]?.enabled,
      ready: !!p.ready()
    }));
  }
}

module.exports = { AIRouter };
