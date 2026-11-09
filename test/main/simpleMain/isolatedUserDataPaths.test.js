/**
 * @jest-environment node
 */
/**
 * STRATOSORT_E2E_USER_DATA isolates automated runs. It must isolate the
 * Documents and Downloads paths too: the default Uncategorized smart folder is
 * created under Documents and watched, and the Downloads watcher reads
 * Downloads, so an "isolated" run used to analyze the tester's own files.
 */
jest.mock('electron', () => require('./loadSimpleMain').electronMockFactory());
jest.mock('chokidar', () => ({ watch: jest.fn() }));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../../src/main/core/userDataLock', () =>
  require('./loadSimpleMain').userDataLockMockFactory()
);
jest.mock('../../../src/main/core/createWindow', () =>
  require('./loadSimpleMain').createWindowMockFactory()
);

const path = require('path');
const realFs = jest.requireActual('fs');

describe('isolated profile override', () => {
  let harness;
  let root;
  /** @type {Record<string, string>} */
  let setPathCalls = {};
  const saved = process.env.STRATOSORT_E2E_USER_DATA;

  beforeAll(() => {
    root = realFs.mkdtempSync(path.join(jest.requireActual('os').tmpdir(), 'strato-isolated-'));
    process.env.STRATOSORT_E2E_USER_DATA = root;
    harness = require('./loadSimpleMain').loadSimpleMain();
    // Captured here: the suite's clearMocks setting wipes call records before each test.
    setPathCalls = Object.fromEntries(harness.app.setPath.mock.calls);
  });

  afterAll(() => {
    harness.dispose();
    if (saved === undefined) delete process.env.STRATOSORT_E2E_USER_DATA;
    else process.env.STRATOSORT_E2E_USER_DATA = saved;
    realFs.rmSync(root, { recursive: true, force: true });
  });

  test('redirects userData, Documents and Downloads into the isolated root', () => {
    const calls = setPathCalls;
    expect(calls.userData).toBe(root);
    expect(calls.documents).toBe(path.join(root, 'Documents'));
    expect(calls.downloads).toBe(path.join(root, 'Downloads'));
  });
});
