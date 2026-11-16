/**
 * @jest-environment node
 */
/**
 * A second launch while startup is still running (before IPC handlers are
 * registered) must not create the main window: the renderer would start
 * invoking before any handler exists. Startup's own window creation serves
 * the launch and brings the window forward on its first show.
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

describe('second launch during startup', () => {
  let harness;

  beforeAll(() => {
    harness = loadSimpleMain();
  });

  afterAll(() => {
    harness.dispose();
  });

  test('defers window creation to startup and focuses the window on its first show', async () => {
    const { app, createWindow, mod } = harness;

    // app.whenReady() never resolves in this harness, so startup has not
    // registered IPC yet.
    app.__events.emit('second-instance', {}, []);
    app.__events.emit('second-instance', {}, []);
    expect(createWindow).not.toHaveBeenCalled();

    mod.createStartupWindow();
    expect(createWindow).toHaveBeenCalledTimes(1);
    const win = createWindow.windows[0];
    expect(win.focus).not.toHaveBeenCalled();

    win.show();
    await new Promise((resolve) => setImmediate(resolve));
    expect(win.focus).toHaveBeenCalled();
  });

  test('a launch after startup created the window restores it', async () => {
    const { app, createWindow } = harness;
    const win = createWindow.windows[0];
    win.hide();
    win.show.mockClear();

    app.__events.emit('second-instance', {}, []);
    await new Promise((resolve) => setImmediate(resolve));

    expect(createWindow).not.toHaveBeenCalled();
    expect(createWindow.windows).toHaveLength(1);
    expect(win.show).toHaveBeenCalled();
  });
});
