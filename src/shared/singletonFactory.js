// @ts-check
/**
 * Singleton Factory
 *
 * Provides a reusable pattern for creating singleton services with:
 * - DI container integration
 * - Local fallback for early startup/testing
 * - Instance migration from local to container
 * - Proper cleanup on reset
 *
 * Eliminates ~60-80 lines of boilerplate per service.
 *
 * @module shared/singletonFactory
 *
 * @example
 * // In a service file (e.g., MyService.js)
 * const { createSingletonHelpers } = require('../../shared/singletonFactory');
 * const MyServiceClass = require('./MyServiceClass');
 *
 * const {
 *   getInstance,
 *   createInstance,
 *   registerWithContainer,
 *   resetInstance
 * } = createSingletonHelpers({
 *   ServiceClass: MyServiceClass,
 *   serviceId: 'MY_SERVICE',
 *   serviceName: 'MyService',
 *   containerPath: './ServiceContainer',
 *   shutdownMethod: 'shutdown' // or 'cleanup'
 * });
 *
 * module.exports = { MyService: MyServiceClass, getInstance, ... };
 */

/** @type {{ debug: (...args: any[]) => void, info: (...args: any[]) => void, warn: (...args: any[]) => void, error: (...args: any[]) => void }} */
let logger;
try {
  const { createSafeLogger } = require('./logger');
  logger = createSafeLogger('SingletonFactory');
} catch {
  logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Get a Node-style require that bypasses Webpack static analysis when bundled.
 * In Electron main, Webpack exposes __non_webpack_require__ for this purpose.
 * FIX: Replaced eval('require') with safer alternatives to eliminate security risk.
 */
/* global __non_webpack_require__, __webpack_require__ */
function getNodeRequire() {
  // Webpack's escape hatch for dynamic require in bundled code
  // @ts-expect-error __non_webpack_require__ is injected by Webpack at bundle time
  if (typeof __non_webpack_require__ !== 'undefined') {
    // @ts-expect-error __non_webpack_require__ is injected by Webpack at bundle time
    return /** @type {NodeRequire} */ (__non_webpack_require__);
  }
  // In Node.js/Electron main process, require is available on global
  if (
    typeof global !== 'undefined' &&
    typeof (/** @type {any} */ (global).require) === 'function'
  ) {
    return /** @type {NodeRequire} */ (/** @type {any} */ (global).require);
  }
  // CommonJS module's own require function
  if (
    typeof module !== 'undefined' &&
    typeof (/** @type {any} */ (module).require) === 'function'
  ) {
    return /** @type {any} */ (module).require.bind(module);
  }
  // Last resort: direct require (works in non-bundled Node.js)
  // @ts-expect-error __webpack_require__ is injected by Webpack at bundle time
  if (typeof __webpack_require__ === 'undefined' && typeof require === 'function') {
    return require;
  }
  throw new Error('Cannot access Node.js require - running in unsupported environment');
}

/**
 * Create singleton helper functions for a service.
 *
 * Optional params (containerPath, shutdownMethod, createFactory) are marked
 * with bracket syntax so JSDoc-aware type checkers treat them as optional —
 * the runtime defaults inside the destructuring make them safe to omit, but
 * the prior annotation had them as required which forced @ts-expect-error at
 * every caller under `// @ts-check`.
 *
 * @param {{ ServiceClass: new (...args: any[]) => any, serviceId: string, serviceName: string, getContainer?: () => any, containerPath?: string, shutdownMethod?: string, createFactory?: ((...args: any[]) => any) | null }} options
 * @returns {{ getInstance: (...args: any[]) => any, createInstance: (...args: any[]) => any, registerWithContainer: (container: any, registrationId: any) => void, resetInstance: () => Promise<void>, disposeLocalInstance: () => Promise<void>, isContainerRegistered: () => boolean, getLocalInstance: () => any }}
 */
function createSingletonHelpers(options) {
  const {
    ServiceClass,
    serviceId,
    serviceName,
    getContainer = null,
    containerPath = './ServiceContainer',
    shutdownMethod = 'shutdown',
    createFactory = null
  } = options;

  /**
   * Resolve `{ container, ServiceIds }` — via the caller-supplied closure when
   * available (correct require context), else the legacy dynamic-require path.
   * Throws when neither resolves; callers wrap in try/catch (container absent
   * is a supported early-startup/test state).
   * @returns {{ container: any, ServiceIds: any }}
   */
  function resolveContainerModule() {
    if (typeof getContainer === 'function') {
      return getContainer();
    }
    const dynamicRequire = getNodeRequire();
    return dynamicRequire(containerPath);
  }

  // Module-level state (closure)
  /** @type {any} */
  let _localInstance = null;
  let _containerRegistered = false;
  // Two concurrent calls could both pass the if (!_localInstance) check and create duplicates
  /** @type {any} */
  let _pendingInstance = null;

  /**
   * Get or create the singleton instance
   * FIX: Thread-safe using promise deduplication pattern for async factories
   * Maintains synchronous return for sync factories (backward compatible)
   * @param {Object} instanceOptions - Options passed to constructor
   * @returns {Object|Promise<Object>} The singleton instance or promise resolving to it
   */
  function getInstance(instanceOptions = {}) {
    // Try to get from DI container first (preferred)
    try {
      const { container, ServiceIds } = resolveContainerModule();
      if (container.has(ServiceIds[serviceId])) {
        return container.resolve(ServiceIds[serviceId]);
      }
    } catch {
      // Container not available yet, use local instance
    }

    if (_localInstance) {
      return _localInstance;
    }

    // This ensures all concurrent callers wait for the same instance
    if (_pendingInstance) {
      return _pendingInstance;
    }

    // Create the instance
    /** @type {any} */
    let instance;
    try {
      instance = createFactory ? createFactory(instanceOptions) : new ServiceClass(instanceOptions);
    } catch (createError) {
      logger.error(`[SingletonFactory] Error creating instance for ${serviceName}:`, createError);
      throw createError;
    }

    // For sync factories, return synchronously (backward compatible)
    // For async factories, wrap in promise deduplication to prevent race conditions
    if (instance && typeof instance.then === 'function') {
      // Async factory - use promise deduplication
      _pendingInstance = Promise.resolve(instance)
        .then((resolvedInstance) => {
          _localInstance = resolvedInstance;
          _pendingInstance = null;
          return resolvedInstance;
        })
        .catch((error) => {
          // On failure, clear pending so next call can retry
          _pendingInstance = null;
          throw error;
        });
      return _pendingInstance;
    }

    // Sync factory - return immediately (backward compatible)
    _localInstance = instance;
    return _localInstance;
  }

  /**
   * Create a new instance (not tied to singleton)
   * @param {Object} instanceOptions - Options passed to constructor
   * @returns {Object} A new instance
   */
  function createInstance(instanceOptions = {}) {
    return createFactory ? createFactory(instanceOptions) : new ServiceClass(instanceOptions);
  }

  /**
   * Register this service with the DI container
   * FIX: Made idempotent using container.has() as authoritative source of truth
   * This prevents race conditions where two calls both pass the _containerRegistered check
   * @param {any} container - The DI container
   * @param {any} registrationId - The service identifier
   */
  function registerWithContainer(container, registrationId) {
    // This is the authoritative source of truth and handles cases where another
    // module registered the service first, or concurrent calls race.
    if (typeof container.has === 'function') {
      if (container.has(registrationId)) {
        _containerRegistered = true;
        return;
      }
    } else if (_containerRegistered) {
      // Fallback for mock containers without has() — use local flag only
      return;
    }

    container.registerSingleton(registrationId, () => {
      // This prevents creating duplicate instances when registerWithContainer is called
      // while an async factory is still initializing
      if (_pendingInstance) {
        return _pendingInstance;
      }

      // If we have a local instance, migrate it to the container
      if (_localInstance) {
        const instance = _localInstance;
        _localInstance = null; // Clear local reference
        return instance;
      }
      return createFactory ? createFactory() : new ServiceClass();
    });

    _containerRegistered = true;
    logger.debug(`[${serviceName}] Registered with DI container`);
  }

  /**
   * Reset the singleton instance (for testing)
   * @returns {Promise<void>}
   */
  async function resetInstance() {
    // Reset container registration flag
    _containerRegistered = false;

    _pendingInstance = null;

    // Clear from DI container if registered
    try {
      const { container, ServiceIds } = resolveContainerModule();
      if (container.has(ServiceIds[serviceId])) {
        const instance = container.tryResolve(ServiceIds[serviceId]);
        container.clearInstance(ServiceIds[serviceId]);
        if (instance && typeof instance[shutdownMethod] === 'function') {
          try {
            await instance[shutdownMethod]();
          } catch (e) {
            logger.warn(`[${serviceName}] Error during container instance cleanup:`, e.message);
          }
        }
      }
    } catch {
      // Container not available
    }

    // Also clear local instance
    if (_localInstance) {
      const oldInstance = _localInstance;
      _localInstance = null;
      if (typeof oldInstance[shutdownMethod] === 'function') {
        try {
          await oldInstance[shutdownMethod]();
        } catch (e) {
          logger.warn(`[${serviceName}] Error during reset cleanup:`, e.message);
        }
      }
    }
  }

  /**
   * Check if container is registered (for testing)
   * @returns {boolean}
   */
  function isContainerRegistered() {
    return _containerRegistered;
  }

  /**
   * Get local instance directly (for testing)
   * @returns {Object|null}
   */
  function getLocalInstance() {
    return _localInstance;
  }

  /**
   * Dispose the module-local instance only.
   *
   * Unlike `resetInstance`, this never touches the DI container — app
   * shutdown already drives container teardown via SHUTDOWN_ORDER, so this
   * helper exists specifically for the case where the service was created
   * via the local fallback path (e.g. consumers that called `getInstance()`
   * before the container was ready). Without this, the local instance and
   * any timers it owns outlive `before-quit`.
   *
   * No-op when no local instance exists. Never creates one.
   * @returns {Promise<void>}
   */
  async function disposeLocalInstance() {
    if (!_localInstance) return;
    const instance = _localInstance;
    _localInstance = null;
    _pendingInstance = null;
    if (typeof instance[shutdownMethod] === 'function') {
      try {
        await instance[shutdownMethod]();
      } catch (error) {
        logger.warn(`[${serviceName}] disposeLocalInstance failed:`, error?.message || error);
      }
    }
  }

  return {
    getInstance,
    createInstance,
    registerWithContainer,
    resetInstance,
    disposeLocalInstance,
    // Testing helpers
    isContainerRegistered,
    getLocalInstance
  };
}

module.exports = { createSingletonHelpers };
