import React, { memo } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { ArrowRight, FolderOpen } from 'lucide-react';
import Modal from '../ui/Modal';
import { Button, StatusBadge } from '../ui';
import { Text } from '../ui/Typography';
import { Inline } from '../layout';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayFileName } from '../../utils/pathDisplay';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The sample-first dialog (useSampleRun): offer, progress, then where each
 * sample file would go and why. Nothing in it moves a file.
 */
function SampleRunDialog({
  session,
  progress = null,
  onSample,
  onSkip,
  onStop,
  onContinue,
  onEditFolders,
  onClose
}) {
  const redactPaths = Boolean(useSelector(selectRedactPaths));
  if (!session) return null;

  const total = session.files.length;
  const sampleCount = session.picked.length;
  const restCount = Math.max(0, total - sampleCount);
  const nameLabel = (name) => formatDisplayFileName(name, { redact: redactPaths });

  if (session.stage === 'offer') {
    return (
      <Modal
        isOpen
        onClose={onClose}
        title="Try a few files first?"
        description={`${plural(total, 'file')} are ready to analyze. Analyze ${sampleCount} of them first to see where your Smart Folders send them. No files are moved.`}
        size="md"
        dataTestId="sample-run-offer"
        footer={
          <Inline className="justify-end" gap="default" wrap={false}>
            <Button onClick={onSkip} variant="secondary" size="sm">
              {`Analyze all ${total} files`}
            </Button>
            <Button onClick={onSample} variant="primary" size="sm">
              {`Analyze ${sampleCount} files first`}
            </Button>
          </Inline>
        }
      >
        <div className="flex flex-col gap-default">
          {session.hintCount > 0 && (
            <Text variant="small" className="text-system-gray-700">
              {`${plural(session.hintCount, 'Smart Folder')} ${
                session.hintCount === 1 ? 'has' : 'have'
              } a description hint in Setup. The sample shows whether it matters.`}
            </Text>
          )}
          <div>
            <Text variant="tiny" className="text-system-gray-600 mb-1.5">
              The sample takes files of each type in the batch:
            </Text>
            <ul className="rounded-xl border border-border-soft/60 divide-y divide-border-soft/40">
              {session.picked.map((file) => (
                <li key={file.path} className="px-3 py-1.5 min-w-0">
                  <Text variant="tiny" className="text-system-gray-800 truncate">
                    {nameLabel(file.name || String(file.path).split(/[\\/]/).pop())}
                  </Text>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Modal>
    );
  }

  if (session.stage === 'running') {
    const done = Math.min(Number(progress?.current) || 0, sampleCount);
    return (
      <Modal
        isOpen
        onClose={onStop}
        closeDisabled
        closeOnOverlayClick={false}
        title="Trying your Smart Folders"
        description={`Analyzing ${plural(sampleCount, 'file')}. No files are moved.`}
        size="md"
        dataTestId="sample-run-progress"
        footer={
          <Inline className="justify-end" gap="default" wrap={false}>
            <Button onClick={onStop} variant="secondary" size="sm">
              Stop
            </Button>
          </Inline>
        }
      >
        <Text variant="small" className="text-system-gray-700" role="status">
          {`${done} of ${sampleCount} done`}
        </Text>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Where these files would go"
      description="Nothing has moved. If a file would land in the wrong folder, edit that folder's description to say what belongs there and what does not."
      size="lg"
      dataTestId="sample-run-review"
      footer={
        <Inline className="justify-end" gap="default" wrap={false}>
          <Button onClick={onEditFolders} variant="secondary" size="sm">
            Edit Smart Folders
          </Button>
          <Button onClick={restCount > 0 ? onContinue : onClose} variant="primary" size="sm">
            {restCount > 0 ? `Analyze the other ${plural(restCount, 'file')}` : 'Done'}
          </Button>
        </Inline>
      }
    >
      <ul
        className="rounded-xl border border-border-soft/60 divide-y divide-border-soft/40 max-h-[50vh] overflow-y-auto modern-scrollbar"
        aria-label="Sample results"
      >
        {session.rows.map((row) => (
          <li key={row.path} className="px-3 py-2 min-w-0" data-testid="sample-run-row">
            <div className="flex items-center gap-compact min-w-0">
              <Text variant="small" className="text-system-gray-800 truncate" title={row.name}>
                {nameLabel(row.name)}
              </Text>
              <ArrowRight
                className="w-3.5 h-3.5 text-system-gray-400 shrink-0"
                aria-label="goes to"
              />
              <FolderOpen className="w-3.5 h-3.5 text-stratosort-blue shrink-0" aria-hidden />
              <Text variant="small" className="font-medium text-system-gray-900 truncate">
                {row.analyzed ? row.folder || 'Uncategorized' : 'Not analyzed'}
              </Text>
              {row.score !== null && (
                <StatusBadge variant="info" size="sm" className="shrink-0 ml-auto">
                  {`${Math.round(row.score * 100)}% confidence`}
                </StatusBadge>
              )}
            </div>
            <Text variant="tiny" className="text-system-gray-600 mt-0.5">
              {row.reason}
            </Text>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

SampleRunDialog.propTypes = {
  session: PropTypes.shape({
    stage: PropTypes.oneOf(['offer', 'running', 'review']).isRequired,
    files: PropTypes.array.isRequired,
    picked: PropTypes.array.isRequired,
    hintCount: PropTypes.number,
    rows: PropTypes.array
  }),
  progress: PropTypes.shape({ current: PropTypes.number, total: PropTypes.number }),
  onSample: PropTypes.func.isRequired,
  onSkip: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
  onContinue: PropTypes.func.isRequired,
  onEditFolders: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired
};

export default memo(SampleRunDialog);
