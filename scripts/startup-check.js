#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Inline ANSI helpers (chalk v5+ is ESM-only, incompatible with require())
const ansi = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyanBold: (s) => `\x1b[1;36m${s}\x1b[0m`
};

try {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
} catch {
  // Silently ignore dotenv errors (file may not exist)
}

function checkFileExists(relativePath) {
  const fullPath = path.join(__dirname, '../', relativePath);
  return fs.existsSync(fullPath);
}

function printStatus(ok, label, details) {
  const icon = ok ? ansi.green('✓') : ansi.red('✗');

  console.log(`${icon} ${label}${details ? ansi.gray(` — ${details}`) : ''}`);
}

async function main() {
  console.log(ansi.cyanBold('\nStratoSort Startup Checklist'));
  // Basic file presence
  const hasDistIndex = checkFileExists('dist/index.html');
  const hasWebpackConfig = checkFileExists('webpack.config.js');
  const hasRendererIndex = checkFileExists('src/renderer/index.html');
  printStatus(hasWebpackConfig, 'Webpack config present', 'webpack.config.js');
  printStatus(hasRendererIndex, 'Renderer index present', 'src/renderer/index.html');
  printStatus(hasDistIndex, 'Built renderer present', 'dist/index.html');

  // Check models directory
  const hasModels = checkFileExists('models');
  printStatus(hasModels, 'Models directory present', 'GGUF models storage');

  // Final hint
  console.log(
    `\n${ansi.gray('Tip:')} Run ${ansi.yellow('npm run dev')} to build and launch in development mode.`
  );

  // Treat the presence of webpack config + renderer index as required; the
  // built output and models dir are advisory (first-run before build/model
  // download). If any required check fails, exit non-zero so CI pipelines
  // that call `npm run startup:check` actually fail. Previously this script
  // always exited 0 regardless of state, silently masking broken setups.
  const requiredPassed = hasWebpackConfig && hasRendererIndex;
  if (!requiredPassed) {
    console.error(
      ansi.red('\n[startup-check] Required files are missing (webpack config or renderer index).')
    );
    process.exit(1);
  }
}

// Run async main function
main().catch((error) => {
  console.error('Startup check failed:', error);
  process.exit(1);
});
