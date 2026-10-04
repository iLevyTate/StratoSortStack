/**
 * @jest-environment node
 */
/**
 * Unit tests for the vacuous-schema gate in scripts/verify-ipc-handler-schemas.js.
 *
 * Regression (M15): extractSchemaExpr used to split on `[,\n]`, so an inline
 * `schema: z.record(z.string(), z.any())` was cut at its inner comma and never
 * matched VACUOUS_RECORD_SCHEMA — only aliased constants were caught.
 */

const {
  collectVacuousSchemaAliases,
  extractSchemaExpr,
  schemaExprIsVacuous
} = require('../scripts/verify-ipc-handler-schemas');

describe('verify-ipc-handler-schemas: extractSchemaExpr', () => {
  test('keeps an inline schema with inner commas whole', () => {
    const body = `{
      channel: IPC_CHANNELS.FOO,
      schema: z.record(z.string(), z.any()),
      handler: async () => {}
    }`;
    expect(extractSchemaExpr(body).replace(/\s+/g, ' ').trim()).toBe(
      'z.record(z.string(), z.any())'
    );
  });

  test('stops at the enclosing object closer when schema is the last property', () => {
    const body = `{ channel: 'x', schema: z.object({ a: z.string(), b: z.number() }) }`;
    expect(extractSchemaExpr(body).replace(/\s+/g, ' ').trim()).toBe(
      'z.object({ a: z.string(), b: z.number() })'
    );
  });

  test('returns an empty string when no schema property is present', () => {
    expect(extractSchemaExpr('{ channel: "x", handler: fn }')).toBe('');
  });
});

describe('verify-ipc-handler-schemas: schemaExprIsVacuous', () => {
  test('flags inline and multiline z.record(z.string(), z.any())', () => {
    expect(schemaExprIsVacuous('z.record(z.string(), z.any())', new Set())).toBe(true);
    expect(schemaExprIsVacuous('z.record(\n  z.string(),\n  z.any()\n)', new Set())).toBe(true);
  });

  test('flags aliased vacuous schemas, including .optional()', () => {
    const aliases = collectVacuousSchemaAliases(
      'const anyRecord = z.record(z.string(), z.any());\nconst real = z.object({});'
    );
    expect(aliases).toEqual(new Set(['anyRecord']));
    expect(schemaExprIsVacuous('anyRecord', aliases)).toBe(true);
    expect(schemaExprIsVacuous('anyRecord.optional()', aliases)).toBe(true);
    expect(schemaExprIsVacuous('real', aliases)).toBe(false);
  });

  test('does not flag constraining schemas', () => {
    expect(schemaExprIsVacuous('z.object({ id: z.string().min(1) })', new Set())).toBe(false);
    expect(schemaExprIsVacuous('z.record(z.string(), z.number())', new Set())).toBe(false);
  });
});
