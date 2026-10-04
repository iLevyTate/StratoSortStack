// @ts-check
/**
 * Lazy `sharp` loader shared by document extraction, image analysis, and
 * the image preprocess worker. Each caller gets its own cache so a failed
 * load in one context cannot poison another, while the require() path stays
 * in one place.
 *
 * @param {{ logger?: { warn?: Function, debug?: Function }, label?: string, concurrency?: number }} [options]
 *   `label` is the complete warn message logged when sharp fails to load.
 * @returns {(() => any) & { getLoadError: () => Error|null, reset: () => void }}
 */
function createSharpLoader(options = {}) {
  const { logger, label = '[sharp] sharp unavailable', concurrency } = options;
  /** @type {any} */
  let sharpModule = null;
  let attempted = false;
  /** @type {Error|null} */
  let loadError = null;

  function getSharp() {
    if (attempted) return sharpModule;
    attempted = true;
    try {
      sharpModule = require('sharp');
      if (typeof concurrency === 'number' && typeof sharpModule.concurrency === 'function') {
        try {
          sharpModule.concurrency(concurrency);
        } catch (concErr) {
          logger?.debug?.(`${label} concurrency failed`, { error: concErr?.message });
        }
      }
    } catch (error) {
      loadError = error;
      sharpModule = null;
      logger?.warn?.(label, {
        error: error?.message,
        code: error?.code
      });
    }
    return sharpModule;
  }

  getSharp.getLoadError = () => loadError;
  getSharp.reset = () => {
    sharpModule = null;
    attempted = false;
    loadError = null;
  };

  return getSharp;
}

module.exports = { createSharpLoader };
