// @ts-check
/**
 * True when the event target is (or is inside) an editable field.
 * Used to avoid hijacking global shortcuts while typing.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;

  if (target.isContentEditable) return true;

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]'
    )
  );
}
