# StratoSort Application Icons

Platform-specific application icons for packaging. All raster sizes are generated from the master SVG.

## Source logo

**`StratoSortStackLogo.svg`** — edit this file, then regenerate:

```bash
npm run generate:icons
# or
npm run generate:assets
```

Legacy PNG fallbacks (`assets/stratosort-logo.png`, `StratoSortNewLogo.png`) are still recognized if the SVG is absent.

## Generated outputs

| Platform | Path |
|----------|------|
| Windows | `win/icon.ico` |
| macOS | `mac/icon.png` (committed); `mac/icon.icns` is generated from `mac/icon.iconset` at build time |
| Linux / general | `png/` (16–1024 px) |
| Web / favicon | `favicon/` |
| Installer (NSIS/DMG) | `assets/installer/` |

Run `npm run generate:icons` on demand or let CI regenerate when the SVG is present.
