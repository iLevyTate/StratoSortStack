#!/usr/bin/env node

/**
 * Verify that ipcMain invoke handlers declare a Zod schema via createHandler / registerHandlers.
 *
 * Complements verify-ipc-handlers.js (existence) with payload-boundary discipline.
 * Uses static analysis (no AST dependency): safeHandle / registerHandlers + createHandler blocks.
 */

const fs = require('fs');
const path = require('path');

// Advance i past a `//` line comment or `/* ... */` block comment starting at s[i].
// Returns the new index positioned at the last consumed character (caller's `i++`
// or `continue` advances past it). Returns -1 if we should abort scanning (e.g.
// unterminated block comment past EOF). Assumes we've already confirmed s[i]==='/'.
// NOTE: Does not attempt to disambiguate regex literals from division — none of
// the scanned IPC files contain a regex literal with `//` or `/*` inside, so a
// naive check is safe here (add real regex-lexer support only if that changes).
function advancePastComment(s, i) {
  const next = s[i + 1];
  if (next === '/') {
    const nl = s.indexOf('\n', i + 2);
    return nl === -1 ? s.length - 1 : nl;
  }
  if (next === '*') {
    const end = s.indexOf('*/', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  return i;
}

const repoRoot = path.resolve(__dirname, '..');
const IPC_DIR = path.join(repoRoot, 'src', 'main', 'ipc');
const CONSTANTS_PATH = path.join(repoRoot, 'src', 'shared', 'constants.js');

/** Files that only provide helpers / aggregation — no channel registrations to scan */
const SKIP_FILES = new Set([
  'ipcWrappers.js',
  'validationSchemas.js',
  'IpcServiceContext.js',
  'index.js'
]);

/**
 * Channels allowed to omit `schema` in createHandler until migrated (ratchet).
 * Use CATEGORY.NAME keys matching IPC_CHANNELS in constants.js.
 */
const SCHEMA_OPTIONAL_CHANNELS = new Set([
  // Window chrome: zero-arg control; optional z.void() migration later
  'WINDOW.MINIMIZE',
  'WINDOW.TOGGLE_MAXIMIZE',
  'WINDOW.IS_MAXIMIZED',
  'WINDOW.CLOSE'
]);

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) results.push(full);
  }
  return results;
}

function findMatchingParen(s, openIdx) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\' && inStr !== '`') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const next = advancePastComment(s, i);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingBrace(s, openIdx) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\' && inStr !== '`') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
      const next = advancePastComment(s, i);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const VACUOUS_RECORD_SCHEMA = /z\.record\(\s*z\.string\(\)\s*,\s*z\.any\(\)\s*\)/;

function collectVacuousSchemaAliases(source) {
  const aliases = new Set();
  const re = /\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (VACUOUS_RECORD_SCHEMA.test(m[2])) aliases.add(m[1]);
  }
  return aliases;
}

// The schema value runs to the next top-level `,` or the closer of the enclosing
// object, so an inline `z.record(z.string(), z.any())` is kept whole rather than
// cut at its inner comma.
function extractSchemaExpr(body) {
  const match = body.match(/\bschema\s*:\s*/);
  if (!match || match.index == null) return '';
  return splitTopLevelArgs(body.slice(match.index + match[0].length))[0];
}

function schemaExprIsVacuous(expr, aliases) {
  const trimmed = String(expr || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return false;
  if (VACUOUS_RECORD_SCHEMA.test(trimmed)) return true;
  const ident = trimmed.replace(/\.optional\(\)\s*$/, '').trim();
  return aliases.has(ident);
}

/**
 * Split a slice into its top-level comma-separated expressions. Scanning stops
 * at the first unbalanced closer (`)`, `}` or `]`), so the slice may run past
 * the end of the enclosing argument list or object literal.
 */
function splitTopLevelArgs(argSlice) {
  const parts = [];
  let start = 0;
  let end = argSlice.length;
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let i = 0; i < argSlice.length; i++) {
    const c = argSlice[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\' && inStr !== '`') {
        esc = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && (argSlice[i + 1] === '/' || argSlice[i + 1] === '*')) {
      const next = advancePastComment(argSlice, i);
      if (next === -1) break;
      i = next;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(argSlice.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(argSlice.slice(start, end).trim());
  return parts;
}

/** Map handler variable name -> body includes schema: */
function buildCreateHandlerVarMap(source) {
  const map = new Map();
  const re = /\b(?:const|let)\s+(\w+)\s*=\s*createHandler\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const openParen = m.index + m[0].length - 1;
    const objBrace = source.indexOf('{', openParen);
    if (objBrace === -1) continue;
    const closeBrace = findMatchingBrace(source, objBrace);
    if (closeBrace === -1) continue;
    const body = source.slice(objBrace + 1, closeBrace);
    map.set(name, /\bschema\s*:/.test(body));
  }
  return map;
}

function analyzeSafeHandles(source, fileLabel, violations) {
  const varMap = buildCreateHandlerVarMap(source);
  const aliases = collectVacuousSchemaAliases(source);
  let pos = 0;
  while (pos < source.length) {
    const idx = source.indexOf('safeHandle(', pos);
    if (idx === -1) break;
    const openParen = idx + 'safeHandle('.length - 1;
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen === -1) break;
    const inner = source.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(inner);
    if (args.length < 3) {
      pos = closeParen + 1;
      continue;
    }
    const channelArg = args[1].replace(/\s+/g, '');
    const handlerArg = args[2].trim();
    const channelMatch = channelArg.match(/^IPC_CHANNELS\.(\w+)\.(\w+)$/);
    if (!channelMatch) {
      pos = closeParen + 1;
      continue;
    }
    const ref = `${channelMatch[1]}.${channelMatch[2]}`;

    const fullCall = source.slice(idx, closeParen + 1);
    let hasSchema = /\bschema\s*:/.test(fullCall);

    if (!hasSchema) {
      const oneLineHandler = handlerArg.replace(/\s+/g, ' ');
      const varOnly = oneLineHandler.match(/^(\w+)$/);
      if (varOnly) {
        hasSchema = varMap.get(varOnly[1]) === true;
      }
    }

    if (!hasSchema && !SCHEMA_OPTIONAL_CHANNELS.has(ref)) {
      violations.push({ file: fileLabel, channel: ref, kind: 'safeHandle' });
    } else if (hasSchema && schemaExprIsVacuous(extractSchemaExpr(fullCall), aliases)) {
      violations.push({ file: fileLabel, channel: ref, kind: 'vacuousSchema' });
    }
    pos = closeParen + 1;
  }
}

function analyzeRegisterHandlers(source, fileLabel, violations) {
  let pos = 0;
  while (pos < source.length) {
    const idx = source.indexOf('registerHandlers(', pos);
    if (idx === -1) break;
    const openParen = source.indexOf('(', idx);
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen === -1) break;
    const callBody = source.slice(openParen + 1, closeParen);
    const handlersMatch = callBody.match(/\bhandlers\s*:\s*\{/);
    if (!handlersMatch) {
      pos = closeParen + 1;
      continue;
    }
    const hBrace = callBody.indexOf('{', handlersMatch.index + handlersMatch[0].length - 1);
    const handlersObjClose = findMatchingBrace(callBody, hBrace);
    if (handlersObjClose === -1) {
      pos = closeParen + 1;
      continue;
    }
    const handlersBlock = callBody.slice(hBrace + 1, handlersObjClose);

    let b = 0;
    while (b < handlersBlock.length) {
      const keyMatch = handlersBlock.slice(b).match(/^\s*\[IPC_CHANNELS\.(\w+)\.(\w+)\]\s*:\s*\{/);
      if (!keyMatch) {
        b++;
        continue;
      }
      const ref = `${keyMatch[1]}.${keyMatch[2]}`;
      const absOpenBrace = b + keyMatch[0].length - 1;
      const entryClose = findMatchingBrace(handlersBlock, absOpenBrace);
      if (entryClose === -1) break;
      const entryBody = handlersBlock.slice(absOpenBrace + 1, entryClose);
      const hasSchema = /\bschema\s*:/.test(entryBody);
      if (!hasSchema && !SCHEMA_OPTIONAL_CHANNELS.has(ref)) {
        violations.push({ file: fileLabel, channel: ref, kind: 'registerHandlers' });
      } else if (
        hasSchema &&
        schemaExprIsVacuous(extractSchemaExpr(entryBody), collectVacuousSchemaAliases(source))
      ) {
        violations.push({ file: fileLabel, channel: ref, kind: 'vacuousSchema' });
      }
      b = entryClose + 1;
    }
    pos = closeParen + 1;
  }
}

function main() {
  const { IPC_CHANNELS } = require(CONSTANTS_PATH);
  const invokeChannelStrings = new Set();
  for (const group of Object.values(IPC_CHANNELS)) {
    for (const ch of Object.values(group)) {
      if (typeof ch === 'string') invokeChannelStrings.add(ch);
    }
  }

  const files = collectJsFiles(IPC_DIR).filter((f) => !SKIP_FILES.has(path.basename(f)));
  const violations = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    const label = path.relative(repoRoot, filePath);
    analyzeSafeHandles(source, label, violations);
    analyzeRegisterHandlers(source, label, violations);
  }

  const filtered = violations.filter((v) => {
    const [cat, name] = v.channel.split('.');
    const channelStr = IPC_CHANNELS[cat]?.[name];
    return typeof channelStr === 'string' && invokeChannelStrings.has(channelStr);
  });

  if (filtered.length > 0) {
    console.error('\nIPC handler schema verification failed\n');
    console.error(
      'Invoke handlers should declare a constraining schema: in createHandler / registerHandlers entries.'
    );
    console.error('z.record(z.string(), z.any()) does not count as a real schema (SW-47).');
    console.error(`(Allowlist: ${SCHEMA_OPTIONAL_CHANNELS.size} channel(s))\n`);
    for (const v of filtered) {
      console.error(`  - ${v.channel} [${v.kind}] ${v.file}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `OK: IPC invoke handlers declare schemas (or are allowlisted). Checked ${files.length} file(s).`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  collectVacuousSchemaAliases,
  extractSchemaExpr,
  schemaExprIsVacuous,
  VACUOUS_RECORD_SCHEMA
};
