#!/usr/bin/env node

/**
 * Verify that every push-event channel actually sent from the main process
 * (safeSend / safeSendToMain) has a payload schema in ipcEventSchemas.js.
 *
 * Closes the last IPC drift axis (backlog S-2): safeSend validates ONLY when
 * a schema exists (`if (hasEventSchema(channel))`), so a new event channel
 * added without a schema would ship silently unvalidated — no other verify:*
 * guard catches that.
 *
 * Static analysis, comment-line-safe (JSDoc examples in ipcWrappers.js use
 * literal channels). Dynamic channel expressions fail the check unless
 * allowlisted below with a justification.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const MAIN_DIR = path.join(repoRoot, 'src', 'main');

const { IPC_CHANNELS, IPC_EVENTS } = require(path.join(repoRoot, 'src', 'shared', 'constants.js'));
const { hasEventSchema } = require(path.join(repoRoot, 'src', 'shared', 'ipcEventSchemas.js'));

/**
 * Channels allowed to lack an event schema (ratchet — keep empty unless a
 * channel genuinely cannot be schema'd, and say why).
 */
const SCHEMA_OPTIONAL_EVENT_CHANNELS = new Set([]);

function collectJsFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, results);
    else if (entry.name.endsWith('.js')) results.push(full);
  }
  return results;
}

function stripLineComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

function resolveChannelExpression(expr, source) {
  const eventMatch = expr.match(/^IPC_EVENTS\.([A-Z0-9_]+)$/);
  if (eventMatch) return IPC_EVENTS[eventMatch[1]];
  const channelMatch = expr.match(/^IPC_CHANNELS\.([A-Z0-9_]+)\.([A-Z0-9_]+)$/);
  if (channelMatch) return IPC_CHANNELS[channelMatch[1]]?.[channelMatch[2]];
  const literalMatch = expr.match(/^['"`]([^'"`]+)['"`]$/);
  if (literalMatch) return literalMatch[1];
  // One level of local-const indirection: `const channel = IPC_CHANNELS.X.Y;`
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const declMatch = source.match(
      new RegExp(`const\\s+${expr}\\s*=\\s*(IPC_(?:EVENTS|CHANNELS)(?:\\.[A-Z0-9_]+)+)`)
    );
    if (declMatch) return resolveChannelExpression(declMatch[1], source);
  }
  return null;
}

const CALL_PATTERN = /safeSend(?:ToMain)?\(\s*[^,()]+,\s*([^,)]+)/g;

const missingSchema = new Map();
const unresolvable = [];

// ipcWrappers.js DEFINES safeSend/safeSendToMain (parameter `channel` is a
// pass-through, validated per-call at the real call sites scanned below).
const SKIP_FILES = new Set(['ipcWrappers.js']);

for (const file of collectJsFiles(MAIN_DIR)) {
  if (SKIP_FILES.has(path.basename(file))) continue;
  const source = stripLineComments(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(repoRoot, file);
  for (const match of source.matchAll(CALL_PATTERN)) {
    const expr = match[1].trim();
    const channel = resolveChannelExpression(expr, source);
    if (!channel) {
      unresolvable.push(`${rel}: safeSend channel expression not statically resolvable: ${expr}`);
      continue;
    }
    if (SCHEMA_OPTIONAL_EVENT_CHANNELS.has(channel)) continue;
    if (!hasEventSchema(channel)) {
      if (!missingSchema.has(channel)) missingSchema.set(channel, []);
      missingSchema.get(channel).push(rel);
    }
  }
}

if (unresolvable.length > 0 || missingSchema.size > 0) {
  for (const line of unresolvable) {
    console.error(`ERROR: ${line}`);
  }
  for (const [channel, files] of missingSchema) {
    console.error(
      `ERROR: event channel '${channel}' is sent via safeSend but has NO schema in ipcEventSchemas.js (sent from: ${[...new Set(files)].join(', ')})`
    );
  }
  console.error(
    '\nAdd a schema to src/shared/ipcEventSchemas.js (safeSend silently skips validation for schema-less channels).'
  );
  process.exit(1);
}

console.log('OK: every safeSend/safeSendToMain event channel has a payload schema.');
