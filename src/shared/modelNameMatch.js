// @ts-check
/**
 * Installed-model name matching (exact, then fuzzy for legacy short names).
 * Shared by the reanalyze preflight in ipc/semantic and the smart-folder
 * watcher's provisional-retry check (F-195), so a service can ask "is this
 * model installed?" without importing IPC handler registration.
 */

/**
 * @param {string|null|undefined} name
 * @returns {string}
 */
function normalizeModelName(name) {
  return String(name || '')
    .toLowerCase()
    .trim();
}

/**
 * @param {string[]|null|undefined} installedModelNames
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
function findInstalledModelMatch(installedModelNames, model) {
  const normalizedModel = normalizeModelName(model);
  if (!normalizedModel) return null;
  const validModelNames = Array.isArray(installedModelNames)
    ? installedModelNames.map((name) => String(name || '').trim()).filter(Boolean)
    : [];

  // Exact, case-insensitive match
  const exact = validModelNames.find((name) => normalizeModelName(name) === normalizedModel);
  if (exact) return exact;

  // Fuzzy match for legacy/stale names (e.g. "mistral" -> "mistral-7b-...gguf")
  return (
    validModelNames.find((name) => normalizeModelName(name).includes(normalizedModel)) ||
    validModelNames.find((name) => normalizedModel.includes(normalizeModelName(name))) ||
    null
  );
}

module.exports = { normalizeModelName, findInstalledModelMatch };
