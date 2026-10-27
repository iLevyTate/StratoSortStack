# Semantic Pipeline — Ingestion, Chunking, Embedding & Retrieval

Reference for how StratoSort Stack handles document understanding, vector search and chat retrieval:
the problems each stage solves in chunking, embedding, retrieval speed and multi-modal file support.

By default all processing is **local and in-process** (node-llama-cpp + Orama) and no data leaves
the machine. If a user opts into a BYOK cloud provider, text analysis, chat and organization
suggestions can be routed to it (see [`AI_PROVIDERS.md`](AI_PROVIDERS.md)); embeddings, search and
image pixels always stay local.

---

## Executive summary

StratoSort splits semantic search into three layers with different cost/quality profiles:

1. **File-level vectors** — one embedding per file from AI summary + metadata + a text snippet
   (“what is this file about?”).
2. **Chunk-level vectors** (optional) — many embeddings from slices of `extractedText` (“where
   inside this file is the answer?”).
3. **Hybrid retrieval** — BM25 keywords + file vectors + chunk vectors, with caching, timeouts, and
   graceful degradation when the embedding model is busy.

**Design principle:** treat GPU embedding as a scarce resource; treat search as a latency-sensitive
UX path. Semantic quality is a bonus when inference is free; keyword search always works.

---

## End-to-end pipeline

```
File detected
    → Extract text (type-specific)
    → LLM analysis (category, summary, keywords, …)
    → File-level embedding → Orama `files` index
    → Optional chunk embeddings → Orama `fileChunks` index
    → Hybrid search / chat retrieval
    → Text LLM generation (chat answers)
```

### Two vector layers per document

| Layer           | Input embedded                                    | Stored in          | Purpose                                             |
| --------------- | ------------------------------------------------- | ------------------ | --------------------------------------------------- |
| **File-level**  | AI summary + metadata + proportional text snippet | Orama `files`      | Broad semantic match, chat context, folder matching |
| **Chunk-level** | Raw slices of `extractedText`                     | Orama `fileChunks` | Deep recall inside long documents                   |

---

## Ingestion by file type

Routing happens in `SmartFolderWatcher._analyzeFile()` (and equivalent paths in `DownloadWatcher`):

| Type            | Analyzer              | Primary extraction                         | `extractedText`                                 |
| --------------- | --------------------- | ------------------------------------------ | ----------------------------------------------- |
| **Documents**   | `analyzeDocumentFile` | PDF/DOCX/OCR/etc. via `documentExtractors` | Full extracted body (normalized, capped)        |
| **Images**      | `analyzeImageFile`    | Vision LLM + optional Tesseract OCR        | OCR text (often empty for photos)               |
| **Audio**       | `analyzeMediaFile`    | Whisper transcription                      | Full timestamped transcript                     |
| **Video**       | `analyzeMediaFile`    | Whisper + optional keyframe captions       | Transcript ± visual descriptions merged by time |
| **Unsupported** | Metadata fallback     | Filename/extension heuristics              | Usually empty                                   |

After analysis, all supported types follow the same post-processing: analysis history, BM25 index
invalidation, and `_embedAnalyzedFile()` (file vector + optional chunks).

### Images

- **Vision LLM** describes the image (category, summary, keywords, colors, etc.).
- **Optional OCR** when filename hints at text or vision indicates text content.
- **No CLIP/image-vector embedding** — search uses the **text embedding model** on descriptions
  (vision output + keywords + OCR snippet).
- **Chunking** only when OCR produces ≥ 200 characters (screenshots, scans). Pure photos get
  file-level vectors only.

### Audio & video

- **Whisper** (`WhisperService`) transcribes via ffmpeg → PCM → whisper.cpp.
- **Video only:** optional keyframe extraction (ffmpeg) and vision captions on stills
  (`captionKeyframes` in `mediaAnalyzerAdapter`, driven by the `captionVideoKeyframes` setting —
  **off by default**).
- **Text LLM** analyzes the transcript (or multimodal merge when captions exist).
- **`extractedText`** = the same blob the LLM saw — critical for search and chunking.
- If Whisper is not installed, adapter returns a skip-shape (empty transcript, no meaningful embed).
- **Chunking** applies to long transcripts (podcasts, meetings) same as documents.

### Text storage cap (aligned with chunking)

`normalizeExtractedTextForStorage()` trims extracted text to the maximum chunkable length (~64k
chars with default constants) so storage matches what can actually be indexed.

---

## Chunking — what exists and what “intelligent” means

There are **multiple chunking strategies** for different purposes. Do not conflate them.

### A. Search / embedding chunks (`textChunking.js`)

**Used for:** Orama `fileChunks` index (deep semantic recall).

**Not semantic/intelligent** — deliberately simple and bounded:

| Constant          | Default    | Role                     |
| ----------------- | ---------- | ------------------------ |
| `CHUNK_SIZE`      | 1000 chars | Window size              |
| `OVERLAP`         | 200 chars  | Context between windows  |
| `MAX_CHUNKS`      | 80         | Hard cap per file        |
| `MIN_TEXT_LENGTH` | 200 chars  | Skip chunking below this |

**Algorithm:**

- Char-based sliding window (no tokenizer — fast, deterministic).
- **Boundary snap** to whitespace or `. ! ? ; ,` within the last 200 chars of each window (avoids
  mid-word cuts).
- Preserves `charStart` / `charEnd` offsets for citations.
- **Atomic swap:** embed all new chunks first, then delete old chunks and batch upsert (partial
  failure does not corrupt the index).

**Gating:** `settings.autoChunkOnAnalysis` (default on); disabled in simple experience mode during
semantic rebuilds.

**Key code paths:** `SmartFolderWatcher._embedChunksForFile()`, `semantic.js` rebuild handlers.

### B. Smart content selection (`contentSelector.js`) — intelligent, for **analysis**

**Used for:** feeding the text LLM on long documents — **not** for search chunks.

When a document exceeds the analysis budget:

1. Extract structural **outline** from headings (~5% of budget).
2. Sample **beginning** (~37%), **middle** (evenly spaced, ~47%), **end** (~16%).
3. Snap cuts to **paragraph boundaries** (smarter than embedding chunk snap).

**Problem solved:** long PDFs misclassified because only the first page was seen.

### C. Map-reduce summarization (`documentLlm.summarizeChunks`) — intelligent, for **deep analysis**

**Used when:** the `deepAnalysis` analysis option is on (default off,
`AI_DEFAULTS.TEXT.DEEP_ANALYSIS` in `src/shared/aiModelConfig.js`) and the document exceeds ~100k
characters.

- Split into 8k non-overlapping chunks.
- LLM summarizes each (batched, 256 tokens per chunk).
- Combined summaries feed final analysis.

**Problem solved:** documents too large for one analysis pass. Does not directly create search index
chunks.

### D. Embedding overflow pooling — intelligent **fallback**

**Used when:** a single embed call exceeds model context (`ParallelEmbeddingService`,
`FolderMatchingService`).

- Split into small dynamic chunks (max 5).
- Embed in parallel (bounded concurrency).
- **Mean-pool** vectors into one composite vector.

**Problem solved:** never drop an embedding for length. Produces **one** file-level vector, not
separate searchable chunks.

### E. Extraction chunking (`documentExtractors.chunkTextForAnalysis`)

Larger chunks (4k, 400 overlap) with combined length cap (~16k) for downstream processing. Separate
from search index chunking.

### Chunking comparison table

| Strategy                        | Intelligent?              | Feeds search chunks?       | Purpose                               |
| ------------------------------- | ------------------------- | -------------------------- | ------------------------------------- |
| `chunkText` (search index)      | No — deterministic + snap | Yes                        | Deep recall in `extractedText`        |
| `selectRepresentativeContent`   | Yes — structure-aware     | No                         | Better LLM analysis                   |
| `summarizeChunks` (map-reduce)  | Yes — LLM per segment     | No (indirect via analysis) | Huge document analysis                |
| Overflow mean-pool              | Yes — adaptive            | No                         | One vector for oversized input        |
| Neighbor expansion at retrieval | Lightly smart             | N/A (post-search)          | ±1 adjacent chunk for snippet context |

**Explicit non-goal today:** semantic/topic-based splitting (by headings or paragraphs) for the
Orama chunk index. That would be new work; current choice favors speed, predictable cost (max 80
embeds/file), and deterministic citation offsets.

---

## Embedding — problems solved

### File-level embedding input

`buildEmbeddingSummary()` combines:

- AI fields: summary, purpose, project, entity, keywords, keyEntities, dates, etc.
- For images: also `content_type`.
- A **proportional snippet** of `extractedText` within the embedding token budget (not the full
  document).

One text embedding model (GGUF) for all file types — no separate image embedding model.

### Engine stack

```
FolderMatchingService.embedText()
  → ParallelEmbeddingService (semaphore, retries, adaptive concurrency)
    → LlamaService.generateEmbedding()  [main process, default]
    OR optional Piscina embeddingWorker  [STRATOSORT_ENABLE_EMBEDDING_WORKER=true, off by default]
```

### Embedding problems solved

| Problem                         | Solution                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Full document too long to embed | Summary + snippet for file vector; chunks for body text                        |
| Repeated identical text         | LRU `EmbeddingCache` (text + model key)                                        |
| GPU/CPU overload                | `ParallelEmbeddingService` semaphore; system-aware concurrency cap             |
| Input exceeds model context     | `capEmbeddingInput` with progressive stricter caps; chunk + mean-pool fallback |
| Analysis blocked by embedding   | Fire-and-forget embed after analysis; decoupled queues                         |
| Double inference on documents   | Precomputed embedding reuse from folder-matching path                          |
| Images without OCR unsearchable | Embed vision description + keywords                                            |
| Media transcript search         | `extractedText` = full Whisper output; same pipeline as docs                   |
| VRAM invisible to worker thread | Main-process embedding default; worker opt-in only                             |
| Batch rebuild overload          | Batched upserts (`SEMANTIC_BATCH_SIZE`), flush delays, concurrency limits      |
| Embedding failure loses work    | Persistent embedding queue with retries and dead-letter                        |
| Embedding-only retry            | Cached LLM analysis reused; only embed re-run                                  |

### Image-specific embed path

Images embed **during analysis** (embedding queue) and again via watcher (`buildEmbeddingSummary`).
Watcher does **not** skip images for precomputed document embeddings — it always runs the full
metadata + chunk path.

---

## Retrieval — problems solved

### Hybrid search (`SearchService`)

Combines:

- **BM25** full-text (Orama, English stemmer) on indexed metadata and `extractedText`.
- **File-level vector** similarity.
- **Chunk-level vector** similarity (default `chunkWeight: 0.5`).
- **Weighted-sum fusion** in `SearchService.hybridSearch()`: with defaults `BM25_WEIGHT: 0.25` and
  `chunkWeight: 0.5`, the combined budget is roughly BM25 25% / file-vector 37.5% / chunk-vector
  37.5%. (`reciprocalRankFusion()` exists but is only used in optional graph-expansion scoring, not
  on the hybrid path.)

Chunk hits are **aggregated per file** (best chunk score wins), not one result per chunk.

### Retrieval speed & resilience

| Problem                                   | Solution                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Vector-only misses exact keywords         | Hybrid BM25 + vector + chunks                                             |
| Query embed blocks search                 | Timeout (~30s) → BM25-only fallback                                       |
| Vector search slow when model busy        | Vector timeout → BM25 fallback with degraded indicator                    |
| Same query embedded twice (search + chat) | Precomputed query embedding shared ChatService → SearchService            |
| Repeated identical searches               | LRU search cache (~10s TTL) + in-flight request deduplication             |
| Sequential file + chunk search            | Parallel vector + chunk search with one query embedding                   |
| LLM rerank destroys latency               | **Rerank off by default** (each candidate = separate inference)           |
| Low-quality matches                       | `MIN_SIMILARITY_SCORE` threshold                                          |
| Stale entries for deleted files           | Ghost-file validation on results                                          |
| Orama restore losing vectors              | Sidecar embedding store + repair (`ORAMA_VECTOR_SIDECAR.md`)              |
| Long media truncated in search/chat       | Higher text caps for audio/video (~20k BM25 / ~15k doc map vs 5k/3k docs) |
| External DB latency                       | In-process Orama — zero network round trips                               |

### Chunk context at retrieval (post-search)

When a chunk matches, optionally expand with **±1 neighbor chunk** (bounded: 8 files, 2000 chars)
for richer snippets — not a re-chunk or re-embed.

### Chat generation

`ChatService`:

1. Precompute query embedding (3s timeout; keyword-only if it fails).
2. `hybridSearch()` with chunk settings.
3. Enrich with full analysis metadata from document map.
4. Build prompt → text LLM (local or cloud provider) → answer + citations.

Generation uses the **text model**, not the embedding model.

---

## Cross-cutting architectural patterns

1. **Decouple expensive stages** — analyze now, embed async; LLM result cached for embedding
   retries.
2. **Bound everything** — chunk count, text caps, cache sizes, concurrency, timeouts.
3. **Cache at hot paths** — embeddings, search results, Orama queries, analysis.
4. **Parallelize independent work** — BM25 while embedding query; file + chunk search together.
5. **Fail open on speed** — BM25 fallback beats waiting on a saturated embedding model.
6. **Pay for precision selectively** — chunks, deep rerank, keyframe captioning gated or off by
   default.
7. **Privacy-first local stack** — no external vector DB or embedding API required.

---

## Key settings & environment variables

| Control                                    | Effect                                                              |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `settings.autoChunkOnAnalysis`             | Toggle chunk embedding on analysis                                  |
| Simple experience mode                     | Skips chunk rebuild in semantic IPC                                 |
| `deepAnalysis` option (default off)        | Map-reduce summarization for 100k+ docs (analysis only)             |
| `STRATOSORT_ENABLE_EMBEDDING_WORKER`       | Optional isolated embedding worker (off by default)                 |
| Embedding model in settings                | Which GGUF model produces vectors                                   |
| `settings.captionVideoKeyframes`           | Vision captions on video keyframes (off by default)                 |
| `STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT` | Backpressure: defer media/image analysis when embed queue saturated |

See also `docs/CONFIG.md` (embedding queue environment and the embedding worker operational notes).

---

## Key source files (for deep dives)

| Area                       | Primary files                                                                     |
| -------------------------- | --------------------------------------------------------------------------------- |
| Search chunking            | `src/main/utils/textChunking.js`, `src/shared/performanceConstants.js`            |
| Analysis content selection | `src/main/analysis/contentSelector.js`                                            |
| Map-reduce analysis        | `src/main/analysis/documentLlm.js`                                                |
| Embedding summary          | `src/main/analysis/embeddingSummary.js`                                           |
| Parallel embedding         | `src/main/services/ParallelEmbeddingService.js`                                   |
| Llama embedding            | `src/main/services/LlamaService.js`                                               |
| Vector storage             | `src/main/services/OramaVectorService.js`                                         |
| Hybrid search              | `src/main/services/SearchService.js`                                              |
| Chat retrieval             | `src/main/services/ChatService.js`                                                |
| Watcher orchestration      | `src/main/services/SmartFolderWatcher.js`                                         |
| Image analysis             | `src/main/analysis/imageAnalysis.js`                                              |
| Media analysis             | `src/main/analysis/mediaAnalysis.js`, `src/main/services/mediaAnalyzerAdapter.js` |
| Semantic rebuild IPC       | `src/main/ipc/semantic.js`                                                        |

---

## Design decisions in brief

**Chunking:** We use a two-tier model — cheap file-level vectors for broad recall, optional
fixed-window overlapping chunks (capped at 80) for deep in-document search, with atomic index swaps
and gating so we never pay chunk cost on content that doesn’t need it (e.g. photos without OCR).

**Embedding:** We treat inference as scarce — summary-based file vectors, input capping, LRU
caching, adaptive concurrency, mean-pool overflow recovery, and async decoupling from analysis so
the UI never blocks on embed.

**Retrieval:** Hybrid BM25 + dual-vector (file + chunk) fusion with weighted-sum scoring (RRF is
used only for optional graph-expansion rank decay), aggressive caching, parallel search legs, and
explicit degraded modes (BM25-only) when embedding is slow or unavailable — search stays responsive
under load.

**Multi-modal:** One text embedding pipeline for documents, OCR’d images, and Whisper transcripts;
vision and Whisper are extraction stages, not separate search stacks.

**Intelligence where it matters:** Structure-aware content selection and optional map-reduce for
analysis quality on long docs; deliberately simple chunk splitting for the vector index to keep cost
and latency predictable.

---

_Last updated: 2026-10-27._
