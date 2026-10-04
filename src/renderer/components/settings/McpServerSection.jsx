import React from 'react';
import PropTypes from 'prop-types';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import SettingsCard from './SettingsCard';
import SettingRow from './SettingRow';
import Button from '../ui/Button';
import {
  enableMcpServer,
  disableMcpServer,
  rotateToken,
  getConfigSnippet,
  testConnection,
  refreshStatus,
  statusPushed
} from '../../store/slices/mcpServerSlice';

const DEFAULT_STATE = {
  enabled: false,
  status: 'stopped',
  port: null,
  tokenMasked: null,
  lastError: null,
  isWorking: false
};

const TOOLS = [
  { name: 'search_documents', desc: 'Hybrid semantic + keyword search.' },
  { name: 'chat_with_documents', desc: 'RAG with citations.' },
  { name: 'get_document_summary', desc: 'Cached LLM analysis lookup.' },
  { name: 'list_smart_folders', desc: 'Enumerate user folders.' }
];

function McpServerSection({ addNotification }) {
  const dispatch = useAppDispatch();
  const { enabled, status, port, tokenMasked, lastError, isWorking } = useAppSelector(
    (s) => s.mcp || DEFAULT_STATE
  );
  const [showToken, setShowToken] = React.useState(false);

  React.useEffect(() => {
    dispatch(refreshStatus());
    // Preload exposes the IPC bridge under `electronAPI`, not `api`. The
    // optional chaining on `window.api?.mcp?` previously swallowed the
    // miss silently, so status pushes from main never reached Redux.
    const off = window.electronAPI?.mcp?.onStatusChanged?.((p) => dispatch(statusPushed(p)));
    return () => off?.();
  }, [dispatch]);

  const onToggle = async (e) => {
    try {
      if (e.target.checked) await dispatch(enableMcpServer()).unwrap();
      else await dispatch(disableMcpServer()).unwrap();
    } catch (err) {
      addNotification?.(`MCP: ${err.message}`, 'error');
    }
  };

  const onRotate = async () => {
    if (!window.confirm('Rotate token? All configured MCP clients will need to be updated.'))
      return;
    try {
      await dispatch(rotateToken()).unwrap();
      addNotification?.('Token rotated.', 'success');
    } catch (err) {
      addNotification?.(err.message, 'error');
    }
  };

  const onCopy = async (client) => {
    try {
      const result = await dispatch(getConfigSnippet(client)).unwrap();
      const snippet = result?.snippet || '';
      await navigator.clipboard.writeText(snippet);
      addNotification?.(`Copied ${client} snippet.`, 'success');
    } catch (err) {
      addNotification?.(err.message, 'error');
    }
  };

  const onTest = async () => {
    try {
      const res = await dispatch(testConnection()).unwrap();
      addNotification?.(`Connected. Tools: ${(res.tools || []).join(', ')}`, 'success');
    } catch (err) {
      addNotification?.(err.message, 'error');
    }
  };

  return (
    <SettingsCard
      title="MCP Server"
      description="Let Claude, Cursor, Zed, or other AI tools search and chat with your StratoSort library. StratoSort itself makes no network calls for this and answers chat with the local model. The tool you connect receives paths, summaries, passages and answers from your library and sends them to its own model, which for Claude, Cursor and Zed is in the cloud."
    >
      <SettingRow label="Enable MCP server">
        <input
          type="checkbox"
          aria-label="Enable MCP server"
          checked={enabled}
          onChange={onToggle}
          disabled={isWorking}
        />
      </SettingRow>
      {enabled && (
        <>
          <SettingRow label="Status">
            <div className="flex flex-col gap-compact sm:flex-row sm:items-center sm:gap-cozy">
              <span>
                {status === 'running' ? `● Running on http://127.0.0.1:${port}/mcp` : status}
              </span>
              <Button onClick={onTest} disabled={status !== 'running'} size="sm">
                Test connection
              </Button>
            </div>
          </SettingRow>
          <SettingRow label="Bearer token">
            <div className="flex flex-col gap-compact sm:flex-row sm:items-center sm:gap-cozy">
              <code>{showToken ? tokenMasked : '••••••••'}</code>
              <Button onClick={() => setShowToken((v) => !v)} size="sm">
                {showToken ? 'Hide' : 'Show'}
              </Button>
              <Button onClick={onRotate} size="sm">
                Rotate
              </Button>
            </div>
          </SettingRow>
          <SettingRow label="Tools exposed" layout="col">
            <ul className="space-y-1">
              {TOOLS.map((t) => (
                <li key={t.name}>
                  <code className="text-sm">{t.name}</code> — {t.desc}
                </li>
              ))}
            </ul>
          </SettingRow>
          <SettingRow label="Client setup" layout="col">
            <div className="flex flex-col gap-compact">
              <Button onClick={() => onCopy('claudeDesktop')} variant="outline" size="sm">
                Copy Claude Desktop config
              </Button>
              <Button onClick={() => onCopy('cursor')} variant="outline" size="sm">
                Copy Cursor config
              </Button>
              <Button onClick={() => onCopy('zed')} variant="outline" size="sm">
                Copy Zed config
              </Button>
            </div>
          </SettingRow>
        </>
      )}
      {lastError && (
        <p role="alert" className="text-red-600">
          {lastError}
        </p>
      )}
    </SettingsCard>
  );
}

McpServerSection.propTypes = { addNotification: PropTypes.func };
McpServerSection.defaultProps = { addNotification: undefined };

export default McpServerSection;
