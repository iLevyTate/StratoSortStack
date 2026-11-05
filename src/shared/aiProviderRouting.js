// @ts-check
'use strict';

/**
 * The three kinds of text work the AI router places. Each can be sent to its
 * own provider (ai.routing.perOperation[id]); an operation with no entry
 * follows ai.routing.default. Embeddings, search, speech-to-text and the
 * pixels of still images stay on the machine. Video frames follow Analysis,
 * and only when "Describe video keyframes" is on. `sends` is the
 * plain-language statement of what leaves the machine when the operation
 * resolves to a cloud provider.
 * @type {ReadonlyArray<{ id: 'analyze' | 'chat' | 'suggest', label: string, sends: string }>}
 */
const AI_ROUTED_OPERATIONS = Object.freeze([
  Object.freeze({
    id: 'analyze',
    label: 'Analysis and reanalysis',
    sends:
      'each document and audio transcript, and up to four frames of each video with its transcript when "Describe video keyframes" is on, on first analysis and on reanalysis'
  }),
  Object.freeze({
    id: 'chat',
    label: 'Chat',
    sends:
      'every Knowledge OS chat question, with the matching passages, summaries and paths of up to five files (twelve in Deep mode), including text read from images'
  }),
  Object.freeze({
    id: 'suggest',
    label: 'Organization suggestions',
    sends: "each candidate file's saved analysis"
  })
]);

const CLOUD_PROVIDER_IDS = Object.freeze(['anthropic', 'openaiCompatible']);

/**
 * Version of the cloud-AI consent text. Stored as ai.consent.version when the
 * user accepts. Bump it whenever cloud AI starts sending something the older
 * text did not mention, so those users are asked again before it is sent.
 *   1 (or no version): file text, chat passages and suggestions.
 *   2: also up to four frames of each video, sent with its transcript.
 */
const CLOUD_CONSENT_VERSION = 2;

/**
 * The consent version a stored consent record covers: 0 when there is none,
 * 1 for a record saved before versions existed.
 * @param {any} consent ai.consent ({ acknowledgedCloudAt, version })
 * @returns {number}
 */
function consentVersionOf(consent) {
  if (!consent || typeof consent.acknowledgedCloudAt !== 'string' || !consent.acknowledgedCloudAt) {
    return 0;
  }
  const version = consent.version;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1;
}

/**
 * Human-readable scope for settings UI and the header Cloud AI badge.
 * Embeddings always use the local embedding model. Speech-to-text stays
 * local because the cloud APIs used here do not accept audio. Video frames
 * are sent with the transcript when Analysis is a cloud provider and
 * "Describe video keyframes" is on. Still images are analyzed by the local
 * vision model, but the text read from them travels with chat.
 */
const AI_CLOUD_ROUTING_SCOPE_DETAIL =
  'The default covers analysis and reanalysis, every Knowledge OS chat question, and organization suggestions. Each of the three can be sent to a different provider below. Analysis sends documents, audio transcripts and, when "Describe video keyframes" is on, up to four video frames with the transcript. Chat sends the matching passages, summaries and paths, including text read from images. Speech-to-text, embeddings, search and the pixels of still images stay on your machine.';

const AI_CLOUD_ROUTING_SCOPE_SHORT =
  'Folder override for analysis and reanalysis of files in this folder, including up to four video frames when "Describe video keyframes" is on. Chat and suggestions follow the per-operation choices in Settings → AI Provider. Speech-to-text, embeddings, search and the pixels of still images stay on-device.';

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
  CLOUD_CONSENT_VERSION,
  consentVersionOf,
  isCloudProviderId,
  resolveOperationProviderId,
  isProviderReady,
  describeOperationRouting,
  isCloudRoutingActive
};
