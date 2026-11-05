// @ts-check
/**
 * The request the duplicate dialog's "Send to Trash" sends to the main process.
 *
 * Byte-identical sets were grouped on a fingerprint stored when each file was
 * indexed, and a file edited since keeps its old one. Each such set therefore
 * also names the copy being kept, so main can read the bytes again and leave
 * any copy that no longer matches it.
 *
 * @param {Array<{ keep?: any, delete: any[], tier?: string }>} resolutions
 * @returns {{ paths: string[], summary: { label: string, tier: string }, verifyIdentical?: Array<{ keep: string, paths: string[] }> }}
 */
export function buildTrashDuplicatesRequest(resolutions) {
  /** @param {any} file */
  const pathOf = (file) => file?.path || file?.id;
  const paths = resolutions.flatMap((r) => r.delete.map(pathOf).filter(Boolean));
  const tiers = new Set(resolutions.map((r) => r.tier).filter(Boolean));
  const summary = {
    label: 'Delete duplicates',
    tier: tiers.size === 1 ? /** @type {string} */ ([...tiers][0]) : 'mixed'
  };
  const verifyIdentical = resolutions
    .filter((r) => r.tier === 'exact' && pathOf(r.keep))
    .map((r) => ({ keep: pathOf(r.keep), paths: r.delete.map(pathOf).filter(Boolean) }));
  return verifyIdentical.length > 0 ? { paths, summary, verifyIdentical } : { paths, summary };
}
