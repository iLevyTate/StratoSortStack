# Orama vector sidecar (v3.x workaround)

## Background

Orama v3.1.x can lose or zero out vector fields after a persist/restore cycle. StratoSort keeps a
parallel **sidecar** (`*.sidecar.json` under the vector DB directory) with full embedding arrays and
prefers those values over `getByID()` for search and scoring.

## Root cause found (2026-09-29): search nulls stored vectors

At least one source of the "lost vectors" is not restore at all. In Orama 3.1.18, `search()` without
`includeVectors: true` sets the vector property to `null` **on the stored document** of every hit:
`search-vector.js` assigns `doc[vectorProperty] = null` on `orama.data.docs`, and
`search-fulltext.js`'s `removeVectorsFromHits` reduces into `result.document` itself. The in-memory
vector index keeps answering, which hides it, but `getByID()` then returns `embedding: null` and the
next persist writes the nulls to disk, so restore finds nothing and inserts a zero placeholder.

Consequences before the fix: every chunk clone on an organize move failed (so moves dropped the
file's passage vectors), and chunk vectors, which had no sidecar, did not survive a restart once any
query had returned them.

Fix: every query in `OramaVectorService` goes through `searchPreservingStoredVectors`, which passes
`includeVectors: true` and strips vectors from **copies** of full-text hits. Chunk vectors are now
recorded in the sidecar map on upsert/clone and removed on delete, like files and folders. Chunk
vectors already lost on an existing install come back with one Rebuild. Keep the sidecar until a
restore round-trip is verified without it.

## `where` on a string property is not exact

`search(db, { term: '', where: { fileId } })` returns the union over the value's tokens, so it also
matches rows of other files that share a path segment or the `file:` prefix (often the whole
collection). Chunk get/clone/delete and the delete cascades go through `_collectExactFileChunkHits`,
and `deleteFileByPath`/`findByHash` re-check the value on each hit. Any new `where` on a string
property must do the same.

## Tracking upstream

File a GitHub issue on [Orama](https://github.com/oramasearch/orama) if you confirm a regression on
a newer version, and reference this document. `package.json` declares `@orama/orama: ^3.0.0`; the
resolved version is pinned by `package-lock.json`. Avoid bumping the caret range until any restore
regression is verified fixed upstream.

## Runtime validation

On startup, `OramaVectorService` spot-checks random document IDs in the `files` and `folders`
collections, comparing sidecar vectors to `getByID()`. Mismatches log a warning (possible drift).

## Not to be confused with: the similarity-cutoff "empty query" symptom

A recurring `Empty folder vector query with populated sidecar; attempting folders index repair`
warning (with a ~1s rebuild on every analysis) looked like restore vector-loss but was **not**.
Orama's vector search applies a default minimum-similarity cutoff (`DEFAULT_SIMILARITY = 0.8`).
Folder routing queries a _document_ embedding against _folder_ embeddings, whose cosine similarity
is almost always below 0.8, so native search returned zero hits even though the index was fully
populated. The health/repair path misread that as corruption.

Fix: `queryFoldersByEmbedding` passes an explicit similarity floor of 0
(`VECTOR_SEARCH_MIN_SIMILARITY` in `OramaVectorService`) so Orama returns ranked top-K candidates
and `FolderMatchingService` owns the score threshold. The file and chunk legs of hybrid search had
the same inherited 0.8 and now pass the same floor. Correction-memory lookup passes an explicit 0.8
(`FEEDBACK_MEMORY_MIN_SIMILARITY`). Any new vector search must pass `similarity` explicitly; do not
rely on the Orama default.

## Future removal

When Orama ships a reliable vector restore:

1. Remove sidecar read/write paths in `OramaVectorService`.
2. Add a one-time migration that writes sidecar embeddings back into Orama-native storage.
3. Delete sidecar files after successful migration.
