// @ts-check
/**
 * Small className join helper (avoids new deps).
 */
export function cx(/** @type {any[]} */ ...parts) {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter(Boolean)
    .join(' ');
}
