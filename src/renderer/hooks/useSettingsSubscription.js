// @ts-check
/**
 * useSettingsSubscription Hook
 *
 * Subscribes to external settings changes from the main process.
 * FIX: Phases weren't receiving runtime settings updates (e.g., AI host changes).
 */

import { useEffect, useRef } from 'react';
import { logger } from '../../shared/logger';

function stableSerialize(/** @type {any} */ value) {
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return Object.keys(val)
            .sort()
            .reduce((/** @type {Record<string, any>} */ acc, nextKey) => {
              acc[nextKey] = val[nextKey];
              return acc;
            }, /** @type {Record<string, any>} */ ({}));
        }
        return val;
      },
      0
    );
  } catch {
    return null;
  }
}

/**
 * Main sends either the settings object or `{ settings }`.
 * @param {any} payload
 * @returns {Record<string, any> | null}
 */
function normalizeSettingsPayload(payload) {
  const settings =
    payload &&
    typeof payload === 'object' &&
    payload.settings &&
    typeof payload.settings === 'object'
      ? payload.settings
      : payload;
  return settings && typeof settings === 'object' ? settings : null;
}

function areValuesEqual(/** @type {any} */ a, /** @type {any} */ b) {
  if (Object.is(a, b)) return true;
  const aIsObject = a && typeof a === 'object';
  const bIsObject = b && typeof b === 'object';
  if (!aIsObject || !bIsObject) return false;
  const aSerialized = stableSerialize(a);
  const bSerialized = stableSerialize(b);
  return aSerialized != null && aSerialized === bSerialized;
}

/**
 * Hook that subscribes to settings changes from the main process
 * and calls the provided callback when settings change.
 *
 * @param {Function} onSettingsChanged - Callback called with the updated settings
 * @param {{ enabled?: boolean, watchKeys?: string[] | null }} [options]
 */
export function useSettingsSubscription(onSettingsChanged, options = {}) {
  const { enabled = true, watchKeys = null } = options;
  const callbackRef = useRef(onSettingsChanged);
  const lastSettingsRef = useRef(null);
  const lastWatchedValuesRef = useRef({});

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = onSettingsChanged;
  }, [onSettingsChanged]);

  // Memoize watchKeys to prevent infinite re-subscription loops when array is passed inline
  // We serialize the array to create a stable string key for comparison
  const watchKeysKey = watchKeys ? JSON.stringify([...watchKeys].sort()) : null;
  const watchKeysRef = useRef(watchKeys);
  useEffect(() => {
    watchKeysRef.current = watchKeys;
  }, [watchKeysKey, watchKeys]);

  useEffect(() => {
    // Reset snapshot when subscription scope changes so we don't compare
    // values from a previous watch-key configuration.
    lastSettingsRef.current = null;
    lastWatchedValuesRef.current = {};
  }, [enabled, watchKeysKey]);

  useEffect(() => {
    if (!enabled) return () => {};

    let disposed = false;

    const handleSettingsChanged = (/** @type {any} */ payload) => {
      try {
        const normalizedSettings = normalizeSettingsPayload(payload);
        if (!normalizedSettings) {
          return;
        }
        // If watching specific keys, filter to only those changes
        const currentWatchKeys = watchKeysRef.current;
        if (currentWatchKeys && Array.isArray(currentWatchKeys)) {
          /** @type {Record<string, any>} */
          const previousWatchedValues = lastWatchedValuesRef.current || {};
          /** @type {Record<string, any>} */
          const nextWatchedValues = { ...previousWatchedValues };
          /** @type {Record<string, any>} */
          const relevantChanges = {};
          let hasRelevantChange = false;

          currentWatchKeys.forEach((/** @type {string} */ key) => {
            if (!(key in normalizedSettings)) return;
            const nextValue = normalizedSettings[key];
            const prevValue = previousWatchedValues[key];
            const hasPreviousValue = Object.prototype.hasOwnProperty.call(
              previousWatchedValues,
              key
            );
            nextWatchedValues[key] = nextValue;
            // Main broadcasts the whole settings object on every save, import
            // and at startup. A key with no baseline yet is recorded, not
            // reported: otherwise the first broadcast after mount claims
            // every watched setting changed.
            if (hasPreviousValue && !areValuesEqual(prevValue, nextValue)) {
              relevantChanges[key] = nextValue;
              hasRelevantChange = true;
            }
          });

          lastWatchedValuesRef.current = nextWatchedValues;
          lastSettingsRef.current = normalizedSettings;

          if (hasRelevantChange) {
            callbackRef.current?.(relevantChanges);
          }
        } else {
          // No filter, pass all settings
          lastSettingsRef.current = normalizedSettings;
          callbackRef.current?.(normalizedSettings);
        }
      } catch (error) {
        logger.error('Error handling settings change:', error);
      }
    };

    // Seed the watched baseline with the current settings, so a real change
    // that arrives as the first broadcast after mount is still reported.
    // Keys an event already recorded are newer than this read and are kept.
    const seedKeys = watchKeysRef.current;
    const getSettings = window.electronAPI?.settings?.get;
    if (Array.isArray(seedKeys) && typeof getSettings === 'function') {
      Promise.resolve()
        .then(() => getSettings())
        .then(
          /**
           * @param {any} result
           * @returns {null}
           */
          (result) => {
            const current = normalizeSettingsPayload(result);
            if (disposed || !current) return null;
            /** @type {Record<string, any>} */
            const seeded = { ...(lastWatchedValuesRef.current || {}) };
            seedKeys.forEach((/** @type {string} */ key) => {
              if (key in current && !Object.prototype.hasOwnProperty.call(seeded, key)) {
                seeded[key] = current[key];
              }
            });
            lastWatchedValuesRef.current = seeded;
            return null;
          }
        )
        .catch((/** @type {any} */ error) => {
          // Without a seed the first broadcast becomes the baseline.
          logger.debug('Could not read settings to seed the watched baseline', {
            error: error?.message
          });
        });
    }

    // Subscribe to settings changes
    let unsubscribe = null;
    if (window.electronAPI?.events?.onSettingsChanged) {
      unsubscribe = window.electronAPI.events.onSettingsChanged(handleSettingsChanged);
      logger.debug('Subscribed to settings changes');
    } else {
      logger.warn('Settings change subscription not available');
    }

    // Cleanup
    return () => {
      disposed = true;
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
          logger.debug('Unsubscribed from settings changes');
        } catch (error) {
          logger.error('Error unsubscribing from settings:', error);
        }
      }
    };
  }, [enabled, watchKeysKey]);
}
