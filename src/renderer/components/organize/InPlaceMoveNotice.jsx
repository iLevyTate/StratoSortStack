import React from 'react';
import PropTypes from 'prop-types';
import { AlertBox } from '../ui';

const FOLDERS_SHOWN = 2;

/** "Bing data", "Bing data and GSC data", "A, B and 2 more". */
function listFolders(names) {
  const shown = names.slice(0, FOLDERS_SHOWN);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.join(' and ');
}

/**
 * Says, before a run, which ready files will not change folder: the smart
 * folder chosen for them is the folder they are in. Without it the run
 * reports them as moved and nothing appears anywhere new.
 */
function InPlaceMoveNotice({ moves, className = '' }) {
  if (!Array.isArray(moves) || moves.length === 0) return null;

  const one = moves.length === 1;
  const folders = Array.from(new Set(moves.map((m) => m.folderName).filter(Boolean)));
  const renamedCount = moves.filter((m) => m.renamed).length;
  let outcome;
  if (renamedCount === moves.length) {
    outcome = `${one ? 'It' : 'They'} will be renamed there, not moved to another folder.`;
  } else if (renamedCount === 0) {
    outcome = `${one ? 'It' : 'They'} will stay as ${one ? 'it is' : 'they are'}.`;
  } else {
    outcome = 'They will stay where they are, and the ones with a new name are renamed there.';
  }

  return (
    <AlertBox variant="info" role="status" className={className}>
      <strong className="font-medium text-system-gray-800">
        {one ? '1 file is' : `${moves.length} files are`} already in the folder chosen for{' '}
        {one ? 'it' : 'them'}
        {folders.length > 0 ? `: ${listFolders(folders)}` : ''}
      </strong>
      <div className="mt-1">
        {outcome} To send a file somewhere else, choose a different folder on its card. Preview
        marks the files that stay.
      </div>
    </AlertBox>
  );
}

InPlaceMoveNotice.propTypes = {
  moves: PropTypes.arrayOf(
    PropTypes.shape({
      folderName: PropTypes.string,
      renamed: PropTypes.bool
    })
  ),
  className: PropTypes.string
};

export default InPlaceMoveNotice;
