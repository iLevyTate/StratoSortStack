/**
 * Chunked lint-staged config. Windows CMD has an ~8,191-char argv limit;
 * large changesets (merge commits, sweeping refactors) blow past it when
 * lint-staged passes hundreds of paths to a single `eslint`/`prettier`
 * invocation. We split the file list into batches of MAX_FILES_PER_BATCH
 * so each spawned command stays well under the limit.
 *
 * Each returned command runs sequentially. If any chunk fails, lint-staged
 * still reverts the stash via its normal failure path.
 */

const MAX_FILES_PER_BATCH = 50;

function batched(files, command) {
  const out = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_BATCH) {
    const chunk = files
      .slice(i, i + MAX_FILES_PER_BATCH)
      .map((f) => `"${f}"`)
      .join(' ');
    out.push(`${command} ${chunk}`);
  }
  return out;
}

module.exports = {
  '*.{js,jsx,ts,tsx}': (files) => [
    ...batched(files, 'eslint --cache --fix'),
    ...batched(files, 'prettier --write')
  ],
  '*.{json,md,yml,yaml,css,scss}': (files) => batched(files, 'prettier --write')
};
