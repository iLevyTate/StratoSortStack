/**
 * @jest-environment node
 */
/**
 * createWindow() holds a mutex while a window is being created. When window
 * creation throws synchronously the mutex must be released, or every later
 * createWindow() (second launch, tray, dock) returns the settled promise and
 * no window ever opens again.
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

const { loadSimpleMain } = require('./loadSimpleMain');

describe('createWindow after a synchronous creation failure', () => {
  let harness;

  beforeAll(() => {
    harness = loadSimpleMain();
  });

  afterAll(() => {
    harness.dispose();
  });

  test('a later launch creates the window again', async () => {
    const { app, createWindow, mod } = harness;
    createWindow.mockImplementationOnce(() => {
      throw new Error('BrowserWindow setup failed');
    });

    await expect(mod.createStartupWindow()).resolves.toBeUndefined();
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow.windows).toHaveLength(0);

    // The user launches the app again: the window must be created this time.
    app.__events.emit('second-instance', {}, []);
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(createWindow.windows).toHaveLength(1);
  });
});
