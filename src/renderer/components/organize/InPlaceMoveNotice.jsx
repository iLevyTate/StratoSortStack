import React from 'react';
import PropTypes from 'prop-types';
import { AlertBox, Button } from '../ui';

const FOLDERS_SHOWN = 2;

/** "Bing data", "Bing data and GSC data", "A, B and 2 more". */
function listFolders(names) {
  const shown = names.slice(0, FOLDERS_SHOWN);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.join(' and ');
}

/** What leaving the files there does, by how many of them get a new name. */
function leaveOutcome(moves) {
  const one = moves.length === 1;
  const renamedCount = moves.filter((m) => m.renamed).length;
  if (renamedCount === moves.length) {
    return `${one ? 'It' : 'They'} will be renamed there, not moved to another folder.`;
  }
  if (renamedCount === 0) {
    return `${one ? 'It' : 'They'} will stay as ${one ? 'it is' : 'they are'}.`;
  }
  return 'They will stay where they are, and the ones with a new name are renamed there.';
}

/** The leave/skip outcome once the user has chosen for every file. */
function chosenOutcome(moves) {
  const skipped = moves.filter((m) => m.choice === 'skip');
  const left = moves.filter((m) => m.choice !== 'skip');
  const one = moves.length === 1;
  if (skipped.length === 0) return leaveOutcome(moves);
  if (left.length === 0) {
    return `${one ? 'It' : 'They'} will be skipped and keep ${one ? 'its name' : 'their names'}.`;
  }
  return `${left.length} will stay where ${left.length === 1 ? 'it is' : 'they are'}, and ${skipped.length} will be skipped.`;
}

/**
 * Says, before a run, which ready files will not change folder: the smart
 * folder chosen for them is the folder they are in. Without it the run
 * reports them as moved and nothing appears anywhere new.
 *
 * With `onChoose`, a file the user has not decided about (`choice` null) is
 * a question: leave it there, or skip it. Move stays off until they answer
 * (see useOrganization). The answer is kept for each folder; `onChoose(null)`
 * asks again.
 */
function InPlaceMoveNotice({ moves, onChoose = null, className = '' }) {
  if (!Array.isArray(moves) || moves.length === 0) return null;

  const undecided = moves.filter((m) => !m.choice);
  const asking = typeof onChoose === 'function' && undecided.length > 0;
  const shown = asking ? undecided : moves;
  const one = shown.length === 1;
  const folders = Array.from(new Set(shown.map((m) => m.folderName).filter(Boolean)));
  const them = one ? 'it' : 'them';
  const hasChoice = moves.some((m) => m.choice);

  return (
    <AlertBox variant={asking ? 'warning' : 'info'} role="status" className={className}>
      <strong className="font-medium text-system-gray-800">
        {one ? '1 file is' : `${shown.length} files are`} already in the folder chosen for {them}
        {folders.length > 0 ? `: ${listFolders(folders)}` : ''}
      </strong>
      {asking ? (
        <>
          <div className="mt-1">
            Leave {them} there: {leaveOutcome(shown)} Skip {them}: {one ? 'it is' : 'they are'} left
            out of this move and {one ? 'keeps its name' : 'keep their names'}. Move stays off until
            you choose. StratoSort keeps your choice for each folder.
          </div>
          <div className="mt-2 flex flex-wrap gap-compact">
            <Button size="sm" variant="secondary" onClick={() => onChoose('leave', shown)}>
              {`Leave ${them} there`}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onChoose('skip', shown)}>
              {`Skip ${them}`}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-1">
            {typeof onChoose === 'function' ? chosenOutcome(shown) : leaveOutcome(shown)} To send a
            file somewhere else, choose a different folder on its card. Preview marks the files that
            stay.
          </div>
          {typeof onChoose === 'function' && hasChoice && (
            <div className="mt-2">
              <Button size="sm" variant="ghost" onClick={() => onChoose(null, shown)}>
                Change this choice
              </Button>
            </div>
          )}
        </>
      )}
    </AlertBox>
  );
}

InPlaceMoveNotice.propTypes = {
  moves: PropTypes.arrayOf(
    PropTypes.shape({
      folderName: PropTypes.string,
      renamed: PropTypes.bool,
      choice: PropTypes.oneOf(['leave', 'skip', null])
    })
  ),
  onChoose: PropTypes.func,
  className: PropTypes.string
};

export default InPlaceMoveNotice;
