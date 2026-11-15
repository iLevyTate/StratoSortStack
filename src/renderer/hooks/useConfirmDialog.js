// @ts-check
import React from 'react';
import { createLogger } from '../../shared/logger';
import { ConfirmModal } from '../components/ui/Modal';

const logger = createLogger('useConfirmDialog');

/**
 * @typedef {{ title?: string, message: any, confirmText?: string, cancelText?: string,
 *   variant?: string, fileName?: any }} ConfirmOptions
 * @typedef {ConfirmOptions & { alternativeText: string }} ChoiceOptions
 */

export function useConfirmDialog() {
  const [confirmState, setConfirmState] = React.useState({
    isOpen: false,
    title: '',
    message: /** @type {any} */ (''),
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    alternativeText: /** @type {string | null} */ (null),
    variant: 'default',
    fileName: null,
    onConfirm: /** @type {null | (() => void)} */ (null),
    onAlternative: /** @type {null | (() => void)} */ (null)
  });
  // Resolves the open dialog's promise with its "closed" value.
  const resolverRef = React.useRef(/** @type {null | ((value: any) => void)} */ (null));
  const closedValueRef = React.useRef(/** @type {any} */ (false));

  /**
   * Open the dialog. `answers` maps each button to the value the promise
   * resolves with; closing it (Cancel, Escape) resolves with `closed`.
   */
  const open = React.useCallback(
    (
      /** @type {ConfirmOptions & { alternativeText?: string | null }} */
      {
        title = 'Confirm action',
        message,
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        alternativeText = null,
        variant = 'default',
        fileName = null
      },
      /** @type {{ confirm: any, alternative: any, closed: any }} */ answers
    ) =>
      new Promise((resolve) => {
        if (typeof resolverRef.current === 'function') {
          resolverRef.current(closedValueRef.current);
        }
        resolverRef.current = resolve;
        closedValueRef.current = answers.closed;
        /** @param {any} value */
        const answer = (value) => () => {
          resolve(value);
          resolverRef.current = null;
          setConfirmState((prev) => ({ ...prev, isOpen: false }));
        };
        setConfirmState({
          isOpen: true,
          title,
          message,
          confirmText,
          cancelText,
          alternativeText,
          variant,
          fileName,
          onConfirm: answer(answers.confirm),
          onAlternative: alternativeText ? answer(answers.alternative) : null
        });
      }),
    []
  );

  /** Resolves true on confirm, false when closed. */
  const showConfirm = React.useCallback(
    (/** @type {ConfirmOptions} */ options) =>
      open(options, { confirm: true, alternative: true, closed: false }),
    [open]
  );

  /**
   * A dialog with two real choices and a way out: resolves 'confirm',
   * 'alternative', or null when closed (Cancel, Escape).
   */
  const showChoice = React.useCallback(
    (/** @type {ChoiceOptions} */ options) =>
      /** @type {Promise<'confirm' | 'alternative' | null>} */ (
        open(options, { confirm: 'confirm', alternative: 'alternative', closed: null })
      ),
    [open]
  );

  const hideConfirm = React.useCallback(() => {
    if (typeof resolverRef.current === 'function') {
      try {
        resolverRef.current(closedValueRef.current);
      } catch (error) {
        // Fixed: Log resolver errors instead of silently swallowing
        logger.warn('Error calling resolver', {
          error: error.message,
          stack: error.stack
        });
      }
      resolverRef.current = null;
    }
    setConfirmState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Return JSX element directly instead of a component function
  // This avoids the anti-pattern of defining components inside hooks
  // Wrapped in useMemo to stabilize the reference and prevent unnecessary re-renders
  const confirmDialog = React.useMemo(
    () =>
      confirmState.isOpen ? (
        <ConfirmModal
          {...{
            isOpen: confirmState.isOpen,
            onClose: hideConfirm,
            onConfirm: confirmState.onConfirm,
            title: confirmState.title,
            message: confirmState.message,
            confirmText: confirmState.confirmText,
            cancelText: confirmState.cancelText,
            variant: confirmState.variant,
            fileName: confirmState.fileName,
            ...(confirmState.onAlternative
              ? {
                  alternativeText: confirmState.alternativeText,
                  onAlternative: confirmState.onAlternative
                }
              : {})
          }}
        />
      ) : null,
    [confirmState, hideConfirm]
  );

  // Return both the old API (ConfirmDialog as a function for backwards compatibility)
  // and the new recommended API (confirmDialog as JSX element)
  const ConfirmDialog = React.useCallback(() => confirmDialog, [confirmDialog]);

  return { showConfirm, showChoice, ConfirmDialog, confirmDialog };
}
