<p align="center">
  <img src="assets/icons/StratoSortStackLogo.svg" alt="StratoSort Logo" width="128" />
</p>

<h1 align="center">StratoSort Stack</h1>

<p align="center">
  <strong>Intelligent File Organization with Privacy-First Local AI</strong>
</p>

<p align="center">
  <a href="https://github.com/iLevyTate/StratoSortStack/releases"><img src="https://img.shields.io/github/v/release/iLevyTate/StratoSortStack?style=flat-square&label=version" alt="Version" /></a>
  <a href="https://github.com/iLevyTate/StratoSortStack/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/iLevyTate/StratoSortStack/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/iLevyTate/StratoSortStack/ci.yml?style=flat-square&label=CI" alt="CI Status" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-41.x-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/node-20.19.0-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/issues-welcome-brightgreen?style=flat-square" alt="Issues Welcome" />
</p>

<p align="center">
  <strong><a href="https://stratosort.com/">Official Website</a> • <a href="https://iLevyTate.github.io/StratoSortStack/">Documentation</a></strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#download">Download</a> •
  <a href="#support-and-feedback">Support</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#contributing">Contributing</a> •
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

StratoSort Stack is a privacy-first, AI-powered file organizer. Drop a folder full of messy files
and StratoSort understands what's actually inside each one — not just the filename — and proposes a
clean structure you can accept or edit. Everything runs locally on your machine by default; your
files never leave the device unless you explicitly opt in to cloud AI.

**What makes it different:**

- **Reads your files, doesn't just rename them.** Vision + OCR + document parsing means a
  screenshot, a scanned receipt, a Word doc, and a Python file all get the same treatment:
  StratoSort actually understands the content and routes it accordingly.
- **Semantic search across everything.** Built-in vector search + BM25 hybrid retrieval finds a file
  by what it is about, even if you never used those words in it, and still finds exact strings like
  an invoice number. Chat's Deep mode adds an LLM re-ranker on top.
- **Knowledge Graph.** See the relationships between your files — clusters, semantic edges, topical
  neighborhoods — in an interactive graph view.
- **Smart Folder Watchers.** Define a folder with a natural-language description ("invoices and
  receipts"); StratoSort routes new files into it automatically as they arrive.
- **MCP server.** Let Claude Desktop, Cursor, Zed, or any other MCP-aware client search and chat
  with your StratoSort-analyzed corpus — without those tools ever uploading your files. See
  [docs/MCP_SERVER.md](docs/MCP_SERVER.md).
- **Optional cloud AI.** Bring your own Anthropic / OpenAI / Ollama / LM Studio / vLLM endpoint for
  higher-quality work on documents that need it. Embeddings stay 100% local always. See
  [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md).
- **Safe by default.** Every move and rename is undoable as a single Ctrl-Z, and files you send to
  the Trash stay in the system Trash for you to restore. Atomic file operations with transaction
  journals mean a crash mid-organize never leaves your files in a half-moved state.
- **No setup tax.** Normal installer, no CLI required, no API keys required, no Python or Docker.
  First launch downloads a 7 to 11 GB model bundle once; after that you're offline-capable.

## Security Warning Notes

Official tagged releases are intended to be signed on Windows and signed/notarized on macOS.
Preview, beta, or manually built artifacts can still trigger OS security prompts. If that happens,
verify that you downloaded the file from
[GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases) and compare its checksum
with the published `checksums-*.sha256` file before proceeding.

### On Windows

If you run an unsigned preview or ad-hoc build, Windows SmartScreen may show a blue "Windows
protected your PC" popup because the publisher is not trusted yet.

1. Click **More info**
2. Click **Run anyway**

### On macOS

If you open an unsigned or unstapled preview build, Gatekeeper may block it saying "the developer
cannot be verified".

1. **Right-click** (or Control-click) the StratoSort Stack app in your Applications folder
2. Select **Open**
3. Click **Open** again in the warning dialog

If macOS says the app is "damaged and should be moved to the Trash", you need to clear the Apple
quarantine flag. Open Terminal and run:

```bash
xattr -cr /Applications/StratoSort\ Core.app
```

---

## Download

### End Users (No CLI)

<p>
  <a href="https://github.com/iLevyTate/StratoSortStack/releases"><img src="https://img.shields.io/badge/Download-Latest%20Release-2ea44f?style=for-the-badge" alt="Download Latest Release" /></a>
</p>

- **Windows/macOS installers:**
  [GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases)
- **Step-by-step install help:** [Install Guide](docs/INSTALL_GUIDE.md)
- **How to use the app:** [User Guide](docs/USER_GUIDE.md)
- **Want to help test?** [Tester Guide](docs/BETA_TESTER_GUIDE.md)

## Support and Feedback

If you run into an issue or have an idea, these links are the fastest way to help:

- **Issues tab:** [View all issues](https://github.com/iLevyTate/StratoSortStack/issues)
- **Report a bug:**
  [Open bug report template](https://github.com/iLevyTate/StratoSortStack/issues/new?template=bug_report.md)
- **Request a feature:**
  [Open feature request issue](https://github.com/iLevyTate/StratoSortStack/issues/new)
- **Contributing guide:** [CONTRIBUTING.md](CONTRIBUTING.md)

## Demo

<p align="center">
  <strong>See StratoSort in action</strong>
</p>

> **Desktop:** Video plays directly below | **Mobile:** Click the filename to watch

https://github.com/user-attachments/assets/7cd1f974-33cb-4d2d-ac8d-ea30c015389b

## What you get today

The current release is **v5.0.0**, the first public release of StratoSort Stack. `main` may include
unreleased work; use GitHub Releases for a stable installer and see **[CHANGELOG.md](CHANGELOG.md)**
for the versioned history.

Shipped in the app you build from this tree:

- **Knowledge OS** — Search, Chat, Timeline, Relate (graph), and Atlas (map).
- **Downloads triage** — Keep / trash / ambiguous review for a messy folder.
- **MCP server** — Opt-in loopback server so Claude Desktop, Cursor, or Zed can search this corpus
  locally.
- **Optional cloud AI** — BYOK Anthropic or OpenAI-compatible endpoints; embeddings stay local.
- **Safe file ops** — Atomic moves, journals, batch undo/redo.

> **Note:** The `main` branch may include unreleased work. For the latest stable build, download the
> newest tagged release from
> [GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases).

## Provenance

StratoSort Stack is the successor to the original
[StratoSort Stack (legacy repository)](https://github.com/iLevyTate/elstratosort). This repository
represents a clean break starting from v2.0.0, focusing on a streamlined, in-process AI
architecture. For versions prior to v2.0.0, or to view the legacy codebase, please visit the
original repository.

## Features

### Core

| Feature                   | What you get                                                                                                                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local AI Intelligence** | In-process LLM via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) reads file content (not just filenames) to suggest categories, names, and routing.  |
| **Privacy-First Design**  | Default-local. Zero telemetry. Zero outbound traffic after model download (unless you opt in to cloud AI).                                                           |
| **Smart Folder Watchers** | Define folders with natural-language descriptions; new files get analyzed and routed in real time as they arrive.                                                    |
| **Image Understanding**   | A multimodal vision model (LLaVA v1.6 Mistral 7B) plus Tesseract OCR categorize screenshots, photos, and scanned PDFs.                                               |
| **Semantic Search**       | Hybrid retrieval: Orama vector search + BM25 full-text + passage vectors. Find files by meaning, not just exact keywords.                                            |
| **Knowledge OS**          | Search, chat, timeline, Relate (graph), and Atlas (map) over the same local index.                                                                                   |
| **Safe Operations**       | Undo/Redo for every move, rename and copy; trashed files stay in the system Trash for manual restore. Journaled moves resume after a crash, and no move is repeated. |
| **GPU Acceleration**      | Auto-detects NVIDIA CUDA, Apple Metal, and Vulkan. Falls back to CPU gracefully on unsupported hardware.                                                             |

### Integrations

| Feature                   | What you get                                                                                                                                                                                                                                                                                                                       |
| :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP Server**            | Expose your StratoSort corpus to [Model Context Protocol](https://modelcontextprotocol.io/) clients (Claude Desktop, Cursor, Zed, etc.). Four tools: `search_documents`, `chat_with_documents`, `get_document_summary`, `list_smart_folders`. Loopback-only, bearer-token auth, opt-in. → [docs/MCP_SERVER.md](docs/MCP_SERVER.md) |
| **Multi-Provider AI**     | Optional opt-in routing to Anthropic (Claude) or any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, vLLM, llama.cpp server) for analysis, chat and suggestions, each routed on its own, with per-Smart-Folder overrides for analysis. Embeddings always stay local. → [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md)         |
| **Per-Folder Overrides**  | Use Claude for the Contracts folder, local for everything else: analysis routing is configurable per Smart Folder, and a monthly spend cap per provider sends analysis and chat back to the local model when hit.                                                                                                                  |
| **Self-Hosted Detection** | Local OpenAI-compatible endpoints (`localhost`, `127.0.0.1`, `.local`) are pinned to $0 spend so your Ollama / LM Studio traffic doesn't eat your budget cap.                                                                                                                                                                      |

### Quality-of-life

| Feature                     | What you get                                                                                                                               |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **Custom Folders**          | Override the AI's routing for specific buckets — your taxonomy wins.                                                                       |
| **Encrypted PDF Detection** | Password-protected PDFs surface a clear "this PDF is encrypted" error instead of silently failing analysis.                                |
| **Batch Resume**            | Crashed mid-organize? Reopen the app and resume the journal — never re-do the same move twice.                                             |
| **Downloads Triage**        | Three-bucket review (keep / trash / ambiguous) for your Downloads folder, with deep-scan embedding for the ambiguous tier.                 |
| **System Tray + Jump List** | System tray menu (Open StratoSort, Semantic Search, Logs, Auto-Sort, Quit) on all platforms; a Windows taskbar Jump List adds quick tasks. |

## Supported File Types

StratoSort Stack currently processes the following file types in the Discover/analysis pipeline:

- **Documents & office:** `.pdf`, `.doc`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`
  (chapters in reading order, title and authors first), `.eml`, `.msg`, `.kml`, `.kmz`, `.ipynb`
  (notebook cells and text outputs)
- **Text, code, and structured data:** `.txt`, `.md`, `.rtf`, `.tex`, `.csv`, `.json`, `.xml`,
  `.yml`, `.yaml`, `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`, `.js`, `.ts`, `.jsx`, `.tsx`,
  `.sql`, `.py`, `.java`, `.c`, `.cpp`, `.h`, `.rb`, `.go`, `.rs`, `.php`, `.sh`, `.bat`, `.ps1`,
  `.ini`, `.conf`, `.log`, `.scad`. Files over the text size limit (50 MB by default) are analyzed
  from their first part.
- **Images:** `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.webp`, `.svg` (its text labels are read
  before the vision pass), `.tiff`, `.tif`, `.ico`; `.heic` and `.heif` are decoded through the
  bundled FFmpeg when its build carries an HEVC decoder, otherwise organized by filename and date
- **Audio:** `.mp3`, `.wav`, `.flac`, `.aac`, `.ogg`, `.oga`, `.m4a`, `.m4b`, `.opus`, `.wma`,
  `.aiff`, `.aif` (transcribed locally via Whisper)
- **Video:** `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.flv`, `.m4v`, `.wmv`, `.3gp`, `.mts`,
  `.m2ts` (audio transcription; keyframe descriptions when "Describe video keyframes" is on in
  Settings → Processing limits)
- **Archives:** `.zip`, `.tar`, `.tgz`, `.gz` are listed by content (entry names become keywords);
  `.rar`, `.7z` and `.bz2` are recognized and organized by name only, because no permissively
  licensed reader exists for them
- **3D / CAD:** `.stl` (name, triangle count, bounding box), `.obj` (object, group and material
  names), `.3mf` (model metadata and object names), `.gcode` (slicer settings and comments), `.scad`
  (read as source text)
- **Design:** `.ai` (PDF-compatible files are read like a PDF, PostScript ones by their header),
  `.eps` (DSC header and shown text); `.psd` is organized by filename and date only

Legacy Excel and PowerPoint binaries (`.xls`, `.ppt`) are picked up and organized by filename and
date only; this build has no reader for their contents. Save them as `.xlsx` or `.pptx` to have the
contents analyzed.

## Quick Start

### End Users — One Download, No CLI

1. **[Download the installer](https://github.com/iLevyTate/StratoSortStack/releases)** for Windows,
   macOS, or Linux.
2. **Run it** — allow the app if your OS shows a security prompt (see
   [Install Guide](docs/INSTALL_GUIDE.md)).
3. **First launch** — choose a model profile and approve the download (7 to 11 GB, one-time).

No terminal, Python, Docker, or API keys. See the full **[Install Guide](docs/INSTALL_GUIDE.md)**
for step-by-step instructions on both platforms and how to handle unsigned-app prompts.

### Supported Platforms

| Platform    | Architectures | Notes                                                                                                 |
| :---------- | :------------ | :---------------------------------------------------------------------------------------------------- |
| **Windows** | x64, arm64    | Windows 10 22H2 and Windows 11. NSIS installer + portable EXE. (arm64 ships without bundled FFmpeg.)  |
| **macOS**   | arm64, x64    | macOS 12 (Monterey) or later. Apple Silicon and Intel both shipped. DMG + ZIP.                        |
| **Linux**   | x64, arm64    | Ubuntu 22.04+ and derivatives. AppImage + deb. Lower priority — some media features may be unbundled. |

### Hardware

| Requirement        | Specification                                                                           |
| :----------------- | :-------------------------------------------------------------------------------------- |
| **Memory**         | 8 GB RAM minimum; 16 GB and a GPU with 8 GB for the Better Quality profile.             |
| **Storage**        | 7.4 GB (Base) or 10.4 GB (Better Quality) for the AI models, plus your analysis cache.  |
| **GPU (optional)** | NVIDIA CUDA, Apple Metal, or Vulkan-compatible GPU for acceleration. Falls back to CPU. |

### Developers — Build from Source

Recommended Node version is `20.19.0` (see `.nvmrc`).

```bash
git clone https://github.com/iLevyTate/StratoSortStack.git
cd StratoSortStack
nvm use
npm ci
npm run dev
```

**First Launch:** The app automatically downloads required AI models (GGUF format) on first run. GPU
acceleration is auto-detected.

**Default Models (Base Small):** Llama 3.2 3B (text), LLaVA v1.6 Mistral 7B (vision),
all-MiniLM-L6-v2 (embeddings). A "Better Quality" profile (Qwen2.5 7B text + nomic-embed-text
embeddings) is available during setup. Change defaults in `src/shared/aiModelConfig.js`. See
[docs/CONFIG.md](docs/CONFIG.md) for details.

## Advanced Capabilities

### Smart Folders and Watchers

Define categories with natural language descriptions ("invoices and receipts", "research papers on
transformers"). The Smart Folder Watcher monitors your downloads or any designated folder,
automatically analyzing new items and routing them based on content understanding — not just file
extensions or path patterns.

Routing can be overridden per folder (use Claude for Contracts, local LLM for everything else) and
the AI's suggestion is always reviewable before files actually move.

### Vision and OCR

StratoSort doesn't just read text files. It uses a multimodal vision model (LLaVA v1.6 Mistral 7B)
plus Tesseract OCR to interpret images, enabling automatic organization of receipts, screenshots,
diagrams, and scanned PDFs. The vision runtime spawns the bundled `llama-server` with a multimodal
projector and runs inference on your GPU when available.

### Semantic Search and Re-Ranking

Search implies meaning. StratoSort combines:

- **Vector search** via [Orama](https://orama.com) over embeddings (default `all-MiniLM-L6-v2`;
  `nomic-embed-text` in the Better Quality profile).
- **BM25 full-text** as a parallel keyword channel.
- **Passage vectors** over each document's text, so a match deep inside a long file still counts.
- **Optional LLM re-ranking**, used by Chat's Deep mode: a compact model scores each candidate
  against the query. It is off in the Search tab and the MCP tool, where it would cost one LLM call
  per result.

The result is hybrid retrieval that handles meaning-based queries ("the lease renewal from Acme") as
well as exact-keyword searches like "invoice 12345". Dates in a query are not parsed as filters yet:
a four-digit year boosts files that mention it, but "last quarter" is matched as words.

### MCP Server — bring StratoSort into your other AI tools

Open Settings → MCP Server → Enable. StratoSort starts a local Model Context Protocol server on
`127.0.0.1` and gives you a copy-pasteable config snippet for Claude Desktop / Cursor / Zed. Paste
it into your client, restart the client, and now the client can ask StratoSort to:

- `search_documents` — hybrid search across your indexed corpus.
- `chat_with_documents` — conversational RAG with citation markers and chunk references.
- `get_document_summary` — pure cache lookup of a previously analyzed file.
- `list_smart_folders` — enumerate your Smart Folders for scoped queries.

Every tool call goes through bearer-token auth, an Origin allowlist (DNS-rebinding defense), and a
60 req/min token-bucket rate limit. Query text is **not logged at info or warn**. Development-only
trace logs may include a truncated query. Full detail in
**[docs/MCP_SERVER.md](docs/MCP_SERVER.md)**.

### Multi-Provider AI — local first, cloud when you want it

Out of the box, every operation runs on the local LLM. No keys, no internet. If you want the quality
bump of Claude or GPT-4 for some operations, configure your provider in **Settings → AI Provider**
and choose where it gets used:

- **A default provider, and a choice per operation.** Document analysis, chat and organization
  suggestions each follow the default unless you pick a provider for that one operation (cloud for
  analysis, local for chat, for example) in Settings → AI Provider.
- **Per-folder overrides:** use Claude for Contracts, local for everything else (applies to analysis
  of files in that folder).
- **Budget cap:** a monthly spend cap per provider (Configure → Monthly spend cap, shown next to
  this month's estimated spend). At the cap, document analysis and chat fall back to the local
  model, and organization suggestions skip the LLM instead — that run is ranked by filename
  patterns, built-in organization strategies, folder-fit scores and clusters, plus embeddings
  outside LLM-only routing and the category already stored by analysis when routing relies on the
  LLM.
- **Self-hosted detection:** Ollama / LM Studio / vLLM on `localhost` are pinned to $0 spend so your
  local traffic doesn't eat the cap.

API keys are stored encrypted via `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
Linux). **Embeddings always stay local** — the vector index that powers search is never uploaded, no
matter how cloud routing is configured. Full detail in
**[docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md)**.

### Knowledge Graph

An interactive force-directed graph view of your corpus. Nodes are files, edges are semantic
similarity above a threshold, clusters are connected components. Useful for finding the
"neighborhood" of a document — what else in your library is related to this contract, this research
paper, this screenshot.

The graph rebuilds incrementally as you add files. Force a fresh rebuild from Settings → Rebuild
Relationships if you want to capture changes immediately.

### Safe Operations

Every move, rename, copy, and trash goes through StratoSort's atomic file operations layer:

- **Atomic writes** (write-to-temp + rename) so a crash mid-write never produces a half-written
  file.
- **Transaction journals** persisted before the operation runs; an interrupted organize batch
  resumes at next startup from the journal, and settings writes roll back if torn.
- **Batch undo/redo** as a single Ctrl-Z — drag 200 files into a Smart Folder, change your mind, one
  undo reverses the whole batch.
- **Path safety** at every IPC boundary — relative paths, URL-style protocols, device paths and `..`
  traversal are rejected before any filesystem call runs; UNC paths are accepted only for Smart
  Folders registered on a network share and for files and destinations under them (see SECURITY.md).

## Privacy and Security

| Principle                 | Implementation                                                                                                                                                                                              |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **100% Local Processing** | No internet required after model download                                                                                                                                                                   |
| **Zero Telemetry**        | No data collection or tracking of any kind                                                                                                                                                                  |
| **Source Available**      | [PolyForm Noncommercial 1.0.0](LICENSE); commercial use requires a [paid license](docs/COMMERCIAL.md)                                                                                                       |
| **Secure by Default**     | Context isolation, input validation, path sanitization                                                                                                                                                      |
| **Transparent Storage**   | The local search index stores extracted document text (for semantic search and chat citations) under your app data folder — on your machine only, removable by rebuilding the index or deleting that folder |

See **[SECURITY.md](SECURITY.md)** for the complete security policy.

## Documentation

### For users

| Document                                                 | Description                                                   |
| :------------------------------------------------------- | :------------------------------------------------------------ |
| **[Install Guide](docs/INSTALL_GUIDE.md)**               | End-user install (Windows & Mac, no CLI)                      |
| **[User Guide](docs/USER_GUIDE.md)**                     | Feature walkthrough for everyday use                          |
| **[License](LICENSE)**                                   | Personal/noncommercial grant (PolyForm Noncommercial 1.0.0)   |
| **[Commercial licensing](docs/COMMERCIAL.md)**           | How to buy a commercial license                               |
| **[E2E Walkthrough](docs/E2E_WALKTHROUGH.md)**           | Visual end-to-end walkthrough (in-repo screenshots)           |
| **[MCP Server](docs/MCP_SERVER.md)**                     | Use StratoSort from Claude Desktop / Cursor / Zed             |
| **[AI Providers](docs/AI_PROVIDERS.md)**                 | Multi-provider routing: local + Anthropic + OpenAI-compatible |
| **[Network Transparency](docs/NETWORK_TRANSPARENCY.md)** | Every network call the shipped app can make                   |
| **[Tester Guide](docs/BETA_TESTER_GUIDE.md)**            | Testing + bug reporting for contributors                      |

### For developers

| Document                                       | Description                              |
| :--------------------------------------------- | :--------------------------------------- |
| **[Getting Started](docs/GETTING_STARTED.md)** | Developer setup and build guide          |
| **[Onboarding](docs/ONBOARDING.md)**           | Clone-to-first-PR for engineers          |
| **[Docs index](docs/README.md)**               | Map of every living document             |
| **[Architecture](docs/ARCHITECTURE.md)**       | System design and data flow              |
| **[Configuration](docs/CONFIG.md)**            | Environment variables and runtime config |
| **[Graph Features](docs/FEATURES_GRAPH.md)**   | Knowledge Graph capabilities             |
| **[IPC Contracts](docs/IPC_CONTRACTS.md)**     | IPC communication specifications         |
| **[Motion System](docs/MOTION_SYSTEM.md)**     | UI animation timing and easing standards |
| **[Release Guide](docs/RELEASING.md)**         | Release process, pre-flight, and smoke   |

## Contributing

Contributions are welcome. Please see **[CONTRIBUTING.md](CONTRIBUTING.md)** for guidelines.

1. Fork the repository
2. Create a feature branch
3. Make changes and verify with `npm test`
4. Submit a Pull Request

## Inspiration and Related Projects

StratoSort builds on ideas from the growing ecosystem of AI-powered file organization:

| Project                                                                       | Description                                                            |
| :---------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| **[llama-fs](https://github.com/iyaja/llama-fs)**                             | Self-organizing filesystem with Llama 3; pioneered watch mode learning |
| **[Local-File-Organizer](https://github.com/QiuYannnn/Local-File-Organizer)** | Privacy-first organizer using Llama3.2 and LLaVA                       |
| **[ai-file-sorter](https://github.com/hyperfield/ai-file-sorter)**            | Cross-platform desktop app with preview and undo                       |
| **[Hazel](https://www.noodlesoft.com/)**                                      | Industry standard Mac file automation                                  |
| **[Sparkle](https://makeitsparkle.co/)**                                      | Mac AI organizer using GPT-4/Gemini                                    |

## License

**PolyForm Noncommercial 1.0.0** — personal and other noncommercial use is free. Commercial use
requires a paid license from Kennedy Applied Sciences.

See **[LICENSE](LICENSE)**, **[docs/COMMERCIAL.md](docs/COMMERCIAL.md)** for how to buy a commercial
license, and **[docs/COMMERCIAL_COMPLIANCE.md](docs/COMMERCIAL_COMPLIANCE.md)** for third-party
attribution. Third-party components remain governed by their own licenses (see
**[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)**).

---

<p align="center">
  <a href="https://github.com/iLevyTate/StratoSortStack">GitHub</a> •
  <a href="https://github.com/iLevyTate/StratoSortStack/issues">Report Bug</a> •
  <a href="https://github.com/iLevyTate/StratoSortStack/issues">Request Feature</a>
</p>

<p align="center">
  Built with <a href="https://github.com/withcatai/node-llama-cpp">node-llama-cpp</a> and <a href="https://orama.com">Orama</a>
</p>

<p align="center">
  © 2026 Kennedy Applied Sciences, Inc.
</p>
