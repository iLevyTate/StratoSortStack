# StratoSort E2E Tests

End-to-end tests for the StratoSort Electron application using Playwright.

## Overview

The specs drive the real built app through its UI and its preload API (`window.electronAPI`). They
are grouped by product area, one folder per area, with shared code in `helpers/`. Playwright picks
up every `*.spec.js` under `test/e2e/`, so a new spec only needs to be put in the right folder.

| Folder       | What it covers                                                              | Specs |
| ------------ | --------------------------------------------------------------------------- | ----- |
| `app/`       | App shell: launch, window, menus, navigation, keyboard, toasts, persistence | 10    |
| `setup/`     | Setup phase: smart folders                                                  | 2     |
| `discover/`  | Discover phase: importing files and analyzing them                          | 9     |
| `organize/`  | Organize phase and undo/redo                                                | 2     |
| `search/`    | Knowledge OS modal: search, chat, graph, Atlas                              | 4     |
| `settings/`  | Settings panel: backup, models, AI providers, MCP                           | 6     |
| `workflows/` | Journeys that cross several phases, run on seeded data (no model needed)    | 2     |
| `live-llm/`  | `@live-llm` specs that need real local models                               | 3     |
| `manual/`    | Opt-in runs that are never part of CI: soak test and a QA repro session     | 2     |
| `helpers/`   | Launch helpers, page objects, fixtures, global setup/teardown (not specs)   | -     |

### Spec index

**CI smoke** marks the eight specs that the `e2e-smoke` job in `.github/workflows/ci.yml` runs on
pushes (Ubuntu and Windows). Everything else runs only when you run it. Unless the **Needs** column
says otherwise, a spec needs no models and no network: every launch gets an isolated profile seeded
to skip the model download.

#### `app/` - app shell

| Spec                          | Purpose                                                                               | CI smoke | Needs                                           |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| `app-launch.spec.js`          | The app starts, the window opens, the UI renders and the core APIs exist              | yes      |                                                 |
| `navigation.spec.js`          | Moving between phases, and the rules for when a phase is open                         |          |                                                 |
| `window-state.spec.js`        | Window size and position, fullscreen, DevTools, the 800x600 minimum                   |          | `--headed` for the fullscreen test (else skips) |
| `menu-shortcuts.spec.js`      | Menu actions and their keyboard shortcuts (select files, select folder, search)       |          |                                                 |
| `keyboard-navigation.spec.js` | Tab order, Enter/Space/Escape, global shortcuts, focus rings                          |          |                                                 |
| `notifications.spec.js`       | Toast notifications: types, auto-dismiss, manual dismiss, stacking, ARIA              |          |                                                 |
| `error-handling.spec.js`      | Invalid input is rejected and errors do not crash the app                             |          |                                                 |
| `session-persistence.spec.js` | Smart folders, settings, undo state and history survive an app restart                | yes      |                                                 |
| `theme-persistence.spec.js`   | The chosen theme is restored on reopen with no flash of the default theme             |          |                                                 |
| `accessibility.spec.js`       | axe audit of each main screen in the dark and light themes, plus the first-run wizard | yes      | `A11Y_VERBOSE=1` (optional) logs minor findings |

#### `setup/` - smart folders

| Spec                       | Purpose                                                         | CI smoke | Needs |
| -------------------------- | --------------------------------------------------------------- | -------- | ----- |
| `smart-folders.spec.js`    | Listing, creating, editing, deleting and scanning smart folders |          |       |
| `smart-folder-add.spec.js` | "Add Smart Folder" really creates the folder on disk            |          |       |

#### `discover/` - import and analysis

| Spec                             | Purpose                                                                         | CI smoke | Needs                                              |
| -------------------------------- | ------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| `file-import.spec.js`            | File and folder selection and the file list in Discover                         |          |                                                    |
| `drag-drop.spec.js`              | The drop zone, the file-processing API behind it, and file type filtering       |          |                                                    |
| `last-browsed-path.spec.js`      | File dialogs reopen at the last folder used                                     |          |                                                    |
| `naming-strategy.spec.js`        | Naming convention controls, preview and persistence                             |          |                                                    |
| `analysis-flow.spec.js`          | The analysis API and the Discover analyze flow                                  |          | One test skips without `STRATOSORT_E2E_MODELS_DIR` |
| `analysis-history.spec.js`       | Analysis history: read, search, statistics, export, clear                       |          |                                                    |
| `vision-ocr-analysis.spec.js`    | Image and PDF analysis API surface and file type support                        |          |                                                    |
| `whisper-variant-loader.spec.js` | Guards the bundled Whisper loader (audio analysis) against a webpack regression | yes      | Passes with or without the Whisper model           |
| `downloads-triage-api.spec.js`   | The Downloads triage API is exposed to the renderer                             |          |                                                    |

#### `organize/` - organize and undo

| Spec                     | Purpose                                                             | CI smoke | Needs |
| ------------------------ | ------------------------------------------------------------------- | -------- | ----- |
| `organize-phase.spec.js` | Organize phase: file list, selection, toolbar, modals, organize API | yes      |       |
| `undo-redo.spec.js`      | Undo/redo API, state, shortcuts, menu items and history             | yes      |       |

#### `search/` - Knowledge OS (search, chat, graph, Atlas)

| Spec                      | Purpose                                                                       | CI smoke | Needs |
| ------------------------- | ----------------------------------------------------------------------------- | -------- | ----- |
| `search-modal.spec.js`    | Search modal: open/close, modes, results, bulk actions, graph tab, duplicates | yes      |       |
| `knowledge-graph.spec.js` | Relate tab: graph controls, clusters, graph API                               |          |       |
| `chat-understand.spec.js` | Understand tab: chat API surface and chat UI                                  |          |       |
| `atlas-tab.spec.js`       | Atlas tab loads under the strict CSP with no eval errors and passes axe       |          |       |

#### `settings/` - settings panel

| Spec                                   | Purpose                                                                 | CI smoke | Needs |
| -------------------------------------- | ----------------------------------------------------------------------- | -------- | ----- |
| `settings-backup-restore.spec.js`      | Settings backup, export, import and restore round trip                  | yes      |       |
| `settings-subcategories-smoke.spec.js` | Each settings section opens and its switches save                       |          |       |
| `model-switching.spec.js`              | Changing the text model in Settings and keeping the choice              |          |       |
| `ai-provider.spec.js`                  | Cloud AI provider keys, default provider and routing (no network calls) |          |       |
| `cloud-consent-theme.spec.js`          | The Cloud AI consent dialog is readable in every theme                  |          |       |
| `mcp-onboarding.spec.js`               | Enabling the MCP server in Settings and testing the connection          |          |       |

#### `workflows/` - cross-phase journeys on seeded data

| Spec                    | Purpose                                                                   | CI smoke | Needs |
| ----------------------- | ------------------------------------------------------------------------- | -------- | ----- |
| `beta-workflow.spec.js` | The Beta Tester Guide path: Setup, Discover, Organize, Search, Settings   |          |       |
| `full-pipeline.spec.js` | Analysis results through Organize to completion, and smart folder routing |          |       |

#### `live-llm/` - real local models

All three are tagged `@live-llm` and run with `npm run test:e2e:live-llm`. Set
`STRATOSORT_E2E_MODELS_DIR` to a folder of `.gguf` models first; without it they skip.

| Spec                      | Purpose                                                                 | CI smoke | Needs                                      |
| ------------------------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------ |
| `full-journey.spec.js`    | One file through import, analysis, organize and search on the real APIs |          | `STRATOSORT_E2E_MODELS_DIR` (text model)   |
| `live-llm-chat.spec.js`   | Analyze a document, then stream a grounded chat answer                  |          | `STRATOSORT_E2E_MODELS_DIR` (text model)   |
| `live-llm-vision.spec.js` | Vision model analysis of a PNG fixture                                  |          | `STRATOSORT_E2E_MODELS_DIR` (vision model) |

#### `manual/` - opt-in, never in CI

Both skip themselves in a plain `npm run test:e2e` run when their requirement is missing.

| Spec                       | Purpose                                                                    | CI smoke | Needs                                                                |
| -------------------------- | -------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `soak.spec.js`             | 10-15 minute stability loop with memory sampling                           |          | `SOAK=1` (use `npm run test:soak`); optional `SOAK_MINUTES`          |
| `qa-runtime-repro.spec.js` | QA repro session for backlog items (settings, chat streaming, graph edges) |          | Windows, with the real models in `%APPDATA%\StratoSort Stack\models` |

## Prerequisites

1. **Node.js 24.11+** - Required (`package.json` engines; `.nvmrc` pins `24.22.1`)
2. **Build the renderer** - Run `npm run build:dev` before testing. Global setup rebuilds the main
   and preload bundles (`npm run build:main:dev`) itself when they are missing or stale.
3. **Models (optional)** - Only the `live-llm/` specs, one `analysis-flow` test and
   `manual/qa-runtime-repro.spec.js` use real models. They skip when the models are missing.

## Running Tests

### Basic Commands

```bash
# Run all E2E tests (headless)
npm run test:e2e

# Run with visible Electron window
npm run test:e2e:headed

# Run in debug mode (with Playwright Inspector)
npm run test:e2e:debug

# Open Playwright UI for interactive testing
npm run test:e2e:ui

# View test report
npm run test:e2e:report

# Run the @live-llm specs (set STRATOSORT_E2E_MODELS_DIR first)
npm run test:e2e:live-llm

# Run the soak test (about 12 minutes)
npm run test:soak
```

### Running Specific Tests

```bash
# Run one folder
npx playwright test test/e2e/search

# Run a specific test file
npx playwright test test/e2e/app/app-launch.spec.js

# Run by file name only (matches in any folder)
npx playwright test app-launch

# Run by describe or test title
npx playwright test --grep "App Launch"

# Run the CI smoke set locally (same specs, same order as ci.yml)
npx playwright test test/e2e/app/app-launch.spec.js test/e2e/discover/whisper-variant-loader.spec.js test/e2e/app/session-persistence.spec.js test/e2e/organize/undo-redo.spec.js test/e2e/organize/organize-phase.spec.js test/e2e/search/search-modal.spec.js test/e2e/settings/settings-backup-restore.spec.js test/e2e/app/accessibility.spec.js --reporter=list
```

### Debug Options

```bash
# Run with trace recording
npx playwright test --trace on

# Run with video recording
npx playwright test --video on
```

## Test Structure

```
test/e2e/
├── helpers/
│   ├── electronApp.js      # Launch/close the app, isolated profiles, modal helpers
│   ├── pageObjects.js      # Page objects (NavigationPage, DiscoverPage, ...)
│   ├── testFixtures.js     # Phases, selectors, timeouts, fixture files, temp dirs
│   ├── seedState.js        # Seed analyzed files so specs need no live model
│   ├── liveLlm.js          # Waits and assertions for specs that use real models
│   ├── e2eSettings.js      # Open Settings, expand sections, switch experience mode
│   ├── e2eShortcuts.js     # Keyboard shortcut helpers (open search)
│   ├── globalSetup.js      # Runs once before all tests (rebuilds stale main/preload bundles)
│   └── globalTeardown.js   # Runs once after all tests (kills orphaned Electron processes)
├── app/                    # App shell
├── setup/                  # Smart folders
├── discover/               # Import and analysis
├── organize/               # Organize and undo/redo
├── search/                 # Knowledge OS: search, chat, graph, Atlas
├── settings/               # Settings panel
├── workflows/              # Cross-phase journeys on seeded data
├── live-llm/               # @live-llm specs (real models)
├── manual/                 # Soak test and QA repro (opt-in)
└── README.md               # This file
```

Two Jest tests read these folders and run with `npm test`:

- `test/e2eSpecsHaveAssertions.test.js` fails when a `test()` block has no assertion. Its allowlist
  keys are full spec paths (`test/e2e/<folder>/<name>.spec.js::<title>`), so update them when you
  move or rename a spec.
- `test/e2eIsolatedProfileSeed.test.js` fails when a spec opts out of the offline profile seed.

## Writing New Tests

Put the spec in the folder for the area it tests. Specs sit one level below `test/e2e/`, so helper
imports start with `../helpers/`.

### Basic Test Template

```javascript
const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('../helpers/electronApp');
const { NavigationPage } = require('../helpers/pageObjects');

test.describe('My Feature', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should do something', async () => {
    // Use page objects for cleaner code
    const nav = new NavigationPage(window);

    // Perform actions
    await nav.goToPhase('setup');

    // Make assertions
    const phase = await nav.getCurrentPhase();
    expect(phase).toBe('setup');
  });
});
```

### Using Page Objects

```javascript
const { NavigationPage, DiscoverPage, OrganizePage } = require('../helpers/pageObjects');

test('workflow test', async () => {
  const nav = new NavigationPage(window);
  const discover = new DiscoverPage(window);

  // Navigate to Discover
  await nav.goToPhase('discover');

  // Check file drop zone
  const hasDropZone = await discover.isDragDropVisible();
  expect(hasDropZone).toBe(true);
});
```

### Using Test Fixtures

```javascript
const { TEST_FILES, setupTestFiles, cleanupTempDir } = require('../helpers/testFixtures');

test('test with files', async () => {
  // Create temp directory with test files
  const { tempDir, files } = await setupTestFiles(['sampleTxt', 'contract']);

  try {
    // Use files in test
    console.log(
      'Test files:',
      files.map((f) => f.name)
    );
  } finally {
    // Clean up
    await cleanupTempDir(tempDir);
  }
});
```

## Configuration

The Playwright configuration is in `playwright.config.js` at the project root:

- **Test timeout**: 3 minutes (for analysis tests)
- **Expect timeout**: 30 seconds
- **Workers**: 1 (Electron tests run serially)
- **Retries**: 2 on CI, 1 locally

## Test Artifacts

Test artifacts are saved to:

- **Screenshots**: `test-results/e2e/screenshots/`
- **Videos**: `test-results/e2e/` (on retry)
- **Traces**: `test-results/e2e/` (on retry)
- **HTML Report**: `test-results/e2e-report/`

## CI/CD Integration

The tests are designed to run in CI environments:

1. Tests handle missing models gracefully
2. Headless mode is default
3. Screenshots/videos captured on failure
4. HTML report generated for review

### GitHub Actions

The `e2e-smoke` job in `.github/workflows/ci.yml` runs the eight specs marked **CI smoke** in the
spec index, on pushes, on Ubuntu (under xvfb) and Windows. The spec paths are listed twice in that
job, once per OS; keep both lists and the "CI smoke set" command above in step when a smoke spec
moves. The full suite and the `@live-llm` specs are run by hand before releases.

## Troubleshooting

### Tests failing with "No window found"

Ensure the build is complete:

```bash
npm run build:dev
```

### Tests timing out

- Increase timeout in `playwright.config.js`
- Check if Electron app is starting correctly
- Run with `--debug` to see what's happening

### AI model-related test failures

Every launch uses an isolated, empty profile, so the models installed for your own copy of the app
are not visible to the tests. Specs that need a model skip when there is none. To run them, point
`STRATOSORT_E2E_MODELS_DIR` at a folder of `.gguf` models:

```bash
# PowerShell: $env:STRATOSORT_E2E_MODELS_DIR = 'C:path	omodels'
export STRATOSORT_E2E_MODELS_DIR=/path/to/models
npm run test:e2e:live-llm
```

### Windows-specific issues

- Ensure GPU acceleration is working or disabled
- Check that the app path doesn't contain special characters
- Run as administrator if file access is restricted

## Contributing

When adding new tests:

1. Put the spec in the folder for its product area and follow the file naming convention
   (`*.spec.js`); add it to the spec index at the top of this file
2. Use page objects for UI interactions
3. Add appropriate test descriptions
4. Handle model unavailability gracefully
5. Clean up any created resources in `afterEach`
