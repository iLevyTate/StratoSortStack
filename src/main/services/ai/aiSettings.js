// @ts-check
'use strict';
const { isDeepStrictEqual } = require('node:util');
const {
  PROVIDER_NAMES,
  CLOUD_PROVIDERS,
  ROUTED_OPERATIONS,
  providerConfigSchema,
  routingSchema,
  consentSchema,
  aiSettingsSchema,
  hasCloudConsent,
  settingsRequireCloudConsent
} = require('./schemas');

/**
 * @typedef {Object} AiSettings
 * @property {Record<string, Record<string, any>>} providers
 * @property {{ default: string, perOperation: Record<string, string>, perFolder: Record<string, string> }} routing
 * @property {Record<string, any>} consent
 */

/** @returns {AiSettings} */
function defaultAiSettings() {
  return {
    providers: {
      local: { enabled: true, displayName: 'Local Llama' },
      anthropic: {
        enabled: false,
        displayName: 'Anthropic Claude',
        model: 'claude-opus-4-7'
      },
      openaiCompatible: {
        enabled: false,
        displayName: 'OpenAI / Custom',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o'
      }
    },
    routing: { default: 'local', perOperation: {}, perFolder: {} },
    consent: {}
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Layered merge where later layers win. Provider entries merge per provider
 * so a partial stored config (e.g. `{ enabled: true }`) keeps its default
 * model/baseUrl/displayName; routing and consent merge shallowly. Non-object
 * sections are ignored rather than spread.
 * @param {...(Record<string, any>|null|undefined)} layers
 * @returns {AiSettings}
 */
function mergeAiSettings(...layers) {
  /** @type {AiSettings} */
  /** @type {AiSettings} */
  const merged = {
    providers: {},
    routing: { default: 'local', perOperation: {}, perFolder: {} },
    consent: {}
  };
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    if (isPlainObject(layer.providers)) {
      for (const [name, config] of Object.entries(layer.providers)) {
        if (!isPlainObject(config)) continue;
        merged.providers[name] = { ...(merged.providers[name] || {}), ...config };
      }
    }
    if (isPlainObject(layer.routing)) {
      merged.routing = { ...merged.routing, ...layer.routing };
    }
    if (isPlainObject(layer.consent)) {
      merged.consent = { ...merged.consent, ...layer.consent };
    }
  }
  return merged;
}

/**
 * Field-wise pass over an object against a Zod object shape: valid fields are
 * kept, invalid or unknown ones are dropped and reported. Keeps every healthy
 * value instead of resetting the whole section on a single bad field.
 * @param {string} label
 * @param {unknown} value
 * @param {Record<string, { safeParse: (v: unknown) => any }>} shape
 * @param {Record<string, any>} base
 * @param {string[]} issues
 * @returns {{ out: Record<string, any>, failed: Set<string> }}
 */
function sanitizeFields(label, value, shape, base, issues) {
  const out = { ...base };
  /** @type {Set<string>} */
  const failed = new Set();
  if (!isPlainObject(value)) {
    if (value !== undefined) issues.push(`${label}: expected an object`);
    return { out, failed };
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(shape, key)) {
      issues.push(`${label}.${key}: unknown field dropped`);
      continue;
    }
    const parsed = shape[key].safeParse(raw);
    if (!parsed.success) {
      failed.add(key);
      issues.push(`${label}.${key}: ${parsed.error?.issues?.[0]?.message || 'invalid'}`);
      continue;
    }
    if (parsed.data === undefined) delete out[key];
    else out[key] = parsed.data;
  }
  return { out, failed };
}

/**
 * Drop the entries of a routing map (perFolder or perOperation) that point
 * at a cloud provider.
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
function stripCloudOverrides(overrides) {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [key, provider] of Object.entries(overrides)) {
    if (!CLOUD_PROVIDERS.includes(provider)) kept[key] = provider;
  }
  return kept;
}

/**
 * Repair a merged AI settings blob that may have been hand-edited or
 * corrupted on disk. Every provider/routing/consent field is validated on its
 * own; a provider whose baseUrl fails the allow-list is reset to the default
 * URL and disabled (a bearer key must never be sent to an unvetted host) and
 * any routing that pointed at it falls back to local, as does cloud routing
 * without a valid past consent timestamp. The result always satisfies
 * aiSettingsSchema.
 * @param {Record<string, any>|null|undefined} merged
 * @returns {{ settings: AiSettings, issues: string[] }}
 */
function sanitizeAiSettings(merged) {
  /** @type {string[]} */
  const issues = [];
  const defaults = defaultAiSettings();
  const source = isPlainObject(merged) ? merged : {};

  /** @type {Record<string, Record<string, any>>} */
  const providers = {};
  /** @type {Set<string>} */
  const disabledByRepair = new Set();
  const sourceProviders = isPlainObject(source.providers) ? source.providers : {};
  for (const name of Object.keys(sourceProviders)) {
    if (!PROVIDER_NAMES.includes(name)) issues.push(`providers.${name}: unknown provider dropped`);
  }
  for (const name of PROVIDER_NAMES) {
    const { out, failed } = sanitizeFields(
      `providers.${name}`,
      sourceProviders[name],
      providerConfigSchema.shape,
      defaults.providers[name],
      issues
    );
    if (failed.has('baseUrl')) {
      out.enabled = false;
      disabledByRepair.add(name);
    }
    providers[name] = out;
  }

  const routing = {
    default: defaults.routing.default,
    perOperation: /** @type {Record<string, string>} */ ({}),
    perFolder: /** @type {Record<string, string>} */ ({})
  };
  if (isPlainObject(source.routing)) {
    const { perFolder: rawPerFolder, perOperation: rawPerOperation, ...scalars } = source.routing;
    const { out } = sanitizeFields(
      'routing',
      scalars,
      { default: routingSchema.shape.default },
      { default: routing.default },
      issues
    );
    routing.default = out.default;
    if (rawPerOperation !== undefined && !isPlainObject(rawPerOperation)) {
      issues.push('routing.perOperation: expected an object');
    } else if (rawPerOperation !== undefined) {
      for (const [operation, provider] of Object.entries(rawPerOperation)) {
        if (!ROUTED_OPERATIONS.includes(operation)) {
          issues.push(`routing.perOperation.${operation}: unknown operation dropped`);
        } else if (typeof provider !== 'string' || !PROVIDER_NAMES.includes(provider)) {
          issues.push(`routing.perOperation.${operation}: unknown provider dropped`);
        } else if (disabledByRepair.has(provider)) {
          issues.push(
            `routing.perOperation.${operation}: provider disabled by repair, override dropped`
          );
        } else {
          routing.perOperation[operation] = provider;
        }
      }
    }
    if (rawPerFolder !== undefined && !isPlainObject(rawPerFolder)) {
      issues.push('routing.perFolder: expected an object');
    } else if (rawPerFolder !== undefined) {
      for (const [folderId, provider] of Object.entries(rawPerFolder)) {
        if (typeof provider !== 'string' || !PROVIDER_NAMES.includes(provider)) {
          issues.push(`routing.perFolder.${folderId}: unknown provider dropped`);
        } else if (disabledByRepair.has(provider)) {
          issues.push(
            `routing.perFolder.${folderId}: provider disabled by repair, override dropped`
          );
        } else {
          routing.perFolder[folderId] = provider;
        }
      }
    }
  } else if (source.routing !== undefined) {
    issues.push('routing: expected an object');
  }
  if (disabledByRepair.has(routing.default)) {
    issues.push(`routing.default: ${routing.default} disabled by repair, reset to local`);
    routing.default = 'local';
  }

  const { out: consent } = sanitizeFields(
    'consent',
    source.consent,
    consentSchema.shape,
    {},
    issues
  );

  /** @type {AiSettings} */
  const settings = { providers, routing, consent };
  if (settingsRequireCloudConsent(settings) && !hasCloudConsent(settings)) {
    issues.push('routing: cloud routing without valid cloud consent reset to local');
    settings.routing = {
      default: 'local',
      perOperation: stripCloudOverrides(routing.perOperation),
      perFolder: stripCloudOverrides(routing.perFolder)
    };
  }

  const verified = aiSettingsSchema.safeParse(settings);
  if (!verified.success) {
    issues.push(`ai: ${verified.error.issues[0]?.message || 'invalid'}; defaults restored`);
    return { settings: defaults, issues };
  }
  return { settings, issues };
}

/**
 * @typedef {{ ok: true, ai: Record<string, any> } | { ok: false, error: string, errorCode: 'AI_SETTINGS_INVALID' | 'CONSENT_REQUIRED', validationErrors?: string[] }} AiSettingsSaveResult
 */

/**
 * Gate for the whole-settings save and import paths, which carry the `ai`
 * blob alongside unrelated keys and therefore bypass the AI_PROVIDER.* IPC
 * handlers. The merged result (defaults ← stored ← incoming) must satisfy
 * aiSettingsSchema, and cloud routing requires consent already on record.
 * Consent is owned by ACKNOWLEDGE_CLOUD: a save can neither grant nor alter
 * it, so the stored value is carried through regardless of what was sent.
 * An incoming blob identical to the stored one is a no-op and never blocks.
 * @param {unknown} incomingAi
 * @param {unknown} storedAi
 * @returns {AiSettingsSaveResult}
 */
function validateAiSettingsForSave(incomingAi, storedAi) {
  if (!isPlainObject(incomingAi)) {
    return {
      ok: false,
      error: 'Invalid AI provider settings: ai must be an object',
      errorCode: 'AI_SETTINGS_INVALID'
    };
  }
  if (isPlainObject(storedAi) && isDeepStrictEqual(incomingAi, storedAi)) {
    return { ok: true, ai: incomingAi };
  }
  const unknownKey = Object.keys(incomingAi).find(
    (key) => !Object.hasOwn(aiSettingsSchema.shape, key)
  );
  if (unknownKey !== undefined) {
    return {
      ok: false,
      error: `Invalid AI provider settings: ai.${unknownKey}: unrecognized key`,
      errorCode: 'AI_SETTINGS_INVALID',
      validationErrors: [`ai.${unknownKey}: unrecognized key`]
    };
  }

  const stored = mergeAiSettings(defaultAiSettings(), storedAi);
  const pinned = { ...incomingAi, consent: stored.consent };
  const merged = mergeAiSettings(stored, pinned);

  const parsed = aiSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const validationErrors = parsed.error.issues.map(
      (issue) => `ai.${issue.path.join('.')}: ${issue.message}`
    );
    return {
      ok: false,
      error: `Invalid AI provider settings: ${validationErrors[0]}`,
      errorCode: 'AI_SETTINGS_INVALID',
      validationErrors
    };
  }
  if (settingsRequireCloudConsent(merged) && !hasCloudConsent(merged)) {
    return { ok: false, error: 'CONSENT_REQUIRED', errorCode: 'CONSENT_REQUIRED' };
  }
  return { ok: true, ai: pinned };
}

module.exports = {
  defaultAiSettings,
  mergeAiSettings,
  sanitizeAiSettings,
  validateAiSettingsForSave
};
