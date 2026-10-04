// @ts-check
const CHAT_PERSONAS = [
  {
    id: 'professional-researcher',
    label: 'Professional Researcher',
    description: 'Formal, structured answers that cite sources and avoid speculation.',
    guidance:
      'Use a professional, research-oriented tone. Be concise, structured, and careful. Cite sources when available, clearly separate document evidence from general knowledge, and avoid speculation.'
  },
  {
    id: 'informal-helper',
    label: 'Informal Helper',
    description: 'Friendly, plain-language guidance with practical tips.',
    guidance:
      'Use a friendly, conversational tone. Keep answers practical and easy to scan. Offer helpful tips and avoid heavy jargon unless the user asks for it.'
  },
  {
    id: 'discoverer',
    label: 'Discoverer',
    description: 'Exploratory, curious responses that surface alternatives and next steps.',
    guidance:
      'Use an exploratory, curious tone. Highlight alternatives, note uncertainties, and suggest engaging next questions or angles to investigate.'
  },
  {
    id: 'auditor',
    label: 'Auditor',
    description: 'Strict citation-only responses that flag uncertainty explicitly.',
    guidance:
      'Never state anything not directly supported by the provided documents. Every claim must have an inline [doc-N] citation. Flag any uncertainty explicitly. If evidence is insufficient, say so rather than speculate. Prioritize accuracy over completeness.'
  }
];

const DEFAULT_CHAT_PERSONA_ID = 'professional-researcher';

/**
 * Validation limits for user-defined custom personas. Mirrors the
 * settings-side validator so a future code path that bypasses validation
 * still hits the same caps.
 */
const CUSTOM_PERSONA_LIMITS = Object.freeze({
  MAX_COUNT: 20, // upper bound on the number of saved personas
  MAX_ID_LENGTH: 64,
  MAX_LABEL_LENGTH: 64,
  MAX_DESCRIPTION_LENGTH: 240,
  MAX_GUIDANCE_LENGTH: 2048
});

const CUSTOM_PERSONA_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CUSTOM_PERSONA_ID_PREFIX = 'custom:';

/**
 * Sanitize a single user-supplied persona entry. Returns the cleaned
 * shape on success, or null if the input is malformed beyond rescue.
 * Used by both the settings validator and the runtime helpers below
 * so a corrupted on-disk entry can't crash prompt construction.
 *
 * Rules:
 *   - id: required, lowercase ASCII + digits + `_-`, prefixed with `custom:`
 *     so it can never collide with a built-in id (which never has a colon).
 *   - label, guidance: required non-empty strings (trimmed, capped).
 *   - description: optional (trimmed, capped).
 */
/** @param {any} raw */
function sanitizeCustomPersona(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!rawId) return null;
  // Allow either the bare id ("my-persona") or the prefixed form
  // ("custom:my-persona") so the same data round-trips through the UI
  // unchanged. We always emit the prefixed form.
  const bareId = rawId.startsWith(CUSTOM_PERSONA_ID_PREFIX)
    ? rawId.slice(CUSTOM_PERSONA_ID_PREFIX.length)
    : rawId;
  if (!CUSTOM_PERSONA_ID_PATTERN.test(bareId)) return null;
  if (bareId.length > CUSTOM_PERSONA_LIMITS.MAX_ID_LENGTH) return null;

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return null;
  const guidance = typeof raw.guidance === 'string' ? raw.guidance.trim() : '';
  if (!guidance) return null;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  return {
    id: `${CUSTOM_PERSONA_ID_PREFIX}${bareId}`,
    label: label.slice(0, CUSTOM_PERSONA_LIMITS.MAX_LABEL_LENGTH),
    description: description.slice(0, CUSTOM_PERSONA_LIMITS.MAX_DESCRIPTION_LENGTH),
    guidance: guidance.slice(0, CUSTOM_PERSONA_LIMITS.MAX_GUIDANCE_LENGTH)
  };
}

/**
 * Sanitize an array of user-supplied personas. Drops malformed entries
 * silently rather than throwing — a single bad row should not lock the
 * user out of all their other personas. Order is preserved so the UI
 * displays the user's chosen ordering.
 *
 * @param {any[]} rawList
 * @returns {any[]}
 */
function sanitizeCustomPersonas(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    if (out.length >= CUSTOM_PERSONA_LIMITS.MAX_COUNT) break;
    const cleaned = sanitizeCustomPersona(raw);
    if (!cleaned) continue;
    if (seen.has(cleaned.id)) continue; // de-dup by id
    seen.add(cleaned.id);
    out.push(cleaned);
  }
  return out;
}

/**
 * @param {string} personaId
 * @param {any[]} [customPersonas]
 */
function getChatPersonaById(personaId, customPersonas) {
  const id = typeof personaId === 'string' ? personaId.trim() : '';
  if (!id) return null;
  // Built-in personas are checked first so user-supplied ids cannot
  // shadow them. The `custom:` prefix on sanitized custom personas
  // makes collision impossible in practice, but the ordering here
  // makes that guarantee defense-in-depth.
  const builtIn = CHAT_PERSONAS.find((persona) => persona.id === id);
  if (builtIn) return builtIn;
  if (Array.isArray(customPersonas) && customPersonas.length > 0) {
    const customs = sanitizeCustomPersonas(customPersonas);
    return customs.find((persona) => persona.id === id) || null;
  }
  return null;
}

/**
 * @param {string} personaId
 * @param {any[]} [customPersonas]
 */
function getChatPersonaOrDefault(personaId, customPersonas) {
  return (
    getChatPersonaById(personaId, customPersonas) ||
    CHAT_PERSONAS.find((persona) => persona.id === DEFAULT_CHAT_PERSONA_ID) ||
    CHAT_PERSONAS[0]
  );
}

/**
 * Returns the merged list of built-in + (sanitized) custom personas in
 * the order the UI should render them: built-ins first, then customs.
 * Used by both the renderer dropdown and the settings editor.
 */
/** @param {any[]} [customPersonas] */
function getAllChatPersonas(customPersonas) {
  return [...CHAT_PERSONAS, ...sanitizeCustomPersonas(customPersonas)];
}

/**
 * Marker that introduces a user's custom guidance override inside the
 * effective persona guidance. Kept as a stable string so prompt-injection
 * audits and logs can grep for it.
 */
const CUSTOM_GUIDANCE_HEADER = 'Additional user instructions:';

/**
 * Build the effective persona used for prompt construction by appending the
 * user's free-text override (if any) to the built-in persona's guidance.
 * The result has the same shape as a built-in persona, so existing consumers
 * (e.g. ChatService._buildPrompt) require no changes beyond resolving the
 * persona via this helper instead of `getChatPersonaOrDefault`.
 *
 * The override is sanitized: trimmed, capped at 2 KB (matching the settings
 * validator) and stripped of trailing/leading whitespace lines so the
 * generated prompt stays predictable. The setting validator already rejects
 * over-length values, so the cap here is defense-in-depth — if a future
 * code path bypasses validation, prompt construction still doesn't blow up.
 *
 * @param {string} personaId - Built-in persona id from CHAT_PERSONAS.
 * @param {string} [customGuidance] - User's free-text override.
 * @param {any[]} [customPersonas] - Optional array of custom personas.
 * @returns {{ id: string, label: string, description: string, guidance: string, isCustomized: boolean }}
 */
function getEffectivePersona(personaId, customGuidance, customPersonas) {
  const persona = getChatPersonaOrDefault(personaId, customPersonas);
  const trimmed = typeof customGuidance === 'string' ? customGuidance.trim().slice(0, 2048) : '';
  if (!trimmed) {
    return { ...persona, isCustomized: false };
  }
  const merged = `${persona.guidance}\n\n${CUSTOM_GUIDANCE_HEADER}\n${trimmed}`;
  return {
    ...persona,
    guidance: merged,
    isCustomized: true
  };
}

module.exports = {
  CHAT_PERSONAS,
  DEFAULT_CHAT_PERSONA_ID,
  CUSTOM_GUIDANCE_HEADER,
  CUSTOM_PERSONA_LIMITS,
  CUSTOM_PERSONA_ID_PATTERN,
  CUSTOM_PERSONA_ID_PREFIX,
  sanitizeCustomPersona,
  sanitizeCustomPersonas,
  getChatPersonaById,
  getChatPersonaOrDefault,
  getAllChatPersonas,
  getEffectivePersona
};
