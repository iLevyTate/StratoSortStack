# Privacy Policy

**Effective date: 2026-09-26**

StratoSort Stack ("StratoSort", "the application", "we") is built and distributed by Kennedy Applied
Sciences, Inc. ("we", "us"). This document explains what data StratoSort handles, where it lives,
and your rights with respect to it.

If you have read nothing else, the short version is: **StratoSort is local-first by design. Your
files, the analyses we generate from them, and the search index we build all live on your machine.
Nothing is sent to a server we operate.**

---

## 1. What StratoSort processes

StratoSort organizes files on your computer using on-device AI. To do that, the application reads
the contents of files you explicitly choose, generates analyses (categories, suggested filenames,
summaries), produces vector embeddings, and writes those results to a local database so search and
re-organization stay fast.

We process the following categories of data:

- **File contents and metadata of files you select.** Including text extracted from documents,
  images you ask the application to analyze (via vision and OCR), filenames, paths, sizes,
  timestamps, and file format.
- **AI analysis output.** Suggested categories, suggested filenames, summaries, tags, and confidence
  scores produced by the bundled local language model.
- **Vector embeddings of file content.** Mathematical fingerprints of the documents you analyze,
  used by semantic search.
- **Settings.** Your preferences (Smart Folders, watchers, AI provider configuration, theme, model
  profile, etc.).
- **Operational telemetry, locally only.** Structured logs and crash dumps, written to disk for
  troubleshooting. These are never automatically uploaded.

We do not collect:

- Identity data (name, email, phone) — there is no account system.
- Payment information — the application is delivered without a billing surface.
- Browser or device fingerprinting beyond what your operating system already exposes via
  `process.platform` and the Electron runtime.

---

## 2. Where data is stored

All persistent state lives under your operating system's standard application data directory:

| OS      | Application data directory                        |
| ------- | ------------------------------------------------- |
| Windows | `%APPDATA%\StratoSort Stack\`                     |
| macOS   | `~/Library/Application Support/StratoSort Stack/` |
| Linux   | `~/.config/StratoSort Stack/`                     |

Inside this directory you will find:

- The Orama vector database and full-text index (`*.orama` files or equivalent).
- Cached AI analyses (one file per analyzed document).
- Your settings (`settings.json` and related state files).
- Application logs (`logs/`).
- Crash dumps, if any (`crash-dumps/`).
- Downloaded AI model files (`models/` or a comparable subdirectory).

The application data directory is owned by your user account on your operating system. We have no
remote copy.

---

## 3. Network behavior

StratoSort is designed to operate without network access after first run.

- **First run, model download.** The first time you launch StratoSort and choose a model profile,
  the application downloads AI model files (roughly 7–10 GB depending on the profile you pick) from
  the public model hosts that those models are published on (for example, Hugging Face). Each
  download is fetched over HTTPS, the source host is on a hard-coded allowlist, and the file's
  SHA-256 hash is verified before the model is loaded. The destination of each download is visible
  in the install wizard.
- **Update checks.** Installed (packaged) builds check for updates by default; development runs
  never do, and `STRATOSORT_ENABLE_AUTO_UPDATES=false` disables the updater entirely. Background
  checks follow the `autoUpdateCheck` preference (on by default) and can be disabled in Settings →
  Application → Background Update Checks; a manual "Check for updates" remains available either way.
  When a check runs, the only network call is to the configured update feed (GitHub Releases by
  default), to fetch a metadata file describing the latest version. No personal data is sent. No
  file contents, no usage data, and no identifiers are transmitted in update checks. Microsoft Store
  installs never self-update — the Store manages updates.
- **Optional cloud AI providers.** If you explicitly configure an external provider in Settings → AI
  Provider (Anthropic, OpenAI, Ollama on a remote host, LM Studio, vLLM, or any other
  OpenAI-compatible endpoint), then text from the specific operations you route through that
  provider is sent to that provider over HTTPS. **This is opt-in and off by default.** Document
  analysis, every chat question (which sends the matching passages, summaries and file paths,
  including text read from images by OCR) and organization suggestions each follow the default
  provider unless you route that one operation elsewhere in Settings → AI Provider; per-folder
  overrides apply to analysis. Embeddings — the data structure that powers search — and image pixels
  always stay local regardless of provider configuration. See `docs/AI_PROVIDERS.md` for the full
  configuration surface.
- **Optional MCP server.** If you enable the Model Context Protocol server in Settings, the
  application listens on `127.0.0.1` (loopback only) for local MCP clients on your machine.
  Connections from the public internet are not accepted. The server is bearer-token authenticated
  and rate-limited. See `docs/MCP_SERVER.md` for details.

We operate **no servers**, run **no analytics**, and integrate **no third-party telemetry SDKs** (no
Sentry, no Mixpanel, no Segment, no Google Analytics, no fingerprinting library) in this
distribution.

---

## 4. Logs and crash dumps

StratoSort writes structured application logs to the `logs/` subdirectory of the application data
directory above. Logs are JSON lines with correlation IDs, used for diagnosing problems. They
include operational events such as service startup, IPC channel activity, and analysis pipeline
state — but the structured logger redacts sensitive keys (token, password, apiKey, and equivalents)
before they are written to disk.

Logs **may** include file paths from your filesystem (for example, the path of a file that failed to
parse). They do **not** include the contents of the files you analyzed.

Crash dumps are written via Electron's built-in crash reporter to `crash-dumps/` in the application
data directory. The crash reporter is configured with `uploadToServer: false` — crash dumps are
never automatically transmitted anywhere. They exist only to help you (or to be voluntarily attached
to a bug report by you).

You can open the logs folder, export a log archive, or delete logs at any time from Settings →
Diagnostics → Troubleshooting logs (advanced experience mode).

---

## 5. Your data, your choice

### Inspect

- All AI analyses are visible in the application UI on the file's detail view.
- The application data directory is a normal directory you can open in Finder / Explorer / your file
  manager. Nothing is hidden.
- You can export your settings via Settings → Application → "Settings backup & restore" at any time
  (advanced experience mode).

### Delete

- **Per-file:** Removing a file's analysis is available in the UI; the cached analysis and its
  vector embedding are deleted from the local database.
- **All analyses:** Settings → AI Configuration → "Rebuild All Embeddings" (advanced experience
  mode) rebuilds the vector database; clearing/rebuilding leaves your original files untouched.
- **Everything:** Quit StratoSort and delete the application data directory listed in section 2.
  This removes all settings, indexes, analyses, logs, crash dumps, and downloaded models.

### Uninstall

Uninstalling the application via your operating system's installer / package manager removes the
application binaries. **Application data (settings, indexes, analyses, logs, models) is not
automatically removed by the uninstaller** — this is intentional so that reinstalling does not lose
your work. To fully remove all data, also delete the application data directory listed in section 2.

---

## 6. GDPR / CCPA / similar regional rights

Because StratoSort processes your data **locally on your own device** and we receive nothing, in
most data-protection frameworks (including the GDPR and the CCPA) the **user is the controller of
their own data**. We do not hold any copy of your data and have no record to provide, correct, or
delete in response to a data subject request directed at us.

If you have routed any operation to an opt-in third-party AI provider (section 3), that provider
processes the relevant request data under its own terms and privacy policy; we do not retain or have
access to those interactions either.

You can exercise the equivalent of inspect / correct / delete rights at any time using the controls
described in section 5.

---

## 7. Children

StratoSort is a productivity tool for general use. It is not directed at children under 13 (United
States) or under 16 (United Kingdom and the European Economic Area), and we do not knowingly collect
data from children — we do not knowingly collect data from anyone, since the application operates
entirely on your local machine.

---

## 8. Security

See [SECURITY.md](SECURITY.md) for the security model, vulnerability disclosure process, and the
defenses we apply to local data (Electron sandbox, ASAR integrity, IPC schema validation, path
sanitization, atomic file operations with transaction journaling).

---

## 9. Changes to this policy

If we change this policy, the effective date at the top of the document will change and the version
of the application that ships with the new policy will include the updated text. Material changes to
the data we process locally — for example, if a future release introduced an opt-in remote
diagnostics feature — would be flagged in the release notes and require an explicit user action to
take effect.

---

## 10. Contact

For privacy-related questions, including data-subject requests:

- General contact: open an issue at
  [github.com/iLevyTate/StratoSortStack/issues](https://github.com/iLevyTate/StratoSortStack/issues).
- For sensitive disclosures (security issues that touch privacy), follow the process in
  [SECURITY.md](SECURITY.md) — use GitHub Security Advisories on the repository's Security tab.

---

_Document version: 1.3 · Effective 2026-10-26 · StratoSort Stack 5.0.0_
