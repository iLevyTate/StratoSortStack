// @ts-check
/**
 * Recursively serializes an object, converting Date objects to ISO strings.
 * Used to sanitize data before storing in Redux to avoid non-serializable value errors.
 *
 * Cycle detection is ancestor-only: a sibling that happens to be the same
 * object reference is serialized again, not replaced with `[Circular]`.
 */
/**
 * @param {any} data
 * @param {any[]} [_ancestors]
 * @returns {any}
 */
export const serializeData = (data, _ancestors) => {
  if (data === null || data === undefined) return data;

  if (data instanceof Date) {
    return data.toISOString();
  }

  if (data instanceof Error) {
    return { message: data.message, name: data.name, stack: data.stack };
  }

  if (Array.isArray(data)) {
    const ancestors = _ancestors || [];
    if (ancestors.includes(data)) return '[Circular]';
    const next = ancestors.concat([data]);
    return data.map((item) => serializeData(item, next));
  }

  if (typeof data === 'object') {
    const ancestors = _ancestors || [];
    if (ancestors.includes(data)) return '[Circular]';
    const next = ancestors.concat([data]);
    /** @type {Record<string, any>} */
    const serialized = {};
    Object.keys(data).forEach((key) => {
      serialized[key] = serializeData(data[key], next);
    });
    return serialized;
  }

  return data;
};
