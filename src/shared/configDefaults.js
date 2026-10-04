// @ts-check
/**
 * Configuration Defaults and Environment Utilities
 * Single source of truth for environment variables, ports, and service URLs
 */

// Default service ports
const PORTS = {
  DEV_SERVER: 3000
};

// Default service URLs
const SERVICE_URLS = {
  // No external AI services - everything is local/in-process
  MODEL_DOWNLOAD_BASE: 'https://huggingface.co'
};

// Default timeout values (in milliseconds)
const TIMEOUTS = {
  STARTUP: 60000,
  HEALTH_CHECK_INTERVAL: 120000,
  ANALYSIS: 60000,
  FILE_OPERATION: 10000,
  IMAGE_ANALYSIS: 120000
};

// Valid protocols for service URLs
const VALID_PROTOCOLS = ['http', 'https'];

// Port number validation range
const PORT_RANGE = {
  MIN: 1,
  MAX: 65535
};

/**
 * Get environment variable with fallback to default
 * @param {string} key - Environment variable name
 * @param {*} defaultValue - Default value if env var is not set
 * @returns {string} The env value or default
 */
function getEnvOrDefault(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value;
}

/**
 * Parse environment variable as boolean
 * Treats 'true', '1', 'yes' (case-insensitive) as true
 * @param {string} key - Environment variable name
 * @param {boolean} defaultValue - Default value if env var is not set
 * @returns {boolean}
 */
function getEnvBool(key, defaultValue = false) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['true', '1', 'yes'].includes(String(value).toLowerCase().trim());
}

/**
 * Parse environment variable as integer with validation
 * @param {string} key - Environment variable name
 * @param {number} defaultValue - Default value if env var is not set or invalid
 * @returns {number}
 */
function getEnvInt(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Check if running in development mode
 * @returns {boolean}
 */
function isDevelopment() {
  return process.env.NODE_ENV === 'development';
}

/**
 * Check if running in production mode
 * @returns {boolean}
 */
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Validate a URL string for service configuration
 * @param {string} urlString - The URL to validate
 * @param {{requireHttps?: boolean, allowedPorts?: number[]}} [options] - Validation options
 * @returns {Object} Validation result with { valid, url, error }
 */
function validateServiceUrl(urlString, options = {}) {
  if (!urlString || typeof urlString !== 'string') {
    return {
      valid: false,
      url: null,
      error: 'URL is required and must be a string'
    };
  }

  try {
    const parsed = new URL(urlString.trim());

    // Validate protocol
    const protocol = parsed.protocol.replace(':', '');
    if (!VALID_PROTOCOLS.includes(protocol)) {
      return {
        valid: false,
        url: null,
        error: `Invalid protocol "${protocol}". Must be http or https.`
      };
    }

    if (options.requireHttps && protocol !== 'https') {
      return {
        valid: false,
        url: null,
        error: 'HTTPS protocol is required for this service.'
      };
    }

    // Validate hostname
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { valid: false, url: null, error: 'Hostname is required.' };
    }

    // Validate hostname length (RFC 1123)
    if (parsed.hostname.length > 253) {
      return {
        valid: false,
        url: null,
        error: 'Hostname exceeds maximum length of 253 characters.'
      };
    }

    // Validate port if specified
    if (parsed.port) {
      const port = parseInt(parsed.port, 10);
      if (isNaN(port) || port < PORT_RANGE.MIN || port > PORT_RANGE.MAX) {
        return {
          valid: false,
          url: null,
          error: `Port must be between ${PORT_RANGE.MIN} and ${PORT_RANGE.MAX}.`
        };
      }

      if (options.allowedPorts && !options.allowedPorts.includes(port)) {
        return {
          valid: false,
          url: null,
          error: `Port ${port} is not in the list of allowed ports.`
        };
      }
    }

    // Return normalized URL
    return {
      valid: true,
      url: parsed.href,
      protocol,
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : protocol === 'https' ? 443 : 80
    };
  } catch (error) {
    return {
      valid: false,
      url: null,
      error: `Invalid URL format: ${error.message}`
    };
  }
}

/**
 * Validate all critical environment variables and return a report
 * Useful for startup diagnostics
 * @returns {Object} Validation report for all critical env vars
 */
function validateEnvironment() {
  const report = {
    valid: true,
    /** @type {string[]} */
    warnings: [],
    /** @type {string[]} */
    errors: [],
    /** @type {Record<string,string>} */
    config: {}
  };

  // Check NODE_ENV
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv) {
    report.warnings.push('NODE_ENV is not set. Defaulting to development behavior.');
  } else if (!['development', 'production', 'test'].includes(nodeEnv)) {
    report.warnings.push(
      `NODE_ENV="${nodeEnv}" is not a standard value. Expected: development, production, or test.`
    );
  }
  report.config.nodeEnv = nodeEnv || 'undefined';

  // Set overall validity
  report.valid = report.errors.length === 0;

  return report;
}

module.exports = {
  PORTS,
  SERVICE_URLS,
  TIMEOUTS,
  VALID_PROTOCOLS,
  PORT_RANGE,
  getEnvOrDefault,
  getEnvBool,
  getEnvInt,
  isDevelopment,
  isProduction,
  validateServiceUrl,
  validateEnvironment
};
