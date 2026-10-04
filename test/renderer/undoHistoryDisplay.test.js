const { formatHistoryActionDisplay } = require('../../src/renderer/utils/undoHistoryDisplay');

describe('formatHistoryActionDisplay', () => {
  test('structures a single move with destination path', () => {
    const display = formatHistoryActionDisplay({
      type: 'FILE_MOVE',
      description: 'Move notes.pdf to C:\\Users\\benja\\Documents\\Research\\notes.pdf',
      metadata: {
        source: 'C:\\Users\\benja\\Downloads\\notes.pdf',
        destination: 'C:\\Users\\benja\\Documents\\Research\\notes.pdf'
      }
    });

    expect(display.badge).toBe('Move');
    expect(display.title).toBe('notes.pdf');
    expect(display.detail).toContain('Research');
    expect(display.detail).toContain('notes.pdf');
  });

  test('redacts filename and path for presentation mode', () => {
    const display = formatHistoryActionDisplay(
      {
        type: 'FILE_MOVE',
        description: 'Move notes.pdf to C:\\Users\\benja\\Documents\\Research\\notes.pdf',
        metadata: {
          source: 'C:\\Users\\benja\\Downloads\\notes.pdf',
          destination: 'C:\\Users\\benja\\Documents\\Research\\notes.pdf'
        }
      },
      { redact: true }
    );

    expect(display.title).toBe('Hidden file.pdf');
    expect(display.detail).toMatch(/^Moved · …/);
    expect(display.detail).not.toMatch(/benja/i);
    expect(display.ariaLabel).not.toMatch(/benja/i);
  });

  test('summarizes batch operations', () => {
    const display = formatHistoryActionDisplay(
      {
        type: 'BATCH_OPERATION',
        description: 'Organized 3 files',
        metadata: {
          operations: [
            { source: '/a.pdf', destination: '/Research/a.pdf' },
            { source: '/b.pdf', destination: '/Research/b.pdf' },
            { source: '/c.pdf', destination: '/Research/c.pdf' }
          ]
        }
      },
      { redact: true }
    );

    expect(display.badge).toBe('Batch');
    expect(display.title).toBe('3 files moved');
    expect(display.detail).toBe('Destinations hidden');
  });

  test('a trash batch is labelled as not restorable, not as reversible moves (UR-14)', () => {
    const display = formatHistoryActionDisplay({
      type: 'TRASH_BATCH',
      description: 'Delete duplicates (3 files)',
      metadata: {
        operations: [
          { type: 'trash', originalPath: '/a/1.txt' },
          { type: 'trash', originalPath: '/a/2.txt' },
          { type: 'trash', originalPath: '/a/3.txt' }
        ]
      }
    });

    expect(display.badge).toBe('Trash');
    expect(display.title).toBe('Delete duplicates (3 files)');
    expect(display.detail).toMatch(/cannot restore/);
    expect(display.detail).not.toMatch(/reversible/);
  });

  test('keeps freeform settings descriptions', () => {
    const display = formatHistoryActionDisplay({
      type: 'SETTINGS_CHANGE',
      description: 'Change setting A',
      metadata: {}
    });

    expect(display.badge).toBe('Settings');
    expect(display.title).toBe('Change setting A');
  });

  test('redacts absolute paths inside freeform descriptions', () => {
    const display = formatHistoryActionDisplay(
      {
        type: 'FILE_MOVE',
        description: 'Move part.stl to C:\\Users\\benja\\Documents\\3D print\\part.stl',
        metadata: {}
      },
      { redact: true }
    );

    expect(display.title).not.toMatch(/benja/i);
    expect(display.title).toContain('…');
  });
});
