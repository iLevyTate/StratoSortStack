// @ts-check
'use strict';

/**
 * Encode one CSV field per RFC 4180 with a spreadsheet formula-injection guard.
 *
 * Quote-doubling is used rather than JSON backslash escaping — the latter
 * corrupts Windows paths and quoted names in Excel/Sheets/pandas. String cells
 * starting with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe so they
 * render as text instead of being evaluated (file names and analysis output
 * are attacker-influenced); guarded cells are always quoted so the marker
 * survives parsers that trim leading characters. Numbers pass through bare.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let s = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(s);
  if (guarded) s = `'${s}`;
  if (guarded || /[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = { csvCell };
