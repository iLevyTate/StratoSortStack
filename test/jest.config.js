/**
 * Jest configuration for StratoSort tests (unit + integration).
 * Updated to Jest 30 syntax—removed deprecated options that triggered warnings.
 */

module.exports = {
  displayName: 'Stratosort Tests',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.+(js|ts|tsx)', '**/*.(test|spec).+(js|ts|tsx)'],
  // Exclude specialized test directories (they have their own configs)
  testPathIgnorePatterns: ['/node_modules/', '/stress/', '/e2e/'],
  // Allow transforming ESM modules in node_modules (required for @orama, @modelcontextprotocol)
  transformIgnorePatterns: [
    'node_modules/(?!(@orama|@orama/plugin-data-persistence|lz4-napi|p-queue|p-timeout|eventemitter3|@modelcontextprotocol|pkce-challenge)/)'
  ],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-react',
          '@babel/preset-typescript'
        ]
      }
    ]
  },
  // No transforms needed for plain JS
  collectCoverageFrom: ['<rootDir>/../src/**/*.{js,jsx}', '!<rootDir>/../src/**/node_modules/**'],
  coverageDirectory: '../coverage',
  setupFilesAfterEnv: ['<rootDir>/test-setup.js'],
  // Sequential execution keeps AI mocks deterministic
  maxWorkers: 1,
  testTimeout: 10000,

  moduleNameMapper: {
    // CSS and style mocks
    '\\.(css|less|scss|sass)$': '<rootDir>/mocks/styleMock.js',
    '^electron$': '<rootDir>/mocks/electron.js',
    '^officeparser$': '<rootDir>/mocks/officeparser.js',
    '^tesseract\\.js$': '<rootDir>/mocks/tesseract.js',
    '^sharp$': '<rootDir>/mocks/sharp.js',
    '^node-llama-cpp$': '<rootDir>/mocks/node-llama-cpp.js',
    '^xlsx-populate$': '<rootDir>/mocks/xlsx.js',
    '^fast-xml-parser$': '<rootDir>/mocks/fast-xml-parser.js',
    '^music-metadata$': '<rootDir>/mocks/music-metadata.js',
    // p-queue v9 is ESM-only; map to CJS mock to avoid "Cannot use import statement" errors
    '^p-queue$': '<rootDir>/mocks/p-queue.js',
    // @playwright/test references browser/runtime primitives at module load
    // that throw under Jest. test/pageObjectsHelpers.test.js needs to import
    // test/e2e/helpers/pageObjects.js (which requires @playwright/test for
    // its `expect`); the mock returns a permissive expect surface so the
    // module loads and the unit test can assert on its own jest mocks.
    '^@playwright/test$': '<rootDir>/mocks/playwright-test.js'
  },

  // Global setup for DOM-dependent packages
  setupFiles: ['<rootDir>/test-globals.js'],

  // Coverage thresholds to ensure quality standards.
  //
  // Ratchet history: floors were raised from a flat 50 after the suite measured
  // branches 54.5 / functions 67.3 / lines 68.4 / statements 66.8 (8423 tests,
  // 587 suites). Each floor is set a few points BELOW the measured number so
  // ordinary churn doesn't trip CI. Branches gets the tightest headroom on
  // purpose: it is the platform-sensitive metric (Windows vs POSIX code paths
  // execute different branches), so the floor must clear the lowest-coverage
  // runner in the Windows/Ubuntu/macOS matrix, not just this machine.
  coverageThreshold: {
    global: {
      branches: 52,
      functions: 62,
      lines: 63,
      statements: 62
    },
    // Preload is the security boundary between renderer and main; coverage
    // floor must not be lower than the global default. Ratchet history:
    // functions once sat at 30%, then floors were aligned to the 50% global
    // minimum. Raised again after direct unit tests for ipcRateLimiter and
    // ipcValidator (both now 100%) lifted measured coverage to branches 67 /
    // functions 71 / lines 76 / statements 74.5 — floors sit a few points
    // below those actuals for normal-churn headroom.
    '<rootDir>/../src/preload/': {
      branches: 64,
      functions: 68,
      lines: 73,
      statements: 71
    },
    '<rootDir>/../src/main/ipc/': {
      functions: 65,
      lines: 60
    },
    '<rootDir>/../src/shared/atomicFileOperations.js': {
      functions: 55,
      lines: 65
    },
    // Security-policy modules: the tests pin *intended* header/path-limit policy,
    // so these floors guard against silent regressions in what the app enforces.
    // Set a few points below measured coverage (securityHeaders 100% across the
    // board; securityConfigPathLimits ~85-94%) to leave normal-churn headroom.
    '<rootDir>/../src/main/core/securityHeaders.js': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    },
    '<rootDir>/../src/shared/securityConfigPathLimits.js': {
      branches: 80,
      functions: 90,
      lines: 88,
      statements: 85
    }
  }
};
