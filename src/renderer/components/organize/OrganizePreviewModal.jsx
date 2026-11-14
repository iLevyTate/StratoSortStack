import React, { memo, useMemo } from 'react';
import PropTypes from 'prop-types';
import { ArrowRight, FolderPlus, FolderInput, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import { Button, StatusBadge } from '../ui';
import { Text } from '../ui/Typography';
import { Inline } from '../layout';
import { formatDisplayFileName, formatDisplayPath } from '../../utils/pathDisplay';
import { toParentFolderKey } from '../../utils/canonicalPath';

const SKIP_REASONS = {
  'source-missing': 'File is no longer at its original location',
  'invalid-operation': 'No destination could be worked out'
};

/** Split "C:\Docs\Finance\a.pdf" into its folder and file name. */
function splitPath(p) {
  if (typeof p !== 'string' || !p) return { folder: '', name: '' };
  const sep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return sep < 0 ? { folder: '', name: p } : { folder: p.slice(0, sep), name: p.slice(sep + 1) };
}

/**
 * Shows the dry-run plan from previewBatchOrganize before anything moves:
 * every file grouped under the folder it will land in, its new name when the
 * move renames it, folders that will be created, name clashes the move will
 * resolve with a numeric suffix (a name taken on disk, or one another file
 * of this batch gets first), files that are already in the folder chosen for
 * them and so do not change folder, and files this batch still sends to one
 * name after numbering, which the move refuses to start with.
 */
function OrganizePreviewModal({ isOpen, plan, onClose, onConfirm, redactPaths, isOrganizing }) {
  const { groups, newFolders, sameNameCount } = useMemo(() => {
    const created = new Set(Array.isArray(plan?.wouldCreateFolders) ? plan.wouldCreateFolders : []);
    const sameName = new Set(
      (Array.isArray(plan?.sameDestination) ? plan.sameDestination : []).flatMap((clash) =>
        (Array.isArray(clash?.files) ? clash.files : []).map((f) => f?.sourcePath)
      )
    );
    /** @type {Map<string, Array<any>>} */
    const byFolder = new Map();
    for (const item of Array.isArray(plan?.wouldMove) ? plan.wouldMove : []) {
      const dest = splitPath(item?.destination);
      const src = splitPath(item?.source);
      const list = byFolder.get(dest.folder) || [];
      const fromFolderKey = toParentFolderKey(item?.source);
      list.push({
        key: item?.source || `${dest.folder}|${dest.name}`,
        fromName: src.name,
        toName: dest.name,
        collision: Boolean(item?.collision),
        sameName: sameName.has(item?.source),
        staysInFolder:
          fromFolderKey !== null && fromFolderKey === toParentFolderKey(item?.destination)
      });
      byFolder.set(dest.folder, list);
    }
    return {
      groups: Array.from(byFolder.entries()).sort((a, b) => b[1].length - a[1].length),
      newFolders: created,
      sameNameCount: sameName.size
    };
  }, [plan]);

  const moveCount = Array.isArray(plan?.wouldMove) ? plan.wouldMove.length : 0;
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : [];
  const summary =
    moveCount === 0
      ? 'None of these files will move.'
      : `${moveCount} file${moveCount !== 1 ? 's' : ''} into ${groups.length} folder${
          groups.length !== 1 ? 's' : ''
        }. Nothing has moved yet.`;
  const folderLabel = (folder) =>
    redactPaths ? formatDisplayPath(folder, { redact: true, segments: 1 }) : folder;
  const nameLabel = (name) => formatDisplayFileName(name, { redact: redactPaths });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Preview: where your files will go"
      description={summary}
      size="lg"
      dataTestId="organize-preview-modal"
      footer={
        <Inline className="justify-end" gap="default" wrap={false}>
          <Button onClick={onClose} variant="secondary" size="sm">
            Close
          </Button>
          <Button
            onClick={onConfirm}
            variant="success"
            size="sm"
            disabled={moveCount === 0 || sameNameCount > 0 || isOrganizing}
          >
            <FolderInput className="w-4 h-4 mr-2" />
            {`Move ${moveCount} file${moveCount !== 1 ? 's' : ''}`}
          </Button>
        </Inline>
      }
    >
      <div className="flex flex-col gap-default max-h-[60vh] overflow-y-auto modern-scrollbar">
        {sameNameCount > 0 && (
          <div
            role="alert"
            className="flex items-start gap-compact rounded-xl border border-stratosort-warning/30 bg-stratosort-warning/12 px-3 py-2"
          >
            <AlertTriangle className="w-4 h-4 text-stratosort-warning shrink-0 mt-0.5" />
            <Text variant="tiny" className="text-system-gray-700">
              {sameNameCount} files would get the same name in the same folder, so the move will not
              start. Close this preview, give the marked files different names, then preview again.
            </Text>
          </div>
        )}
        {groups.map(([folder, files]) => (
          <section key={folder} aria-label={`Destination ${folderLabel(folder)}`}>
            <div className="flex items-center gap-compact mb-1.5 min-w-0">
              <Text
                variant="small"
                className="font-medium text-system-gray-800 truncate"
                title={redactPaths ? undefined : folder}
              >
                {folderLabel(folder)}
              </Text>
              {newFolders.has(folder) && (
                <StatusBadge variant="info" size="sm" className="shrink-0">
                  <FolderPlus className="w-3 h-3" />
                  New folder
                </StatusBadge>
              )}
              <Text variant="tiny" className="text-system-gray-500 shrink-0 ml-auto">
                {files.length} file{files.length !== 1 ? 's' : ''}
              </Text>
            </div>
            <ul className="rounded-xl border border-border-soft/60 divide-y divide-border-soft/40">
              {files.map((f) => {
                const renamed = f.fromName && f.toName && f.fromName !== f.toName;
                return (
                  <li key={f.key} className="flex items-center gap-compact px-3 py-2 min-w-0">
                    <Text
                      variant="tiny"
                      className="text-system-gray-700 truncate"
                      title={f.fromName}
                    >
                      {nameLabel(f.fromName)}
                    </Text>
                    {renamed && (
                      <>
                        <ArrowRight
                          className="w-3.5 h-3.5 text-system-gray-400 shrink-0"
                          aria-label="renamed to"
                        />
                        <Text
                          variant="tiny"
                          className="text-system-gray-900 font-medium truncate"
                          title={f.toName}
                        >
                          {nameLabel(f.toName)}
                        </Text>
                      </>
                    )}
                    {(f.staysInFolder || f.collision || f.sameName) && (
                      <span className="ml-auto flex shrink-0 items-center gap-compact">
                        {f.sameName && (
                          <StatusBadge variant="warning" size="sm">
                            Same name as another file
                          </StatusBadge>
                        )}
                        {f.staysInFolder && (
                          <StatusBadge variant="info" size="sm">
                            {renamed ? 'Already in this folder' : 'Already here — no change'}
                          </StatusBadge>
                        )}
                        {f.collision && (
                          <StatusBadge variant="warning" size="sm">
                            Name taken — number added
                          </StatusBadge>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {skipped.length > 0 && (
          <section aria-label="Files that will not move">
            <div className="flex items-center gap-compact mb-1.5">
              <AlertTriangle className="w-4 h-4 text-stratosort-warning" />
              <Text variant="small" className="font-medium text-system-gray-800">
                {skipped.length} file{skipped.length !== 1 ? 's' : ''} will not move
              </Text>
            </div>
            <ul className="rounded-xl border border-stratosort-warning/30 divide-y divide-border-soft/40">
              {skipped.map((s, i) => (
                <li key={s?.source || i} className="px-3 py-2">
                  <Text variant="tiny" className="text-system-gray-700 truncate">
                    {nameLabel(splitPath(s?.source).name) || 'Unknown file'}
                  </Text>
                  <Text variant="tiny" className="text-system-gray-500">
                    {SKIP_REASONS[s?.reason] || 'Skipped'}
                  </Text>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

OrganizePreviewModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  plan: PropTypes.shape({
    wouldMove: PropTypes.arrayOf(
      PropTypes.shape({
        source: PropTypes.string,
        destination: PropTypes.string,
        collision: PropTypes.bool
      })
    ),
    skipped: PropTypes.arrayOf(
      PropTypes.shape({ source: PropTypes.string, reason: PropTypes.string })
    ),
    wouldCreateFolders: PropTypes.arrayOf(PropTypes.string),
    sameDestination: PropTypes.arrayOf(
      PropTypes.shape({
        destination: PropTypes.string,
        files: PropTypes.arrayOf(PropTypes.shape({ sourcePath: PropTypes.string }))
      })
    )
  }),
  onClose: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
  redactPaths: PropTypes.bool,
  isOrganizing: PropTypes.bool
};

export default memo(OrganizePreviewModal);
