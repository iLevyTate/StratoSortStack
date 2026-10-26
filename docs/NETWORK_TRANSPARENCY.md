# Network Transparency

StratoSort Stack's headline claim is that your files and their contents never leave your machine.
This document makes that claim verifiable: it enumerates every network connection the shipped app
can make, the exact conditions that trigger each one, and a test you can run yourself. Every row is
backed by a source reference so the claim can be re-audited against the code.

**The short version:** analysis, organization, search, chat, and transcription run entirely
on-device. The app touches the network only to (1) download AI models you ask for, (2) check GitHub
Releases for app updates (on by default in installed builds; switch it off in Settings), and (3)
call cloud AI providers if — and only if — you configure them with your own API keys. There is no
telemetry, no crash upload, no account, no phone-home.

---

## Complete network surface

| Connection                                                                     | When it happens                                                                                                                                                                                                                                                                                                                                                                                                          | Source                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `https://huggingface.co` (model files)                                         | Only when you download or update an AI model. Host allowlist: `huggingface.co`, `hf.co`; HTTPS only; no credentials sent.                                                                                                                                                                                                                                                                                                | `src/shared/modelRegistry.js`, `src/main/services/ModelDownloadManager.js` |
| App updates (`STRATOSORT_ENABLE_AUTO_UPDATES`)                                 | Packaged builds only: at startup and every 4 hours while Settings → Application → Background Update Checks is on (the default), plus when you click "Check for updates". Fetches release metadata from the packaged GitHub Releases feed, or from `STRATOSORT_UPDATE_FEED_URL` if set (HTTPS, allowlisted host required). `STRATOSORT_ENABLE_AUTO_UPDATES=false` disables it entirely. No file or document data is sent. | `src/main/core/autoUpdater.js`                                             |
| Cloud AI providers (OpenAI, Anthropic, Groq, DeepSeek)                         | Only if you enter an API key and select that provider in Settings. Off by default; the default provider is the local model.                                                                                                                                                                                                                                                                                              | `src/main/services/ai/` provider modules                                   |
| Local inference servers (Ollama `localhost:11434`, LM Studio `localhost:1234`) | Only if you configure them. Loopback only.                                                                                                                                                                                                                                                                                                                                                                               | AI provider settings                                                       |
| Built-in MCP server (`http://127.0.0.1:<port>/mcp`)                            | Only if you enable it in Settings. Binds to 127.0.0.1 exclusively — never reachable from the network. The AI tool you connect to it (Claude Desktop, Cursor, Zed) receives search results, summaries, passages and answers from your library and sends them to its own model, which may be in the cloud; that traffic is the client's, not StratoSort's.                                                                 | `src/main/transports/mcp/transport.js`, `docs/MCP_SERVER.md`               |
| `https://huggingface.co` (missing core models at launch)                       | Each launch, if a core model the setup wizard chose is missing from disk and you have not declined downloads in the wizard. Same host allowlist and checksum rules as a manual download.                                                                                                                                                                                                                                 | `src/main/core/backgroundSetup.js`                                         |
| `https://github.com` (vision runtime binary)                                   | Only if the bundled `llama-server` binary is missing (a development checkout, or a damaged install). Host checked on every redirect; SHA-256 pinned.                                                                                                                                                                                                                                                                     | `src/main/services/VisionService.js`                                       |
| `https://cdn.jsdelivr.net` (OCR language data)                                 | Only if the bundled `eng.traineddata` is missing (a development checkout, or a damaged install). Packaged builds ship it and verify its checksum.                                                                                                                                                                                                                                                                        | `src/main/utils/tesseractJsPaths.js`, `scripts/setup-tessdata-runtime.js`  |

**What is deliberately absent:**

- **No telemetry or analytics.** There is no analytics SDK in the dependency tree.
- **No crash upload.** The crash reporter writes minidumps locally under the app's user-data folder
  with `uploadToServer: false` (`src/main/simple-main.js`).
- **No spellchecker dictionary downloads.** Chromium's spellchecker fetches Hunspell dictionaries
  from a Google CDN on Windows and Linux, so it is turned off (`spellcheck: false` in
  `src/main/core/createWindow.js`).
- **No license phone-home.** License keys are verified offline with an embedded Ed25519 public key
  (`src/main/services/LicenseService.js`). Activation never contacts a server.
- **No document, image, audio, or embedding data in ANY request.** Model downloads fetch public
  files; the updater fetches release metadata; only user-configured cloud providers ever receive
  content, and only for the requests you route to them.

---

## The airplane-mode test

You can verify the offline claim end-to-end in about two minutes:

1. Install StratoSort and download a model profile while online (the one network step).
2. **Disconnect completely** — enable airplane mode, or unplug Ethernet and disable Wi-Fi.
3. Use the app: analyze documents and photos, transcribe an audio file, organize into smart folders,
   run semantic searches, chat with your documents.
4. Everything works. No feature degrades, no errors about connectivity, nothing queues waiting for a
   connection.

For a stronger check, run a local firewall monitor (e.g., Windows Defender Firewall logging, Little
Snitch on macOS, OpenSnitch on Linux) during normal indexing and search: with no cloud provider
configured and no update feed set, the app makes no outbound requests.

---

## Model download integrity

Every model in the registry ships with a pinned SHA-256 checksum, and the downloader refuses to
install a file that does not match:

- The registry (`src/shared/modelRegistry.js`) records `checksum` for every model artifact,
  including vision models' companion CLIP projectors.
- `ModelDownloadManager` fails closed: a missing or malformed checksum aborts the download before it
  starts, and a hash mismatch after download discards the file
  (`src/main/services/ModelDownloadManager.js` — `_verifyChecksum`, streamed SHA-256, verified
  before the file is moved into place).
- Downloads are restricted to the HuggingFace host allowlist over HTTPS.

To audit the pinned hashes yourself, read the registry file — model names, exact URLs, sizes, and
checksums are all declared in one place — and compare against the SHA-256 values published on the
corresponding HuggingFace repository pages.

---

## Logs and crash dumps

Structured logs (JSONL) and crash dumps stay under the app's user-data directory. Log content is
sanitized (secrets such as tokens and API keys are redacted by `src/shared/logger.js`), and nothing
is transmitted anywhere. Deleting the user-data folder removes all of it.

---

## Related documents

- [`docs/MCP_SERVER.md`](MCP_SERVER.md) — the local MCP server's security model (loopback bind,
  bearer auth, origin guard, rate limits)
- [`docs/THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — third-party attribution, including AI
  model licenses
- [`docs/COMMERCIAL_COMPLIANCE.md`](COMMERCIAL_COMPLIANCE.md) — dependency and model license
  compliance process
- Verification scripts run in CI: `npm run verify:ipc-handlers`, `verify:ipc-handler-schemas`,
  `verify:electron-fuses-config`, `compliance:commercial:verify`
