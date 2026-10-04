// @ts-check
/**
 * textModelActivity — process-wide refcount of in-flight interactive text
 * generations.
 *
 * Background pipelines (batch analysis, smart-folder watchers) check this
 * before scheduling their own LLM work so a user-initiated chat or
 * folder-suggestion request never has to fight a background job for the
 * single LLM context. Callers acquire by calling
 * `beginInteractiveTextRequest()` and release by invoking the returned
 * function (idempotent).
 */
let interactiveTextRequestCount = 0;

function beginInteractiveTextRequest() {
  interactiveTextRequestCount += 1;
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    interactiveTextRequestCount = Math.max(0, interactiveTextRequestCount - 1);
  };
}

function isInteractiveTextRequestActive() {
  return interactiveTextRequestCount > 0;
}

function getInteractiveTextRequestCount() {
  return interactiveTextRequestCount;
}

module.exports = {
  beginInteractiveTextRequest,
  isInteractiveTextRequestActive,
  getInteractiveTextRequestCount
};
