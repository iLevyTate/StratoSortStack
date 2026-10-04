---
layout: single
title: 'Dependency Injection Patterns'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/05_discover_phase.webp
  caption: 'Dependency Injection Patterns'
---

# Dependency Injection Patterns

This document describes the dependency injection (DI) patterns used in the StratoSort Core codebase.

## Overview

The codebase uses a centralized DI container (`ServiceContainer`) for managing service dependencies.
All services should be accessed through the container rather than direct instantiation or
`getInstance()` calls.

## ServiceContainer

The `ServiceContainer` class (`src/main/services/ServiceContainer.js`) provides:

- **Singleton services**: Created once and reused
- **Transient services**: Created fresh each time
- **Lazy initialization**: Services created on first request
- **Circular dependency detection**
- **Graceful shutdown**

## Service IDs

All container-registered services use `ServiceIds` in `ServiceContainer.js` (28 entries as of the
current tree). Prefer resolving through the container; `SERVICE_INTEGRATION` is registered but is
**not** listed in `SHUTDOWN_ORDER` because `ServiceIntegration.shutdown()` calls
`container.shutdown(SHUTDOWN_ORDER)` — including it would recurse.

```javascript
const { container, ServiceIds } = require('./ServiceContainer');

ServiceIds.SERVICE_INTEGRATION;
ServiceIds.ORAMA_VECTOR;
ServiceIds.SETTINGS;
ServiceIds.SEARCH_SERVICE;
ServiceIds.DOWNLOAD_WATCHER;
ServiceIds.FILE_PATH_COORDINATOR;
ServiceIds.CACHE_INVALIDATION_BUS;
ServiceIds.LLAMA_SERVICE;
ServiceIds.VISION_SERVICE;
ServiceIds.PARALLEL_EMBEDDING;
ServiceIds.EMBEDDING_CACHE;
ServiceIds.MODEL_MANAGER;
ServiceIds.MODEL_DOWNLOAD_MANAGER;
ServiceIds.FOLDER_MATCHING;
ServiceIds.ORGANIZATION_SUGGESTION;
ServiceIds.AUTO_ORGANIZE;
ServiceIds.CLUSTERING;
ServiceIds.LEARNING_FEEDBACK;
ServiceIds.RELATIONSHIP_INDEX;
ServiceIds.ANALYSIS_HISTORY;
ServiceIds.CHAT_HISTORY_STORE;
ServiceIds.UNDO_REDO;
ServiceIds.PROCESSING_STATE;
ServiceIds.ANALYSIS_CACHE;
ServiceIds.FILE_ACCESS_POLICY;
ServiceIds.SMART_FOLDER_WATCHER;
ServiceIds.NOTIFICATION_SERVICE;
ServiceIds.WHISPER_SERVICE;
```

### Legacy: `getInstance()` (deprecated)

Dozens of files under `src/main/` still call module-level `getInstance()` on services that also
exist in the container (Llama, Orama helpers, download manager, etc.). **New code** should inject
dependencies or use `container.resolve(ServiceIds.*)`. Migrate call sites incrementally when
touching those modules — there is no single “flip” PR.

The dual-path safety net is `createSingletonHelpers` (`src/shared/singletonFactory.js`): its
`getInstance()` prefers the container and its `registerWithContainer()` migrates any early local
instance into it, so the two paths converge on one instance. **Adopters must pass
`getContainer: () => require('./ServiceContainer')`** (a closure written in the service module) —
the legacy `containerPath` string resolved relative to the factory module, silently failed, and let
register-then-`getInstance()` fork two live instances (caught 2026-07-03 by
`test/services/singletonContainerConsistency.test.js`, which pins the invariant).

### Intentionally container-free module singletons

`DegradedStateTracker`, `GPUMonitor`, and `ModelAccessCoordinator` are plain module singletons with
**no** container registration (no `ServiceIds` entry). That is deliberate — they are low-level
cross-cutting utilities consumed before/outside container lifecycle — and carries no dual-instance
hazard because there is only one acquisition path.

## Usage Patterns

### Recommended: Container Resolution

```javascript
const { container, ServiceIds } = require('./services/ServiceContainer');

// Resolve a service
const vectorDb = container.resolve(ServiceIds.ORAMA_VECTOR);
const llama = container.resolve(ServiceIds.LLAMA_SERVICE);
```

### Legacy: getInstance() (Deprecated)

Some services still export `getInstance()` for backward compatibility. **Do not use in new code**:

```javascript
// DEPRECATED - avoid in new code
const { getInstance } = require('./LlamaService');
const llama = getInstance();
```

## Registering New Services

### Singleton Services

```javascript
container.registerSingleton(ServiceIds.MY_SERVICE, (c) => {
  // c is the container - use it to resolve dependencies
  return new MyService({
    vectorDb: c.resolve(ServiceIds.ORAMA_VECTOR),
    settings: c.resolve(ServiceIds.SETTINGS)
  });
});
```

### Transient Services

```javascript
container.registerTransient('myTransient', () => {
  return new TransientService();
});
```

## Service Integration

The `ServiceIntegration` class (`src/main/services/ServiceIntegration.js`) handles:

1. Registering all core services with the container
2. Initializing services in dependency order
3. Providing backward-compatible property access
4. Coordinating service shutdown

### Initialization

```javascript
const ServiceIntegration = require('./services/ServiceIntegration');

const integration = new ServiceIntegration();
await integration.initialize();

// Access via container (recommended)
const vectorDb = container.resolve(ServiceIds.ORAMA_VECTOR);

// Or via integration properties (backward compatible)
const vectorDb = integration.vectorService;
```

## Testing

The DI container makes testing easier by allowing mock injection:

```javascript
// In tests, register mocks before resolving
container.registerInstance(ServiceIds.ORAMA_VECTOR, mockVectorDb);

// Your service will receive the mock
const folderMatching = container.resolve(ServiceIds.FOLDER_MATCHING);
```

## Migration Guide

When migrating from `getInstance()` to container resolution:

1. Import the container and ServiceIds
2. Replace `getInstance()` calls with `container.resolve()`
3. Ensure the service is registered in `ServiceIntegration._registerCoreServices()`

### Before

```javascript
const { getInstance } = require('./LlamaService');
const llama = getInstance();
await llama.generateEmbedding(text);
```

### After

```javascript
const { container, ServiceIds } = require('./ServiceContainer');
const llama = container.resolve(ServiceIds.LLAMA_SERVICE);
await llama.generateEmbedding(text);
```

## Best Practices

1. **Always use the container** for service access in new code
2. **Accept dependencies via constructor** rather than grabbing singletons
3. **Register services in ServiceIntegration** for proper lifecycle management
4. **Use ServiceIds** constants instead of string literals
5. **Mock services in tests** by registering test instances
