// @ts-check
'use strict';
const { z } = require('zod');
const { PROVIDER_BASE_URL_RULE, isAllowedProviderBaseUrl } = require('./providerBaseUrl');

const PROVIDER_NAMES = ['local', 'anthropic', 'openaiCompatible'];

const providerBaseUrlSchema = z
  .string()
  .url()
  .refine(isAllowedProviderBaseUrl, { message: PROVIDER_BASE_URL_RULE });

const providerConfigSchema = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    baseUrl: providerBaseUrlSchema.optional(),
    apiKeyRef: z.enum(PROVIDER_NAMES).optional(),
    spendCapMonthlyUsd: z.number().nonnegative().max(10000).optional()
  })
  .strict();

// Operations the router is asked to place. Each can be sent to its own
// provider through routing.perOperation; an operation with no entry follows
// routing.default. Names match the `operation` argument of AIRouter.choose().
const ROUTED_OPERATIONS = ['analyze', 'chat', 'suggest'];

const perOperationRoutingSchema = z
  .object({
    analyze: z.enum(PROVIDER_NAMES).optional(),
    chat: z.enum(PROVIDER_NAMES).optional(),
    suggest: z.enum(PROVIDER_NAMES).optional()
  })
  .strict();

const routingSchema = z
  .object({
    default: z.enum(PROVIDER_NAMES),
    perOperation: perOperationRoutingSchema.optional(),
    perFolder: z.record(z.string(), z.enum(PROVIDER_NAMES))
  })
  .strict();

const consentSchema = z
  .object({
    acknowledgedCloudAt: z.string().datetime().optional()
  })
  .strict();

const aiSettingsSchema = z
  .object({
    providers: z
      .object({
        local: providerConfigSchema,
        anthropic: providerConfigSchema,
        openaiCompatible: providerConfigSchema
      })
      .strict(),
    routing: routingSchema,
    consent: consentSchema.optional()
  })
  .strict();

const CLOUD_PROVIDERS = ['anthropic', 'openaiCompatible'];

// Validate the consent timestamp on read instead of trusting any truthy
// string. Without this, a corrupted settings.json with
// `consent: { acknowledgedCloudAt: "x" }` bypasses the gate. We require a
// well-formed ISO datetime that is in the past (future-dated values are
// rejected — this is a record of past consent, not a permit).
function hasCloudConsent(/** @type {any} */ settings) {
  const ts = settings?.consent?.acknowledgedCloudAt;
  if (typeof ts !== 'string' || ts.length === 0) return false;
  const parsedMs = Date.parse(ts);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) return false;
  // Consent is a record of past acknowledgement, not a permit. Reject any
  // timestamp that claims to be in the future — a settings.json copied from
  // another machine, or a clock that was wrong at acknowledge time, must not
  // automatically grant cloud routing.
  return parsedMs <= Date.now();
}

function settingsRequireCloudConsent(/** @type {any} */ settings) {
  if (!settings) return false;
  if (CLOUD_PROVIDERS.includes(settings.routing?.default)) return true;
  const perOperation = settings.routing?.perOperation || {};
  if (Object.values(perOperation).some((p) => CLOUD_PROVIDERS.includes(p))) return true;
  const perFolder = settings.routing?.perFolder || {};
  return Object.values(perFolder).some((p) => CLOUD_PROVIDERS.includes(p));
}

module.exports = {
  PROVIDER_NAMES,
  CLOUD_PROVIDERS,
  ROUTED_OPERATIONS,
  isAllowedProviderBaseUrl,
  providerBaseUrlSchema,
  providerConfigSchema,
  perOperationRoutingSchema,
  routingSchema,
  consentSchema,
  aiSettingsSchema,
  hasCloudConsent,
  settingsRequireCloudConsent
};
