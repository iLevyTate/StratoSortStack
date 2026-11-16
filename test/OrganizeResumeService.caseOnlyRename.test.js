/**
 * @jest-environment node
 */
/**
 * Resuming a case-only rename (Invoice.pdf -> invoice.pdf) on a
 * case-insensitive filesystem found the source itself at the destination,
 * took the name for occupied, and committed the file as `invoice_1.pdf`.
 * Both the resume collision walk and atomicMove now treat a destination that
 * is the source itself (same dev + ino) as free.
 *
 * On a case-sensitive host the other-cased name simply does not exist, so the
 * same expectations hold there too.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { resumeIncompleteBatches } = require('../src/main/services/OrganizeResumeService');
const { atomicFileOps } = require('../src/shared/atomicFileOperations');

describe('case-only rename keeps its name', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-case-only-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test('atomicMove renames Invoice.pdf to invoice.pdf, not invoice_1.pdf', async () => {
    const source = path.join(testDir, 'Invoice.pdf');
    const dest = path.join(testDir, 'invoice.pdf');
    await fs.writeFile(source, 'invoice-bytes');

    const committed = await atomicFileOps.atomicMove(source, dest);

    expect(path.basename(committed)).toBe('invoice.pdf');
    expect(await fs.readdir(testDir)).toEqual(['invoice.pdf']);
  });

  test('resume commits the case-only rename under the planned name', async () => {
    const source = path.join(testDir, 'Invoice.pdf');
    const dest = path.join(testDir, 'invoice.pdf');
    await fs.writeFile(source, 'invoice-bytes');

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
    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    await resumeIncompleteBatches(serviceIntegration, logger, () => null);

    expect(markOrganizeOpError).not.toHaveBeenCalled();
    const committed = markOrganizeOpDone.mock.calls.at(-1)?.[2]?.destination;
    expect(path.basename(committed)).toBe('invoice.pdf');
    expect(await fs.readdir(testDir)).toEqual(['invoice.pdf']);
    expect(await fs.readFile(dest, 'utf8')).toBe('invoice-bytes');
  });
});
