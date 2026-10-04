// @ts-check
/**
 * Search result utilities for UnifiedSearchModal
 * Error formatting, response validation, and path helpers
 *
 * @module search/utils/searchResultUtils
 */

import { createLogger } from '../../../../shared/logger';
import { extractExtension } from '../../../../shared/namingConventions';
import { safeBasename } from '../../../../shared/memberPathUtils';
import { sanitizeSemanticTerms } from '../../../utils/semanticTerms';
import { formatDisplayFileName, formatDisplayPath } from '../../../utils/pathDisplay';
import { getMetadataPath } from './graphPathUtils';

const logger = createLogger('SearchUtils');

export function getErrorMessage(/** @type {any} */ error, context = 'Operation') {
  // Accept strings, Error instances, and the standardized IPC error envelope
  // ({ code, message, details }) — callers pass whatever the handler returned.
  const msg = typeof error === 'string' ? error : error?.message || '';
  const code = error?.code || error?.cause?.code || '';

  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return `${context} failed: Embedding service unavailable. Check the AI engine status.`;
  }

  if (msg.includes('timeout') || msg.includes('Timeout')) {
    return `${context} timed out. Try a shorter query or fewer files.`;
  }

  if (
    code === 'VECTOR_DB_UNAVAILABLE' ||
    code === 'VECTOR_DB_PENDING' ||
    msg.includes('Vector DB') ||
    msg.includes('not available yet')
  ) {
    return `${context} failed: Knowledge Graph is initializing. Please wait a moment and try again.`;
  }

  if (msg.includes('Embedding model changed') || msg.includes('dimension mismatch')) {
    return 'Embedding model changed. Please rebuild your index in Settings > Embeddings maintenance to use the new model.';
  }

  return msg || `${context} failed`;
}

/**
 * Validate search response structure before rendering
 * Prevents crashes when API returns malformed data
 *
 * @param {any} response - API response to validate
 * @param {string} context - Context for error messages
 * @returns {{ valid: boolean, error?: string, results?: any[] }}
 */
export function validateSearchResponse(response, context = 'Search') {
  if (!response) {
    return { valid: false, error: `${context} returned no data` };
  }

  if (response.success !== true) {
    // Normalize to a string: response.error may be the structured envelope
    // object, which downstream code renders directly into JSX.
    return { valid: false, error: getErrorMessage(response.error, context) };
  }

  if (!Array.isArray(response.results)) {
    // A success envelope without a results array is a contract violation, not
    // an empty result set — surface it so the UI shows an error instead of a
    // misleading "No results found".
    logger.warn('[SearchUtils] Response missing results array', { response });
    return { valid: false, error: `${context} returned a malformed response` };
  }

  const validResults = response.results.filter((/** @type {any} */ result) => {
    if (!result) {
      logger.debug('[SearchUtils] Skipping null result');
      return false;
    }
    if (!result.id || typeof result.id !== 'string') {
      logger.debug('[SearchUtils] Skipping result with invalid id', { result });
      return false;
    }
    return true;
  });

  if (validResults.length !== response.results.length) {
    logger.warn('[SearchUtils] Filtered invalid results', {
      original: response.results.length,
      valid: validResults.length
    });
  }

  const deduplicatedResults = [];
  const seenPaths = new Map();

  for (const result of validResults) {
    const dedupKey = getMetadataPath(result, result?.id) || result.id;

    if (seenPaths.has(dedupKey)) {
      const existingIndex = seenPaths.get(dedupKey);
      if ((result.score || 0) > (deduplicatedResults[existingIndex].score || 0)) {
        deduplicatedResults[existingIndex] = result;
      }
    } else {
      seenPaths.set(dedupKey, deduplicatedResults.length);
      deduplicatedResults.push(result);
    }
  }

  if (deduplicatedResults.length !== validResults.length) {
    logger.debug('[SearchUtils] Deduplicated results by path', {
      before: validResults.length,
      after: deduplicatedResults.length
    });
  }

  return { valid: true, results: deduplicatedResults };
}

export function getParentFolderName(/** @type {any} */ filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[parts.length - 2] || '';
}

export function getConnectionReason(/** @type {any} */ edge) {
  const reasons = edge?.data?.reasons;
  if (Array.isArray(reasons) && reasons.length > 0) {
    const r = reasons[0];
    if (r?.kind === 'content_similarity') {
      const pct = Math.round((Number(r.similarity) || 0) * 100);
      return {
        type: 'similarity',
        label: pct > 0 ? `Similar content ${pct}%` : 'Similar content',
        detail: 'Embedding similarity'
      };
    }
    if (r?.kind === 'shared_concepts') {
      const concepts = sanitizeSemanticTerms(r.concepts, { maxTerms: 3, minLength: 2 });
      return {
        type: 'knowledge',
        label: 'Shared concepts',
        detail:
          concepts.length > 0
            ? `Shared: ${concepts.slice(0, 3).join(', ')}`
            : 'Shared analysis metadata'
      };
    }
    if (r?.kind === 'centroid_bridge') {
      const terms = sanitizeSemanticTerms(r.sharedTerms, { maxTerms: 3, minLength: 2 });
      const pct = Math.round((Number(r.similarity) || 0) * 100);
      return {
        type: 'bridge',
        label: pct > 0 ? `Cluster bridge ${pct}%` : 'Cluster bridge',
        detail:
          terms.length > 0 ? `Shared terms: ${terms.slice(0, 3).join(', ')}` : 'Related clusters'
      };
    }
  }

  const kind = edge?.data?.kind;
  if (kind === 'query_match') {
    const score = Math.round((edge?.data?.score || 0) * 100);
    const terms = sanitizeSemanticTerms(edge?.data?.matchDetails?.matchedTerms, {
      maxTerms: 3,
      minLength: 2
    });
    return {
      type: 'query',
      label: score > 0 ? `Query match ${score}%` : 'Query match',
      detail:
        terms.length > 0
          ? `Matched terms: ${terms.slice(0, 3).join(', ')}`
          : 'Matched search intent'
    };
  }
  if (kind === 'knowledge' || kind === 'multi_hop') {
    const concepts = sanitizeSemanticTerms(edge?.data?.concepts, { maxTerms: 3, minLength: 2 });
    return {
      type: 'knowledge',
      label: 'Knowledge link',
      detail:
        concepts.length > 0
          ? `Shared concepts: ${concepts.slice(0, 3).join(', ')}`
          : 'Shared analysis metadata'
    };
  }
  if (kind === 'cross_cluster') {
    const bridgeCount = edge?.data?.bridgeCount || 0;
    const terms = sanitizeSemanticTerms(edge?.data?.sharedTerms, {
      maxTerms: 3,
      minLength: 2
    });
    return {
      type: 'bridge',
      label: `Topic bridge ${Math.round((edge?.data?.similarity || 0) * 100)}%`,
      detail:
        bridgeCount > 0
          ? `${bridgeCount} file${bridgeCount === 1 ? '' : 's'} link both topic groups`
          : terms.length > 0
            ? `Shared themes: ${terms.slice(0, 3).join(', ')}`
            : 'Related topic groups'
    };
  }
  if (kind === 'organize') {
    return {
      type: 'organize',
      label: 'Organize suggestion',
      detail: 'Suggested smart folder placement'
    };
  }

  const similarity = edge?.data?.similarity || 0;
  const similarityPct = Math.round(similarity * 100);
  const sharedTerms = sanitizeSemanticTerms(edge?.data?.sharedTerms, {
    maxTerms: 3,
    minLength: 2
  });
  if (sharedTerms.length > 0) {
    return {
      type: 'similarity',
      label: `Shared topics ${similarityPct}%`,
      detail: `Terms: ${sharedTerms.slice(0, 3).join(', ')}`
    };
  }

  return {
    type: 'similarity',
    label: similarityPct > 0 ? `Similar content ${similarityPct}%` : 'Related content',
    detail: 'Similarity connection'
  };
}

/** Re-export from shared namingConventions; returns extension without dot for backward compatibility. */
export function getFileExtension(/** @type {any} */ nameOrPath) {
  const ext = extractExtension(nameOrPath);
  return ext ? ext.slice(1) : '';
}

/**
 * Produce a human label for a graph "bridge file" entry, honoring the redact-paths
 * setting. Prefers the embedded name, falls back to the basename of the path, then
 * the file id. When redacted, routes through pathDisplay helpers so the returned
 * string never leaks full filesystem paths.
 */
export function formatGraphBridgeFileLabel(
  /** @type {any} */ file,
  /** @type {any} */ filePath,
  /** @type {any} */ redactPaths
) {
  if (!redactPaths) {
    return (
      file?.name || (filePath ? safeBasename(filePath) : null) || file?.id || String(file ?? '')
    );
  }
  const raw =
    (typeof file?.name === 'string' && file.name.trim()) ||
    (filePath ? safeBasename(filePath) : '') ||
    (typeof file?.id === 'string' ? file.id : '');
  if (raw) return formatDisplayFileName(raw, { redact: true });
  if (filePath) return formatDisplayPath(filePath, { redact: true, segments: 2 });
  return String(file ?? '');
}
