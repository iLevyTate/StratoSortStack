# FFmpeg LGPL Runtime — Attribution and Source Offer

StratoSort Core ships an LGPL-3.0-or-later build of FFmpeg in this directory and invokes it
exclusively via `child_process.spawn()` (no static or dynamic linking into the application).
Because StratoSort does not link against libavcodec/libavformat/etc., the LGPL "user must be
able to relink" obligation does not apply, and only the standard LGPL attribution and
source-availability obligations remain. Those are addressed below.

## Components

- **FFmpeg** (https://ffmpeg.org/) — multimedia framework.
- License: GNU Lesser General Public License version 3 or later (LGPL-3.0-or-later).
- Full LGPL-3.0 license text: https://www.gnu.org/licenses/lgpl-3.0.txt
- A copy of LGPL-3.0 is also included in the `node_modules/` tree of bundled npm packages that
  carry it (e.g., `sharp` / libvips), and in StratoSort's `docs/THIRD_PARTY_NOTICES.md` shipped
  alongside the installer.

## Build Provenance

| Platform        | Build Source                                                                                |
|-----------------|----------------------------------------------------------------------------------------------|
| Windows x64     | `BtbN/FFmpeg-Builds` GitHub releases — `master-latest-win64-lgpl.zip` (LGPL configuration)  |
| Windows arm64   | Not bundled (no upstream LGPL win-arm64 build); the app falls back to a system `ffmpeg` on `PATH` |
| macOS           | StratoSort self-hosted GitHub Actions workflow `.github/workflows/build-ffmpeg-lgpl.yml` building from upstream FFmpeg sources with `--disable-gpl --disable-nonfree` (LGPL-only) |
| Linux x64/arm64 | `BtbN/FFmpeg-Builds` GitHub releases — `master-latest-{linux64,linuxarm64}-lgpl.tar.xz` (LGPL configuration) |

The exact build identifier (release tag and commit SHA) for the FFmpeg copy bundled with this
installer is recorded in `assets/runtime/ffmpeg/ffmpeg-runtime.json` next to this file, written
by `scripts/setup-ffmpeg-runtime.js` at package time.

## Source Code Availability

The complete corresponding source code for the FFmpeg version bundled here is available from
the upstream project at https://ffmpeg.org/download.html and from the build sources listed
above:

- Windows / Linux: https://github.com/BtbN/FFmpeg-Builds (the BtbN build scripts and source
            mirror for the LGPL binaries bundled on those platforms)
- macOS:   https://github.com/iLevyTate/StratoSortCore/releases — the release that holds the
            self-hosted LGPL binaries also carries `ffmpeg-<version>-source.tar.xz`, the
            exact upstream source tarball those binaries were built from

If you cannot retrieve the source via the above, you may request a copy by writing to the
contact address listed in the repository's `LICENSE` and `package.json` metadata. We will
provide the complete corresponding source code on a physical medium customarily used for
software interchange, for a charge no more than our cost of physically performing the
distribution, in accordance with LGPL-3.0 §6.

## No Modifications

StratoSort distributes unmodified upstream FFmpeg binaries. We do not patch FFmpeg sources. If
that ever changes, modified sources will be published in the same release artifact alongside
the binary.

## Trademark Notice

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
