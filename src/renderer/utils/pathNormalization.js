// @ts-check
import { normalizeText } from '../../shared/normalization/text';
import { safeBasename } from './pathUtils';

const coercePathValue = (/** @type {any} */ value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.path === 'string') {
    return value.path;
  }
  return '';
};

const stripWrappingQuotes = (/** @type {any} */ value) => value.replace(/^(['"])(.*)\1$/, '$2');

const decodeFileUrl = (/** @type {any} */ value) => {
  if (!value.toLowerCase().startsWith('file://')) return value;
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname || '');
    if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) {
      return pathname.slice(1);
    }
    return pathname;
  } catch {
    return value;
  }
};

export const normalizePathValue = (
  /** @type {any} */ value,
  /** @type {{ maxLength?: number, collapseWhitespace?: boolean }} */ options = {}
) => {
  const raw = coercePathValue(value);
  if (!raw) return '';
  const { maxLength = 2048, collapseWhitespace = false } = options;
  const trimmed = normalizeText(raw, { maxLength, collapseWhitespace, trim: true });
  const unquoted = stripWrappingQuotes(trimmed);
  return decodeFileUrl(unquoted);
};

export const normalizeFileUri = (
  /** @type {any} */ value,
  /** @type {{ maxLength?: number, collapseWhitespace?: boolean }} */ options = {}
) =>
  normalizePathValue(value, {
    ...options,
    collapseWhitespace: options.collapseWhitespace ?? false
  });

export const isAbsolutePath = (/** @type {any} */ value, options = {}) => {
  const normalized = normalizePathValue(value, options);
  if (!normalized) return false;
  return (
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('/')
  );
};

export const extractFileName = (/** @type {any} */ value) => safeBasename(coercePathValue(value));
