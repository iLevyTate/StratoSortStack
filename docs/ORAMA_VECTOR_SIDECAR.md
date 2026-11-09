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

## The sidecar is durable state, never a cache (2026-11-08)

The sidecar map used to evict its oldest entry once it held more than 10,000 vectors
(`_maxEmbeddingStoreSize`) and zero that document's vector in Orama. Restore repairs vectors from
the saved sidecar, so on a library past the cap every evicted document came back without a usable
vector: startup repair and `onlyMissing` backfills re-embedded them on every launch, and vector
search silently left them out. With the cap set to 3, upserting a, b, c, d left three usable
documents.

The cap is gone for files and folders (chunks never had one). A vector whose document is still in
its collection stays in the in-memory map and in the saved `*.sidecar.json`; entries leave only when
the document is deleted or its collection is reset. Pinned by
`test/OramaVectorService.uncappedSidecar.test.js`.

What the cap was worth in memory, measured on Node 24 (V8 heap + array buffers, 768-dim vectors):

| What                                            | Bytes per vector |
| :---------------------------------------------- | ---------------: |
| `number[]` as JSON.parse / the service holds it |           ~6,200 |
| `Float32Array` copy in Orama's vector index     |           ~3,280 |
| Sidecar `Map` entry (shares the doc's array)    |           ~20-60 |
| Saved JSON text (sidecar file, per vector)      |    ~15,200 chars |

The sidecar map references the same array as the stored Orama document (measured: 2,000 of 2,000
upserted documents share it; restore stores the inserted array too), so the map itself costs tens of
bytes per document: about 0.2-0.6 MB per 10,000 documents. The cap bounded none of the real cost
(the document's own array and Orama's index copy, ~9.5 KB per 768-dim vector), which stays as long
as the document exists. Each document's vector is also written twice on disk, once in the collection
blob and once in the sidecar (~15 KB each at 768 dims).

## A saved file the store did not read is never saved over (2026-11-09)

Two cases leave a collection's file on disk unread for the session: it decompresses past the longest
string V8 can build (`too-large-to-read`), or the LZ4 binding did not load and the file is a
`.json.lz4` (`lz4-unavailable`). Either way the collection starts this session without that data, so
writing it would replace the library on disk with whatever the session holds.

Such a collection is listed in `_saveBlocked` (collection name to reason). While it is listed, a
save writes neither its blob nor its sidecar and rotates no `.bak` over it; the save result lists it
in `saveBlocked`. The block used to be "the empty stand-in object is still the live collection", so
the automatic files/folders index repair (run by the health probe after every batch upsert, and by
an empty folder query) swapped in a new object, lifted the block and saved over the unread file. It
is now a flag:

- Automatic repairs never lift it, and the health checks skip auto-repair for a blocked collection.
- Only a deliberate reset (`resetFiles`, `resetFolders`, `resetFileChunks`, `resetFeedbackMemory`,
  `resetLearningPatterns`, and so `resetAll` / Full Rebuild) lifts `too-large-to-read`.
- `lz4-unavailable` is never lifted in-session: a plain `.json` written now would be ignored next to
  the `.lz4` once the binding loads (restore reads `.lz4` first), and its sidecar would replace the
  one the `.lz4` needs. The session's changes to that collection stay in memory; the next launch
  with the binding restores the untouched `.lz4` and its sidecar. `resetAll` reports
  `persisted: false` while such a block remains. Collections that had no `.json.lz4` still save as
  plain `.json` and are read back from it.
- A save that replaces `<name>.json.lz4` no longer deletes a `<name>.json` newer than it (written by
  an older binding-less session, or with compression off; restore did not read it). It is renamed to
  `<name>.json.newer-than-lz4.<timestamp>.bak` and a warning is logged.

Pinned by `test/OramaVectorService.saveSafety.test.js` ("a collection too large to read") and
`test/OramaVectorService.lz4Unavailable.test.js`.

### What "saved" means to callers

`persistAll()` resolves `{ success, tooLargeToSave?, saveBlocked? }`. `success: true` means the
round did not fail, not that every collection reached disk. Resets and repairs report through
`_reportSave(what, saved, collections)`, which returns `persisted: false` when one of the named
collections was skipped. Full Rebuild's retry save (`src/main/ipc/semantic.js`) does the same for
`files`, `folders` and `fileChunks`, so `rebuildInProgress` stays set when the rebuilt index did not
reach disk.

### Files health probe

The files probe searches with `where: { isOrphaned: false, hasVector: true }`, so it now picks its
probe vector from a sidecar entry whose document is live (not orphaned, `hasVector` not false). It
used the first sidecar entry before: when that row was orphaned the probe could never pass, so every
batch upsert rebuilt and fully saved the files index and `primaryHealthy` stayed false. With no live
row to probe the collection counts as healthy (`no-valid-probe`). Pinned by
`test/OramaVectorService.filesRepair.test.js`.

### Quitting during a save

`cleanup()` waits for any running save (`_waitForSaveIdle`, the same wait `persistAll()` uses)
before each final save round, and again before clearing the in-memory collections. Before, a
`persistAll()` that started its save while cleanup waited made each final round return "A save is
already running", and cleanup cleared `_databases` under that save (a TypeError, collections not
written). If a save is still running after 120 s, cleanup logs an error and leaves the collections
in memory instead of clearing them. Pinned by `test/OramaVectorService.cleanupRace.test.js`.

## Restore parses in a worker thread

Reading a saved collection back (read, LZ4 decode, `JSON.parse`, prototype-pollution strip) used to
run on the main process: ~350 ms for a 121 MB collection and ~350 ms more for its 118 MB sidecar
(8,000 documents x 768 dims), ~1.1 s for a 264 MB collection, all with no IPC answered.
`_createOrRestoreDatabase` now hands each file to `src/main/workers/oramaRestoreWorker.js`, which
runs the same loader (`oramaRestoreLoader.js`) the main thread used, and sends back:

- documents in batches of 512, each batch's embeddings as one transferred `Float64Array` (zero copy,
  exact values) with `embedding: null` left in place on each document. The main side asks for the
  next batch from a `setImmediate` (Node delivers queued port messages back to back, so sending
  every batch at once would deserialize them all in one block) and writes a plain `number[]` back
  into each document;
- the sidecar as one `Float64Array` plus its ids. Vectors are built only when restore asks for one
  (a document saved without its embedding, or the repair pass), which is rarely.

On-disk format, the order sources are tried in (`.json.lz4`, `.json`, `.bak`), and every outcome
restore distinguishes (missing, unreadable or corrupt LZ4, too large for a string, decodes to
nothing, does not parse, no documents) are unchanged: the worker reports the loader's outcome with
the error's name, message and code, and the main side handles it exactly as before. Files under 4 MB
are parsed in-process (a thread costs more than parsing them). If the worker cannot start, dies,
replies `fatal` (for example the LZ4 binding does not load in it) or sends nothing for 120 s, the
file is read in-process with the same loader, the failure is logged once, and the rest of the
session reads in-process. `STRATOSORT_ORAMA_RESTORE_WORKER=false` turns the worker off; under tests
it is off unless set to `true`. The "Restored ... database" log line says where each collection and
its sidecar were parsed (`parsedIn`, `sidecarParsedIn`).

Packaging: `oramaRestoreWorker` is a `webpack.main.config.js` entry and is unpacked to
`app.asar.unpacked/dist/` like the other worker bundles; `@antoniomuso/lz4-napi-*` (the LZ4
binding's platform packages) is unpacked whole so the worker, which resolves modules from
`app.asar.unpacked`, can load the binding.

Measured on the synthetic 8,000-document x 768-dim `files` collection (96 MB `.json.lz4`, 118 MB
sidecar), Node 24 on Windows, largest gap seen by a `setImmediate` probe:

| Phase                           |                                   Main thread (before) |                 Worker (after) |
| :------------------------------ | -----------------------------------------------------: | -----------------------------: |
| Parse collection + sidecar      |                                         385 ms max gap |                  11 ms max gap |
| Full `_createOrRestoreDatabase` | 497-512 ms max gap, 2 gaps > 50 ms (~870-900 ms total) | 25-45 ms max gap, none > 50 ms |
| Wall time, full restore         |                                            1.46-1.63 s |                    1.69-1.95 s |
| RSS after restore               |                                                ~905 MB |                        ~670 MB |

The worker's remaining main-thread cost is taking in each batch (structured-clone of the vector-free
metadata plus writing 512 vector arrays, a few ms) and Orama's own inserts, which yield every 256
documents (the 25-45 ms gaps). Wall time grows by ~0.2-0.3 s (thread start and the extra copy into
the `Float64Array`). Peak memory moves rather than grows: the decoded text and parse tree now live
in the worker's heap and are freed when it exits.

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
