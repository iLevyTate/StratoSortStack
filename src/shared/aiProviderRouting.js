// @ts-check
'use strict';

/**
 * The three kinds of text work the AI router places. Each can be sent to its
 * own provider (ai.routing.perOperation[id]); an operation with no entry
 * follows ai.routing.default. Embeddings, search and speech-to-text stay on
 * the machine. Video frames follow Analysis. `sends` is
 * the plain-language statement of what leaves the machine when the operation
 * resolves to a cloud provider.
 * @type {ReadonlyArray<{ id: 'analyze' | 'chat' | 'suggest', label: string, sends: string }>}
 */
const AI_ROUTED_OPERATIONS = Object.freeze([
  Object.freeze({
    id: 'analyze',
    label: 'Analysis and reanalysis',
    sends:
      'each document, each audio transcript, and up to four video frames plus the transcript, on first analysis and on reanalysis'
  }),
  Object.freeze({
    id: 'chat',
    label: 'Chat',
    sends:
      'every Knowledge OS chat question, with the matching passages, summaries and paths of up to five files'
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
 * Embeddings always use the local embedding model. Speech-to-text stays
 * local because the cloud APIs used here do not accept audio. Video frames
 * are sent with the transcript when Analysis is a cloud provider. Still
 * images stay on the local vision model.
 */
const AI_CLOUD_ROUTING_SCOPE_DETAIL =
  'The default covers analysis and reanalysis, every Knowledge OS chat question, and organization suggestions. Each of the three can be sent to a different provider below. Analysis sends documents, audio transcripts, and up to four video frames with the transcript. Speech-to-text, embeddings, search and still images stay on your machine.';

const AI_CLOUD_ROUTING_SCOPE_SHORT =
  'Folder override for analysis and reanalysis of files in this folder. Chat and suggestions follow the per-operation choices in Settings → AI Provider. Speech-to-text, embeddings, search and still images stay on-device.';

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
