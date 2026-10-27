---
layout: single
title: 'IPC Contracts'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/14_settings_panel_top.webp
  caption: 'IPC Channel Contracts Reference'
---

# IPC Contracts Reference

This document describes the IPC payload contracts used between the renderer and main processes.
Schemas are defined in code and should be treated as the source of truth.

## Sources of Truth

- Input validation schemas: `src/main/ipc/validationSchemas.js`
- Event payload schemas: `src/shared/ipcEventSchemas.js`
- IPC handlers and channel registration: `src/main/ipc/*`
- Renderer event validation: `src/renderer/store/middleware/ipcMiddleware.js`

## Input Validation (Renderer -> Main)

Most IPC handlers use `createHandler()` or `withValidation()` to validate inputs. When Zod is
available, `validationSchemas.js` defines the expected shapes for:

- Settings payloads
- File operations (single + batch)
- Analysis inputs (single + batch)
- Suggestions and feedback payloads
- Embeddings search and query inputs

If Zod is not available, a fallback validator performs basic checks for critical fields.

## Event Payloads (Main -> Renderer)

Event payloads are validated in `ipcMiddleware.js` using schemas in `ipcEventSchemas.js`. If a
schema exists for a channel, an invalid payload is logged and **dropped** (not dispatched). Channels
without a schema pass through unvalidated. `npm run verify:ipc-event-schemas` (part of `ci`) fails
when a push event sent from main has no schema.

## Adding or Modifying a Contract

1. Add/modify a schema in `src/main/ipc/validationSchemas.js` or `src/shared/ipcEventSchemas.js`.
2. Update handlers to reference the schema (or to normalize inputs).
3. Update tests if the payload shape changes.
4. Ensure new payloads are documented here.

## Conventions

- Use normalized paths and IDs (see `src/shared/pathSanitization.js`).
- Keep query strings trimmed and bounded in length.
- Prefer the structured error envelope `{ success: false, error: { code, message, details } }`
  produced by `createErrorResponse()`; the original error name lands in `error.details.errorType`.
  Renderer code must normalize `error` to a string (`toErrorMessage`) before rendering it.

## Concurrency-Limited Channels

Some channels mutate shared state or hold expensive resources (multi-GB model loads, full-library
scans) and are serialized via `CONCURRENCY_LIMITED_CHANNELS`, defined in
`src/shared/ipcEnforcement.js` (the source of truth) and consumed by the preload bridge. A second
`invoke()` against the same channel while one is in-flight rejects synchronously with
`Operation already in progress: <channel>`.

| Channel                          | Why serialized                                                  |
| :------------------------------- | :-------------------------------------------------------------- |
| `embeddings:full-rebuild`        | Multi-GB model + index reload                                   |
| `embeddings:reanalyze-all`       | Library-wide AI work; pins inference slots                      |
| `embeddings:rebuild-files`       | Index rebuild against current state                             |
| `embeddings:rebuild-folders`     | Same as above for folders index                                 |
| `embeddings:compute-clusters`    | Long full-corpus pass                                           |
| `embeddings:rebuild-bm25`        | Full reindex                                                    |
| `embeddings:find-duplicates`     | Pairwise scan over all vectors                                  |
| `embeddings:trash-duplicates`    | Mutates store + filesystem                                      |
| `embeddings:reindex-file-hashes` | Full hash-rebuild walk                                          |
| `embeddings:clear-clusters`      | Mutates cluster state                                           |
| `embeddings:rename-cluster`      | Mutates cluster state                                           |
| `embeddings:diagnose-search`     | Walks the full retrieval pipeline; holds a model slot           |
| `analysis:analyze-batch`         | Batch IO + pipeline coordination                                |
| `analysis:analyze-media`         | Per-file ffmpeg + Whisper slot pinning                          |
| `organize:auto`                  | LLM analysis + atomic moves over the same files                 |
| `organize:batch`                 | Atomic batch moves; overlapping runs could double-move or race  |
| `llama:download-model`           | Multi-GB download                                               |
| `llama:delete-model`             | Filesystem mutation against active models dir                   |
| `llama:update-config`            | Reloads model in-place                                          |
| `llama:test-connection`          | Triggers cold model load if needed; coalesced in `LlamaService` |
| `ai-provider:test-provider`      | Round-trips a real LLM call                                     |
| `system:dismiss-degraded-flag`   | Mutates the shared `degradedState` map                          |

Downloads-triage channels (`start`, `deep-scan`, `act`) share a single lock key
(`DOWNLOADS_TRIAGE_MUTATION_LOCK_KEY`) so any one of the three in-flight blocks the others.
