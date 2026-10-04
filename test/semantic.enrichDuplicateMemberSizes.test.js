const fs = require('fs');

const { enrichDuplicateMemberSizes } = require('../src/main/ipc/semantic');

// The jest environment swaps in an in-memory (POSIX-style) fs. The handler
// reads files via `require('fs').promises`, which resolves to the same mock,
// so files written here are visible to enrichDuplicateMemberSizes. Use literal
// forward-slash paths — Windows path.join would emit backslashes the mock
// can't resolve.
const BASE_DIR = '/dedupe-size-test';

describe('enrichDuplicateMemberSizes', () => {
  function writeFile(name, bytes) {
    // mkdir per-write: the in-memory fs is reset between tests.
    fs.mkdirSync(BASE_DIR, { recursive: true });
    const filePath = `${BASE_DIR}/${name}`;
    fs.writeFileSync(filePath, Buffer.alloc(bytes));
    return filePath;
  }

  test('attaches real on-disk byte size to each member (shared refs across groups + tiers)', async () => {
    const aPath = writeFile('a.pdf', 1024);
    const bPath = writeFile('b.pdf', 2048);

    const member = { id: 'doc-1', path: aPath };
    const group = {
      id: 'dup-related-0',
      members: [member, { id: 'doc-2', filePath: bPath }]
    };
    // tiers and groups reference the SAME group/member objects (as in
    // findNearDuplicates), so enriching once must update both views.
    const result = { success: true, groups: [group], tiers: { related: [group] } };

    await enrichDuplicateMemberSizes(result);

    expect(result.groups[0].members[0].size).toBe(1024);
    expect(result.groups[0].members[1].size).toBe(2048);
    expect(result.tiers.related[0].members[0].size).toBe(1024);
    // Same object reference, mutated in place.
    expect(result.tiers.related[0].members[0]).toBe(member);
  });

  test('records a real 0 for genuinely empty files', async () => {
    const emptyPath = writeFile('empty.txt', 0);
    const result = { success: true, groups: [{ members: [{ id: 'x', path: emptyPath }] }] };

    await enrichDuplicateMemberSizes(result);

    expect(result.groups[0].members[0].size).toBe(0);
  });

  test('leaves size unset for missing/unreadable files (→ "Size unavailable")', async () => {
    const missing = `${BASE_DIR}/does-not-exist.pdf`;
    const member = { id: 'x', path: missing };
    const result = { success: true, groups: [{ members: [member] }] };

    await enrichDuplicateMemberSizes(result);

    expect(member.size).toBeUndefined();
  });

  test('is a no-op for empty / malformed results', async () => {
    await expect(enrichDuplicateMemberSizes(undefined)).resolves.toBeUndefined();
    await expect(enrichDuplicateMemberSizes({ groups: [] })).resolves.toBeUndefined();
    await expect(
      enrichDuplicateMemberSizes({ groups: [{ members: [{ id: 'no-path' }] }] })
    ).resolves.toBeUndefined();
  });
});
