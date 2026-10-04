/**
 * Regenerate docs/IPC_ERROR_AUDIT_LINE_BY_LINE.md from source.
 * Run: node scripts/generate-ipc-line-audit-data.js
 */
const fs = require('fs');
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants.js');

const repoRoot = path.join(__dirname, '..');

function resolveChannel(expr) {
  const m = expr.match(/IPC_CHANNELS\.([\w.]+)/);
  if (!m) return '?';
  let o = IPC_CHANNELS;
  for (const p of m[1].split('.')) {
    o = o?.[p];
  }
  return typeof o === 'string' ? o : '?';
}

function toPosixRel(absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

const ipcDir = path.join(repoRoot, 'src', 'main', 'ipc');
const files = [];

function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) files.push(p);
  }
}
walk(ipcDir);

const rows = [];
for (const file of files.sort()) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('safeHandle(')) {
      let buf = line;
      let j = i;
      while (j < lines.length && !buf.includes('IPC_CHANNELS') && j - i < 8) {
        j += 1;
        if (j < lines.length) buf += `\n${lines[j]}`;
      }
      const m = buf.match(/IPC_CHANNELS[\w.]+/);
      if (m) {
        rows.push({
          file: toPosixRel(file),
          line: i + 1,
          channel: m[0],
          how: 'safeHandle'
        });
      }
    }
    const km = line.match(/^\s*\[(IPC_CHANNELS[\w.]+)\]:/);
    if (km) {
      rows.push({
        file: toPosixRel(file),
        line: i + 1,
        channel: km[1],
        how: 'registerHandlers'
      });
    }
  }
}

const seen = new Set();
const out = [];
for (const r of rows) {
  const k = `${r.file}:${r.line}:${r.channel}`;
  if (!seen.has(k)) {
    seen.add(k);
    out.push(r);
  }
}
out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

out.push({
  file: 'src/main/simple-main.js',
  line: 1020,
  channel: 'IPC_CHANNELS.SYSTEM.RENDERER_ERROR_REPORT',
  how: 'registerListener',
  note: 'ipcMain.on — not invoke/handle'
});

for (const r of out) {
  r.wire = resolveChannel(r.channel);
}

const byFile = new Map();
for (const r of out) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}

const handleCount = out.filter((r) => r.how !== 'registerListener').length;
const listenerCount = out.filter((r) => r.how === 'registerListener').length;

let md = `# IPC error-response audit: line-by-line reference

Date: March 2026. Companion to [\`IPC_ERROR_AUDIT.md\`](IPC_ERROR_AUDIT.md). Channel strings: [\`src/shared/constants.js\`](../src/shared/constants.js) (\`IPC_CHANNELS\`).

## Mechanics

| Piece | Role |
| --- | --- |
| \`registerAllIpc\` | \`src/main/ipc/index.js\` — calls each \`*Ipc(container)\` registrar. |
| \`safeHandle(ipcMain, channel, handler)\` | \`src/main/ipc/ipcWrappers.js\` — wraps \`registerHandler\` from \`src/main/core/ipcRegistry.js\`. |
| \`registerHandlers({ handlers: { [channel]: config } })\` | \`ipcWrappers.js\` — builds handlers via \`createHandler\`, then \`registerHandler\` per channel (used by \`chat.js\`, \`knowledge.js\`). |
| \`registerHandler\` | \`ipcRegistry.js\` — **actual** \`ipcMain.handle(channel, …)\` (tracked for safe teardown). |

## Inventory

- **${handleCount}** invoke channels registered via \`safeHandle\` / \`registerHandlers\` (see tables below).
- **${listenerCount}** main-process **listener** on \`IPC_CHANNELS.SYSTEM.RENDERER_ERROR_REPORT\` (\`ipcMain.on\`, not \`handle\`) in \`simple-main.js\` — renderer pushes error payloads; no structured return value.

**Out of scope here:** \`IPC_EVENTS\` (main→renderer \`webContents.send\` only) — see \`IPC_EVENTS\` in \`constants.js\` and [\`IPC_ERROR_AUDIT.md\`](IPC_ERROR_AUDIT.md) legend.

## Regenerate tables

From repo root:

\`\`\`powershell
node scripts/generate-ipc-line-audit-data.js
\`\`\`

---

`;

for (const file of [...byFile.keys()].sort()) {
  const list = byFile.get(file);
  md += `## \`${file}\`\n\n`;
  md += '| Line | Constant | Wire string | Registration |\n';
  md += '| ---: | --- | --- | --- |\n';
  for (const r of list) {
    const reg = r.note ? `${r.how} (${r.note})` : r.how;
    md += `| ${r.line} | \`${r.channel}\` | \`${r.wire}\` | ${reg} |\n`;
  }
  md += '\n';
}

md += `## Core implementation excerpts

### \`registerHandler\` → \`ipcMain.handle\`

\`\`\`60:103:src/main/core/ipcRegistry.js
function registerHandler(ipcMain, channel, handler) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('Channel must be a non-empty string');
  }
  if (!handler || typeof handler !== 'function') {
    throw new Error('Handler must be a function');
  }

  // Check for duplicate registration
  if (registry.handlers.has(channel)) {
    logger.warn(\`[REGISTRY] Handler already registered for channel: \${channel}\`);
    // Remove old handler before registering new one
    try {
      ipcMain.removeHandler(channel);
    } catch (e) {
      logger.debug(\`[REGISTRY] Could not remove old handler: \${e.message}\`);
    }
  }

  const wrappedHandler = async (event, ...args) => {
    const operationId = \`\${channel}-\${++_opCounter}\`;
    _inFlightOperations.add(operationId);
    if (_isShuttingDown) {
      _inFlightOperations.delete(operationId);
      logger.debug(\`[REGISTRY] Rejecting IPC call during shutdown: \${channel}\`);
      return {
        success: false,
        error: {
          code: 'APP_SHUTTING_DOWN',
          message: 'Application is shutting down'
        }
      };
    }
    try {
      return await handler(event, ...args);
    } finally {
      _inFlightOperations.delete(operationId);
    }
  };

  ipcMain.handle(channel, wrappedHandler);
  registry.handlers.add(channel);
  logger.debug(\`[REGISTRY] Handler registered: \${channel}\`);
}
\`\`\`

### \`safeHandle\` and \`registerHandlers\`

\`\`\`548:572:src/main/ipc/ipcWrappers.js
function registerHandlers({ ipcMain, logger, handlers, context = 'IPC' }) {
  const { registerHandler } = require('../core/ipcRegistry');

  for (const [channel, config] of Object.entries(handlers)) {
    const handler = createHandler({
      logger,
      context,
      ...config
    });
    registerHandler(ipcMain, channel, handler);
  }
}

function safeHandle(ipcMain, channel, handler) {
  const { registerHandler } = require('../core/ipcRegistry');
  registerHandler(ipcMain, channel, handler);
}
\`\`\`
`;

const mdPath = path.join(repoRoot, 'docs', 'IPC_ERROR_AUDIT_LINE_BY_LINE.md');
fs.writeFileSync(mdPath, md, 'utf8');
console.log('Wrote', mdPath, 'rows', out.length);
