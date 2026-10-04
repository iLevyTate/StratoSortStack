/**
 * Tests for src/shared/chatPersonas.js — covers the existing helpers plus
 * the new getEffectivePersona() that merges chatPersonaCustomGuidance
 * into the selected persona's guidance.
 */

const {
  CHAT_PERSONAS,
  DEFAULT_CHAT_PERSONA_ID,
  CUSTOM_GUIDANCE_HEADER,
  getChatPersonaById,
  getChatPersonaOrDefault,
  getEffectivePersona
} = require('../src/shared/chatPersonas');

describe('chatPersonas — basic helpers', () => {
  test('CHAT_PERSONAS exposes the four built-in personas', () => {
    const ids = CHAT_PERSONAS.map((p) => p.id);
    expect(ids).toEqual(['professional-researcher', 'informal-helper', 'discoverer', 'auditor']);
    for (const persona of CHAT_PERSONAS) {
      expect(typeof persona.label).toBe('string');
      expect(typeof persona.description).toBe('string');
      expect(typeof persona.guidance).toBe('string');
      expect(persona.guidance.length).toBeGreaterThan(0);
    }
  });

  test('getChatPersonaById returns matches and null for unknowns', () => {
    expect(getChatPersonaById('auditor')?.label).toBe('Auditor');
    expect(getChatPersonaById('nonexistent')).toBeNull();
    expect(getChatPersonaById('')).toBeNull();
    expect(getChatPersonaById(undefined)).toBeNull();
  });

  test('getChatPersonaOrDefault falls back to the default persona', () => {
    expect(getChatPersonaOrDefault('nonexistent').id).toBe(DEFAULT_CHAT_PERSONA_ID);
    expect(getChatPersonaOrDefault().id).toBe(DEFAULT_CHAT_PERSONA_ID);
    expect(getChatPersonaOrDefault('discoverer').id).toBe('discoverer');
  });
});

describe('getEffectivePersona — custom guidance override', () => {
  test('returns the built-in persona unchanged when no override is supplied', () => {
    const result = getEffectivePersona('auditor');
    expect(result.id).toBe('auditor');
    expect(result.guidance).toBe(getChatPersonaById('auditor').guidance);
    expect(result.isCustomized).toBe(false);
  });

  test('treats whitespace-only override as absent (no merge)', () => {
    const result = getEffectivePersona('auditor', '   \n\t  ');
    expect(result.guidance).toBe(getChatPersonaById('auditor').guidance);
    expect(result.isCustomized).toBe(false);
  });

  test('appends a non-empty override below a stable header marker', () => {
    const result = getEffectivePersona('auditor', 'Always cite by document title.');
    expect(result.isCustomized).toBe(true);
    expect(result.guidance).toContain(getChatPersonaById('auditor').guidance);
    expect(result.guidance).toContain(CUSTOM_GUIDANCE_HEADER);
    expect(result.guidance).toContain('Always cite by document title.');
    // Header appears AFTER the built-in guidance (override appends, never prepends).
    expect(result.guidance.indexOf(CUSTOM_GUIDANCE_HEADER)).toBeGreaterThan(
      result.guidance.indexOf(getChatPersonaById('auditor').guidance)
    );
  });

  test('caps the override at 2048 characters as defense-in-depth', () => {
    const huge = 'X'.repeat(5000);
    const result = getEffectivePersona('auditor', huge);
    // Header + 2048 cap; the merge contains exactly 2048 X's, no more.
    const overrideSection = result.guidance.split(CUSTOM_GUIDANCE_HEADER + '\n')[1];
    expect(overrideSection.length).toBe(2048);
  });

  test('falls back to the default persona when persona id is unknown', () => {
    const result = getEffectivePersona('nonexistent', 'extra rules');
    expect(result.id).toBe(DEFAULT_CHAT_PERSONA_ID);
    expect(result.isCustomized).toBe(true);
    expect(result.guidance).toContain('extra rules');
  });

  test('non-string customGuidance is treated as absent', () => {
    expect(getEffectivePersona('auditor', null).isCustomized).toBe(false);
    expect(getEffectivePersona('auditor', undefined).isCustomized).toBe(false);
    expect(getEffectivePersona('auditor', 42).isCustomized).toBe(false);
    expect(getEffectivePersona('auditor', { text: 'hi' }).isCustomized).toBe(false);
  });

  test('preserves persona shape (id, label, description, guidance)', () => {
    const result = getEffectivePersona('discoverer', 'be brief');
    expect(Object.keys(result).sort()).toEqual(
      ['description', 'guidance', 'id', 'isCustomized', 'label'].sort()
    );
  });
});

const {
  CUSTOM_PERSONA_LIMITS,
  CUSTOM_PERSONA_ID_PATTERN,
  CUSTOM_PERSONA_ID_PREFIX,
  sanitizeCustomPersona,
  sanitizeCustomPersonas,
  getAllChatPersonas
} = require('../src/shared/chatPersonas');

describe('sanitizeCustomPersona', () => {
  test('returns null for non-objects', () => {
    expect(sanitizeCustomPersona(null)).toBeNull();
    expect(sanitizeCustomPersona(undefined)).toBeNull();
    expect(sanitizeCustomPersona('string')).toBeNull();
    expect(sanitizeCustomPersona(42)).toBeNull();
  });

  test('rejects entries missing required fields', () => {
    expect(sanitizeCustomPersona({})).toBeNull();
    expect(sanitizeCustomPersona({ id: 'foo' })).toBeNull();
    expect(sanitizeCustomPersona({ id: 'foo', label: 'Foo' })).toBeNull();
    expect(sanitizeCustomPersona({ label: 'Foo', guidance: 'do x' })).toBeNull();
    expect(sanitizeCustomPersona({ id: 'foo', label: 'Foo', guidance: '   ' })).toBeNull();
  });

  test('rejects ids that violate the pattern', () => {
    expect(sanitizeCustomPersona({ id: 'UPPER', label: 'L', guidance: 'g' })).toBeNull();
    expect(sanitizeCustomPersona({ id: 'has space', label: 'L', guidance: 'g' })).toBeNull();
    expect(
      sanitizeCustomPersona({ id: '_starts-underscore', label: 'L', guidance: 'g' })
    ).toBeNull();
    expect(sanitizeCustomPersona({ id: '-starts-dash', label: 'L', guidance: 'g' })).toBeNull();
  });

  test('accepts both bare and prefixed ids and emits the prefixed form', () => {
    const bare = sanitizeCustomPersona({ id: 'my-persona', label: 'Mine', guidance: 'g' });
    expect(bare.id).toBe(`${CUSTOM_PERSONA_ID_PREFIX}my-persona`);
    const prefixed = sanitizeCustomPersona({
      id: `${CUSTOM_PERSONA_ID_PREFIX}my-persona`,
      label: 'Mine',
      guidance: 'g'
    });
    expect(prefixed.id).toBe(`${CUSTOM_PERSONA_ID_PREFIX}my-persona`);
  });

  test('caps oversized fields at the documented limits', () => {
    const cleaned = sanitizeCustomPersona({
      id: 'p1',
      label: 'A'.repeat(500),
      description: 'B'.repeat(500),
      guidance: 'C'.repeat(5000)
    });
    expect(cleaned.label.length).toBe(CUSTOM_PERSONA_LIMITS.MAX_LABEL_LENGTH);
    expect(cleaned.description.length).toBe(CUSTOM_PERSONA_LIMITS.MAX_DESCRIPTION_LENGTH);
    expect(cleaned.guidance.length).toBe(CUSTOM_PERSONA_LIMITS.MAX_GUIDANCE_LENGTH);
  });

  test('CUSTOM_PERSONA_ID_PATTERN documentation cases', () => {
    expect(CUSTOM_PERSONA_ID_PATTERN.test('legal-reviewer')).toBe(true);
    expect(CUSTOM_PERSONA_ID_PATTERN.test('persona_v2')).toBe(true);
    expect(CUSTOM_PERSONA_ID_PATTERN.test('99-99')).toBe(true);
    expect(CUSTOM_PERSONA_ID_PATTERN.test('CamelCase')).toBe(false);
    expect(CUSTOM_PERSONA_ID_PATTERN.test('')).toBe(false);
  });
});

describe('sanitizeCustomPersonas', () => {
  test('drops malformed entries silently and de-dupes by id', () => {
    const out = sanitizeCustomPersonas([
      { id: 'a', label: 'A', guidance: 'g' },
      null,
      { id: 'b' }, // missing label/guidance
      { id: 'a', label: 'A2', guidance: 'g2' }, // duplicate id, dropped
      { id: 'c', label: 'C', guidance: 'g' }
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id)).toEqual([
      `${CUSTOM_PERSONA_ID_PREFIX}a`,
      `${CUSTOM_PERSONA_ID_PREFIX}c`
    ]);
  });

  test('preserves input order', () => {
    const out = sanitizeCustomPersonas([
      { id: 'z', label: 'Z', guidance: 'g' },
      { id: 'a', label: 'A', guidance: 'g' },
      { id: 'm', label: 'M', guidance: 'g' }
    ]);
    expect(out.map((p) => p.id)).toEqual([
      `${CUSTOM_PERSONA_ID_PREFIX}z`,
      `${CUSTOM_PERSONA_ID_PREFIX}a`,
      `${CUSTOM_PERSONA_ID_PREFIX}m`
    ]);
  });

  test('truncates at MAX_COUNT entries', () => {
    const overflow = Array.from({ length: CUSTOM_PERSONA_LIMITS.MAX_COUNT + 5 }, (_, i) => ({
      id: `p${i}`,
      label: `P${i}`,
      guidance: 'g'
    }));
    expect(sanitizeCustomPersonas(overflow)).toHaveLength(CUSTOM_PERSONA_LIMITS.MAX_COUNT);
  });

  test('returns [] for non-array input', () => {
    expect(sanitizeCustomPersonas(null)).toEqual([]);
    expect(sanitizeCustomPersonas(undefined)).toEqual([]);
    expect(sanitizeCustomPersonas({})).toEqual([]);
  });
});

describe('getChatPersonaById / getChatPersonaOrDefault with custom personas', () => {
  const customs = [
    { id: 'legal', label: 'Legal Reviewer', guidance: 'be precise' },
    { id: 'humor', label: 'Humorist', guidance: 'be funny' }
  ];

  test('finds custom personas by their prefixed id', () => {
    expect(getChatPersonaById(`${CUSTOM_PERSONA_ID_PREFIX}legal`, customs)?.label).toBe(
      'Legal Reviewer'
    );
  });

  test('built-in lookup still works without customs', () => {
    expect(getChatPersonaById('auditor')?.label).toBe('Auditor');
    expect(getChatPersonaById('auditor', customs)?.label).toBe('Auditor');
  });

  test('returns null for unknown ids whether or not customs are provided', () => {
    expect(getChatPersonaById('nonexistent')).toBeNull();
    expect(getChatPersonaById('nonexistent', customs)).toBeNull();
  });

  test('built-in ids always win over user attempts to shadow them', () => {
    // Even if someone hand-edited settings.json to inject `id: "auditor"`,
    // the built-in one wins. (Plus the sanitizer would prefix it anyway.)
    const collision = [{ id: 'auditor', label: 'PWNED', guidance: 'pwn' }];
    expect(getChatPersonaById('auditor', collision)?.label).toBe('Auditor');
  });

  test('getChatPersonaOrDefault falls back to default when custom id is not in customs', () => {
    expect(getChatPersonaOrDefault(`${CUSTOM_PERSONA_ID_PREFIX}missing`, customs).id).toBe(
      'professional-researcher'
    );
  });

  test('getChatPersonaOrDefault returns the custom persona when present', () => {
    const result = getChatPersonaOrDefault(`${CUSTOM_PERSONA_ID_PREFIX}humor`, customs);
    expect(result.label).toBe('Humorist');
  });
});

describe('getEffectivePersona — with custom personas + override', () => {
  test('resolves a custom persona, then merges the free-text override on top', () => {
    const customs = [{ id: 'tutor', label: 'Tutor', guidance: 'explain step by step' }];
    const result = getEffectivePersona(`${CUSTOM_PERSONA_ID_PREFIX}tutor`, 'be brief', customs);
    expect(result.label).toBe('Tutor');
    expect(result.guidance).toContain('explain step by step');
    expect(result.guidance).toContain('be brief');
    expect(result.isCustomized).toBe(true);
  });

  test('without an override the custom persona is returned unchanged', () => {
    const customs = [{ id: 'tutor', label: 'Tutor', guidance: 'explain step by step' }];
    const result = getEffectivePersona(`${CUSTOM_PERSONA_ID_PREFIX}tutor`, '', customs);
    expect(result.guidance).toBe('explain step by step');
    expect(result.isCustomized).toBe(false);
  });
});

describe('getAllChatPersonas', () => {
  test('returns built-ins first, then sanitized customs', () => {
    const customs = [
      { id: 'a', label: 'A', guidance: 'g' },
      { id: 'b', label: 'B', guidance: 'g' }
    ];
    const all = getAllChatPersonas(customs);
    expect(all.length).toBe(4 + 2);
    expect(all.slice(0, 4).map((p) => p.id)).toEqual([
      'professional-researcher',
      'informal-helper',
      'discoverer',
      'auditor'
    ]);
    expect(all.slice(4).map((p) => p.id)).toEqual([
      `${CUSTOM_PERSONA_ID_PREFIX}a`,
      `${CUSTOM_PERSONA_ID_PREFIX}b`
    ]);
  });

  test('drops malformed customs from the merged list', () => {
    const all = getAllChatPersonas([null, { id: 'ok', label: 'OK', guidance: 'g' }, {}]);
    expect(all.length).toBe(4 + 1);
    expect(all[4].label).toBe('OK');
  });
});
