# Security Policy

<p align="center">
  <img src="https://img.shields.io/badge/security-priority-red?style=flat-square" alt="Security Priority" />
  <img src="https://img.shields.io/badge/local--only-no%20cloud-green?style=flat-square" alt="Local Only" />
</p>

## Supported Versions

Security fixes land in the latest minor release line. Older lines are not back-ported.

| Version | Supported          |
| ------- | ------------------ |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Security Design Principles

StratoSort is designed with security and privacy as core principles:

- **Local-First Processing.** All AI analysis happens locally, in-process. No data is sent to a
  server we operate.
- **Local search index contains document text.** To power semantic search and chat citations, the
  on-device index (Orama) stores extracted text of analyzed documents in chunks, alongside
  embeddings, file names, keywords, and tags. This data lives only under the user's application data
  directory, is never transmitted, and is deleted when the index is rebuilt from scratch or the
  application data directory is removed. Users indexing sensitive material should treat that
  directory with the same care as the documents themselves (e.g. full-disk encryption).
- **Hardened Electron runtime.** Sandbox enabled, context isolation enabled, `nodeIntegration`
  disabled, `webviewTag` disabled, sender origin validated on every IPC invocation.
- **Strict Content Security Policy.** `script-src 'self'` (no `unsafe-eval`); inline-style hashes
  pinned and verified at build time.
- **Electron fuses pinned in production builds.** `runAsNode`,
  `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments`,
  `grantFileProtocolExtraPrivileges` all set to `false`; `enableEmbeddedAsarIntegrityValidation` and
  `onlyLoadAppFromAsar` set to `true`. Verified in CI via `scripts/verify-electron-fuses-config.js`;
  verifiable on a built binary with `npx @electron/fuses read --app <path>`.
- **Input Validation.** All IPC handlers that accept input enforce Zod schema validation. Coverage
  is enforced at build time via `scripts/verify-ipc-handler-schemas.js`.
- **Path Sanitization.** File paths are normalized and rejected against dangerous patterns (URL
  schemes, traversal, reserved names, system directories) before any filesystem call. UNC paths are
  accepted only for Smart Folders the user registered on a network share, for files under them, and
  for destinations inside them.
- **Destination containment.** A move or copy requested by the renderer lands only in a Smart
  Folder, a folder picked in a native dialog this session, Downloads, the app data directory or the
  file's own folder; any other folder is confirmed in a main-process dialog first, once per folder
  per session. Autostart folders (Windows Startup, macOS LaunchAgents and LaunchDaemons,
  `~/.config/autostart`) are refused outright. `shell.openPath` never receives an executable, a link
  to one, or an application bundle. The vector index stays under the app data directory whatever
  `settings.json` says.
- **Cloud consent is recorded in main.** Turning cloud AI on requires a main-process confirmation
  dialog in addition to the in-app notice, so a renderer cannot grant consent on its own.
- **Atomic file operations with transaction journaling.** Multi-file moves are journaled and rolled
  back on next startup if the app crashes mid-operation.
- **Auto-update signature validation.** Update metadata is hash-verified (SHA-512); update feeds are
  HTTPS-only and host-allowlisted.
- **No Telemetry by Default.** Analytics, telemetry, and remote crash reporting are disabled. Crash
  dumps stay on disk under the user's application data directory and are never automatically
  uploaded.

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please follow these
steps:

**Contact:** For sensitive reports, use GitHub Security Advisories (below). For general security
questions you may open a discussion on the repository; do not post exploit details publicly.

**Encrypted reports (optional):** If you prefer PGP, publish a public key in your report or ask for
the maintainers’ key in an initial advisory-only message. The project may publish a dedicated
`security@` address and a PGP key on the website or GitHub org profile as they become available.

### For Critical Vulnerabilities

1. **Do NOT** create a public GitHub issue
2. Report privately via **GitHub Security Advisories** (preferred)
   - Use the repository’s **Security** tab → **Report a vulnerability**
3. Include:
   - A clear description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Any suggested fixes (optional but appreciated)

### For Non-Critical Issues

1. Create a GitHub issue with the `security` label
2. Avoid including exploit code or detailed attack vectors in public issues

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Resolution Timeline**: Depends on severity
  - Critical: 1-7 days
  - High: 7-14 days
  - Medium: 14-30 days
  - Low: Next release cycle

## Security Best Practices for Users

### Installation

- Download StratoSort only from official sources (GitHub Releases)
- Verify checksums when available
- Keep the application updated to the latest version

### Configuration

- Review imported settings files before applying
- Use strong, unique paths for sensitive document organization
- Regularly backup your settings using the built-in backup feature

### Network

- StratoSort runs entirely in-process for AI and vector search
- No telemetry or analytics are ever sent. The only outbound requests are: HTTPS update-metadata
  checks when `autoUpdateCheck` is enabled (on by default; disable in Settings → Application), model
  downloads on first run, and any cloud AI provider you explicitly opt into (Anthropic / an
  OpenAI-compatible endpoint). Embeddings and vector search always stay local.

## Known Security Considerations

### Electron Security

- Node integration is disabled in the renderer process
- Context isolation is enabled
- Web security is enabled
- The sandbox is enabled for all renderer processes

### File System Access

- StratoSort requires file system access to organize files
- Dangerous system paths are blocked from organization operations
- Path traversal attacks are mitigated through validation

### Settings Import/Export

- Imported settings are validated against a whitelist of allowed keys
- URL patterns are validated to prevent SSRF-style attacks
- Prototype pollution attacks are explicitly blocked

## Security Updates

Security updates will be released as patch versions (e.g., 4.0.1, 4.0.2) and announced via:

- GitHub Releases
- In-app update notifications (if auto-update is enabled)

## Acknowledgments

We appreciate the security research community's efforts in making StratoSort more secure.
Contributors who report valid security issues will be acknowledged here (with permission).

---

_Last updated: 2026-09-26 — applies to StratoSort Core 4.0.6._
