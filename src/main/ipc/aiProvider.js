// @ts-check
'use strict';

const path = require('node:path');
const { app, dialog } = require('electron');
const { getEnvBool } = require('../../shared/configDefaults');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { registerHandlers, safeSendToMain } = require('./ipcWrappers');
const { IPC_EVENTS } = require('../../shared/constants');
const { schemas } = require('./validationSchemas');
const { container, ServiceIds } = require('../services/ServiceContainer');
const { createLogger } = require('../../shared/logger');
const {
  CLOUD_PROVIDERS,
  hasCloudConsent,
  settingsRequireCloudConsent
} = require('../services/ai/schemas');
const {
  defaultAiSettings,
  mergeAiSettings,
  sanitizeAiSettings
} = require('../services/ai/aiSettings');
const { AI_ROUTED_OPERATIONS } = require('../../shared/aiProviderRouting');

// Analysis and suggestions ask the router once per file, so an unavailable
// per-operation provider would otherwise raise one toast per file.
const OVERRIDE_NOTICE_INTERVAL_MS = 60_000;
/** @type {Map<string, number>} */
const _operationOverrideNoticeAt = new Map();

/** @typedef {import('../services/ai/aiSettings').AiSettings} AiSettings */

// Module-scope logger so error paths in module-level helpers (notably _fail)
// can record breadcrumbs even before registerAiProviderIpc runs / outside its
// closure. The per-registration `logger` from context.core remains the
// preferred logger inside handlers.
const _moduleLogger = createLogger('aiProvider');

// Lazy-loaded so unrelated IPC tests don't pull in the AI service tree.
/** @type {import('../services/ai/AIRouter').AIRouter | null} */
let _router = null;
/** @type {import('../services/ai/AIKeyStore').AIKeyStore | null} */
let _keyStore = null;
/** @type {Record<string, any> | null} */
let _providers = null;
/** @type {import('../services/ai/costTracker').CostTracker | null} */
let _costTracker = null;
/** @type {string[]} */
let _registeredChannels = [];
/** @type {((event: import('electron').Event) => void) | null} */
let _willQuitHandler = null;
let _disposing = false;
let _settingsWriteQueue = Promise.resolve();
let _llamaReadyListenerAttached = false;

// Generic provider error → safe error envelope. Never echo raw provider error
// messages: they may include API keys (Authorization header) or auth tokens.
// We map AIProviderError codes to user-readable strings; everything else is a
// generic "provider error" with the code only.
/** @type {Readonly<Record<string, string>>} */
const _SAFE_ERROR_MESSAGES = Object.freeze({
  AUTH_FAILED: 'Authentication failed. Check the API key and try again.',
  RATE_LIMITED: 'Rate limit reached. Try again later.',
  NETWORK_ERROR: 'Could not reach the provider. Check your network and try again.',
  CONTENT_TOO_LONG: 'Request too large for the provider.',
  BUDGET_EXCEEDED: 'Monthly spend cap reached. Adjust the cap or wait until next month.',
  PROVIDER_DISABLED: 'This provider is not enabled.',
  NO_PROVIDER_READY: 'No AI provider is ready. Configure one in Settings → AI.',
  PROVIDER_FAILED: 'The provider returned an error. Try again or switch providers.',
  INVALID_RESPONSE: 'The provider returned an unexpected response.'
});

function _ok(extra = {}) {
  return { success: true, ...extra };
}

function _consentRequired() {
  return {
    success: false,
    error: 'CONSENT_REQUIRED',
    code: 'CONSENT_REQUIRED',
    errorCode: 'CONSENT_REQUIRED'
  };
}

/** @param {any} err */
function _fail(err) {
  // Always log the underlying error before redacting it for the renderer.
  // Without this trail, any failure on the 10+ call sites that funnel through
  // _fail surfaces as the literal string "AI provider error." with no
  // breadcrumb — turning user reports of "AI doesn't work" into
  // un-reproducible mysteries. The log captures the real shape (code, name,
  // message) without exposing it to the renderer.
  try {
    _moduleLogger.error('[aiProvider] _fail called', {
      message: err?.message,
      name: err?.name,
      code: err?.code,
      errorCode: err && err.name === 'AIProviderError' ? err.code : 'PROVIDER_FAILED'
    });
  } catch {
    /* logger must never re-throw from an error path */
  }

  // AIProviderError carries a typed code we can safely surface; everything else
  // is mapped to a generic message so secrets in raw error strings can't leak.
  if (err && err.name === 'AIProviderError' && err.code) {
    const safeMessage = _SAFE_ERROR_MESSAGES[err.code] || 'AI provider error.';
    return { success: false, error: safeMessage, errorCode: err.code };
  }
  return { success: false, error: 'AI provider error.', errorCode: 'PROVIDER_FAILED' };
}

/**
 * Native confirmation for cloud consent; true when the user confirms. The
 * renderer's consent modal explains the trust model, but the record itself is
 * written only after this dialog, so a renderer alone cannot turn cloud
 * routing on. Unpackaged runs under STRATOSORT_E2E skip the dialog (Playwright
 * cannot drive native dialogs); a missing dialog API fails closed.
 * @param {(() => any)|null|undefined} getMainWindow
 * @param {any} logger
 * @returns {Promise<boolean>}
 */
async function _confirmCloudConsentInMain(getMainWindow, logger) {
  if (!app?.isPackaged && getEnvBool('STRATOSORT_E2E')) {
    logger?.info?.('[ai] cloud consent confirmed without a dialog under STRATOSORT_E2E');
    return true;
  }
  if (typeof dialog?.showMessageBox !== 'function') {
    logger?.warn?.('[ai] cloud consent refused: no dialog available to confirm it');
    return false;
  }
  /** @type {import('electron').MessageBoxOptions} */
  const options = {
    type: 'question',
    buttons: ['Enable cloud AI', 'Keep local'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Enable cloud AI?',
    message: 'Send file text to the cloud AI provider you configure?',
    detail:
      'Document analysis, chat and organization suggestions can each be sent to that provider. Embeddings, search and image pixels stay on this computer. You can switch any of them back to local in Settings → AI Provider.'
  };
  try {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const result =
      win && !win.isDestroyed?.()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return result?.response === 0;
  } catch (err) {
    logger?.warn?.('[ai] cloud consent dialog failed; consent not recorded', {
      error: err?.message
    });
    return false;
  }
}

/** @param {string} name */
function _defaultProviderConfig(name) {
  return defaultAiSettings().providers[name] || {};
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerAiProviderIpc(servicesOrParams) {
  const context =
    servicesOrParams instanceof IpcServiceContext
      ? servicesOrParams
      : createFromLegacyParams(servicesOrParams);

  const { ipcMain, IPC_CHANNELS, logger } = context.core;
  const settingsService =
    /** @type {Record<string, any>} */ (context).settingsService ||
    context._settings?.settingsService ||
    null;
  const getMainWindow = context.electron?.getMainWindow || null;
  const { getServiceIntegration } = context;

  // ---- Settings access -------------------------------------------------------

  // settings.json is user-editable, so the stored blob is repaired field-wise
  // on every read (bad baseUrl → provider disabled, cloud routing without
  // consent → local). The warning is de-duplicated so the hot routing path
  // does not log on every call.
  let _lastSanitizeWarning = '';
  /** @returns {AiSettings} */
  const getAiSettings = () => {
    let stored;
    try {
      stored = settingsService?.get?.('ai');
    } catch (err) {
      logger.warn('[ai] failed to read settings; using defaults', { error: err.message });
      return defaultAiSettings();
    }
    if (!stored || typeof stored !== 'object') return defaultAiSettings();
    const { settings, issues } = sanitizeAiSettings(mergeAiSettings(defaultAiSettings(), stored));
    const warning = issues.join('; ');
    if (warning && warning !== _lastSanitizeWarning) {
      _lastSanitizeWarning = warning;
      logger.warn('[ai] stored AI settings repaired on read', { issues });
    }
    return settings;
  };

  // Serialized settings writes — prevents the renderer's debounced auto-save
  // from clobbering an in-flight SET_PROVIDER_CONFIG / SET_ROUTING write
  // (read full settings → spread ai → write back race window).
  /** @param {AiSettings} next */
  const setAiSettings = async (next) => {
    if (!settingsService) {
      logger.warn('[ai] no settingsService available; settings not persisted');
      return;
    }
    const task = async () => {
      let current = {};
      try {
        if (typeof settingsService.load === 'function') {
          current = (await settingsService.load()) || {};
        } else if (typeof settingsService.getAll === 'function') {
          current = settingsService.getAll() || {};
        }
      } catch (err) {
        // CRITICAL: do NOT proceed with empty current. The previous behavior
        // here was to swallow the load error and save({ ...current={}, ai:next })
        // — which OVERWRITES the entire settings file (smartFolders, ui,
        // llama config, etc.) with just the ai key plus defaults. A transient
        // EBUSY / EACCES / corrupt JSON would silently wipe the user's
        // settings. Throw so the caller's catch can surface it instead.
        logger.error('[ai] settings load failed; aborting save to prevent data loss', {
          error: err?.message,
          code: err?.code
        });
        throw err;
      }
      try {
        await settingsService.save({ ...current, ai: next });
      } catch (err) {
        // SettingsService now hard-rejects save() during shutdown with
        // code='SETTINGS_SHUTDOWN'. The renderer's debounced auto-save chain
        // and our own IPC handlers may both fire during quit; treat the
        // shutdown rejection as a benign no-op (the user is leaving) instead
        // of letting it surface as an unhandled rejection.
        if (err && err.code === 'SETTINGS_SHUTDOWN') {
          logger.debug('[ai] settings save skipped (service shutting down)');
          return;
        }
        throw err;
      }
    };
    // Chain onto the queue so concurrent calls serialize.
    const next$ = _settingsWriteQueue.then(task, task);
    // why-silent: a rejection in the queue head MUST not poison the chain
    // (it would deadlock all subsequent settings writes for the process
    // lifetime). The original error already surfaced via `next$`'s own
    // rejection — the caller receives it via `return next$` below — so we
    // log here at warn level for ops visibility without re-propagating.
    _settingsWriteQueue = next$.catch((err) => {
      logger.warn?.('[ai] settings-write-chain rejection (chain continues)', {
        error: err?.message
      });
    });
    return next$;
  };

  // ---- Lazy service construction ---------------------------------------------

  const ensureKeyStore = () => {
    if (_keyStore) return _keyStore;

    const { AIKeyStore } = require('../services/ai/AIKeyStore');
    _keyStore = new AIKeyStore({ logger });
    return _keyStore;
  };

  const ensureCostTracker = () => {
    if (_costTracker) return _costTracker;
    const { CostTracker } = require('../services/ai/costTracker');
    let userDataPath;
    try {
      userDataPath = app.getPath('userData');
    } catch {
      userDataPath = '.';
    }
    _costTracker = new CostTracker(
      /** @type {any} */ ({
        filePath: path.join(userDataPath, 'ai-cost-tracker.json'),
        getSettings: getAiSettings,
        logger
      })
    );
    // Log at error level — costTracker now stores _loadError internally so
    // enforceCap fails closed on cloud calls until the file is repaired.
    // The renderer surfaces this via GET_USAGE health field.
    _costTracker.load().catch((err) => {
      logger.error('[ai] costTracker initial load failed; cap enforcement degraded', {
        error: err.message
      });
    });
    return _costTracker;
  };

  // Disposes only the cached provider instances (not the keystore or tracker)
  // so the next ensureRouter() rebuilds with current settings (model/baseUrl).
  // Triggered after SET_PROVIDER_CONFIG so changes to model/baseUrl take effect
  // without an app restart.
  const rebuildProviders = () => {
    _router = null;
    _providers = null;
  };

  const ensureRouter = () => {
    if (_router) return _router;

    const { AIRouter } = require('../services/ai/AIRouter');
    const { LocalLlamaProvider } = require('../services/ai/providers/LocalLlamaProvider');
    const { AnthropicProvider } = require('../services/ai/providers/AnthropicProvider');
    const {
      OpenAICompatibleProvider
    } = require('../services/ai/providers/OpenAICompatibleProvider');

    const integration = getServiceIntegration && getServiceIntegration();
    const diContainer = integration?.container || container;
    /** @param {string} id */
    const safeResolve = (id) => {
      try {
        return diContainer.resolve(id);
      } catch {
        return null;
      }
    };
    const llamaService = safeResolve(ServiceIds.LLAMA_SERVICE);
    const keyStore = ensureKeyStore();
    const costTracker = ensureCostTracker();
    const settings = getAiSettings();

    _providers = {
      local: new LocalLlamaProvider(llamaService),
      anthropic: new AnthropicProvider({
        getKey: () => keyStore.get('anthropic'),
        model: settings.providers.anthropic?.model,
        costTracker,
        logger
      }),
      openaiCompatible: new OpenAICompatibleProvider({
        getKey: () => keyStore.get('openaiCompatible'),
        model: settings.providers.openaiCompatible?.model,
        baseUrl: settings.providers.openaiCompatible?.baseUrl,
        displayName: settings.providers.openaiCompatible?.displayName,
        costTracker,
        logger
      })
    };

    _router = new AIRouter({ providers: _providers, getSettings: getAiSettings, logger });
    _router.on('routing-changed', () => {
      safeSendToMain(getMainWindow, IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED, _routerStatus());
    });
    _router.on('folder-override-unavailable', (payload) => {
      const providerLabel = payload?.configuredProvider || 'cloud';
      safeSendToMain(getMainWindow, IPC_EVENTS.NOTIFICATION, {
        message: `Smart folder AI override (${providerLabel}) is unavailable — using local model.`,
        severity: 'warning',
        duration: 8000,
        source: 'ai-provider',
        type: 'folder-override-unavailable'
      });
    });
    _router.on('operation-override-unavailable', (payload) => {
      const key = `${payload?.operation}:${payload?.configuredProvider}`;
      const now = Date.now();
      if (now - (_operationOverrideNoticeAt.get(key) || 0) < OVERRIDE_NOTICE_INTERVAL_MS) return;
      _operationOverrideNoticeAt.set(key, now);
      const operationLabel =
        AI_ROUTED_OPERATIONS.find((op) => op.id === payload?.operation)?.label ||
        payload?.operation ||
        'This operation';
      const providerLabel =
        _providers?.[payload?.configuredProvider]?.displayName ||
        payload?.configuredProvider ||
        'the chosen provider';
      safeSendToMain(getMainWindow, IPC_EVENTS.NOTIFICATION, {
        message: `${operationLabel} is set to ${providerLabel}, which is not ready. Using the local model.`,
        severity: 'warning',
        duration: 8000,
        source: 'ai-provider',
        type: 'operation-override-unavailable'
      });
    });

    if (llamaService && !_llamaReadyListenerAttached) {
      const pushLocalReadyStatus = () => {
        try {
          safeSendToMain(getMainWindow, IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED, _routerStatus());
        } catch (err) {
          logger.debug('[ai] failed to push local ready status', { error: err?.message });
        }
      };
      llamaService.on('initialized', pushLocalReadyStatus);
      llamaService.on('model-change', pushLocalReadyStatus);
      _llamaReadyListenerAttached = true;
    }

    return _router;
  };

  const _routerStatus = () => {
    const router = ensureRouter();
    const settings = getAiSettings();
    return {
      providers: router.listProviders(),
      routing: settings.routing,
      consent: { acknowledgedCloudAt: settings.consent?.acknowledgedCloudAt || null }
    };
  };

  // keyStore.get() is async; provider.ready() is sync and only warms the cache
  // in the background. After SET_KEY we must await the key and set _readyCache
  // before listProviders() / STATUS_CHANGED, or Settings stays at ready:false
  // even though the key is stored.
  /** @param {string} providerName */
  const _syncProviderReadyCache = async (providerName) => {
    ensureRouter();
    const provider = _providers?.[providerName];
    if (!provider || !('_readyCache' in provider)) return;

    if (providerName === 'openaiCompatible' && !provider._baseUrl) {
      provider._readyCache = false;
      return;
    }

    if (typeof provider._getKey !== 'function') return;

    let key;
    try {
      key = await provider._getKey();
    } catch {
      key = null;
    }
    provider._readyCache = typeof key === 'string' && key.length > 0;
  };

  const _syncAllCloudProviderReadyCaches = async () => {
    for (const name of CLOUD_PROVIDERS) {
      await _syncProviderReadyCache(name);
    }
  };

  const _notifyRouterStatusChanged = async () => {
    ensureRouter();
    await _syncAllCloudProviderReadyCaches();
    _router.notifySettingsChanged();
    return _routerStatus();
  };

  // Eager init: AIRouter must exist before any document analysis so callers
  // (documentLlm.js, ChatService.js) that read getActiveAiRouter() at boot get
  // the configured cloud routing rather than silently falling through to local.
  try {
    ensureRouter();
  } catch (err) {
    logger.warn('[ai] eager router init deferred', { error: err.message });
  }

  // ---- IPC handlers (registerHandlers wires Zod validation + sender check) ---

  /** @type {Record<string, import('./ipcWrappers').HandlerConfig>} */
  const handlerMap = {
    [IPC_CHANNELS.AI_PROVIDER.GET_CONFIG]: {
      schema: schemas.aiProviderGetConfig,
      handler: async () => {
        try {
          ensureRouter();
          await _syncAllCloudProviderReadyCaches();
          const settings = getAiSettings();
          return _ok({ settings, status: _routerStatus() });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.SET_PROVIDER_CONFIG]: {
      schema: schemas.aiProviderSetProviderConfig,
      handler: async (_e, args) => {
        try {
          const cur = getAiSettings();
          // Cloud-consent enforcement: ANY change to a cloud provider's config
          // (model, baseUrl, enabled, spend cap) requires the user to have
          // acknowledged cloud routing first. Without this, a renderer could
          // set baseUrl='https://attacker.example' (without tripping the gate
          // because enabled stays undefined), then save a key and TEST_PROVIDER
          // would exfiltrate the key to that URL even though routing.default
          // remained 'local'.
          //
          // Exception: clearing the config (enabled=false with no other fields)
          // should be allowed so a user can disable cloud without first
          // re-acknowledging consent.
          const isCloud = CLOUD_PROVIDERS.includes(args.provider);
          const isClearingOnly =
            args.config && Object.keys(args.config).length === 1 && args.config.enabled === false;
          if (isCloud && !isClearingOnly && !hasCloudConsent(cur)) {
            return _consentRequired();
          }
          const existing = cur.providers[args.provider] || _defaultProviderConfig(args.provider);
          // spendCapMonthlyUsd: null clears the cap. The stored schema has no
          // null, so the key is removed rather than written.
          const incoming = { ...args.config };
          const clearSpendCap = incoming.spendCapMonthlyUsd === null;
          if (clearSpendCap) delete incoming.spendCapMonthlyUsd;
          const nextProvider = { ...existing, ...incoming };
          if (clearSpendCap) delete nextProvider.spendCapMonthlyUsd;
          const merged = {
            ...cur,
            providers: {
              ...cur.providers,
              [args.provider]: nextProvider
            }
          };
          await setAiSettings(merged);
          // Provider model/baseUrl is captured at construction; rebuild so
          // user changes take effect without an app restart.
          rebuildProviders();
          const status = await _notifyRouterStatusChanged();
          return _ok({ status });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.SET_KEY]: {
      schema: schemas.aiProviderSetKey,
      handler: async (_e, args) => {
        try {
          // Storing a key for a cloud provider is itself a cloud-AI action.
          // Without this gate, an attacker who got SET_PROVIDER_CONFIG to
          // accept a malicious baseUrl (closed elsewhere, but defense in
          // depth) could save a key and use TEST_PROVIDER to exfiltrate it.
          if (CLOUD_PROVIDERS.includes(args.provider) && !hasCloudConsent(getAiSettings())) {
            return _consentRequired();
          }
          const result = await ensureKeyStore().set(args.provider, args.key, {
            allowPlaintext: args.allowPlaintext === true
          });
          const status = await _notifyRouterStatusChanged();
          // result.encryption is 'safeStorage' or 'plaintext'; the renderer
          // uses this to surface a "key stored unprotected" warning.
          return _ok({ encryption: result?.encryption, status });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.GET_KEY_STATUS]: {
      schema: schemas.aiProviderGetKeyStatus,
      handler: async (_e, args) => {
        try {
          const status = await ensureKeyStore().status(args.provider);
          return _ok(status);
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.REMOVE_KEY]: {
      schema: schemas.aiProviderRemoveKey,
      handler: async (_e, args) => {
        try {
          await ensureKeyStore().remove(args.provider);
          const status = await _notifyRouterStatusChanged();
          return _ok({ status });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.TEST_PROVIDER]: {
      schema: schemas.aiProviderTestProvider,
      handler: async (_e, args) => {
        try {
          // Test calls invoke provider.analyze() directly, bypassing the
          // router. Without a consent check here, an attacker who has set a
          // malicious baseUrl + a key (despite the gate at SET_PROVIDER_CONFIG
          // and SET_KEY) could still trigger an outbound request that leaks
          // the bearer key. Defense in depth.
          if (CLOUD_PROVIDERS.includes(args.provider) && !hasCloudConsent(getAiSettings())) {
            return _consentRequired();
          }
          const router = ensureRouter();
          const provider = router._providers[args.provider];
          if (!provider) return _fail(new Error(`unknown provider ${args.provider}`));

          // For cloud providers, await the key directly and decide locally
          // — DO NOT poke provider._readyCache. A previous fix wrote to the
          // cache here, but if `_refreshReadyAsync` had a stale promise in
          // flight it would overwrite our value moments later, racing the
          // subsequent provider.ready() read. Local providers (no _getKey)
          // fall through to ready() which checks the underlying service.
          if (typeof provider._getKey === 'function') {
            let key = null;
            try {
              key = await provider._getKey();
            } catch {
              /* treat as missing key */
            }
            if (!key || String(key).length === 0) {
              return _fail({
                name: 'AIProviderError',
                code: 'AUTH_FAILED',
                message: 'Provider not ready (missing key or service)'
              });
            }
          } else {
            // Local provider: trust ready().
            const isReady = await provider.ready();
            if (!isReady) {
              return _fail({
                name: 'AIProviderError',
                code: 'AUTH_FAILED',
                message: 'Provider not ready (missing key or service)'
              });
            }
          }
          const start = Date.now();
          const result = await provider.analyze('Reply with the single word "OK".', {});
          // Return both `success` (envelope contract) AND `ok` for backwards
          // compat with any renderer code branching on `ok`.
          return _ok({
            ok: true,
            latencyMs: Date.now() - start,
            sample: (result.text || '').slice(0, 40)
          });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.GET_USAGE]: {
      schema: schemas.aiProviderGetUsage,
      handler: async () => {
        try {
          const tracker = ensureCostTracker();
          // Don't await load() — if it failed at boot, _loadError is set and
          // we want to return health info instead of re-throwing here.
          if (!tracker._loaded && !tracker._loadError) {
            try {
              await tracker.load();
            } catch {
              // Health below will reflect the failure.
            }
          }
          const all = /** @type {Record<string, any>} */ (tracker.getMonthlyUsage());
          const now = new Date();
          const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
          const month = all[monthKey] || {};
          const zero = { inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
          return _ok({
            thisMonth: {
              anthropic: month.anthropic || zero,
              openaiCompatible: month.openaiCompatible || zero
            },
            // Health surfaces tracker degradation so the renderer can warn
            // the user when cap enforcement is unreliable.
            health: tracker.getHealth()
          });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.SET_ROUTING]: {
      schema: schemas.aiProviderSetRouting,
      handler: async (_e, args) => {
        try {
          const cur = getAiSettings();
          let nextPerFolder = cur.routing.perFolder;
          if (args.perFolder) {
            const merged = { ...cur.routing.perFolder, ...args.perFolder };
            nextPerFolder = {};
            for (const [folderId, providerName] of Object.entries(merged)) {
              if (providerName !== null && providerName !== undefined) {
                nextPerFolder[folderId] = providerName;
              }
            }
          }
          let nextPerOperation = cur.routing.perOperation || {};
          if (args.perOperation) {
            const merged = { ...nextPerOperation, ...args.perOperation };
            nextPerOperation = {};
            for (const [operation, providerName] of Object.entries(merged)) {
              if (providerName !== null && providerName !== undefined) {
                nextPerOperation[operation] = providerName;
              }
            }
          }
          const mergedSettings = {
            ...cur,
            routing: {
              default: args.default ?? cur.routing.default,
              perOperation: nextPerOperation,
              perFolder: nextPerFolder
            }
          };
          // Cloud-consent enforcement: any cloud choice (default, per-operation
          // or per-folder) requires the user to have acknowledged cloud routing.
          // Without this, a misbehaving renderer could route private documents
          // to cloud after the user explicitly chose default=local.
          if (settingsRequireCloudConsent(mergedSettings) && !hasCloudConsent(cur)) {
            return _consentRequired();
          }
          await setAiSettings(mergedSettings);
          const status = await _notifyRouterStatusChanged();
          return _ok({ status });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.AI_PROVIDER.ACKNOWLEDGE_CLOUD]: {
      schema: schemas.aiProviderAcknowledgeCloud,
      handler: async () => {
        try {
          const confirmed = await _confirmCloudConsentInMain(getMainWindow, logger);
          if (!confirmed) {
            return {
              success: false,
              error: 'Cloud AI was not enabled.',
              code: 'CONSENT_DECLINED',
              errorCode: 'CONSENT_DECLINED'
            };
          }
          const cur = getAiSettings();
          const next = {
            ...cur,
            consent: { ...cur.consent, acknowledgedCloudAt: new Date().toISOString() }
          };
          await setAiSettings(next);
          const status = await _notifyRouterStatusChanged();
          return _ok({ status });
        } catch (e) {
          return _fail(e);
        }
      }
    }
  };

  registerHandlers({
    ipcMain,
    logger,
    context: 'AIProvider',
    handlers: handlerMap
  });
  _registeredChannels = Object.keys(handlerMap);

  // Use will-quit so the async dispose actually completes before exit. The
  // _disposing flag short-circuits a re-entry if a second listener also
  // preventDefault'd. Listener is removable so HMR / test cycles can fully
  // re-init without leaking handlers.
  _willQuitHandler = (event) => {
    if (_disposing) return;
    _disposing = true;
    event.preventDefault();
    disposeAiProvider()
      .then(() => app.quit())
      .catch(() => app.quit());
  };
  app.on('will-quit', _willQuitHandler);
}

async function disposeAiProvider() {
  // Remove IPC handlers so registerAiProviderIpc() is safe to call again
  // (HMR, test cycles, repeated init flows). Without this the second call
  // throws "Attempted to register a second handler for ...".
  try {
    const { ipcMain } = require('electron');
    for (const channel of _registeredChannels) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* may already be removed */
      }
    }
  } catch {
    /* defensive: ipcMain may not be available in some test contexts */
  }
  _registeredChannels = [];

  if (_willQuitHandler) {
    try {
      app.removeListener('will-quit', _willQuitHandler);
    } catch {
      /* defensive */
    }
    _willQuitHandler = null;
  }

  _router = null;
  _keyStore = null;
  _providers = null;
  _costTracker = null;
  _disposing = false;
}

// Exposed for other modules (operation services in T16/T17/T18) to consume the same router.
function getActiveAiRouter() {
  return _router;
}

module.exports = registerAiProviderIpc;
module.exports.disposeAiProvider = disposeAiProvider;
module.exports.getActiveAiRouter = getActiveAiRouter;
