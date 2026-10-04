# Application update host (Phase B)

When you are ready to turn **automatic application updates** back on, provide the following so the
team can wire [electron-updater](https://www.electron.build/auto-update) correctly.

## What to decide

1. **Host type**
   - **Generic HTTPS** — You host `latest.yml`, installers, and `.blockmap` files at a stable base
     URL (recommended if the GitHub repo stays private or you use a CDN).
   - **Public GitHub Releases** — Repository is **public** (or a public fork) so unauthenticated
     clients can read release assets; keep `publish` in `electron-builder.json` aligned with that
     repo.

2. **Base URL (generic)** — The directory URL that contains `latest.yml` for Windows, for example:  
   `https://downloads.example.com/stratosort/win/`  
   Trailing slash is normalized at runtime.

3. **Layout** — Same filenames as `release/build` after `npm run dist:win` (see
   `verify-updater-metadata.js`).

## Runtime configuration (implemented)

| Variable                               | Purpose                                                                                                                                          |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_ENABLE_AUTO_UPDATES`       | Set to `true` to enable the updater in production builds. Default is off until a feed is ready.                                                  |
| `STRATOSORT_UPDATE_FEED_URL`           | Optional. When set (and auto-updates enabled), sets a **generic** feed so the app does not rely on GitHub `app-update.yml`.                      |
| `STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS` | Required when using a custom `STRATOSORT_UPDATE_FEED_URL` in a **packaged** build: a comma-separated allowlist of hosts the updater may contact. |

## Build-time option (future)

You can also configure `electron-builder` `publish` with `provider: generic` and `url` so
`app-update.yml` inside the package points at your CDN; see electron-builder docs. Runtime
`STRATOSORT_UPDATE_FEED_URL` overrides the feed without rebuilding.

## Not in scope here

- **AI model** downloads (Hugging Face, etc.) are separate from app auto-update.
- **Portable** `.exe` builds do not participate in the NSIS auto-update channel the same way as the
  full installer.
