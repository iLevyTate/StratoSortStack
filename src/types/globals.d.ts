// Ambient globals shared across the renderer bootstrap path (polyfills,
// splash, error capture, HMR guards) and the webpack magic public-path
// variable. These live on `window` (or `globalThis`) because the boot code
// runs before React and needs to communicate through the global object.
//
// Everything is optional so consumers still have to feature-check before
// calling — the bootstrap sequence sets them in a specific order.

declare global {
  interface Window {
    __STRATOSORT_BOOT_ERRORS?: any[];
    __STRATOSORT_BOOT_ERRORS_DROPPED?: number;
    __STRATOSORT_BOOT_CAPTURE_ACTIVE?: boolean;
    __STRATOSORT_CANCEL_SPLASH_TIMEOUT?: () => void;
    __STRATOSORT_TEARDOWN_BOOT_LISTENERS?: () => void;
    __STRATOSORT_SHUTTING_DOWN__?: boolean;
    __STRATOSORT_SPLASH_AT?: number;
    __STRATOSORT_RENDERER_BOOTSTRAP_DISPATCH__?: boolean;
    __STRATOSORT_RENDERER_HYDRATE_ONCE__?: boolean;
    __STRATOSORT_REACT_ROOT__?: any;
  }

  // Injected by webpack at bundle-init time. Assigning to it changes the
  // runtime public path for async chunk loads (see polyfills.js for the
  // http-origin fixup that runs when the main process serves dist/ over
  // http://127.0.0.1:<random>/).
  // eslint-disable-next-line no-var
  var __webpack_public_path__: string;

  // Injected by webpack DefinePlugin at build time (release date of this
  // build). Guarded by `typeof X !== 'undefined'` at each usage site because
  // dev/test bundles may not define it.
  // eslint-disable-next-line no-var
  var __STRATOSORT_BUILD_DATE__: string;

  // Webpack HMR extends Node's Module type at bundle time (see webpack-env
  // types). We don't pull @types/webpack-env in, so declare the minimum
  // surface the bootstrap actually uses.
  namespace NodeJS {
    interface Module {
      hot?: {
        accept(dependencies?: string | string[], callback?: () => void): void;
        dispose(callback: (data: any) => void): void;
      };
    }
  }
}

export {};
