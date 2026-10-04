// @ts-check
/**
 * ConfigurationManager Class
 *
 * Manages loading, validation, and access to configuration values.
 *
 * @module config/ConfigurationManager
 */

/**
 * @typedef {import('./configValidation').SchemaDef} SchemaDef
 */

/**
 * @typedef {{ key?: string, path?: string, value: any, error?: string, reason?: string }} ValidationError
 */

const { CONFIG_SCHEMA, SENSITIVE_KEYS, DEPRECATED_MAPPINGS } = require('./configSchema');
const { parseEnvValue, getEnvVar, validateValue } = require('./configValidation');

/**
 * Configuration Manager Class
 * Manages loading, validation, and access to configuration values.
 */
class ConfigurationManager {
  constructor() {
    /** @type {Record<string, Record<string, any>>} */
    this._config = {};
    this._loaded = false;
    /** @type {ValidationError[]} */
    this._validationErrors = [];
    /** @type {string[]} */
    this._deprecationWarnings = [];
  }

  /**
   * Load configuration from schema defaults and environment variables
   * @returns {Object} Loaded configuration
   */
  load() {
    this._config = {};
    this._validationErrors = [];
    this._deprecationWarnings = [];

    // Check for deprecated environment variables
    for (const [oldKey, newKey] of Object.entries(DEPRECATED_MAPPINGS)) {
      if (process.env[oldKey]) {
        this._deprecationWarnings.push(
          `Environment variable '${oldKey}' is deprecated. Use '${newKey}' instead.`
        );
      }
    }

    // Load each category
    /** @type {Record<string, Record<string, SchemaDef>>} */
    const schema = /** @type {any} */ (CONFIG_SCHEMA);
    for (const [category, properties] of Object.entries(schema)) {
      this._config[category] = {};

      for (const [propName, schemaDef] of Object.entries(properties)) {
        // Try to get value from environment
        const envValue = getEnvVar(schemaDef.envVar);
        let value;

        if (envValue !== undefined) {
          value = parseEnvValue(envValue, schemaDef);
        }

        // Validate and apply default if needed
        const validation = validateValue(`${category}.${propName}`, value, schemaDef);

        if (!validation.valid) {
          this._validationErrors.push({
            key: `${category}.${propName}`,
            value,
            error: /** @type {any} */ (validation).error
          });
          // Use default on validation failure
          this._config[category][propName] = schemaDef.default;
        } else {
          this._config[category][propName] = /** @type {any} */ (validation).value;
        }
      }
    }

    this._loaded = true;
    return this._config;
  }

  /**
   * Get a configuration value by path
   * @param {string} path - Dot-separated path (e.g., 'SERVER.devServerPort')
   * @param {*} [defaultValue] - Default value if not found
   * @returns {*} Configuration value
   */
  get(path, defaultValue = undefined) {
    if (!this._loaded) {
      this.load();
    }

    const parts = path.split('.');
    let current = this._config;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return defaultValue;
      }
      current = current[part];
    }

    return current !== undefined ? current : defaultValue;
  }

  /**
   * Get entire configuration category
   * @param {string} category - Category name (e.g., 'SERVER')
   * @returns {Object} Category configuration
   */
  getCategory(category) {
    if (!this._loaded) {
      this.load();
    }
    return this._config[category] || {};
  }

  /**
   * Get all configuration
   * @returns {Object} Complete configuration object
   */
  getAll() {
    if (!this._loaded) {
      this.load();
    }
    return { ...this._config };
  }

  /**
   * Check if in development mode
   * @returns {boolean}
   */
  isDevelopment() {
    return this.get('ENV.nodeEnv') === 'development';
  }

  /**
   * Check if in production mode
   * @returns {boolean}
   */
  isProduction() {
    return this.get('ENV.nodeEnv') === 'production';
  }

  /**
   * Check if in test mode
   * @returns {boolean}
   */
  isTest() {
    return this.get('ENV.nodeEnv') === 'test';
  }

  /**
   * Check if running in CI
   * @returns {boolean}
   */
  isCI() {
    return this.get('ENV.isCI');
  }

  /**
   * Validate all configuration and return validation report
   * @returns {{ valid: boolean, errors: ValidationError[], warnings: string[] }}
   */
  validate() {
    if (!this._loaded) {
      this.load();
    }

    return {
      valid: this._validationErrors.length === 0,
      errors: [...this._validationErrors],
      warnings: [...this._deprecationWarnings]
    };
  }

  /**
   * Dump configuration for debugging (with sensitive values redacted)
   * @param {{ includeSensitive?: boolean }} [options] - Dump options
   * @returns {{ config: Record<string, any>, metadata: { loadedAt: string, nodeEnv: any, validationErrors: number, deprecationWarnings: number } }} Configuration dump
   */
  dump(options = {}) {
    const { includeSensitive = false } = options;

    if (!this._loaded) {
      this.load();
    }

    /**
     * @param {Record<string, any>} obj
     * @param {string} [prefix]
     * @returns {Record<string, any>}
     */
    const redact = (obj, prefix = '') => {
      /** @type {Record<string, any>} */
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          result[key] = redact(value, fullKey);
        } else if (!includeSensitive && SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s))) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = value;
        }
      }
      return result;
    };

    return {
      config: redact(this._config),
      metadata: {
        loadedAt: new Date().toISOString(),
        nodeEnv: this.get('ENV.nodeEnv'),
        validationErrors: this._validationErrors.length,
        deprecationWarnings: this._deprecationWarnings.length
      }
    };
  }

  /**
   * Get configuration schema
   * @returns {Object} Configuration schema
   */
  getSchema() {
    return CONFIG_SCHEMA;
  }

  /**
   * Get validation errors
   * @returns {ValidationError[]} Validation errors
   */
  getValidationErrors() {
    return [...this._validationErrors];
  }

  /**
   * Get deprecation warnings
   * @returns {string[]} Deprecation warnings
   */
  getDeprecationWarnings() {
    return [...this._deprecationWarnings];
  }

  /**
   * Override a configuration value at runtime
   * Note: This does not persist and will be reset on next load()
   * @param {string} path - Configuration path
   * @param {*} value - New value
   */
  override(path, value) {
    if (!this._loaded) {
      this.load();
    }

    const parts = path.split('.');

    // Validate against schema if definition exists (coerce types but allow unrecognized paths)
    if (parts.length === 2) {
      const [category, propName] = parts;
      const schemaAny = /** @type {Record<string, Record<string, SchemaDef>>} */ (
        /** @type {any} */ (CONFIG_SCHEMA)
      );
      const schemaDef = schemaAny?.[category]?.[propName];
      if (schemaDef) {
        const validation = validateValue(path, value, schemaDef);
        if (validation.valid) {
          value = /** @type {any} */ (validation).value;
        } else {
          // was silently ignored and the invalid value was written to config
          this._validationErrors.push({ path, value, reason: 'validation_failed' });
          return;
        }
      }
    }

    let current = this._config;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * Reset configuration to defaults by reloading
   */
  reset() {
    this._loaded = false;
    this._config = {};
    this._validationErrors = [];
    this._deprecationWarnings = [];
    this.load();
  }
}

module.exports = ConfigurationManager;
