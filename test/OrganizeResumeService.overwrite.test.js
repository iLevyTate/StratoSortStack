/**
 * Regression coverage for F-044: OrganizeResumeService must not silently
 * overwrite a file that appears at the destination during the move window.
 *
 * The resume path checks destination existence once (to decide whether to run
 * the collision-rename loop), then performs the move a few async steps later.
 * A bare fs.rename overwrites an existing destination on POSIX, so a file
 * created in that TOCTOU window — or already present when the collision loop
 * was skipped because the destination was absent at check time — was clobbered
 * with no backup and no undo entry. Routing the move through the shared guarded
 * atomicMove fixes this: it re-checks existence immediately before the rename
 * and bumps to a fresh unique name on EEXIST.
 *
 * We model "a file appears in the move window" deterministically by mocking
 * handleDuplicateMove (which runs inside that window) to drop a file at the
 * destination as a side effect, then report "not a duplicate" so the move
 * proceeds — a stand-in for a concurrent writer.
 */
const path = require('path');
const fs = require('fs').promises;
const fssync = require('fs');
const os = require('os');

const VICTIM_CONTENT = 'concurrently-created-victim';
const SOURCE_CONTENT = 'resumed-source-content';

let mockDestForInjection = null;

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn(async () => 'checksum'),
  handleDuplicateMove: jest.fn(async () => {
    if (mockDestForInjection) {
      await require('fs').promises.writeFile(mockDestForInjection, VICTIM_CONTENT);
    }
    return null;
  })
}));

describe('OrganizeResumeService — guarded move does not clobber (F-044)', () => {
  let testDir;
  let resumeIncompleteBatches;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `resume-overwrite-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });
    ({ resumeIncompleteBatches } = require('../src/main/services/OrganizeResumeService'));
  });

  afterEach(async () => {
    mockDestForInjection = null;
    jest.clearAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test('a file appearing at the destination during the move window is not overwritten', async () => {
    const source = path.join(testDir, 'source.txt');
    const dest = path.join(testDir, 'dest.txt');
    await fs.writeFile(source, SOURCE_CONTENT);
    // handleDuplicateMove (mocked) creates `dest` mid-flight, simulating a
    // concurrent writer landing in the TOCTOU window after the existence check.
    mockDestForInjection = dest;

    const markOrganizeOpDone = jest.fn(async () => {});
    const markOrganizeOpError = jest.fn(async () => {});
    const serviceIntegration = {
      processingState: {
        getIncompleteOrganizeBatches: () => [
          { id: 'b1', operations: [{ source, destination: dest, status: 'pending' }] }
        ],
        markOrganizeOpStarted: jest.fn(async () => {}),
        markOrganizeOpDone,
        markOrganizeOpError,
        completeOrganizeBatch: jest.fn(async () => {})
      }
    };
    const logger = { info: jest.fn(), warn: jest.fn() };
    const getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: { send: jest.fn() }
    });

    await resumeIncompleteBatches(serviceIntegration, logger, getMainWindow);

    // The victim file created in the window must survive untouched.
    expect(fssync.existsSync(dest)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe(VICTIM_CONTENT);

    // The resumed source must have moved to a fresh, non-clobbering name.
    expect(fssync.existsSync(source)).toBe(false);
    const committedDest = markOrganizeOpDone.mock.calls.at(-1)?.[2]?.destination;
    expect(committedDest).toBeTruthy();
    expect(committedDest).not.toBe(dest);
    expect(await fs.readFile(committedDest, 'utf8')).toBe(SOURCE_CONTENT);

    // The op completes successfully, not as an error.
    expect(markOrganizeOpError).not.toHaveBeenCalled();
  });
});
