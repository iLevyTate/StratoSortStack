const js = require('@eslint/js');
const globals = require('globals');
const reactPlugin = require('eslint-plugin-react');
const reactHooksPlugin = require('eslint-plugin-react-hooks');
const jsxA11yPlugin = require('eslint-plugin-jsx-a11y');
const importPlugin = require('eslint-plugin-import');
const promisePlugin = require('eslint-plugin-promise');
const jestPlugin = require('eslint-plugin-jest');

module.exports = [
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      'node_modules/',
      'dist/',
      'release/',
      'out/',
      '.cache/',
      '.webpack-cache/',
      'coverage/',
      'assets/',
      'tmpUserData/',
      '.tmp/',
      'release/build/',
      'Documents/',
      'test-results/',
      '**/*.min.js',
      '**/*.bundle.js',
      '**/*.map'
    ]
  },

  // Base configuration for all JS/JSX files
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        // Injected by webpack DefinePlugin (webpack.main.config.js): the
        // build date used for license maintenance-window gating.
        __STRATOSORT_BUILD_DATE__: 'readonly'
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
      import: importPlugin,
      promise: promisePlugin
    },
    settings: {
      react: {
        version: 'detect'
      },
      'import/resolver': {
        node: {},
        webpack: {
          config: './webpack.config.js'
        }
      }
    },
    rules: {
      // Base ESLint recommended
      ...js.configs.recommended.rules,

      // Import rules
      'import/no-extraneous-dependencies': 'off',
      'import/no-unresolved': ['error', { ignore: ['csv-parse/sync'] }],
      'import/order': 'off',
      'import/prefer-default-export': 'off',
      'import/no-cycle': 'off',
      'import/no-import-module-exports': 'off',
      'import/extensions': 'off',
      'import/no-dynamic-require': 'off',

      // React rules
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'warn',
      'react/jsx-uses-vars': 'warn',
      'react/prop-types': 'off',
      'react/jsx-props-no-spreading': 'off',
      'react/no-array-index-key': 'off',
      'react/jsx-boolean-value': 'off',
      'react/button-has-type': 'off',
      'react/destructuring-assignment': 'off',
      'react/jsx-no-useless-fragment': 'off',
      'react/no-unescaped-entities': 'off',
      'react/jsx-curly-brace-presence': 'off',
      'react/no-unused-prop-types': 'off',
      'react/require-default-props': 'off',
      'react/function-component-definition': 'off',
      'react/forbid-prop-types': 'off',
      'react/jsx-no-constructed-context-values': 'off',
      'react/sort-comp': 'off',
      // Disabled: uses context.getFilename() removed in ESLint 10 flat config
      'react/jsx-filename-extension': 'off',

      // React Hooks
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // JSX A11y rules: ratchet complete (off → warn → error). The 56-warning
      // backlog was cleared 2026-07-02 (real fixes + per-site justified
      // disables); 'error' locks the zero baseline. New suppressions require a
      // `-- reason` justification at the site.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/control-has-associated-label': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      'jsx-a11y/interactive-supports-focus': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/no-noninteractive-tabindex': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',

      // Promise rules
      'promise/param-names': 'off',
      'promise/catch-or-return': 'off',
      'promise/always-return': 'off',
      'promise/no-nesting': 'off',

      // General JS rules (relaxed for practical code)
      'no-shadow': 'off',
      'no-restricted-syntax': 'off',
      'no-await-in-loop': 'off',
      'no-plusplus': 'off',
      'no-continue': 'off',
      'no-underscore-dangle': 'off',
      'func-names': 'off',
      'no-multi-assign': 'off',
      'class-methods-use-this': 'off',
      'no-param-reassign': 'off',
      'consistent-return': 'off',
      'no-use-before-define': 'off',
      'prefer-destructuring': 'off',
      'no-else-return': 'off',
      'no-lonely-if': 'off',
      'no-nested-ternary': 'off',
      'no-unneeded-ternary': 'off',
      'prefer-template': 'off',
      'object-shorthand': 'off',
      'arrow-body-style': 'off',
      'no-return-assign': 'off',
      'no-bitwise': 'off',
      radix: 'off',
      camelcase: 'off',
      'lines-between-class-members': 'off',
      'max-classes-per-file': 'off',
      'no-new': 'off',
      'valid-typeof': 'off',
      'global-require': 'off',
      'no-restricted-globals': 'off',
      'no-promise-executor-return': 'off',
      'default-case': 'off',
      'no-loop-func': 'off',
      'no-useless-return': 'off',
      'no-empty-function': 'off',
      'no-useless-constructor': 'off',
      'prefer-exponentiation-operator': 'off',
      'prefer-object-spread': 'off',
      'no-prototype-builtins': 'off',
      'prefer-promise-reject-errors': 'off',
      'no-void': 'off',
      'no-return-await': 'off',
      'default-param-last': 'off',
      'no-labels': 'off',
      'symbol-description': 'off',
      'guard-for-in': 'off',
      'no-sequences': 'off',
      'no-unused-expressions': 'off',

      // Empty catch blocks (sync) — warn so new instances are visible in
      // review and the IDE. Existing intentional sites should carry a
      // `// why-silent: <reason>` comment OR be migrated to
      // `swallow(promise, logger, 'context')` from src/shared/promiseUtils.js.
      // See docs/PHILOSOPHY.md "Silent catches" for the full convention.
      // allowEmptyCatch:false flags `catch (e) {}` — pair with eslint-disable-next-line
      // comments where silence is the documented intent.
      'no-empty': ['warn', { allowEmptyCatch: false }],

      // Console logging - warn by default, logger.js override below
      'no-console': 'warn',

      // Unused vars - warn but ignore _ prefixed
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },

  // Renderer — ratchet floating promises (warn) to match main/preload surfaces
  {
    files: ['src/renderer/**/*.{js,jsx}'],
    rules: {
      'promise/catch-or-return': ['warn', { allowFinally: true }],
      'promise/always-return': 'warn'
    }
  },

  // Main/preload process files - use main webpack config for import resolution
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js'],
    settings: {
      'import/resolver': {
        node: {},
        webpack: {
          config: './webpack.main.config.js'
        }
      }
    },
    rules: {
      // Ratchet: catch floating promises in Electron entry surfaces (warn first).
      'promise/catch-or-return': ['warn', { allowFinally: true }],
      'promise/always-return': 'warn'
    }
  },

  // Logger files - allow console
  {
    files: ['**/logger.js', '**/logger.ts'],
    rules: {
      'no-console': 'off'
    }
  },

  // Test files configuration
  {
    files: [
      'test/**/*.{js,ts}',
      '**/*.test.{js,ts}',
      '**/*.spec.{js,ts}',
      '**/__tests__/**/*.{js,ts}'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.jest,
        ...globals.node
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      }
    },
    plugins: {
      jest: jestPlugin
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      'no-undef': 'off',
      'global-require': 'off',
      'import/no-dynamic-require': 'off',
      'import/no-unresolved': 'off',
      'import/order': 'off',
      'import/first': 'off',
      'import/newline-after-import': 'off',
      'no-restricted-syntax': 'off',
      'no-underscore-dangle': 'off',
      'no-plusplus': 'off',
      'no-promise-executor-return': 'off',
      'prefer-destructuring': 'off',
      'class-methods-use-this': 'off',
      'no-await-in-loop': 'off',
      'max-classes-per-file': 'off',
      'lines-between-class-members': 'off',
      'no-useless-return': 'off',
      'no-useless-constructor': 'off',
      'no-empty-function': 'off',
      'no-return-await': 'off',
      'no-loop-func': 'off',
      radix: 'off',
      'no-continue': 'off',
      'no-restricted-globals': 'off',
      'no-unneeded-ternary': 'off',
      'no-else-return': 'off',
      'no-nested-ternary': 'off',
      'no-proto': 'off',
      'prefer-exponentiation-operator': 'off',
      'no-restricted-properties': 'off',
      'object-shorthand': 'off',
      'func-names': 'off',
      'no-bitwise': 'off',
      'no-use-before-define': 'off',
      'prefer-const': 'off',
      'prefer-template': 'off',
      'dot-notation': 'off',
      'react/prop-types': 'off',
      'react/jsx-filename-extension': 'off',
      'react/jsx-props-no-spreading': 'off',
      'react/no-array-index-key': 'off',
      'react/button-has-type': 'off',
      'react/jsx-boolean-value': 'off',
      'promise/param-names': 'off',
      'promise/catch-or-return': 'off',
      'promise/always-return': 'off',
      'prefer-promise-reject-errors': 'off',
      'jest/expect-expect': 'off',
      'jest/no-conditional-expect': 'off',
      'jest/no-jasmine-globals': 'off',
      'jest/no-standalone-expect': 'off',
      // Fail CI when a test file accidentally ships with `.only` / `fdescribe` /
      // `fit` — those run a single test locally but skip the rest of the suite
      // in CI, silently reducing coverage. Errors force the author to unpin.
      'jest/no-focused-tests': 'error',
      // Similarly, ship-blocker for a committed `.skip` without a ticket or
      // explanation. Warn (not error) so we don't block legitimate TDD pins
      // behind a longer review cycle — but the noise surfaces them in PRs.
      'jest/no-disabled-tests': 'warn'
    }
  },

  // Scripts directory configuration
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off',
      'global-require': 'off',
      'import/no-dynamic-require': 'off',
      'promise/catch-or-return': 'off',
      'promise/always-return': 'off',
      'promise/no-nesting': 'off'
    }
  },

  // Polyfills and shared files that may need to handle globalThis
  {
    files: ['**/polyfills.js', '**/correlationId.js'],
    rules: {
      'no-redeclare': 'off'
    }
  },

  // Config files configuration
  {
    files: ['*.config.js', 'webpack.*.js', 'postcss.config.js', 'babel.config.js'],
    rules: {
      'global-require': 'off',
      'import/no-dynamic-require': 'off',
      'no-console': 'off'
    }
  }
];
