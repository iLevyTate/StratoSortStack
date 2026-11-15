/**
 * @jest-environment node
 *
 * Trashing duplicates from the graph removes files from disk and the
 * indexes. Every other delete path tells the renderer with
 * FILE_OPERATION_COMPLETE so Discover/Organize drop the files; this one did
 * not, so trashed files lingered in renderer state.
 */

const mockTrashBatch = jest.fn();
jest.mock('../src/main/services/TrashService', () => ({
  TrashService: class {
    trashBatch(paths) {
      return mockTrashBatch(paths);
    }
  }
}));

const { IPC_EVENTS } = require('../src/shared/constants');
const { handleTrashDuplicates } = require('../src/main/ipc/semantic');

const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

function makeEvent(destroyed = false) {
  return { sender: { send: jest.fn(), isDestroyed: () => destroyed } };
}

describe('handleTrashDuplicates notifies the renderer', () => {
  beforeEach(() => {
    mockTrashBatch.mockReset();
  });

  test('sends a delete FILE_OPERATION_COMPLETE with only the trashed paths', async () => {
    mockTrashBatch.mockResolvedValue({
      trashed: [{ path: '/docs/copy-a.pdf', size: 1 }],
      failed: [{ path: '/docs/copy-b.pdf', error: 'locked' }],
      totalBytes: 1
    });
    const event = makeEvent();

    await handleTrashDuplicates({ logger }, event, {
      paths: ['/docs/copy-a.pdf', '/docs/copy-b.pdf']
    });

    const sends = event.sender.send.mock.calls.filter(
      ([channel]) => channel === IPC_EVENTS.FILE_OPERATION_COMPLETE
    );
    expect(sends).toEqual([
      [IPC_EVENTS.FILE_OPERATION_COMPLETE, { operation: 'delete', files: ['/docs/copy-a.pdf'] }]
    ]);
  });

  test('sends nothing when no file was trashed', async () => {
    mockTrashBatch.mockResolvedValue({
      trashed: [],
      failed: [{ path: '/docs/copy-a.pdf', error: 'locked' }],
      totalBytes: 0
    });
    const event = makeEvent();

    await handleTrashDuplicates({ logger }, event, { paths: ['/docs/copy-a.pdf'] });

    expect(event.sender.send).not.toHaveBeenCalled();
  });

  test('a destroyed window does not turn a successful trash into a failure', async () => {
    mockTrashBatch.mockResolvedValue({
      trashed: [{ path: '/docs/copy-a.pdf', size: 1 }],
      failed: [],
      totalBytes: 1
    });
    const event = makeEvent(true);

    const result = await handleTrashDuplicates({ logger }, event, {
      paths: ['/docs/copy-a.pdf']
    });

    expect(result.success).toBe(true);
    expect(event.sender.send).not.toHaveBeenCalled();
  });
});
