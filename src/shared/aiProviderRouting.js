// @ts-check
'use strict';

/**
 * The three kinds of text work the AI router places. Each can be sent to its
 * own provider (ai.routing.perOperation[id]); an operation with no entry
 * follows ai.routing.default. Embeddings, search and image pixels are never
 * routed: they stay on the machine whatever is configured here. `sends` is
 * the plain-language statement of what leaves the machine when the operation
 * resolves to a cloud provider.
 * @type {ReadonlyArray<{ id: 'analyze' | 'chat' | 'suggest', label: string, sends: string }>}
 */
const AI_ROUTED_OPERATIONS = Object.freeze([
  Object.freeze({
    id: 'analyze',
    label: 'Document analysis',
    sends: 'the text of each file or media transcript when it is analyzed'
  }),
  Object.freeze({
    id: 'chat',
    label: 'Chat',
    sends:
      'every question, with the matching passages, summaries and paths of up to five files, including text read from images'
  }),
  Object.freeze({
    id: 'suggest',
    label: 'Organization suggestions',
    sends: "each candidate file's saved analysis"
  })
]);

const CLOUD_PROVIDER_IDS = Object.freeze(['anthropic', 'openaiCompatible']);

/**
 * Human-readable scope for settings UI and the header Cloud AI badge.
 * Embeddings always use the local embedding model and image pixels never
 * leave the machine (imageAnalysis.js forces the vision step local). Text
 * read from an image by OCR is stored with the analysis like any other
 * extracted text, so chat and suggestions can send it to a cloud provider.
 */
const AI_CLOUD_ROUTING_SCOPE_DETAIL =
  'The default covers document and media text analysis, every Knowledge OS chat question (which sends the matching passages, summaries and paths, including text read from images) and organization suggestions. Each of the three can be sent to a different provider below. Embeddings, search and image pixels always stay on your machine.';

const AI_CLOUD_ROUTING_SCOPE_SHORT =
  'Folder override for re-analysis of files in this folder. Chat and suggestions follow the per-operation choices in Settings → AI Provider. Embeddings, search and image pixels always stay on-device.';

/**
 * @param {string} providerId
 * @returns {boolean}
 */
function isCloudProviderId(providerId) {
  return CLOUD_PROVIDER_IDS.includes(providerId);
}

/**
 * The provider id an operation is configured to use: its per-operation entry,
 * else the default, else local. Availability is not considered here.
 * @param {any} settings
 * @param {string} operation
 * @returns {string}
 */
function resolveOperationProviderId(settings, operation) {
  const routing = settings?.routing || {};
  return routing.perOperation?.[operation] || routing.default || 'local';
}

/**
 * @param {any} status router status ({ providers: [{ id, enabled, ready }] })
 * @param {string} providerId
 * @returns {boolean}
 */
function isProviderReady(status, providerId) {
  const providers = status?.providers;
  if (!Array.isArray(providers)) return false;
  const entry = providers.find((p) => p?.id === providerId);
  return Boolean(entry?.enabled && entry?.ready);
}

/**
 * One row per routed operation: the provider it resolves to, whether that
 * came from a per-operation entry, and whether the provider is ready.
 * @param {any} settings
 * @param {any} status
 * @returns {Array<{ id: string, label: string, sends: string, providerId: string, overridden: boolean, ready: boolean }>}
 */
function describeOperationRouting(settings, status) {
  return AI_ROUTED_OPERATIONS.map((op) => {
    const providerId = resolveOperationProviderId(settings, op.id);
    return {
      id: op.id,
      label: op.label,
      sends: op.sends,
      providerId,
      overridden: Boolean(settings?.routing?.perOperation?.[op.id]),
      ready: isProviderReady(status, providerId)
    };
  });
}

/**
 * True when at least one routed operation resolves to a cloud provider that
 * is enabled and ready, so some text work leaves the machine rather than
 * falling back to local.
 * @param {any} settings
 * @param {any} status
 * @returns {boolean}
 */
function isCloudRoutingActive(settings, status) {
  return describeOperationRouting(settings, status).some(
    (route) => isCloudProviderId(route.providerId) && route.ready
  );
}

module.exports = {
  AI_ROUTED_OPERATIONS,
  AI_CLOUD_ROUTING_SCOPE_DETAIL,
  AI_CLOUD_ROUTING_SCOPE_SHORT,
  isCloudProviderId,
  resolveOperationProviderId,
  isProviderReady,
  describeOperationRouting,
  isCloudRoutingActive
};
