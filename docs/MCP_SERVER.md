# MCP Server

> **What it is:** Let Claude Desktop, Cursor, Zed, or any other MCP-aware client search and chat
> with the documents StratoSort has analyzed — without those tools ever uploading your files.

## Why it exists

StratoSort already runs a complete RAG stack on your machine (in-process LLM via node-llama-cpp +
Orama vector DB + ChatService with citation streaming + knowledge graph). Until now, all of that was
only reachable from inside StratoSort's own UI.

The **MCP server** opens that stack to any
[Model Context Protocol](https://modelcontextprotocol.io/) client. Your favorite AI tool can now ask
StratoSort:

- "Find the contract I signed with Acme"
- "What did the kickoff meeting notes actually say about the budget?"
- "Summarize the receipts in the Tax 2025 folder"

…and StratoSort answers locally, citing the exact files and chunks. The client never sees the raw
files — only the summaries and citations StratoSort returns.

---

## Privacy posture

The MCP server inherits StratoSort's privacy-first defaults:

| Property           | Value                                                                                                                                                                                                                                 |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Default state**  | Off. Must be explicitly enabled in Settings.                                                                                                                                                                                          |
| **Bind address**   | `127.0.0.1` only. Never reachable from another machine.                                                                                                                                                                               |
| **Authentication** | Bearer token, generated locally, constant-time compared.                                                                                                                                                                              |
| **Origin guard**   | Deny-by-default. Accepts requests with **no** `Origin` header or an `Origin` prefixed by `claude://`, `cursor://`, `zed://`, or `vscode-webview://`. Literal `Origin: null` and browser origins are rejected (DNS-rebinding defense). |
| **Rate limit**     | 60 requests/minute per MCP session (token bucket), applied after authentication.                                                                                                                                                      |
| **Logging**        | Server lifecycle (port/token/auth) only. Query text is never logged at info/warn.                                                                                                                                                     |
| **Telemetry**      | None. Zero outbound calls.                                                                                                                                                                                                            |
| **Inference**      | Local-only. `chat_with_documents` always uses the on-device model, even when a cloud provider is enabled for in-app chat.                                                                                                             |

If the bearer token leaks, you can rotate it from Settings → MCP without reinstalling clients
(though they'll need the new token).

---

## Quick start

1. Open StratoSort → **Settings → MCP Server**.
2. Click **Enable**. StratoSort generates a 32-byte token and starts the server on
   `http://127.0.0.1:53827/mcp`. If that port is already taken, the server binds an OS-assigned
   ephemeral port (`listen(0)`) and Settings shows the actual port.
3. Click **Copy Claude Desktop config** (or the snippet for whatever client you use).
4. Paste it into your client's config file. Restart the client.
5. The client now sees four StratoSort tools: `search_documents`, `chat_with_documents`,
   `get_document_summary`, `list_smart_folders`.

To verify, click **Test connection** in Settings — it issues a `tools/list` round-trip and reports
the four tools back.

### Client config snippets

The Settings panel generates copy-pasteable config for the most common clients. The current snippets
follow this shape:

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "stratosort": {
      "url": "http://127.0.0.1:53827/mcp",
      "headers": { "Authorization": "Bearer <YOUR-TOKEN>" }
    }
  }
}
```

**Cursor** (Settings → MCP):

```json
{
  "mcpServers": {
    "stratosort": {
      "url": "http://127.0.0.1:53827/mcp",
      "headers": { "Authorization": "Bearer <YOUR-TOKEN>" }
    }
  }
}
```

**Zed** (`~/.config/zed/settings.json`): same shape under `context_servers`.

The Settings panel always generates the snippet with your actual port and token filled in — copy
from there rather than from this doc.

---

## Tools exposed (v1)

All four tools share these conventions:

- All inputs validated with [Zod](https://zod.dev/). Bad input → JSON-RPC error with a typed `code`
  and `message`, never a 500.
- Path inputs must be absolute and OS-native. UNC paths, relative paths, `file://` URLs, and `..`
  traversal are rejected with `INVALID_PATH`.
- Payload size guards: the HTTP transport rejects request bodies over 5 MB (or missing a
  `Content-Length` header) before parsing, and every tool input field carries an explicit Zod
  length/range bound (see per-tool schemas below).

### `search_documents`

Search the indexed corpus by meaning, keyword, or both.

**Input**

```json
{
  "query": "string (1..1000)",
  "top_k": 10,
  "mode": "hybrid",
  "smart_folder_id": "optional-uuid"
}
```

`mode` is one of `hybrid` (default; BM25 + vector weighted-sum), `semantic` (vector-only, same as
internal `vector` mode), or `keyword` (BM25-only). `smart_folder_id` scopes the search to a single
Smart Folder.

**Output**

```json
{
  "results": [
    {
      "file_path": "C:\\Users\\you\\Documents\\Contracts\\acme-q2-2026.pdf",
      "file_name": "acme-q2-2026.pdf",
      "score": 0.873,
      "snippet": "…the parties agree to extend the master services agreement…",
      "smart_folder": "Contracts",
      "modified_at": "2026-06-30T19:22:00Z"
    }
  ],
  "total_matches": 12,
  "query_ms": 87
}
```

**Errors:** `INVALID_QUERY`, `INVALID_SMART_FOLDER` (unknown `smart_folder_id`),
`UNSUPPORTED_SMART_FOLDER` (criteria-based folders aren't searchable here), `SERVICE_UNAVAILABLE`.

### `chat_with_documents`

Conversational RAG over the corpus. Returns a grounded answer with `[n]` citation markers and a
parallel `citations` array pointing at the exact chunks used. Each `[n]` in `answer` is the 1-based
index of an entry in `citations`, numbered in first-use order. When no retrieved document is cited
(usually because nothing matched), `citations` is empty, `grounded` is `false`, and `answer` is the
model's own words rather than a document claim.

**Input**

```json
{
  "query": "string (1..2000)",
  "session_id": "optional",
  "max_context_files": 5,
  "persona": "optional"
}
```

`session_id` semantics:

- Provided + matches an existing MCP session → continues the conversation (60-min TTL memory).
- Provided + unknown → creates a new MCP session with that ID.
- Absent → the server generates an `mcp-<uuid>` ID and returns it as `session_id`; reuse it to
  continue the conversation.

MCP sessions are **ephemeral, in-memory, and per-process**: they are never written to the in-app
chat history, never appear in the Chat sidebar, and are gone when the app restarts (or after 60
minutes idle). Internally they are stored under an `mcp:`-namespaced key, so a `session_id` can
never collide with — read from, or append to — an in-app conversation, even if a client supplies an
in-app conversation's ID.

One concurrent LLM call per session is enforced inside the tool handler so a client can't fan-out
and DoS itself.

**Output**

```json
{
  "answer": "The Q3 contract was signed on Aug 14 [1] and the renewal clause is 30 days [2].",
  "citations": [
    { "id": 1, "file_path": "...", "file_name": "...", "snippet": "...", "chunk_index": 12 },
    { "id": 2, "file_path": "...", "file_name": "...", "snippet": "...", "chunk_index": 14 }
  ],
  "grounded": true,
  "session_id": "8f3a-…",
  "tokens_used": { "prompt": 1840, "completion": 220 }
}
```

**Errors:** `INVALID_QUERY`, `MODEL_NOT_READY` (the local text model is missing or not loaded),
`RETRIEVAL_FAILED` (the document search itself failed, or generation failed for another reason),
`LLM_TIMEOUT` (default 60s). A search that returns nothing is not an error: the call succeeds with
`grounded: false`.

> **Note:** Streaming is non-streaming in v1 (one full response). MCP `progress` notifications for
> streaming chat are planned for v2 once client support stabilizes.

### `get_document_summary`

Returns the cached analysis StratoSort produced when the file was last analyzed. **No inference
runs.** This is a pure cache lookup, designed to be fast and free. The lookup accepts the file's
current path or the path it was analyzed at; `file_path` in the output is where the file is now.

**Input** `{ "file_path": "absolute path" }`

**Output**

```json
{
  "file_path": "C:\\…\\acme-q2-2026.pdf",
  "summary": "Q2 master services agreement extension between Acme and StratoSort.",
  "category": "Contracts",
  "entity": "Acme Corp",
  "type": "legal_document",
  "date": "2026-06-30",
  "keywords": ["contract", "MSA", "renewal"],
  "key_entities": ["Acme Corp", "StratoSort", "Levy Tate"],
  "suggested_name": "acme-msa-extension-2026-06.pdf",
  "confidence": 87,
  "analyzed_at": "2026-04-25T14:01:00Z"
}
```

**Errors:** `FILE_NOT_ANALYZED` (with a hint to open the desktop app and run analysis),
`INVALID_PATH`, `SERVICE_UNAVAILABLE`.

### `list_smart_folders`

Enumerate the user's Smart Folders. Useful for clients that want to scope a follow-up
`search_documents` call.

**Output**

```json
{
  "folders": [
    {
      "id": "8f3a-…",
      "name": "Contracts",
      "description": "Legal agreements and signed documents",
      "destination_path": "C:\\Users\\you\\Documents\\Contracts",
      "file_count": 47,
      "last_organized_at": "2026-04-29T22:13:00Z"
    }
  ]
}
```

`file_count` is the number of files directly inside the folder at call time and `last_organized_at`
is when the folder's entries last changed (a move into or out of it); both are `null` when the
folder cannot be read.

**Errors:** `SERVICE_UNAVAILABLE`.

---

## Operational notes

### Lifecycle

- The server starts lazily when you enable it. It does not run by default.
- Disabling closes every live MCP session first (ending any open SSE streams), then terminates
  remaining connections and closes the HTTP socket. The close is bounded to 10 s; if it fails or
  times out (rare — usually only when the OS hasn't released the port), Settings shows an **error**
  state with the underlying message instead of pretending it stopped, and a later **Enable** still
  works.
- The token persists across restarts. **Rotate token** generates a new 32-byte token and persists it
  atomically — if the persist write fails, the in-memory state rolls back so your existing clients
  keep working.
- If the stored token can no longer be read (for example the OS secret store that encrypted it is no
  longer available), enabling generates and persists a fresh token instead of failing. Re-copy the
  client snippet afterwards.

### Status events

Settings reflects live status (`stopped`, `starting`, `running`, `error`) over IPC. The lifecycle
service emits a `mcp:status-changed` event whenever the server transitions; the event payload
mirrors `lifecycle.status()` and is validated against `mcpStatusChangedSchema` before reaching the
renderer.

### Port collisions

If the configured port (default `53827`, override via `STRATOSORT_MCP_PORT`) is already taken, the
server binds an OS-assigned ephemeral port (`listen(0)`) instead and surfaces the actual bound port
in the status payload — copy the snippet again to refresh.

### Concurrency

- **Per-session ChatService mutex:** one in-flight LLM call per `session_id`. A second concurrent
  `chat_with_documents` for the same session will queue, not race.
- **Rate limit:** 60 req/min per MCP session (`Mcp-Session-Id`) via token bucket, so one busy client
  cannot starve another; header-less `initialize` requests share a single bucket. The limiter runs
  after authentication, so unauthenticated requests are always answered `401` and never consume or
  create a bucket. Bursts up to the bucket size are permitted; sustained higher rates get an HTTP
  `429` with a `Retry-After` header and JSON-RPC error
  `{ code: -32004, message: "Rate limit exceeded" }`.
- The client-facing concurrency model is independent of StratoSort's renderer-side
  `CONCURRENCY_LIMITED_CHANNELS` (which is a preload-layer concept).

### Logging

The MCP transport logs server lifecycle events (port binding, token generation, auth/rate-limit
warnings) via `src/shared/logger.js`. Query strings, search results, chat answers, and other request
content are **never logged at info or warn**. SearchService may record query length (not text) when
the vector path is degraded. Development-only trace logs can include a truncated query.

### What this does NOT expose

For your own safety the v1 tools deliberately do not include:

- `analyze_file` / `organize_files` / `move_file` — actions that mutate the filesystem.
- Direct embedding or vector access — only ranked hybrid-search results (the MCP tool does not run
  the LLM re-ranker).
- Knowledge graph traversal as a tool — use the desktop app's graph view.
- Anything that would let a client cause inference work to run on demand against arbitrary paths
  (the `get_document_summary` cache-lookup design is intentional).

If you want any of these, file an issue describing the use case.

---

## Troubleshooting

**Client says "no tools" / `tools/list` returns empty:** Check that you copied the latest snippet
(token may have been rotated). Click **Test connection** in Settings — if it succeeds locally, the
issue is in the client's config.

**`401 Unauthorized`:** The bearer token in the client's config doesn't match what's currently
stored. Re-copy the snippet from Settings.

**`403 Forbidden`:** The request's `Origin` header isn't in the allowlist. This usually means the
client is sending an unexpected origin string. File an issue with the client name.

**`429 Too Many Requests`:** You hit the per-minute rate limit. Back off a few seconds; the bucket
refills automatically.

**`FILE_NOT_ANALYZED`:** The file at that path hasn't been analyzed yet. Open StratoSort, drop the
file onto the analyze dropzone (or wait for Smart Folder Watcher to pick it up), then retry.

**Server stuck in `error` state:** Settings shows `lastError` text. Common causes: another process
holding the port (kill it or restart StratoSort to claim a fresh port), or filesystem lock during
token rotation. Check the StratoSort log (`%APPDATA%\StratoSort Stack\logs\stratosort-*.log` on
Windows) for the full stack.

---

## Configuration

| Variable              | Default | Purpose                                                                                                                                                                                         |
| :-------------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_MCP_PORT` | `53827` | Initial bind port. If taken, binds an OS-assigned ephemeral port (`listen(0)`) and reports the actual port in Settings. Loopback only — ignored on non-127.0.0.1 binds (we don't permit those). |

There are no environment variables for the bearer token. It's always generated locally on enable and
stored under `userData/mcp-token.bin` (encrypted with `safeStorage` when DPAPI/Keychain is
available; falls back to plaintext + warning on platforms without OS-level encryption). A sidecar
`userData/mcp-token.enc` records which mode was used, so the file is read correctly even if
encryption availability changes between runs; a plaintext token is re-encrypted automatically once
`safeStorage` becomes available.

---

## See also

- [USER_GUIDE.md](USER_GUIDE.md) — the desktop app walkthrough.
- [AI_PROVIDERS.md](AI_PROVIDERS.md) — using cloud AI alongside the local LLM.
- [SECURITY.md](https://github.com/iLevyTate/StratoSortStack/blob/main/SECURITY.md) — full security
  policy.
- [Model Context Protocol spec](https://modelcontextprotocol.io/) — the open standard this
  implements.
