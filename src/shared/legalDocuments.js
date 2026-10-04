// @ts-check
/**
 * Bundled legal document identifiers and filenames.
 * Files ship via electron-builder extraResources (packaged) or live at the
 * repository root during development.
 */
const LEGAL_DOCUMENT_KINDS = Object.freeze(['license', 'privacy', 'security']);

const LEGAL_DOCUMENT_FILES = Object.freeze({
  license: 'LICENSE',
  privacy: 'PRIVACY.md',
  security: 'SECURITY.md'
});

module.exports = {
  LEGAL_DOCUMENT_KINDS,
  LEGAL_DOCUMENT_FILES
};
