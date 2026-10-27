---
layout: single
title: 'Dependency Boundaries'
sidebar:
  nav: 'docs'
---

This document defines the intended main/renderer/shared boundaries that keep layers from coupling.
They describe the direction new code should follow. They are **not lint-enforced** today
(`eslint.config.js` has no import-boundary rule), and the known exceptions are listed below.

## Rules

1. **Renderer must not import main-only modules** (e.g., `src/main/*`).
2. **Main must not import renderer-only modules** (e.g., `src/renderer/*`).
3. **Shared modules** (`src/shared/*`) that the renderer imports must avoid Node APIs that are not
   available in the sandboxed renderer.
4. **IPC is the only bridge** between main and renderer. Use typed IPC contracts.

## Allowed Imports

- Renderer: `src/shared/*`, `src/renderer/*`
- Main: `src/shared/*`, `src/main/*`
- Shared: `src/shared/*` only (see exceptions)

## Known exceptions

`src/shared/` also holds some main-process-only utilities. They are never imported by the renderer,
but they break rule 3 and the "shared imports shared only" line:

- **Shared modules that import from `src/main/`:**
  - `src/shared/atomicFileOperations.js` lazily requires `../main/errors/FileSystemError` and
    `../main/services/DegradedStateTracker`.
  - `src/shared/fileOperationTracker.js` resolves `../main/services/ServiceContainer` through its
    `getContainer` closure.
- **Shared modules that use Node or Electron APIs** (`fs`, `os`, `child_process`, `electron`):
  `atomicFile.js`, `atomicFileOperations.js`, `crossPlatformUtils.js`, `fileOperationTracker.js`,
  `logger.js`, `pathSanitization.js`, `platformUtils.js`, `safeStorageEncryption.js` and
  `securityConfigPathLimits.js`. Some of these are also bundled for the renderer or preload; they
  guard the Node-only paths at runtime or are swapped for stubs (for example
  `securityConfigPathLimits.preload-stub.js`) or webpack `resolve.fallback` shims.

When you touch one of these modules, prefer moving main-only logic under `src/main/` over adding
more exceptions.

## Enforcement

- Prefer IPC channels and payload schemas for cross-process data.
- Review new `src/shared/*` imports against the rules above; an import-boundary lint rule would be
  welcome.
