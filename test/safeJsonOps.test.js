/**
 * Tests for safeJsonOps utility
 */

const {
  safeParse,
  safeStringify,
  parseJsonLines,
  tryParse,
  jsonClone,
  deepClone,
  stableStringify
} = require('../src/shared/safeJsonOps');

describe('safeJsonOps', () => {
  describe('safeParse', () => {
    test('parses valid JSON', () => {
      expect(safeParse('{"key": "value"}')).toEqual({ key: 'value' });
      expect(safeParse('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(safeParse('"hello"')).toBe('hello');
      expect(safeParse('123')).toBe(123);
      expect(safeParse('true')).toBe(true);
      expect(safeParse('null')).toBe(null);
    });

    test('returns fallback for invalid JSON', () => {
      expect(safeParse('not json')).toBe(null);
      expect(safeParse('not json', {})).toEqual({});
      expect(safeParse('{ invalid }', [])).toEqual([]);
    });

    test('returns fallback for null/undefined input', () => {
      expect(safeParse(null)).toBe(null);
      expect(safeParse(undefined)).toBe(null);
      expect(safeParse(null, 'default')).toBe('default');
      expect(safeParse(undefined, [])).toEqual([]);
    });

    test('handles empty string', () => {
      expect(safeParse('')).toBe(null);
      expect(safeParse('', {})).toEqual({});
    });

    test('parses nested objects', () => {
      const json = '{"outer": {"inner": {"value": 42}}}';
      expect(safeParse(json)).toEqual({ outer: { inner: { value: 42 } } });
    });
  });

  describe('safeStringify', () => {
    test('stringifies valid values', () => {
      expect(safeStringify({ key: 'value' })).toBe('{"key":"value"}');
      expect(safeStringify([1, 2, 3])).toBe('[1,2,3]');
      expect(safeStringify('hello')).toBe('"hello"');
      expect(safeStringify(123)).toBe('123');
      expect(safeStringify(true)).toBe('true');
      expect(safeStringify(null)).toBe('null');
    });

    test('returns fallback for circular references', () => {
      const obj = { a: 1 };
      obj.self = obj;
      expect(safeStringify(obj)).toBe(null);
      expect(safeStringify(obj, '{}')).toBe('{}');
    });

    test('supports pretty printing', () => {
      const result = safeStringify({ a: 1 }, null, { pretty: true });
      expect(result).toBe('{\n  "a": 1\n}');
    });

    test('handles BigInt gracefully', () => {
      // BigInt cannot be serialized to JSON
      const obj = { value: BigInt(9007199254740991) };
      expect(safeStringify(obj)).toBe(null);
      expect(safeStringify(obj, '{"error": true}')).toBe('{"error": true}');
    });
  });

  describe('parseJsonLines', () => {
    test('parses multiple JSON lines', () => {
      const text = '{"id": 1}\n{"id": 2}\n{"id": 3}';
      expect(parseJsonLines(text)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    test('skips invalid lines', () => {
      const text = '{"id": 1}\ninvalid line\n{"id": 3}';
      expect(parseJsonLines(text)).toEqual([{ id: 1 }, { id: 3 }]);
    });

    test('handles empty lines', () => {
      const text = '{"id": 1}\n\n{"id": 2}\n  \n{"id": 3}';
      expect(parseJsonLines(text)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    test('returns empty array for invalid input', () => {
      expect(parseJsonLines(null)).toEqual([]);
      expect(parseJsonLines(undefined)).toEqual([]);
      expect(parseJsonLines('')).toEqual([]);
      expect(parseJsonLines(123)).toEqual([]);
    });

    test('handles single line', () => {
      expect(parseJsonLines('{"single": true}')).toEqual([{ single: true }]);
    });

    test('handles all invalid lines', () => {
      const text = 'not json\nalso not json\nstill not json';
      expect(parseJsonLines(text)).toEqual([]);
    });
  });

  describe('tryParse', () => {
    test('returns success true for valid JSON', () => {
      const result = tryParse('{"key": "value"}');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ key: 'value' });
      expect(result.error).toBe(null);
    });

    test('returns success false for invalid JSON', () => {
      const result = tryParse('not json');
      expect(result.success).toBe(false);
      expect(result.value).toBe(null);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain('Unexpected');
    });

    test('returns error for null/undefined input', () => {
      const nullResult = tryParse(null);
      expect(nullResult.success).toBe(false);
      expect(nullResult.error.message).toBe('Input is null or undefined');

      const undefinedResult = tryParse(undefined);
      expect(undefinedResult.success).toBe(false);
      expect(undefinedResult.error.message).toBe('Input is null or undefined');
    });

    test('provides specific error message', () => {
      const result = tryParse('{ broken');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('jsonClone', () => {
    test('creates deep clone of object', () => {
      const original = { a: { b: { c: 1 } } };
      const cloned = jsonClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.a).not.toBe(original.a);
      expect(cloned.a.b).not.toBe(original.a.b);
    });

    test('clones arrays', () => {
      const original = [1, [2, [3]]];
      const cloned = jsonClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[1]).not.toBe(original[1]);
    });

    test('returns fallback for circular references', () => {
      const obj = { a: 1 };
      obj.self = obj;

      expect(jsonClone(obj)).toBe(null);
      expect(jsonClone(obj, {})).toEqual({});
    });

    test('handles primitives', () => {
      expect(jsonClone(42)).toBe(42);
      expect(jsonClone('hello')).toBe('hello');
      expect(jsonClone(true)).toBe(true);
      expect(jsonClone(null)).toBe(null);
    });

    test('loses functions and undefined values', () => {
      const original = {
        fn: () => {},
        undef: undefined,
        value: 'kept'
      };
      const cloned = jsonClone(original);

      expect(cloned.fn).toBeUndefined();
      expect(cloned.undef).toBeUndefined();
      expect(cloned.value).toBe('kept');
    });

    test('returns fallback for undefined input', () => {
      expect(jsonClone(undefined)).toBe(null);
      expect(jsonClone(undefined, {})).toEqual({});
    });
  });

  describe('deepClone', () => {
    test('creates deep clone of nested object', () => {
      const original = { a: { b: { c: 1 } } };
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.a).not.toBe(original.a);
      expect(cloned.a.b).not.toBe(original.a.b);
    });

    test('clones arrays', () => {
      const original = [1, [2, [3]]];
      const cloned = deepClone(original);

      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[1]).not.toBe(original[1]);
    });

    test('handles primitives', () => {
      expect(deepClone(42)).toBe(42);
      expect(deepClone('hello')).toBe('hello');
      expect(deepClone(true)).toBe(true);
      expect(deepClone(null)).toBe(null);
    });

    test('preserves Maps and Sets when structuredClone is available', () => {
      if (typeof structuredClone !== 'function') return;
      const original = {
        map: new Map([['k', 'v']]),
        set: new Set([1, 2, 3])
      };
      const cloned = deepClone(original);

      expect(cloned.map).toBeInstanceOf(Map);
      expect(cloned.map.get('k')).toBe('v');
      expect(cloned.set).toBeInstanceOf(Set);
      expect(Array.from(cloned.set)).toEqual([1, 2, 3]);
    });

    test('preserves Date objects when structuredClone is available', () => {
      if (typeof structuredClone !== 'function') return;
      const original = { ts: new Date('2025-01-01T00:00:00.000Z') };
      const cloned = deepClone(original);

      expect(cloned.ts).toBeInstanceOf(Date);
      expect(cloned.ts.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });

    test('handles cycles via structuredClone', () => {
      if (typeof structuredClone !== 'function') return;
      const obj = { a: 1 };
      obj.self = obj;
      const cloned = deepClone(obj);
      expect(cloned.a).toBe(1);
      expect(cloned.self).toBe(cloned);
    });

    test('throws on non-cloneable values when structuredClone is available', () => {
      if (typeof structuredClone !== 'function') return;
      // Functions are not structured-cloneable. deepClone mirrors structuredClone
      // semantics: it throws rather than silently degrading. Use jsonClone for
      // safe lossy clones.
      const original = { fn: () => {} };
      expect(() => deepClone(original)).toThrow();
    });
  });

  describe('stableStringify', () => {
    test('sorts object keys so equivalent objects serialize identically', () => {
      expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
      expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    test('pretty-prints when indent is 2', () => {
      expect(stableStringify({ b: 1, a: 2 }, 2)).toBe('{\n  "a": 2,\n  "b": 1\n}');
    });
  });
});
