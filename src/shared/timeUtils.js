// @ts-check
/** @returns {string} */
function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {string|null}
 */
function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0];
}

module.exports = {
  nowIso,
  toIsoDate
};
