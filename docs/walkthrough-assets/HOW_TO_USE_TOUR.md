# How-to-use tour (recorded from the app)

The watchable clips are a real Electron session with a moving pointer — not a Ken Burns slideshow.

**Guided tour (~43 s):** [how-to-use.mp4](./how-to-use.mp4) (live mouse, 1920×1080)

**YouTube Short (~43 s):** [shorts/stratosort-short.mp4](./shorts/stratosort-short.mp4) (live mouse,
1080×1920, whole UI centered over a blurred fill)

**Stills:** [E2E Walkthrough](../E2E_WALKTHROUGH.md) (`docs/assets/e2e-screenshots/`)

**Lessons** (16:9, same live-pointer edit):

- [lessons/search.mp4](./lessons/search.mp4) — semantic search and a cited chat answer
- [lessons/graph.mp4](./lessons/graph.mp4) — Relate: zoom and open a connection
- [lessons/connect.mp4](./lessons/connect.mp4) — Advanced settings, an optional cloud key, MCP
- [lessons/models-and-names.mp4](./lessons/models-and-names.mp4) — choose a local model, then a
  filename pattern

```bash
npm run tour:record:library   # one analysis, then search + graph
npm run tour:record:studio    # settings, models, naming; no file analysis
npm run tour:compose:lessons
```

The cloud-key beat shows the consent copy and an empty key field, then cancels. The MCP token stays
masked. Model menus are opened and closed without switching the loaded text model or starting a
download.

## Regenerate

```bash
npm run tour:record   # headless by default; does not take the display
npm run tour:compose  # --short | --howto to build one; --offset=N to fix clock skew (see below)
```

Watch it live (the window stays up through analysis):

```bash
npx cross-env STRATOSORT_TOUR_HEADED=1 node scripts/record-product-tour.js
npm run tour:compose
```

`tour:record` rebuilds `dist/` when `src/` is newer, launches an isolated profile, junctions your
already-downloaded models, copies six demo files (Finance, Research, Nature) into a temp inbox, and
walks the product the way a first-time viewer should see it. The profile is empty apart from those
six files, so Welcome has no leftover toasts, Knowledge OS counts six, and search cannot surface
files from an older library. It runs inference on the GPU (the shared e2e launcher's CPU-only
override is lifted), so a full take is eight to ten minutes, most of it the analysis wait that the
edit time-lapses. Path redaction stays off: the demo names are the point, and the Complete shot is
framed on the "6 files" line so the temp destination list stays out of frame.

Atlas is not in this cut. The six-file library draws the small-map fallback, and a WebGPU miss
draws a blank panel. Record that shot on its own, with `STRATOSORT_TOUR_ATLAS=1`, only on a machine
where WebGPU works and the library already has a few hundred files. Otherwise the tour ends on
Relate.

## The story

Both cuts use the same scenes. The how-to opens on Welcome; the end card is held long enough to read.

1. Welcome — the four-step story, then Setup
2. Add Smart Folders — Finance, Research, and Nature, each with its description
3. Drop in your files — the empty drop zone, then the files, and the counter fills to 5 of 6
   (the app leaves Discover for review before a held 6 of 6)
4. Review what the AI found — type one new name and change one category
5. Move everything in one click — Organize is pressed on camera, then the "6 files" summary
6. Search by meaning — "how warming affects wildlife" → results
7. Chat with your documents — "Summarize the arctic sea ice report…" → cited answer
8. See how files connect — zoom into the graph and open Why connected

The end card follows. Atlas is a separate shot. See above.

## How the edit is built (`scripts/compose-walkthrough-media.js`)

- **Scenes.** Each step is a scene. Cuts inside a step are hard, and the how-to cuts hard
  between steps so two screens never sit on top of each other. The step title sits in a bar under
  the picture. Only the end card dissolves in.
- **Camera.** Cuts carry `cam` keyframes resolved into an ffmpeg `zoompan`. The tour shows the UI
  1.33× larger already, so it uses 75 % of each push. The move progress and Complete push in so
  the temp destination list stays below the frame. Every other step is the full window.
- **Time-lapse.** `speed` (or a `from`/`until` window) compresses typing, the analysis wait and the
  move so nothing sits still; `speed` is derived when both anchors are given.
- **Clock alignment.** Every recorded mark is the moment of its click. Playwright's video starts a
  couple of seconds after the recorder's clock, so the recorder writes the measured `videoOffset`
  into `tour-raw/actions.json` from its clapperboard flash. If the flash is not found, measure one
  click by eye (e.g. a frame grid around the setup-add mark) and pass `--offset=2.45`.
- **No spinners.** Beats that never pay off on screen are marked `ok: false`; compose leaves them
  out along with their lead-in (`requires`) instead of cutting in a "Searching…".
- Captions need a TrueType font; the defaults are Segoe UI / Arial / DejaVu. Override with
  `STRATOSORT_TOUR_FONT_BOLD` and `STRATOSORT_TOUR_FONT`.

Paths on the Complete screen are cropped out of the shot. Demo files are copies, so the repo set
is not moved. Local PNG dumps under `tour/` and `tour-raw/` are capture artifacts (gitignored),
not the published stills. A new take moves every mark, so voiceover and music need retiming
against that cut.

## Voiceover

Install StratoSort, skip the cloud, and keep everything on this machine. Describe where work should
land. Drop messy files in. The local model reads what is inside, not the filename. You approve the
move. Then search it, map it, and ask it questions — all on that same private index.

## Title

How to organize files with StratoSort
