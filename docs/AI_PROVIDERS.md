# AI Providers (Multi-Provider Routing)

> **What it is:** Use Claude or any OpenAI-compatible cloud model alongside StratoSort's built-in
> local LLM — without losing the privacy-first guarantee on the parts of the workflow that actually
> need to stay local.

## TL;DR

- **Default behavior is unchanged.** Out of the box, everything runs on the local LLM. No API keys
  required, no internet required, no data leaves your machine.
- **Cloud is opt-in, per operation.** Settings → AI Provider picks a default (local, Anthropic, or
  OpenAI-compatible) for text analysis, chat and organization suggestions, and each of the three can
  be sent to a different provider or kept local. Per–smart-folder overrides apply to analysis of
  files already under a folder. Explicit consent is required before any cloud routing sticks.
- **Embeddings stay 100% local. Always.** The vector index that powers search is never sent
  anywhere. Cloud routing only affects generation/analysis steps.
- **Analysis is one round-trip per file; chat is one per question.** Analysis sends a file's text
  once and caches the JSON locally. Each chat question sends the question, recent conversation and
  the matching passages, summaries and paths of up to five files, or up to twelve when the question
  runs in Deep mode (including text read from images by OCR). Organization suggestions send each
  candidate's cached analysis. Search never leaves the machine.
- **Consent is one answer for every cloud provider.** The first time cloud AI is enabled you are
  asked once; that answer covers any cloud provider or OpenAI-compatible endpoint configured later,
  and switching providers does not ask again.
- **Local-endpoint detection.** If you point the OpenAI-compatible provider at Ollama, LM Studio,
  vLLM, or any other `http://localhost` / `127.0.0.1` / `[::1]` endpoint, StratoSort treats those
  calls as $0 spend (they don't count against your budget cap).

---

## Why this exists

The local LLM is great for the privacy-first default and works on a $0 inference budget. But:

- A 7B local model has a quality ceiling. For complex documents, Claude 3.5 Sonnet or GPT-4 will
  produce better summaries, classifications, and chat answers.
- Some users have a paid API tier idle and want to use it without giving up the local-first
  workflow.
- Some users self-host (Ollama, LM Studio, vLLM, llama.cpp server) and want StratoSort to talk to
  that endpoint instead of the bundled in-process model.

The multi-provider architecture lets all three of those use cases coexist with one another and with
the privacy-first default.

---

## Architecture

```
                                ┌─────────────────────────┐
                                │  Operation services      │
                                │  (BatchAnalysisService,  │
                                │   ChatService,           │
                                │  OrganizationSuggestion- │
                                │  Service)                │
                                └──────────┬──────────────┘
                                           │ aiRouter.choose({
                                           │   operation: 'analyze' | 'chat' | 'suggest',
                                           │   smartFolderId, allowFallback, ...
                                           │ })
                                           │ (perFolder override → perOperation[operation]
                                           │  → default → local fallback)
                                           ▼
                                ┌─────────────────────────┐
                                │      AIRouter            │
                                │  (decides per call)      │
                                └──┬──────────┬──────────┬─┘
                                   │          │          │
                                   ▼          ▼          ▼
                       ┌────────────────┐ ┌──────────┐ ┌─────────────────────────┐
                       │ LocalLlama     │ │Anthropic │ │ OpenAICompatible        │
                       │ (existing)     │ │(direct)  │ │ (OpenAI / Ollama / LM   │
                       │                │ │          │ │  Studio / vLLM / etc.)  │
                       └────────────────┘ └──────────┘ └─────────────────────────┘
```

Each provider implements a small interface: `analyze`, `chatStream`, `suggest`, `ready`. The router
picks one based on user config + feature + per-folder overrides + budget state, and the operation
service delegates without caring which provider answered.

The local LLM (`LocalLlamaProvider`) is just another provider — same interface, same router
contract. It's always registered and always available; cloud providers register only when keys are
configured.

---

## Trust model

When a cloud provider is the default, or is chosen for an operation:

1. **Document text goes to the cloud when a file is analyzed.** The provider's response (summary,
   category, suggested name, keywords, etc.) is cached locally in StratoSort's analysis history.
2. **Every chat question goes to the cloud too**, unless chat is set to Local Llama under "Where
   each kind of work runs". The prompt carries the question, the recent conversation, and for up to
   five matching files (up to twelve in Deep mode) their path, summary and an extract of their text
   (including text read from images by OCR; transcripts can be several thousand characters). This
   happens on each question, not once per file.
3. **Organization suggestions send each candidate file's cached analysis** (about 1,200 characters)
   to the cloud default.
4. **Search, undo and the index never leave your machine.** Embeddings are computed locally always;
   the vector index is never uploaded; image pixels stay local (only their OCR text is stored with
   the analysis).
5. **Cache stays local.** If you later disable cloud routing, the cached summaries continue to work
   — they're just JSON in your `userData/analysis-history`.

The first-run consent dialog spells this out before you can store an API key.

---

## Configuration

All configuration lives in **Settings → AI Provider** in the desktop UI (visible in Simple and
Advanced experience modes). There are no env vars or hand-edited config files; this is intentional
because API keys are encrypted by the OS keystore and shouldn't be in plaintext config.

### Storing keys

API keys are stored via Electron's `safeStorage` API:

- **Windows:** DPAPI (per-user encryption tied to your Windows account).
- **macOS:** Keychain (entry visible under `StratoSort Core` in Keychain Access).
- **Linux:** Whichever backend `safeStorage` resolves (libsecret on most distros).

If `safeStorage` reports the OS keystore as unavailable (rare — happens on some Linux setups without
a keyring service), `set()` throws `ENCRYPTION_UNAVAILABLE` and the renderer shows a "safe storage
is not available — store this key unprotected anyway?" prompt. Plaintext storage is opt-in only.

### Default, per-operation and per-folder routing

| Control                                     | What it affects                                                                                                                                                                                                                  |
| :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings → Default provider**             | Document text analysis (including first-time Discover import), media transcript analysis, Knowledge OS chat, and organization suggestions, for every operation left on Default below.                                            |
| **Settings → Where each kind of work runs** | Sends document analysis, chat or organization suggestions to a provider of its own. An operation whose chosen provider is not ready runs on local Llama; it never slides to a different cloud provider.                          |
| **Smart folder → AI provider**              | Optional override for watcher re-analysis and manual re-analyze when the file path is already under that folder. Does **not** change the first Discover pass (folder is unknown yet), and does not apply to chat or suggestions. |

Precedence inside `AIRouter.choose()`: the smart-folder override (analysis only), then
`routing.perOperation[operation]`, then `routing.default`, then local when fallback is allowed. The
`operation` argument (`analyze`, `chat`, `suggest`) selects the per-operation entry.

**Deep analysis (map-reduce)** on very large documents also routes chunk summarization through the
same default provider when cloud is active — not only the final JSON extraction pass.

**MCP `search_documents`** scopes results to a folder path but does **not** call a cloud LLM; search
uses the local Orama index (embeddings are always local).

### Budget cap

The cost tracker accumulates per-provider monthly spend (input + output tokens × pricing). When you
hit your monthly cap, the provider refuses any new request with `BUDGET_EXCEEDED` before it reaches
the network, and each caller degrades on its own:

- **Document analysis** and **chat** fall back to the local model — `BUDGET_EXCEEDED` is in
  `CLOUD_FALLBACK_CODES` (`src/main/analysis/documentLlm.js`) and `CLOUD_CHAT_FALLBACK_CODES`
  (`src/main/services/ChatService.js`), and both re-run the request on local Llama. The analysis
  result is stamped `provider: 'local'`.
- **Organization suggestions** do _not_ re-run on the local model. `llmSuggester.js` logs the
  failure and returns no LLM suggestions, so the run is ranked by embeddings, filename patterns and
  clusters only.

No separate notification is shown: Settings → AI Provider → Configure shows this month's estimated
spend next to the cap.

**Self-hosted endpoints are free.** The cost tracker treats `localhost`, `127.0.0.1`, `[::1]`,
`0.0.0.0` and `*.local` base URLs as $0 spend. Plain `http://` is accepted only for the loopback
hosts; a LAN or `*.local` Ollama must be reached over `https://`. Without that detection, an Ollama
user would be billed at "unknown model" rates (Opus pricing) and hit `BUDGET_EXCEEDED` on phantom
spend.

### Status indicator

The header shows a **Cloud AI** badge when any operation (analysis, chat or suggestions) resolves to
a **ready** cloud provider (enabled + API key loaded). If you select OpenAI/Anthropic but it is not
ready, that work falls back to local Llama and the badge stays hidden. Hover the badge to see where
each operation goes and the scope (text work only; not embeddings or images).

---

## Supported providers

### Local Llama (built-in)

The bundled `node-llama-cpp` runtime. Always registered, always free, runs on CPU/CUDA/Metal/Vulkan
depending on your hardware. No configuration needed.

**Models:** Whatever you have downloaded under `userData/models`. Default is the StratoSort base
profile (Llama 3.2 3B + LLaVA v1.6 Mistral 7B + all-MiniLM-L6-v2); the Better Quality profile swaps
in Qwen2.5 7B and nomic-embed-text v1.5.

### Anthropic (Claude)

Direct integration with the Anthropic Messages API via `fetch`. No SDK; we control the wire format
end-to-end.

**Required:** Anthropic API key (`sk-ant-…`). **Default model:** `claude-opus-4-7` (configurable per
provider in Settings). **Streaming:** Yes (chat responses stream tokens as they arrive). **Pricing
model:** Per-million tokens, input + output, latest published rates.

### OpenAI-compatible

Generic OpenAI Chat Completions API. Works with **any** server that speaks the
`/v1/chat/completions` shape:

- OpenAI itself (`api.openai.com`)
- [Ollama](https://ollama.com/) running locally
- [LM Studio](https://lmstudio.ai/) running locally
- [vLLM](https://vllm.ai/), [llama.cpp server](https://github.com/ggml-org/llama.cpp), or any other
  compatible runtime
- Cloud-hosted gateways like Together, Groq, Fireworks (anything OpenAI-compatible)

**Required:** Base URL + API key (use any non-empty string for self-hosted endpoints that don't
authenticate). **Streaming:** Yes. **Pricing model:** Configured per model. Loopback endpoints
(`localhost`, `127.0.0.1`, `[::1]`) are pinned to $0 — you can configure spend caps without worrying
that your local Ollama traffic will eat them. The monthly cap (`spendCapMonthlyUsd`) is set per
provider under Configure → Monthly spend cap, next to this month's estimated spend; leave it empty
for no cap.

---

## Operational notes

### Concurrency & key writes

Setting an API key is serialized per-provider through an internal write queue. Two parallel "Save
key" clicks on the same provider will execute in order — they don't race on the `.tmp` → `rename`
atomic write, which on Windows could otherwise let the second call's failed unlink delete the first
call's key mid-rename.

### Cost tracking write safety

The cost tracker also serializes its persist writes. Concurrent provider responses landing within
the same millisecond won't read the same snapshot, mutate, and clobber each other on persist.

### Errors

All cloud provider errors are normalized into `AIProviderError` with a typed `.code`:

The canonical set is `AI_ERROR_CODES` in `src/main/services/ai/errors.js`:

| Code                             | Meaning                                                                                        |
| :------------------------------- | :--------------------------------------------------------------------------------------------- |
| `AUTH_FAILED`                    | Missing key, or the provider rejected the key (HTTP 401/403 from upstream).                    |
| `RATE_LIMITED`                   | The provider rate-limited us (HTTP 429); router can fall back to local.                        |
| `NETWORK_ERROR`                  | Fetch failed or the response body timed out (providers throw this, not `TIMEOUT`).             |
| `CONTENT_TOO_LONG`               | The request exceeded the provider's context/length limits.                                     |
| `BUDGET_EXCEEDED`                | Monthly cap hit; analysis and chat fall back to local, organization suggestions skip the LLM.  |
| `PROVIDER_DISABLED`              | The provider is configured but disabled in Settings.                                           |
| `NO_PROVIDER_READY`              | All registered providers report `ready: false`.                                                |
| `FOLDER_OVERRIDE_UNAVAILABLE`    | A smart-folder override names a provider that is not ready and the caller disallowed fallback. |
| `OPERATION_OVERRIDE_UNAVAILABLE` | A per-operation choice names a provider that is not ready and the caller disallowed fallback.  |
| `PROVIDER_FAILED`                | Generic upstream failure; check the error `cause`.                                             |
| `INVALID_RESPONSE`               | Upstream returned something that didn't match the expected schema.                             |
| `STREAM_IDLE_TIMEOUT`            | The streaming response stalled longer than the idle window.                                    |

> Note: `ENCRYPTION_UNAVAILABLE` is an `AIKeyStore` (key-storage IPC) error code, not an
> `AIProviderError`. It surfaces when the OS keystore is unavailable and a key wasn't stored.

### What's NOT routed to cloud

By design, the following always run locally regardless of provider config:

- **Embedding generation** (search, dedup, semantic clustering, knowledge graph edges).
- **OCR** (Tesseract.js, runs locally).
- **Image preprocessing** (sharp, in a worker pool).
- **Vision multimodal inference** (the bundled llama-server with `--mmproj`).
- **Anything related to file system mutations** (move, rename, undo, redo).

Cloud providers only receive text. The vision pipeline is local-only because the multimodal
projector files are local and there's no privacy-clean equivalent to "send my screenshot to the
cloud" that we'd want to default-on.

---

## Troubleshooting

**Header badge says "Cloud AI off" but I configured a key:** The provider is configured but not
enabled. Open Settings → AI Provider → click the provider row → toggle **Enabled**.

**Header badge flickers between providers:** The router fell back from your preferred cloud provider
to local — usually because of `BUDGET_EXCEEDED`, `RATE_LIMITED`, or `AUTH_FAILED`. Open Settings to
see the actual reason in the provider row.

**`BUDGET_EXCEEDED` immediately on a self-hosted endpoint:** You're on an older build. Update —
local-endpoint detection (`localhost`, `127.0.0.1`, `.local`) is now correctly treated as $0 spend.

**Key won't save / `ENCRYPTION_UNAVAILABLE`:** On Linux, install/configure a keyring service
(gnome-keyring or KDE Wallet). Or, in the "safe storage unavailable" prompt, choose **Store
unprotected** if you understand the risk.

**Test connection works, but document analysis still uses local:** In Settings → AI Provider →
**Status**, confirm the cloud row shows `ready: true`. If not, the router silently uses local. Also
check the smart-folder **AI provider** dropdown — a per-folder override beats the default.

**Badge missing but I selected OpenAI:** Same as above — `ready: false` means local fallback; fix
the key/config first.

---

## See also

- [USER_GUIDE.md](USER_GUIDE.md) — the desktop app walkthrough.
- [MCP_SERVER.md](MCP_SERVER.md) — exposing your StratoSort corpus to MCP-aware AI clients.
- [CONFIG.md](CONFIG.md) — environment variables for the local LLM stack.
- [SECURITY.md](../SECURITY.md) — full security policy.
