# How-to-use tour (recorded from the app)

The watchable clips are a real Electron session with a moving pointer — not a Ken Burns slideshow.

**Guided tour (~55 s):** [how-to-use.mp4](./how-to-use.mp4) (live mouse, 1920×1080)

**YouTube Short (~45 s):** [shorts/stratosort-short.mp4](./shorts/stratosort-short.mp4) (live mouse,
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
npx cross-env STRATOSORT_TOUR_HEADED=1 STRATOSORT_REDACT_PATHS=1 node scripts/record-product-tour.js
npm run tour:compose
```

`tour:record` rebuilds `dist/` when `src/` is newer, launches an isolated profile, junctions your
already-downloaded models, copies six demo files (Finance, Research, Nature) into a temp inbox, and
walks the product the way a first-time viewer should see it. It runs inference on the GPU (the
shared e2e launcher's CPU-only override is lifted), so a full take is eight to ten minutes, most of
it the analysis wait that the edit time-lapses.

## The story

Both cuts are the same eight steps; the Short skips the Welcome orientation.

1. Add Smart Folders — type Finance and Nature destinations
2. Drop in your files — six files land, analysis runs as a time-lapse
3. Review what the AI found — open one file's details and scroll them
4. Move everything in one click — the move runs at 3×, then Organization Complete
5. Search by meaning — "how warming affects wildlife" → results
6. Chat with your documents — "Summarize the arctic sea ice report…" → cited answer
7. See how files connect — zoom in, zoom out, click two nodes
8. Map your whole library — Atlas overview, then the brand outro

## How the edit is built (`scripts/compose-walkthrough-media.js`)

- **Scenes.** Each step is a scene: hard cuts inside it, a 0.35 s crossfade between scenes, a
  numbered caption per scene (in the letterbox on the Short, a lower-third pill on the tour).
- **Camera.** Cuts carry `cam` keyframes — eased push-ins on the modal, the details panel, the
  answer bubble — resolved into an ffmpeg `zoompan` so the phone-sized frame stays readable. The
  tour shows the UI 1.33× larger already, so it uses 75 % of each push.
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

Paths are redacted. Demo files are copies, so the repo set is not moved. Local PNG dumps under
`tour/` and `tour-raw/` are capture artifacts (gitignored), not the published stills.

## Voiceover

Install StratoSort, skip the cloud, and keep everything on this machine. Describe where work should
land. Drop messy files in. The local model reads what is inside, not the filename. You approve the
move. Then search it, map it, and ask it questions — all on that same private index.

## Title

How to organize files with StratoSort
