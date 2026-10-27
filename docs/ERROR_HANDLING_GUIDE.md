---
layout: single
title: 'Error Handling Guide'
sidebar:
  nav: 'docs'
toc: true
toc_label: 'Guide Sections'
toc_icon: 'exclamation-triangle'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/30_settings_diagnostics.webp
  caption: 'Error Handling Patterns'
---

# Error Handling Guide

## Overview

This guide covers the error-handling building blocks that exist in the StratoSort Stack codebase
today and when to reach for each one. Every function named here is a real export; if you find one
that no longer matches the code, the code wins — please fix this page.

| Layer                         | Module                                                                |
| :---------------------------- | :-------------------------------------------------------------------- |
| Response envelopes + codes    | `src/shared/errorHandlingUtils.js`, `src/shared/errorCodes.js`        |
| IPC handler wrapping          | `src/main/ipc/ipcWrappers.js`                                         |
| Timeouts, retries, cleanup    | `src/shared/promiseUtils.js`                                          |
| Typed errors (main process)   | `src/main/errors/AnalysisError.js`, `FileSystemError.js`              |
| Classification                | `src/shared/errorClassifier.js`, `src/shared/llamaErrorClassifier.js` |
| Process-level handler         | `src/main/errors/ErrorHandler.js`                                     |
| Renderer display + boundaries | `src/renderer/utils/errorMapping.js`, `ErrorBoundary.jsx`             |

---

## 1. Response envelopes (`errorHandlingUtils.js`)

`src/shared/errorHandlingUtils.js` exports `ERROR_CODES`, `createErrorResponse`,
`createSuccessResponse`, `withRetry`, `logFallback`, `getErrorMessage` and `attachErrorCode`.

- `createErrorResponse(error, context = {})` returns the canonical failure envelope:

  ```javascript
  {
    success: false,
    error: {
      code: 'FILE_NOT_FOUND', // error.code || error.errorCode || ERROR_CODES.UNKNOWN_ERROR
      message: 'File not found',
      details: { errorType: 'Error', correlationId, ...context } // omitted when empty
    }
  }
  ```

  The first argument is the **error** (or an error-like `{ message, name, code }` object), not a
  message string. The code is read from `error.code`; use `attachErrorCode` to set it.

- `createSuccessResponse(data)` returns `{ success: true, data }`.
- `getErrorMessage(error, fallback = 'Unknown error')` extracts a string from any error shape.
- `attachErrorCode(error, code)` stamps an `ERROR_CODES` value onto an error (if it has none) and
  returns it.
- `logFallback(logger, context, operation, error, fallbackValue, { level })` logs a swallowed error
  (default level `debug`) and returns `fallbackValue`.

Error codes are defined in `src/shared/errorCodes.js` (`ERROR_CODES`) and re-exported here.

```javascript
const {
  createErrorResponse,
  createSuccessResponse,
  attachErrorCode,
  ERROR_CODES
} = require('../../shared/errorHandlingUtils');

async function readSummary(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return createErrorResponse(
      attachErrorCode(new Error('Invalid file path'), ERROR_CODES.INVALID_INPUT)
    );
  }
  try {
    const summary = await loadSummary(filePath);
    return createSuccessResponse({ summary }); // → { success: true, data: { summary } }
  } catch (error) {
    return createErrorResponse(error, { operation: 'readSummary' });
  }
}
```

---

## 2. IPC handlers (`ipcWrappers.js`)

Every IPC handler is registered through the IPC registry (`src/main/core/ipcRegistry.js`), which
also applies `ipcSenderValidator`. Never call `ipcMain.handle` directly. The helpers in
`src/main/ipc/ipcWrappers.js`:

- `createHandler({ logger, handler, schema, ... })` composes service checks (`serviceName`,
  `getService`, `fallbackResponse`), Zod (or fallback-validator) input validation (`schema`,
  `normalize`), optional result wrapping (`wrapResponse`) and error logging into one handler.
- `safeHandle(ipcMain, channel, handler)` registers a single handler with the registry.
- `registerHandlers({ ipcMain, logger, handlers, context })` builds and registers a map of
  `channel → createHandler config`.
- Lower-level wrappers: `withErrorLogging(logger, fn, { context })`,
  `withValidation(logger, schema, handler, { context })`, `withServiceCheck`, `withVectorDbInit`.

Two behaviors to know:

1. **Validation failures return an envelope.** An input that fails the schema returns a
   `createErrorResponse` failure (message `'Invalid input'`, `details.errorType: 'ValidationError'`,
   `details.validationErrors`) without calling your handler.
2. **Thrown errors are logged and re-thrown.** `withErrorLogging` (which `createHandler` always
   applies) logs and then re-throws, so `ipcRenderer.invoke` rejects. If the renderer should get a
   structured envelope instead, catch inside the handler and return `createErrorResponse(...)`.

```javascript
const { createHandler, safeHandle, z } = require('./ipcWrappers');

const handler = createHandler({
  logger,
  context: 'Analysis',
  schema: z.object({ filePath: z.string().min(1) }),
  handler: async (event, { filePath }) => performDocumentAnalysis(filePath)
});

safeHandle(ipcMain, IPC_CHANNELS.ANALYSIS.ANALYZE_DOCUMENT, handler);
```

See `src/main/ipc/analysis.js` for real examples.

**Success shapes differ by helper.** `ipcWrappers.createSuccessResponse(data)` spreads plain-object
data into the response (`{ success: true, ...data }`) for backward compatibility, while the shared
`errorHandlingUtils.createSuccessResponse(data)` nests it (`{ success: true, data }`). The simple
helpers `successResponse(data, warnings)`, `errorResponse(error, extras)` and `canceledResponse()`
(`{ success: false, canceled: true }`) are used by settings-style handlers. Check which helper a
channel uses before reading its result in the renderer. Failure envelopes from `createErrorResponse`
always use the nested `error: { code, message, details }` shape.

---

## 3. Timeouts, retries and cleanup (`promiseUtils.js`)

- `withTimeout(promiseOrFn, timeoutMs, operationName)` rejects with
  `"<operationName> timed out after <ms>ms"`.
- `withAbortableTimeout(fn, timeoutMs, operationName)` passes an `AbortController` to `fn` and
  aborts it on timeout. Prefer it when the underlying work can actually be cancelled.
- `withRetry(fn, options)` **returns a wrapped function**; call the result to run it. Options:
  `maxRetries` (alias `maxAttempts`, default 3), `initialDelay` (alias `delay`, default 1000),
  `maxDelay`, `backoff` (alias `backoffFactor`, default 2), `jitterFactor`,
  `shouldRetry(error, attempt)`, `onRetry`, `operationName`.
- `retry(fn, options)` runs `withRetry(fn, options)()` immediately and returns the result.
- `swallow(promise, logger, context, level = 'debug')` awaits a best-effort operation (for example
  temp-file cleanup), logs any rejection and resolves to `undefined`.
- Also available: `delay`, `debounce`, `throttle`, `mapWithConcurrency`, `Semaphore`,
  `createInitGuard`.

```javascript
const { retry, withTimeout, swallow } = require('../../shared/promiseUtils');

const result = await retry(() => withTimeout(fetchModelManifest(), 10000, 'FetchManifest'), {
  maxRetries: 3,
  initialDelay: 1000,
  shouldRetry: (error) => error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT'
});

await swallow(fs.promises.unlink(tempPath), logger, 'cleanup:temp-file');
```

`errorHandlingUtils.js` re-exports `withRetry` (same wrapper semantics) but not `withTimeout` or
`retry`; import those from `promiseUtils.js`.

---

## 4. Typed errors (`src/main/errors/`)

Main-process code throws typed, operational errors (`isOperational = true`) that carry a `code`,
structured `metadata`, `getUserFriendlyMessage()` and `getActionableSteps()`.

**`AnalysisError.js`** — `AnalysisError(code, metadata)` (message is generated from `code`; pass
`{ cause }` in metadata to chain), plus `ModelMissingError(modelName)`,
`DependencyMissingError(dependencyName)`, `AiEngineConnectionError(details)` and
`FileProcessingError(code, fileName, metadata)`.

**`FileSystemError.js`** — `FileSystemError(code, metadata)` with `FILE_SYSTEM_ERROR_CODES` and
`NODE_ERROR_CODE_MAP`, plus `isRecoverable()`, `shouldRetry()`, `getRetryDelay()` and `toJSON()`.
Convenience subclasses: `FileNotFoundError`, `PermissionDeniedError`, `WriteFailedError`,
`WatcherError`, `AtomicOperationError`, `IntegrityError`. Convert raw Node errors with the static
factories:

```javascript
const { FileSystemError } = require('../errors/FileSystemError');

try {
  await fs.promises.rename(src, dest);
} catch (nodeError) {
  throw FileSystemError.forOperation('rename', nodeError, src);
  // or: FileSystemError.fromNodeError(nodeError, { path: src, operation: 'rename' })
}
```

**`ErrorHandler.js`** exports a singleton (not a class). `simple-main.js` initializes it; it listens
for Electron `render-process-gone` / `child-process-gone`, writes to `userData/logs`, and escalates
critical failures via `handleCriticalError` (`uncaughtException` / `unhandledRejection` are handled
in `src/main/core/lifecycle.js`, not here). Call `errorHandler.handleError(error, context)` only for
errors that should reach that central path; most code should throw or return an envelope instead.

---

## 5. Classification (`errorClassifier.js`)

`src/shared/errorClassifier.js` turns arbitrary errors (usually Node `code`s) into decisions:

- `classifyError(error, { context })` returns `category`, `userMessage`, `code`, `originalMessage`
  and the booleans `isRetryable`, `isNetworkError`, `isPermissionError`, `isNotFoundError` and
  `isCriticalError`
- `getErrorCategory(error)` (an `ErrorCategory` value), `getUserMessage(error, context)`
- Predicates: `isRetryable`, `isNetworkError`, `isPermissionError`, `isNotFoundError`,
  `isCrossDeviceError`, `isExistsError`, `isCriticalError`

Use `isRetryable` as the `shouldRetry` for filesystem retries rather than hand-rolling code lists.
Errors from node-llama-cpp have their own classifier, `src/shared/llamaErrorClassifier.js`
(`classifyLlamaError` plus `looksLikeVramExhausted`, `looksLikeCorruptGguf`, etc.).

---

## 6. Renderer: displaying errors and boundaries

**Normalize IPC errors before rendering.** The failure envelope's `error` is an object; placing it
directly into JSX throws React error #31 ("Objects are not valid as a React child"). Convert it with
`toErrorMessage(response.error, fallback)` from `src/renderer/utils/errorMapping.js` before putting
it in state that feeds JSX or a notification.
`mapErrorToNotification({ error, errorType, errorCode, operationType })` builds richer toast
content, and `isIpcTimeoutError(error)` detects preload invoke timeouts.

**Error boundaries:**

- `src/renderer/components/ErrorBoundary.jsx` — default export `ErrorBoundaryCore` (props include
  `variant`, `contextName`, `fallback`, `onReset`) and the named export `GlobalErrorBoundary`, which
  wraps the whole app in `src/renderer/index.js`.
- `src/renderer/components/PhaseErrorBoundary.jsx` — default export; requires `phaseName`.

```javascript
import ErrorBoundary from './components/ErrorBoundary';
import PhaseErrorBoundary from './components/PhaseErrorBoundary';

<PhaseErrorBoundary phaseName="Discover">
  <DiscoverPhase />
</PhaseErrorBoundary>;

<ErrorBoundary contextName="NavigationBar" fallback={() => null}>
  <NavigationBar />
</ErrorBoundary>;
```

---

## Decision guide

| Situation                                     | Use                                                                          |
| :-------------------------------------------- | :--------------------------------------------------------------------------- |
| New IPC handler                               | `createHandler` + Zod schema, registered via `safeHandle`/`registerHandlers` |
| Handler must return a failure the UI can show | catch and return `createErrorResponse(error, context)`                       |
| Filesystem failure in main                    | `FileSystemError.forOperation` / `fromNodeError`                             |
| Analysis/model failure in main                | `AnalysisError` family                                                       |
| Deciding whether to retry                     | `isRetryable` / `classifyError`, then `retry` or `withRetry`                 |
| Work that can hang                            | `withAbortableTimeout` (cancellable) or `withTimeout`                        |
| Best-effort cleanup                           | `swallow`                                                                    |
| Catch block that returns a default            | `logFallback`                                                                |
| Showing an IPC error in the UI                | `toErrorMessage` / `mapErrorToNotification`                                  |
| React subtree that may throw                  | `ErrorBoundary` (`contextName`) or `PhaseErrorBoundary`                      |

## Best practices

- **Never swallow silently.** Log with context (`logFallback`, `swallow`, or `logger.error`) or
  re-throw.
- **Throw typed errors in main, return envelopes at the IPC edge.** Services throw; handlers decide
  whether the renderer gets a rejection or a `{ success: false, error }` envelope.
- **Keep codes in `ERROR_CODES`.** Don't invent ad-hoc string codes in handlers.
- **Handle errors where you can act on them.** Low-level helpers should usually let errors bubble.

---

**Last Updated:** 2026-10-27
