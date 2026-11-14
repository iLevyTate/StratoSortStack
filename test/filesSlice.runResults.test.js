/**
 * files.lastOrganizeRunFiles: every file of the last organize run, with what
 * happened to it. Cleared when a new run starts, when an undo puts files back
 * (the list no longer matches the disk) and when the session is reset.
 */

import filesReducer, {
  addOrganizedFiles,
  removeOrganizedFiles,
  resetFilesState,
  setLastOrganizeRunFiles,
  updateFilePathsAfterMove
} from '../src/renderer/store/slices/filesSlice';
import { selectLastOrganizeRunFiles } from '../src/renderer/store/selectors';
import { MAX_RUN_RESULT_ROWS } from '../src/renderer/utils/organizeRunResults';

const row = (name, outcome = 'moved') => ({
  name,
  originalPath: `/in/${name}`,
  finalPath: outcome === 'moved' ? `/out/${name}` : null,
  outcome,
  reason: outcome === 'moved' ? '' : 'Access denied.'
});

const initial = () => filesReducer(undefined, { type: '@@init' });

describe('lastOrganizeRunFiles', () => {
  test('starts empty', () => {
    expect(initial().lastOrganizeRunFiles).toEqual([]);
    expect(selectLastOrganizeRunFiles({ files: initial() })).toEqual([]);
    expect(selectLastOrganizeRunFiles({})).toEqual([]);
  });

  test('stores the rows, dropping anything that is not one, and caps the list', () => {
    let state = filesReducer(
      initial(),
      setLastOrganizeRunFiles([row('a.pdf'), null, { outcome: 'deleted' }, row('b.pdf', 'failed')])
    );
    expect(state.lastOrganizeRunFiles.map((r) => r.name)).toEqual(['a.pdf', 'b.pdf']);

    const many = Array.from({ length: MAX_RUN_RESULT_ROWS + 5 }, (_, i) => row(`${i}.pdf`));
    state = filesReducer(state, setLastOrganizeRunFiles(many));
    expect(state.lastOrganizeRunFiles).toHaveLength(MAX_RUN_RESULT_ROWS);

    state = filesReducer(state, setLastOrganizeRunFiles(null));
    expect(state.lastOrganizeRunFiles).toEqual([]);
  });

  test('an undo that puts files back clears it', () => {
    let state = filesReducer(
      initial(),
      addOrganizedFiles([{ originalPath: '/in/a.pdf', path: '/out/a.pdf' }])
    );
    state = filesReducer(state, setLastOrganizeRunFiles([row('a.pdf')]));
    state = filesReducer(state, removeOrganizedFiles(['/in/a.pdf']));
    expect(state.lastOrganizeRunFiles).toEqual([]);
  });

  test('an undo that matched nothing keeps it', () => {
    let state = filesReducer(initial(), setLastOrganizeRunFiles([row('a.pdf')]));
    state = filesReducer(state, removeOrganizedFiles(['/elsewhere/z.pdf']));
    expect(state.lastOrganizeRunFiles).toHaveLength(1);
  });

  test('resetting the session clears it', () => {
    let state = filesReducer(initial(), setLastOrganizeRunFiles([row('a.pdf')]));
    state = filesReducer(state, resetFilesState());
    expect(state.lastOrganizeRunFiles).toEqual([]);
  });
});

describe('updateFilePathsAfterMove and Unicode', () => {
  test('a queued file saved with a decomposed name follows its move', () => {
    const decomposed = '/Users/h/Ma\u0308rz.pdf';
    const composed = '/Users/h/M\u00e4rz.pdf';
    const state = {
      ...initial(),
      selectedFiles: [{ path: decomposed, name: 'Ma\u0308rz.pdf' }]
    };
    // Main returns the composed spelling of the source it moved.
    const next = filesReducer(
      state,
      updateFilePathsAfterMove({ oldPaths: [composed], newPaths: ['/Users/h/Bills/M\u00e4rz.pdf'] })
    );
    expect(next.selectedFiles[0].path).toBe('/Users/h/Bills/M\u00e4rz.pdf');
  });
});
