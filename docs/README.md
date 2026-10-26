---
layout: single
title: 'Documentation Index'
sidebar:
  nav: 'docs'
---

# StratoSort Stack Documentation Index

Pick the doc that matches what you need to do.

## I am new here

**Start with [ONBOARDING.md](ONBOARDING.md)** — clone-to-first-PR in ~30 minutes. Covers the mental
model, the five files to read first, an end-to-end IPC trace, the service inventory, and the
surprises that bite senior devs.

Then keep these tabs open:

| Doc                                                    | What it answers                                   |
| ------------------------------------------------------ | ------------------------------------------------- |
| [GETTING_STARTED.md](GETTING_STARTED.md)               | "What are the mechanical setup steps?"            |
| [GLOSSARY.md](GLOSSARY.md)                             | "What does this term mean in this codebase?"      |
| [PHILOSOPHY.md](PHILOSOPHY.md)                         | "What design principles guide this codebase?"     |
| [PACKAGE_SCRIPTS.md](PACKAGE_SCRIPTS.md)               | "Which `npm run` do I want?"                      |
| [DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md)               | "My local dev is broken — what now?"              |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | "How are main / preload / renderer wired?"        |
| [IPC_CONTRACTS.md](IPC_CONTRACTS.md)                   | "What's the wire format for channel X?"           |
| [DI_PATTERNS.md](DI_PATTERNS.md)                       | "How does `ServiceContainer.getInstance()` work?" |
| [ERROR_HANDLING_GUIDE.md](ERROR_HANDLING_GUIDE.md)     | "What error type / classifier should I use?"      |
| [CODE_QUALITY_STANDARDS.md](CODE_QUALITY_STANDARDS.md) | "What does this project consider 'clean code'?"   |
| [TESTING.md](TESTING.md)                               | "How do I write/run tests for this change?"       |
| [CONFIG.md](CONFIG.md)                                 | "Which `STRATOSORT_*` env var controls X?"        |

## Licensing

| Doc                                                  | What it is                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [`LICENSE`](../LICENSE) (repo root)                  | Live grant: PolyForm Noncommercial 1.0.0 (personal/noncommercial free) |
| [COMMERCIAL.md](COMMERCIAL.md)                       | How to buy a commercial license                                        |
| [COMMERCIAL_COMPLIANCE.md](COMMERCIAL_COMPLIANCE.md) | Pre-release third-party license audit + appendices                     |

## Privacy and network

| Doc                                                | What it answers                             |
| -------------------------------------------------- | ------------------------------------------- |
| [NETWORK_TRANSPARENCY.md](NETWORK_TRANSPARENCY.md) | Every network call the shipped app can make |
| [AI_PROVIDERS.md](AI_PROVIDERS.md)                 | Optional BYOK cloud routing                 |
| [MCP_SERVER.md](MCP_SERVER.md)                     | Local MCP server for other AI tools         |

## I am running a release

| Doc                                                  | What it covers                                            |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [RELEASING.md](RELEASING.md)                         | Tagging, pre-flight, post-install smoke, signing/notarize |
| [MAC_SIGNING.md](MAC_SIGNING.md)                     | macOS Developer ID signing + notarization runbook         |
| [COMMERCIAL_COMPLIANCE.md](COMMERCIAL_COMPLIANCE.md) | Pre-release license audit + appendices                    |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)     | Attribution shipped in the installer (load-bearing)       |
| [UPDATE_HOST.md](UPDATE_HOST.md)                     | `electron-updater` feed configuration                     |

## I am working on a specific subsystem

| Subsystem                       | Doc                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Search / Knowledge OS           | [FEATURES_GRAPH.md](FEATURES_GRAPH.md), [SEMANTIC_PIPELINE.md](SEMANTIC_PIPELINE.md), [ORAMA_VECTOR_SIDECAR.md](ORAMA_VECTOR_SIDECAR.md) |
| UI animation                    | [MOTION_SYSTEM.md](MOTION_SYSTEM.md)                                                                                                     |
| AI provider plumbing (BYOK)     | [AI_PROVIDERS.md](AI_PROVIDERS.md)                                                                                                       |
| MCP server                      | [MCP_SERVER.md](MCP_SERVER.md)                                                                                                           |
| Cross-package import discipline | [DEPENDENCY_BOUNDARIES.md](DEPENDENCY_BOUNDARIES.md)                                                                                     |

## I am a tester or end user

These docs are for non-developer audiences. Skip them if you're working on the code.

| Doc                                                                            | Audience                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| [USER_GUIDE.md](USER_GUIDE.md)                                                 | End user — how the app behaves                              |
| [E2E_WALKTHROUGH.md](E2E_WALKTHROUGH.md)                                       | Visual tour (stills + how-to clip)                          |
| [INSTALL_GUIDE.md](INSTALL_GUIDE.md)                                           | Installer for any user                                      |
| [BETA_TESTER_GUIDE.md](BETA_TESTER_GUIDE.md)                                   | Tester — install, checklist, bug reports                    |
| [walkthrough-assets/HOW_TO_USE_TOUR.md](walkthrough-assets/HOW_TO_USE_TOUR.md) | How to regenerate the recorded clip (`npm run tour:record`) |

Everything above is live. Tour media:
[walkthrough-assets/HOW_TO_USE_TOUR.md](walkthrough-assets/HOW_TO_USE_TOUR.md), `how-to-use.mp4`,
`shorts/stratosort-short.mp4`, and `demo-files/`. Public stills for Pages live in
[assets/e2e-screenshots/](assets/e2e-screenshots/).

Load-bearing files that must stay: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
`commercial-use-inventory.json`, `commercial-model-licenses.json`,
`commercial-compliance-waivers.json`. They are in git; Pages does not publish the JSON inventories.

Gitignored (local only): `walkthrough-assets/tour-raw/`, `walkthrough-assets/tour/` (recorder PNG
dumps), `walkthrough-assets/shorts/probe/`, `walkthrough-assets/lessons/probe/`, `.legacy/`,
`licenses-production.json`.

## What's in the repo root (not under `docs/`)

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `README.md`          | Public-facing project overview                            |
| `CLAUDE.md`          | Project intelligence for AI assistants                    |
| `CONTRIBUTING.md`    | How to contribute                                         |
| `CODE_OF_CONDUCT.md` | Community standards                                       |
| `SECURITY.md`        | How to report vulnerabilities                             |
| `PRIVACY.md`         | Data-handling policy                                      |
| `CHANGELOG.md`       | Release notes                                             |
| `LICENSE`            | PolyForm Noncommercial 1.0.0 (commercial sold separately) |

## Adding a new doc

1. Name it `UPPERCASE_WITH_UNDERSCORES.md`.
2. Put a one-line description at the top so the index entry has something to copy.
3. Add a row to the table in the matching section above.
4. If the doc is regenerable from code (e.g. line-by-line audits), do **not** check it into `docs/`.
   Add a regen script under `scripts/` and let people run it on demand.
