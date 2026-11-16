/**
 * @jest-environment node
 */
/**
 * cleanupStaleTransactions must not delete the backups and journal of a
 * transaction whose rollback failed: the backup may be the only copy of the
 * file that was being replaced, and recoverFromJournals needs both at the
 * next startup.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = jest.requireActual('path');
const fs = require('fs').promises;
const os = require('os');

describe('AtomicFileOperations stale-transaction cleanup', () => {
  let AtomicFileOperations;
  let testDir;
  let ops;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-stale-'));
    jest.resetModules();
    ({ AtomicFileOperations } = require('../src/shared/atomicFileOperations'));
    ops = new AtomicFileOperations();
    ops.journalBaseDirectory = path.join(testDir, 'journal-base');
    ops.backupBaseDirectory = path.join(testDir, 'backup-base');
  });

  afterEach(async () => {
    ops.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const exists = (p) =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false);

  /** Begin a transaction holding one real backup, aged past maxAge. */
  async function staleTransactionWithBackup(status) {
    const source = path.join(testDir, 'settings.json');
    await fs.writeFile(source, '{"theme":"dark"}');
    const id = await ops.beginTransaction();
    const backup = await ops.createBackup(source, id);
    const tx = ops.activeTransactions.get(id);
    tx.backups.push({ source, backup });
    tx.status = status;
    tx.startTime = Date.now() - 2 * 3600000;
    await ops.writeJournal(id);
    const journalPath = path.join(ops.journalDirectory, `${id}.journal`);
    return { id, source, backup, journalPath };
  }

  test('keeps backups and journal of a rollback_failed transaction', async () => {
    const { id, backup, journalPath } = await staleTransactionWithBackup('rollback_failed');

    const count = await ops.cleanupStaleTransactions(3600000);

    expect(count).toBe(1);
    expect(ops.activeTransactions.has(id)).toBe(false);
    expect(await exists(backup)).toBe(true);
    expect(await exists(journalPath)).toBe(true);
  });

  test('a stale active transaction whose rollback fails keeps its rollback material', async () => {
    const { id, backup, journalPath } = await staleTransactionWithBackup('active');
    jest.spyOn(ops, 'rollbackTransaction').mockImplementation(async () => {
      // Mirrors the real method: it flips status to rolled_back, then throws.
      ops.activeTransactions.get(id).status = 'rolled_back';
      throw new Error('restore failed');
    });

    await ops.cleanupStaleTransactions(3600000);

    expect(ops.activeTransactions.has(id)).toBe(false);
    expect(await exists(backup)).toBe(true);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    // A non-terminal status makes recoverFromJournals restore from the backup.
    expect(journal.status).toBe('rollback_failed');
  });

  test('a stale active transaction is rolled back and then cleaned up', async () => {
    const { id, source, backup, journalPath } = await staleTransactionWithBackup('active');
    await fs.unlink(source);

    await ops.cleanupStaleTransactions(3600000);

    expect(ops.activeTransactions.has(id)).toBe(false);
    expect(await fs.readFile(source, 'utf8')).toBe('{"theme":"dark"}');
    expect(await exists(backup)).toBe(false);
    expect(await exists(journalPath)).toBe(false);
  });

  test('committed transactions still have their backups and journal removed', async () => {
    const { id, backup, journalPath } = await staleTransactionWithBackup('committed');

    await ops.cleanupStaleTransactions(3600000);

    expect(ops.activeTransactions.has(id)).toBe(false);
    expect(await exists(backup)).toBe(false);
    expect(await exists(journalPath)).toBe(false);
  });

  test('leaves an in-flight rollback alone', async () => {
    const { id, backup } = await staleTransactionWithBackup('rolling_back');

    await ops.cleanupStaleTransactions(3600000);

    expect(ops.activeTransactions.has(id)).toBe(true);
    expect(await exists(backup)).toBe(true);
  });
});
