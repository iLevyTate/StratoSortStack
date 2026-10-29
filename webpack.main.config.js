const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const { MAIN_BUNDLE_MARKER } = require('./scripts/mainBundleMarker');

const commonConfig = (isProduction) => ({
  mode: isProduction ? 'production' : 'development',
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            // Build against the Electron-bundled Node, not the host Node.
            // `node: 'current'` was compiling main/preload using whatever
            // Node happened to run webpack - on newer engines that can
            // emit syntax Electron's bundled V8 may not support in older
            // minor versions. Pin to the Electron major we ship.
            presets: [['@babel/preset-env', { targets: { electron: '45.0' } }]]
          }
        }
      }
    ]
  },
  resolve: {
    // `.mjs` / `.cjs` are explicitly listed so webpack resolves ESM-only
    // dependencies (which increasingly ship without a plain `.js` entry)
    // without requiring every import site to spell the extension out.
    extensions: ['.js', '.mjs', '.cjs', '.json']
  },
  optimization: {
    minimize: isProduction,
    minimizer: [
      new TerserPlugin({
        parallel: true,
        extractComments: false,
        terserOptions: {
          // Preserve `Error.prototype.name` / class identifiers so that our
          // runtime error classifier (which switches on `err.name` /
          // `err.constructor.name` — e.g. `LlamaLoadError`, `AbortError`,
          // `DegradedStateError`) keeps working in the minified production
          // bundle. Without these flags Terser rewrites class names to
          // single letters and the classifier silently falls through to
          // "unknown error".
          keep_classnames: /Error$|Exception$/,
          keep_fnames: /Error$|Exception$/,
          compress: {
            pure_funcs: ['console.log', 'console.debug']
          }
        }
      })
    ]
  },
  devtool: isProduction ? false : 'source-map'
});

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';
  const common = commonConfig(isProduction);

  const mainConfig = {
    ...common,
    entry: {
      main: './src/main/simple-main.js',
      ocrWorker: './src/main/workers/ocrWorker.js',
      embeddingWorker: './src/main/workers/embeddingWorker.js',
      logExportWorker: './src/main/workers/logExportWorker.js',
      textExtractionWorker: './src/main/workers/textExtractionWorker.js',
      imagePreprocessWorker: './src/main/workers/imagePreprocessWorker.js',
      umapProjectionWorker: './src/main/workers/umapProjectionWorker.js',
      settingsImportParserWorker: './src/main/workers/settingsImportParserWorker.js'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      libraryTarget: 'commonjs2'
    },
    target: 'electron-main',
    node: {
      __dirname: false,
      __filename: false
    },
    externals: [
      {
        electron: 'commonjs electron',
        sharp: 'commonjs sharp',
        '@napi-rs/canvas': 'commonjs @napi-rs/canvas',
        'electron-updater': 'commonjs electron-updater',
        'better-sqlite3': 'commonjs better-sqlite3',
        'lz4-napi': 'commonjs lz4-napi',
        'tesseract.js': 'commonjs tesseract.js',
        'tesseract.js-core': 'commonjs tesseract.js-core',
        // Pino uses thread-stream which spawns Worker threads via __dirname-relative
        // paths. Bundling breaks __dirname resolution, so keep pino ecosystem external.
        pino: 'commonjs pino',
        'pino-pretty': 'commonjs pino-pretty',
        // Dev-only devDependencies. Externalizing keeps them out of dist/main.js
        // so a packaged build cannot load a `.env` (simple-main.js guards the
        // call on app.isPackaged) or ship the DevTools installer.
        dotenv: 'commonjs dotenv',
        'electron-devtools-installer': 'commonjs electron-devtools-installer',
        // Piscina spawns its internal bootstrap worker via resolve(__dirname, 'worker.js').
        // Bundling moves __dirname to dist/ where piscina's worker.js doesn't exist.
        piscina: 'commonjs piscina',
        // unpdf bundles pdf.js which contains dynamic import() expressions that
        // webpack cannot statically analyze. Runs fine as a runtime require in
        // the Node.js main process.
        unpdf: 'commonjs unpdf',
        // pdfjs-dist is only loaded via dynamic import() behind the
        // STRATOSORT_USE_OFFICIAL_PDFJS opt-in (see documentExtractors.js).
        // The legacy/build/pdf.mjs entry uses worker/eval patterns that
        // webpack cannot safely bundle; keep it external so the require is
        // resolved by Node at runtime. Without this, webpack emits huge
        // wasm/worker chunks that can also trigger ESM/CJS interop errors.
        'pdfjs-dist': 'commonjs pdfjs-dist',
        'pdfjs-dist/legacy/build/pdf.mjs': 'commonjs pdfjs-dist/legacy/build/pdf.mjs',
        // officeparser depends on file-type ^21 (via overrides); file-type is ESM-only
        // and its package.json exports omit webpack's require condition. Keep external
        // so Node/Electron resolves it at runtime like plain `node -e "require('officeparser')"`.
        officeparser: 'commonjs officeparser',
        // Chokidar v5 is ESM-only ("type": "module"). Bundling it causes
        // ERR_REQUIRE_ESM at runtime. Keep external for runtime resolution.
        chokidar: 'commonjs chokidar',
        // @fugood/whisper.node is a native N-API addon (whisper.cpp bindings).
        // Native addons must stay external so Electron's require() loads the
        // platform-specific .node binary from node_modules at runtime.
        '@fugood/whisper.node': 'commonjs @fugood/whisper.node'
      },
      ({ request }, callback) => {
        if (!request) return callback();

        if (
          request === 'node-llama-cpp' ||
          request.startsWith('@node-llama-cpp/') ||
          request === '@reflink/reflink' ||
          request.startsWith('@reflink/')
        ) {
          return callback(null, `commonjs ${request}`);
        }

        // Whisper variant packages (@fugood/node-whisper-<platform>-<arch>[-<gpu>]).
        // The actual fix for the webpack-erasure bug lives in
        // WhisperService.loadNativeWhisperModule (uses __non_webpack_require__ so the
        // runtime-computed specifier never reaches webpack). This entry is
        // defense in depth: if a future code path adds a STATIC require like
        // `require('@fugood/node-whisper-win32-x64')`, webpack would try to bundle
        // a .node native binary and fail. Externalizing the whole namespace here
        // means a static require degrades cleanly to a runtime resolution.
        if (request.startsWith('@fugood/node-whisper-')) {
          return callback(null, `commonjs ${request}`);
        }

        if (request.endsWith('.node')) {
          return callback(null, `commonjs ${request}`);
        }

        return callback();
      }
    ],
    plugins: [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
        // License maintenance-window gating (LicenseService): packaged builds
        // carry the date they were BUILT, compared against a key's
        // maintenanceUntil — the runtime clock never expires a license. Every
        // dist:* script runs `npm run build` immediately before
        // electron-builder, so this equals the release date in packaged apps.
        __STRATOSORT_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
      }),
      // Stamp `dist/main.js` with a deterministic banner so the post-build
      // verifier in `scripts/copy-assets-to-dist.js` can confirm the renderer
      // build did not clobber the Electron main-process bundle. `include`
      // scopes the banner to the `main` chunk only — worker bundles
      // (ocrWorker, embeddingWorker, …) do not need it. The leading `/*!`
      // marks this as a "bang" comment, which Terser preserves by default
      // (`format.comments: 'some'`) when the bundle is minified for release.
      new webpack.BannerPlugin({
        banner: MAIN_BUNDLE_MARKER,
        raw: false,
        entryOnly: true,
        include: /^main\.js$/
      })
    ]
  };

  const preloadConfig = {
    ...common,
    entry: {
      preload: './src/preload/preload.js'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: false
    },
    // Sandboxed preload: only require('electron') is available at runtime.
    // Using 'web' target ensures webpack bundles Node builtins via polyfills
    // instead of externalizing them — Electron's sandbox loader crashes on any
    // external require('os'|'fs'|'path') before try/catch can run.
    target: 'web',
    resolve: {
      ...common.resolve,
      alias: {
        ...common.resolve?.alias,
        // Map both bare and node:-prefixed specifiers to browser polyfills
        os: require.resolve('os-browserify/browser'),
        'node:os': require.resolve('os-browserify/browser'),
        path: require.resolve('path-browserify'),
        'node:path': require.resolve('path-browserify'),
        process: require.resolve('process/browser'),
        'node:process': require.resolve('process/browser')
      },
      fallback: {
        ...common.resolve?.fallback,
        path: require.resolve('path-browserify'),
        fs: false,
        os: require.resolve('os-browserify/browser'),
        process: require.resolve('process/browser'),
        stream: false,
        util: false,
        buffer: require.resolve('buffer'),
        crypto: false
      }
    },
    externals: {
      // Only electron is available via require() in sandbox preload
      electron: 'commonjs electron'
    },
    plugins: [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development')
      }),
      new webpack.ProvidePlugin({
        process: require.resolve('process/browser'),
        Buffer: ['buffer', 'Buffer']
      }),
      new webpack.IgnorePlugin({
        resourceRegExp: /^(async_hooks|crypto)$/
      }),
      // securityConfigPathLimits uses child_process (reg query); preload target
      // is `web` and cannot resolve Node builtins. Swap in a stub at bundle time.
      new webpack.NormalModuleReplacementPlugin(
        /securityConfigPathLimits\.js$/,
        path.resolve(__dirname, 'src/shared/securityConfigPathLimits.preload-stub.js')
      )
    ]
  };

  return [mainConfig, preloadConfig];
};
