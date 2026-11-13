# Changelog

<p align="center">
  <img src="https://img.shields.io/badge/format-Keep%20a%20Changelog-E05735?style=flat-square" alt="Keep a Changelog" />
  <img src="https://img.shields.io/badge/versioning-SemVer-3F4551?style=flat-square" alt="Semantic Versioning" />
</p>

All notable changes to StratoSort Stack will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Two identical files in one folder are no longer both sent to the trash when one run renames or
  moves them.** Each was taken for a copy of the other that was already in place, so both were
  removed instead of moved, and the run could then fail and be undone with the two files missing
  from the folder. A file the same run has still to move no longer counts as a copy already in
  place, and renaming a file inside its own folder never removes it. A file removed this way went to
  the system trash.
- **An organize run that did not move everything says so and stays on the Organize screen.** A
  banner above the file list says how many files moved, how many did not and why, or that the whole
  run was undone and the files are back where they were. Before, a run that failed part-way or was
  undone could move on to the Complete screen as if it had worked. An identical copy that was
  removed instead of moved is listed as a duplicate, with the copy that was kept, and is no longer
  counted as a moved file.
- **One file that cannot be confirmed after its move no longer undoes the whole run.** After each
  move the app checks that the file is at its destination and gone from its source. A file that
  failed this check stopped the run and sent every file already moved back. It is now listed as not
  moved, with whether it is still at its original location, and the other files stay moved. Three
  such failures in a row, with no confirmed move between them, still undo the run.
- **A move to another drive that loses its temporary copy no longer says the original was not
  found.** Such a move copies the file to a temporary name in the destination folder and renames it
  into place. When another program removed or held that copy, the failure read "File not found" with
  the path of the original, which was still there. It now names the destination folder, says the
  temporary copy was removed or could not be read or renamed, and says the original was not moved.
  Three of these in a row, with no confirmed move between them, undo the run, as failed move checks
  do.
- **Files that are already in the folder chosen for them are pointed out before the run.** When a
  folder you sort from is also one of your Smart Folders, files matched to it stay where they are
  (or are renamed there). A notice on the Organize screen and a mark in Preview now say which, so a
  run no longer reports files as organized while nothing appears anywhere new.
- **A folder on an external or second drive can be a Smart Folder, can be scanned and can have
  folders created in it.** These were refused for any folder outside your user folder, with a
  message about a link or short name. Folders inside system folders, or reached through a link that
  leads into one, are still refused. A folder that is not inside a Smart Folder or Documents and was
  not picked in a file dialog is confirmed once in a prompt.
- **A folder the app will not scan, or cannot read, gives the reason.** Choosing or dropping such a
  folder on the Discover screen said that no files were found.
- **An image that arrives just as a text model starts loading no longer starts the vision runtime
  beside it.** The image looked for a loading model before the load began and found none. The vision
  runtime now checks the memory budget again at the moment it starts; if a load began meanwhile, the
  image waits for it, makes room and is sent once more. Such a refusal does not count toward turning
  vision off.
- **An embedding model put on the CPU beside a text model returns to the GPU when there is room.**
  After a text-model load that failed, or once the text model was unloaded, it stayed on the CPU
  until some other load replaced it.
- **A text model larger than the memory budget no longer unloads models that hold no GPU memory.**
  An embedding model on the CPU and Whisper on the CPU were unloaded to make room, which freed
  nothing, and were loaded again for the next file.
- **A short category is no longer taken for a misspelling of a short Smart Folder name.** Any name
  within two letters of a folder's name counted as that folder, so a file labeled "SEO" could be
  sent to a folder named "Web" or "Dev". The allowance now grows with the length of the name: none
  under four letters, one letter per four, three at most.
- **A file with a generic category ("document", "file", "image") is no longer sent to the first
  Smart Folder in the list when there is no Uncategorized folder.** It is left without a match, and
  the other suggestions decide.
- **A suggestion says what named its folder.** "Using Date-Based organization method" described a
  folder that was named after the file's category, its type or its purpose; the explanation now says
  which.
- **Editing a Smart Folder's description past its first 64 characters is used by the next
  analysis.** The saved answer for a file was looked up by the start of each description only, so a
  change further in returned the answer for the old wording.
- **Preview on the Organize screen says why when it cannot open.** A preview that failed or was
  refused said only "Nothing to preview."; it now gives the reason. The button shows that it is
  working, and pressing it twice no longer asks for two previews.
- **Preview marks files that would get the same name in the same folder.** A move with such files
  does not start; Preview now shows which files they are and keeps its Move button off until they
  have different names.
- **Analysis progress shows one figure for files and one for percent.** It read "Analyzing 3 of 10"
  with the percentage twice; it now reads "Analyzing 3 of 10 files" and "30% complete".
- **An analysis that continues after a restart says so.** The notice now reads "Continuing the
  analysis that was interrupted" with the number of files left, and stays up for six seconds.
- **Model download speed and time left follow the current speed.** They were averaged from the start
  of the download and shown after the first second, so the first figures could be far off and a
  change in speed took a long time to show. The speed is now measured over the last ten seconds and
  shown once three seconds of data have arrived; until then the row reads "Calculating speed…".

### Documentation

- **The Install Guide, the README and each release's notes say which Mac file to download:**
  `mac-arm64` for Apple Silicon, `mac-x64` for Intel, and how to check in About This Mac.

## [5.2.0] - 2026-11-10

Cloud analysis now covers audio and video, and video frames are sent only with your consent and the
"Describe video keyframes" setting. When the disk fills up, the app says so and stops analyzing
until it can save again. Exact duplicates are found without a manual step, and Find Duplicates can
keep a whole set. A batch of images no longer restarts the vision model for every image, and much
less is rewritten to disk while a batch runs. A new Live Activity panel shows what the app is doing
as it happens, and in most cases (see Known issues) log lines no longer leave a second file path, or
a macOS or Linux folder with a space in its name, in the clear. Contributors now need Node 24.

Changes you will notice:

- If you use a cloud provider, you are asked to accept the updated consent text once (see Privacy).
  Until you do, no video frame is sent.
- Video frames are extracted and sent only with **Describe video keyframes** on.
- A full disk shows a banner, and the smart-folder and Downloads watchers wait until it can save.
- Files added to smart folders while the app was closed start analyzing about 2 minutes after
  launch, 25 at a time, instead of all at once.
- The first launch after updating may re-embed files whose search vectors were missing, so expect
  some embedding activity shortly after startup (capped per launch).
- Building from source needs Node 24 (`.nvmrc` 24.22.1). The installed app is unaffected; it already
  ran on the Node inside Electron.

### Known issues

- **Hiding file names in the Live Activity panel is best effort.** With paths hidden for demos
  (`STRATOSORT_REDACT_PATHS=1`), the panel also hides some words that only look like file names,
  such as `simple-main.js`, and web domains. It can show the part of a file name before its last
  space. A name inside a web link, or one ending in `.com`, `.co` or `.io`, can still show. The name
  of the part of the app that wrote a line (the context column) is never hidden.
- **Some macOS and Linux folder names can still reach the log.** A path that starts somewhere other
  than the usual places for files (for example `/data/My Files/x.pdf`) is still cleaned up only to
  its first space, so the folders after it can appear. A folder name with two spaces in a row, or
  with `"`, `:`, `;`, `=` and some other punctuation after a space (see `docs/DEBUGGING_GUIDE.md`),
  also ends the cleanup early. The file name is kept on purpose; when it contains a space, only the
  part before the space is marked as the name. A word that looks like a file name ends the path, so
  `Moved /Users/a/x.pdf to Finance/Taxes` keeps "x.pdf to Finance/Taxes" readable, but a folder
  whose name has such a word before a space (`notes.txt and more`) shows from that word on.

### Privacy

- **Video frames can go to the cloud Analysis provider.** With a cloud provider for Analysis and
  **Describe video keyframes** (`captionVideoKeyframes`) on, video analysis sends up to four frames
  with the transcript. With the setting off, no frames are extracted or sent anywhere. Frames go to
  a cloud provider only under the current consent (version 2), which the main process checks before
  every upload; without it, the local model describes the frames and only text is sent. The pixels
  of still images stay local.
- **Updated consent, asked once.** The consent dialog now says that video frames are sent with
  keyframes on, and that text read from images and saved descriptions can travel with chat and
  suggestions. Accepting stores the consent version; consent given before counts as version 1, which
  still covers text work but never frames. Existing users see the new text the next time they pick a
  cloud provider, change a cloud provider's settings, or turn on keyframes while Analysis uses a
  cloud provider.
- Settings routing text, the keyframe switch, About and Diagnostics say what each operation sends.
  `PRIVACY.md` and `docs/AI_PROVIDERS.md` (new "Video frames" and "Consent versions" sections) are
  updated to match.
- **Log lines hide every Windows folder path.** The logger already cut a Windows path down to its
  file name, but only the first one in a line: in `move C:\Users\…\a.pdf to D:\Archive\…\a.pdf` the
  second path was written in full. Every Windows path in a line is now reduced to its file name:
  drive-letter paths (also written with forward slashes, `C:/Users/…`), network paths
  (`\\server\share\…`) and paths escaped inside JSON text.
- **Log lines hide macOS and Linux folders whose names contain spaces.** A macOS or Linux path used
  to be cleaned up only to its first space, so in
  `/Users/me/Library/Mobile Documents/…/Medical Records/scan.pdf` the folders after the space were
  written in full. In most cases (see Known issues), a path that starts in a usual place for files
  (`/Users`, `/home`, `/Volumes`, `/media`, `/mnt`, `/tmp`, `~/` and similar) is now reduced to its
  file name even when its folders have spaces, and two paths in one line stay apart. That includes
  the app's own lower-case file ids on macOS (`file:/users/…`). Both changes apply to the log files
  and to the new Live Activity panel.

### Added

- **The Windows installer installs the Microsoft Visual C++ Redistributable when it is missing.**
  Windows packages now carry Microsoft's own, unmodified and Microsoft-signed redistributable (v14,
  x64 or ARM64 to match the build). On a PC without it, such as a fresh Windows install, the
  installer runs it; Windows asks once for administrator permission because the runtime is installed
  for the whole PC, while StratoSort itself still installs per user. Auto-updates never run it. If
  you decline or it fails, the installer offers Microsoft's download page as before. In the app, the
  "Local AI needs the Microsoft Visual C++ Redistributable" banner now has **Install now** (runs the
  bundled installer after checking its Microsoft signature, then offers **Restart StratoSort**) next
  to **Open download page**, which also covers the Windows zip build. The file is fetched from
  Microsoft at build time only; the app downloads nothing for it. Business or commercially licensed
  builds must confirm Visual Studio redistribution licensing before shipping it
  (`docs/COMMERCIAL_COMPLIANCE.md`).
- **Cloud analysis for audio and video.** Audio and video can use the cloud Analysis provider.
  Speech is still transcribed on the machine (Whisper) and the transcript is sent; video frames
  follow the Privacy rules above. Still photos stay on the local vision model. If the cloud call
  fails on budget, rate limit, network or authentication, the file goes through the local text
  route. Cancelling a video stops the cloud request. Cloud video results get the same folder
  matching, name cleanup and extension restore as the transcript route, and repeats come from the
  analysis cache. A category that matches no folder now comes back empty, or as the Uncategorized
  folder if you have one, the same as documents.
- **Storage-full banner and hold.** When the disk is too full for the search index or the analysis
  history to save (`ENOSPC`, `EDQUOT` or SQLite's `SQLITE_FULL`), a banner names the store that
  cannot save. While it is up, the smart-folder watcher holds its queue and the Downloads watcher
  holds new downloads, checking again every minute, and the watcher status line reads "paused, disk
  full · N files waiting". The search index retries its save once a minute, and work resumes on its
  own once every store can save. Dismissing the banner hides it but does not lift the hold. Held
  downloads are kept in memory only, so quitting while the disk is full drops them.
- **Keep all in Find Duplicates.** Each set has a **Keep all** button that leaves every file alone
  and stops listing the set. The choice is remembered; if a new copy appears, the set is listed
  again. **Show N kept** → **Restore** brings sets back. Kept sets show no Keep/Delete badges and
  are left out of the graph's duplicate badge.
- **Automatic file fingerprints.** Every file's search entry now stores a fingerprint (SHA-256) of
  its contents, so **Exact duplicates** and Downloads triage's "already in a smart folder" check
  work without running Settings → **Reindex file hashes**. That action is now only a backfill for
  files indexed by an older version.
- **Live Activity panel.** Settings → Diagnostics → **Show live activity** (Advanced) or
  Ctrl+Shift+L (Cmd+Shift+L on macOS, in any mode) opens a small floating panel that shows what the
  app is doing as it happens. **Activity** says it in plain words ("Analyzing receipt.jpg", "Vision
  model ready", "Filed invoice.pdf", "Saved search index"); **Raw** shows the log lines, with a
  minimum-level filter, a context filter and a details box for the selected line. Drag it by its
  title bar, resize it from the corner, move or resize it with the arrow keys, minimize it to a pill
  that pulses when new lines arrive, and pause, copy or clear it. Its position, size and tab are
  remembered on this computer. It shows the same cleaned-up lines the log file gets (Windows folder
  paths removed; see Privacy for macOS and Linux paths), and when paths are hidden for demos
  (`STRATOSORT_REDACT_PATHS=1`) it also shows file names as "a file", with the limits listed under
  Known issues. Off by default; nothing is collected for it while it is closed, and turning it on or
  off does not create a settings backup.

### Changed

- The star/sparkle icon is gone from every screen; each place now uses an icon for what it does
  (analysis, suggestion, description, embeddings, recommended model and so on).
- **StratoSort no longer registers itself as a viewer for PDF, Word, Excel, PowerPoint, text and
  Markdown files.** Opening a file that way did nothing, so the entry in "Open with" is gone.
  Existing installs drop it on the next install or update.
- **The vision model stays loaded across a batch of images.** On a GPU with little memory, it was
  shut down and restarted after every image to make room for the embedding model. During a vision
  batch the embedding model now runs on the CPU beside it (without raising the "running on CPU"
  badge), and moves back to the GPU after the batch.
- **Much less is rewritten to disk during analysis.**
  - Search index saves write only the collections that changed, refresh the `.bak` copy at most
    every 30 minutes, and are spaced by how long a save takes (5 s to 2 min). On a large library one
    save had been about 785 MB.
  - Each search index file now holds only the documents, which is all a restart reads back. The
    index structures Orama rebuilds on load, including a second copy of every embedding, were more
    than half of each file. Files written by earlier versions still load, and earlier versions can
    read the new files.
  - A write that landed during a save no longer starts a second save right after the first one.
  - Analysis history saves wait for 2 s of quiet and are at least 10 s apart, holding a change for
    at most about 10 s; quitting writes at once. A crash can lose at most those last seconds of
    entries.
  - The hash cache (`hash-cache.json`) saves 5 s after the last change, at most every 30 s, and is
    flushed on quit.
  - While analysis runs, the window's saved state (results, file states, selection) is written at
    most every 30 s instead of every 1 to 5 s.
- **Launch no longer stalls while the app catches up.**
  - Reading the search index back at startup is about six times faster. The check that keeps
    `__proto__` and `constructor` keys out of a loaded file had run once for every number in every
    embedding; it now runs once per object after a normal parse. On a 253 MB test index the read
    went from about 40 s to about 6 s.
  - Files added to a smart folder while the app was closed are picked up 2 minutes after launch, 25
    at a time, and the next 25 wait until the previous ones are analyzed. They had all been queued
    at once while the window was still opening. A file not reached before you quit is found again on
    the next launch. A folder you add while the app runs is still scanned at once.
  - The search service warms up only after the window is on screen. It had started on a 1 s timer,
    and the rest of startup's heavy work had been released as soon as the page loaded, which is
    before the window is shown.
- **Each analyzed file is indexed once.** The smart-folder and Downloads watchers no longer embed a
  document's passages or an image's vector a second time after analysis already queued them.
- **OCR after vision uses Tesseract only.** When Tesseract finds no text in an image that vision has
  just described, the app no longer makes a second, slow vision call. OCR before vision is
  unchanged.
- **Quieter in the background.** The graph's duplicate badge rescans only after the file count has
  settled for 5 s, and at most every 30 s; the duplicate scan caches its result and yields to the
  main process while it runs, so cancel and progress work. Startup repair checks only the files that
  need work on disk. Status polling pauses while the window is hidden, the Atlas rebuild poll backs
  off from 3 s to 1 min, the metrics push skips a minimized window, and the memory heartbeat logs
  only when memory use changes (at least every 5 min).
- **More in the log at the default level.** A search index save that wrote something
  (`Persisted databases`) and each file moved or skipped as a duplicate by Organize
  (`[FILE-OPS] Move completed`, `Move skipped (duplicate)`) are now logged at info in every build,
  so the Live Activity panel can show them. The move lines were only written in development builds
  before. The move lines hold only the file's name (no folders, on every platform), never file
  content.
- The keyword index used for naming context is rebuilt at most every 2 minutes during a batch,
  instead of before every file. Search keeps its own freshness check.
- **Organize** checks for duplicates on each move with the stored fingerprints instead of reading
  every same-size file; a match is confirmed with fresh reads before anything goes to the Trash.
- The related slider in Find Duplicates starts at 90%, the bottom of its range.
- The default Anthropic model is `claude-opus-5-5`. Older saved model ids still price correctly.
- **Contributors:** the toolchain runs on Node 24.22.1, the Node inside Electron 45.2 (`.nvmrc`,
  `engines` `>=24.11.0`, every workflow, `@types/node` 24). A new unmocked PDF test
  (`test/integration/pdfExtraction.unmocked.test.js`) runs the real extractor, which caught unpdf
  2.x failing on Node 20 while every mocked test passed. Dependabot no longer holds the
  better-sqlite3, `@testing-library/jest-dom` and cssnano majors.
- Dependencies: Electron 45.1.0 → 45.2.1, unpdf 1.9.1 → 2.1.0, pdfjs-dist 6.4.299 → 6.5.438,
  officeparser 8.3.0 → 8.5.0, `@napi-rs/canvas` 1.0.11 → 1.1.0 and postal-mime 4.1.4 → 4.2.0, plus
  minor updates to renderer libraries and build tooling.

### Fixed

- **A Discover run with a long recording is no longer cut off or started over.** The batch request
  ended after a fixed 30 minutes, and five minutes without a finished file was taken for a stuck
  analysis. Either way the rest of the run went one file at a time, where a recording gets five
  minutes and is then transcribed again from the start, and where Stop does not reach the work in
  progress. A run with audio or video now always goes through the batch, the batch keeps reporting
  while one long file is transcribed, and the run is bounded by its own checks (no progress, and at
  most six hours).
- **Stop leaves nothing behind.** After a cancel, a file that was in flight could still report
  progress, which put back counts that read as a paused analysis; a document that was mid-analysis
  was listed as failed; and an image whose vision request was cancelled was stored with a
  filename-only "Limited analysis" result. A cancelled batch now reports nothing more, and a
  cancelled file is neither failed nor recorded.
- **Leaving Discover during an analysis no longer says "Analysis cancelled by user".** The notice
  now appears only when you stop the run. A run left behind this way also no longer writes over the
  progress of the run a returning Discover started.
- **The Dashboard waits for a running analysis.** Switching to the Dashboard closed Discover, which
  stopped the run without saying so. The Dashboard toggle and **Back to dashboard** now explain that
  the dashboard opens when the analysis finishes; the way back to Guided stays open.
- **Progress from other work no longer shows as analysis progress.** Organize batches, model
  downloads and **Reanalyze all** report on the same channel as a Discover batch, and their counts
  were written into the analysis state: "Analysis continuing in background: 3/7 files" could be an
  organize batch, and a finished reanalysis could leave a paused analysis behind. Only a Discover
  analysis updates that state now, and another sender can no longer take over the running batch
  (after which its progress was dropped and Stop did nothing).
- **A file that finishes right after another appears without waiting for the next one.** The second
  result was held back until another file finished, which behind a long recording could be many
  minutes.
- **The completion notice counts every file of a run that waited for an earlier batch,** not only
  the files the run analyzed itself.
- **Dates follow your calendar day, not the UTC day.** A file saved in the evening west of Greenwich
  was named and dated for the next day, and a date written in a document or file name moved back a
  day east of it. Suggested names, the file date given to the model, dates the model reads from the
  content and the settings export file name now use the local day. A date-range search of the
  analysis history also no longer skips the first or last month of the range.
- **A recording longer than the transcription limit is recorded once instead of failing every
  time.** Each attempt decoded the audio up to the limit before failing, and the smart-folder
  watcher retried it. The file is now kept as "not transcribed", with the limit in its description.
- **Two models are no longer loaded onto a GPU that has room for one.** A model counted against the
  memory budget only once it had finished loading, and the vision runtime only once it had started
  (about a minute on a laptop GPU), so a text model and the vision runtime started moments apart
  both fit on paper. Memory now counts from the moment a load begins, a second caller for the same
  model shares the load, and background work does not start on memory that is spoken for.
- **An image being analyzed keeps the vision runtime.** The runtime could be shut down under an
  image in three ways: by its idle timer while another image was still running, by a text model
  taking its memory between its start and the request, and by a start that failed without reporting
  it (the app then polled a dead port until the startup timeout). Each left the image with an
  OCR-only result or the batch waiting. A request that timed out also kept the runtime pinned in
  memory for the rest of the session, and a runtime that crashed part way through an answer left its
  image waiting for good.
- **Cancelling one analysis no longer cancels another that was waiting for the same transcription.**
  Two analyses of one recording share a transcription; cancelling the first failed the second as
  cancelled, and cancelling the second did nothing until the transcription ended. Each now follows
  its own cancel.
- **The smart-folder watcher checks again before it analyzes.** A file queued while a Discover run
  held the queue was analyzed a second time although the run had just analyzed it, and a file saved
  while it was being analyzed was recorded as up to date with the old content. The watcher now asks
  the history when a file's turn comes and records the file as it was when the analysis started. An
  image batch (up to 20 images) also pauses when a Discover run starts, instead of finishing beside
  it, and a reanalysis you asked for is no longer turned into a plain update by a change to the same
  file.
- **A batch replaced as stale is stopped,** instead of running beside its replacement, and when it
  ends late it no longer makes the replacement impossible to cancel.
- **Quieter logs.** A model load refused because another model is in use is no longer logged as an
  unclassified failure with a stack trace, waiting for a model that is in use warns once instead of
  every two seconds, and the batch concurrency in the memory-pressure warning is the one that
  applies.
- **A file's status is no longer put back by a later change.** Each change to the list of file
  statuses was worked out from the list as the page last drew it. A second change in the same
  moment, or one made after you had left the page (a Discover run ends when its last file is let go,
  which can be minutes later), put that older list back over everything changed since. Every change
  in Discover and Organize now starts from the current list.
- **"Analysis paused" no longer appears after Stop.** Progress reaches the screen at most every 80
  ms, and an update that arrived inside that window was written when it ended, also when the
  analysis had been stopped or reset in between. Counts without a running analysis read as a paused
  one. The held update is now dropped when its analysis ends.
- **The progress of a run that waited for an earlier batch counts the whole run.** Such a run sends
  only the files the earlier batch did not finish, and the count shown restarted with them: "1 of
  10" on a run of 40 with 30 done. It now continues from what was done, "31 of 40".
- **A second Analyze right after the first no longer replaces it.** A run records its first progress
  a moment after it starts, and until then it looked like a run that had stopped responding: a
  second request in that moment reset it and took its place. The second request now waits its turn
  behind the first.
- **Development builds: a resumed analysis keeps its activity signal.** Under React StrictMode the
  run that was aborted while starting carried on as if it had started, reported the analysis as
  started a second time, and switched off the 30-second activity signal of the run that replaced it
  (and of every run after that), so a long first file could be taken for a stuck analysis. A run
  replaced while starting now stops there, and a run only ever stops its own signal.
- **Analyzed files show up again after Discover remounts mid-start.** A run that Discover's unmount
  (or React StrictMode in development) aborted during its first moments still sent its batch, then
  ignored every result: the list stayed on "0 ready" with loading placeholders, and five minutes
  later the inactivity check cancelled the batch, turning the image in progress into a filename-only
  "Limited analysis". An aborted run now sends nothing, reports no completion, and hands its files
  to the run that replaces it.
- **The smart-folder watcher pauses while you analyze in Discover.** Its catch-up of files already
  in your smart folders (for example the first launch over a library another app sorted) took turns
  with the Discover run on the one GPU, halving its speed. The watcher now holds its queue until the
  Discover run ends and then resumes on its own.
- **Files are no longer analyzed two or three times at once.** Leaving Discover and coming back
  while a batch ran started a new run that the window's still-running batch refused; the new run
  then analyzed the same files again file by file, in parallel, and restarted itself when it ended.
  That doubled GPU work, showed each "analyzed" notification more than once, kept the progress count
  low, and could leave no room for the vision model, so an image fell back to OCR. A new run now
  waits for the earlier batch, shows what it finished, and then analyzes only the files it did not
  finish.
- **An image whose vision step failed is no longer cached with its OCR-only result.** The next
  analysis of that image (within the 30-minute cache window) tries the vision model again.
- **The smart-folder watcher waits for files you are analyzing in Discover** instead of analyzing
  them at the same time, then skips them once the analysis history has them.
- **Audio and video no longer swap Whisper and the text model for every file** on a GPU too small
  for both. When the text model already holds a dedicated GPU, Whisper runs on the CPU beside it;
  Macs with unified memory are unchanged.
- **The smart-folder watcher runs files of the same kind together.** It keeps taking documents,
  images, or audio/video, whichever it just ran, while more are waiting (up to 25 in a row), so a
  model loads once per group instead of once per file.
- **On a GPU too small for both models, the text model stays loaded between files.** Loading the
  ~200 MB embedding model used to evict a 7B text model on a 6 GB card and reload it for the next
  file, about 4-5 s per file. The embedding model now runs on the CPU beside it.
- **Turning on "Describe video keyframes" no longer asks for cloud consent because of a deleted
  smart folder.** A deleted folder's AI provider override stayed in settings and counted as a cloud
  route; only overrides of folders that still exist count now.
- **Target Smart Folders** wraps long folder paths inside each card instead of running past it, and
  a description the user typed in quotes is no longer shown in doubled quotes.

- **An index file too large to load can no longer be overwritten by an automatic repair.** It stays
  protected until you reset or rebuild that index. A session without the compression library no
  longer saves over the compressed index or its vectors either.
- One orphaned file no longer marks the whole search index unhealthy and triggers a full rebuild
  after every analysis.
- Quitting while a save of the search index is running waits for that save instead of cutting it
  short.
- Install now (Visual C++ runtime) works on locked-down PCs where PowerShell runs in constrained
  mode, verifies and runs a private copy of Microsoft's installer, recognizes a declined admin
  prompt, and does not prompt when the runtime is already installed. The installer license now says
  the Microsoft runtime has its own terms.
- A batch that lists the same file twice and is rolled back no longer reports that file as moved.
  Recovery after a crash no longer picks a file when two identical copies could match.
- A corrupt organize journal is kept under a .corrupt name instead of being overwritten.
- On case-sensitive macOS volumes, renaming a file to a different-case name no longer replaces a
  different existing file.
- Logs and exported logs hide API keys and tokens written inside text, including Anthropic keys.
- Development: automated runs never touch your own files. An isolated test profile now also gets its
  own Documents and Downloads folders, so the default Uncategorized folder and the Downloads watcher
  stay inside it.

- **On a new PC without the Microsoft Visual C++ Redistributable, local AI now says why it is off.**
  A fresh Windows install does not include that runtime, and the AI engine needs it, so every AI
  feature failed with only a log error. The app now shows a banner with a link to Microsoft's
  download page (opened only when you click it), and the installer offers the same link.
- **OCR, image preprocessing, log export and embeddings work in installed builds.** Their background
  workers could not load their own dependencies once packaged, so they failed on every installed
  copy while working in development.
- A settings file or smart-folder list saved with a byte-order mark (Notepad can add one) is read
  normally instead of being treated as corrupt and replaced.
- The update status is delivered to the window when a copy cannot update itself (the zip build),
  instead of being dropped as invalid.

- **A search index too large to save is reported instead of silently not saving.** A collection is
  saved as one block of text, and V8 cannot build one longer than about 537 million characters. Past
  that, every save failed, was retried as if the disk had hiccuped, and new passages were lost at
  each restart. Now the app shows an error naming the index, saves everything else, and retries that
  index every 30 minutes, when files are removed from it, and once more at quit. It warns in the log
  once a save passes 85% of the limit.
- **A search index file too large to read is no longer renamed as corrupt.** It is left on disk as
  it is and never saved over, so no data is lost, and an error says search results are incomplete.
  Resetting that index clears the error.
- **Half-written search index files are cleaned up.** A save interrupted by a crash or a full disk
  left its temporary file behind (hundreds of MB each on a large library). Startup now removes those
  older than an hour from the search index folder.
- **A vector repair at startup no longer wipes the file's details.** When the index restored a
  file's missing vector from its backup copy, it replaced the whole entry with the vector alone, so
  the file lost its name, path, tags and hash from search. The repair now keeps the full entry.
- **Large libraries keep every file's vector.** Past 10,000 files the app dropped stored vectors
  from its backup copy, so those files were re-embedded on every launch and could drop out of
  search. The limit is gone; it saved well under 1 MB per 10,000 files.
- **Loading the search index no longer freezes the window.** The index is read and parsed on a
  background thread, so the app stays responsive while a large library loads.
- **Typing a new search cancels the previous one** instead of letting it run ahead of the new query.
  Cancelling a search affects only that search.
- **Phase tabs, Alt+arrow keys, dashboard links and the File menu follow one rule.** A tab that is
  blocked says why in its tooltip and when clicked, going back is always allowed, and all of them
  pause while analysis, file moves or undo run. Files you organized before keep Organize and
  Complete open, so a returning user can reach their results.
- **File naming has one setting.** Changing the naming convention in Discover changes the default in
  Settings, and the other way round.
- **Creating a folder through a link that points outside your allowed locations** is refused with a
  message that says so, instead of a generic "cannot access that path".

- **Organize no longer overwrites a file when two moves pick the same numbered name.** When a batch
  moved `report.pdf` and `report_1.pdf` into a folder that already held `report.pdf`, both moves
  could land on `report_1.pdf` and one file was lost. Every mover in the app (organize, single move,
  Downloads, undo, rollback) now claims a destination name one at a time.
- **A batch that was rolled back no longer shows as organized.** Restored files are reported as not
  moved, no undo entry is recorded for them, and a file whose restore failed is named in the error.
- One file held by antivirus or the indexer (permission denied) fails only that file instead of
  undoing the whole batch. Repeated permission failures still stop the batch.
- A destination folder deleted during a batch is recreated instead of reported as a missing source.
- A cross-drive move that loses a name race walks to the next free name instead of failing.
- After a crash, a move that had already landed on a numbered or fallback name is found and kept in
  undo and search.
- **A large library no longer starts in degraded mode.** A startup that is slow but still working
  keeps going: the 45 s mark reports a warning, the services are no longer shut down after they
  finish, and the warning clears once startup completes. A hard cap still stops a hung startup.
- Quitting while the vector store is still saving waits for that save instead of exiting halfway
  through it. Saving the index now tells its callers when it did not reach disk, and a full rebuild
  that could not be saved says so.
- A transient read error at launch no longer replaces the organize and analysis journal with an
  empty one, and restoring settings from a backup no longer files the default settings as the newest
  automatic backup.
- Search stays responsive while the keyword index rebuilds after an analysis.
- Find Duplicates checks the whole library, not only the first 1,000 files.
- Chat treats documents found by keyword as keyword matches, with their text, instead of telling the
  model they were 0% relevant. A local answer cut off at the output limit says so instead of showing
  a raw fragment. Cancelling a cloud chat no longer returns the partial answer as complete, and no
  longer falls back to the local model.
- Map-reduce summaries honor local-only processing, so text from a local-only file is not sent to a
  cloud provider.
- A provider address with a user name or password in it is refused, and errors never repeat it.
- The smart-folder and Downloads watchers do not follow a link or junction out of the watched
  folder. Stopping a watcher cancels its running analysis, including transcription, and failed
  analyses retry with a delay instead of three times in a row.
- File paths are hidden in log keys as well as values, and a home folder no longer leaves your
  account name visible.
- Scanned PDFs are read past the first page (up to a page limit), large CSV files are read in part,
  and a partial read is marked as partial in the file's details.
- First run: choosing the dashboard with only the Uncategorized folder now sends you to add a
  destination, and Welcome, Setup and Discover agree on what counts as one. Files left out of a pick
  for being unsupported or too large are counted, by reason, in the message.
- Development: end-to-end tests no longer download AI models.
- **Startup repair re-embeds missing vectors under default settings.** The file-vector backfill
  asked whether embedding was allowed after organizing, which is refused under the default "during
  analysis" timing, so missing file vectors were never rebuilt and the file was marked skipped.
  Files whose passages were never written, or were saved as all zeros, are now re-embedded from the
  text already stored, without calling a language model and under the same ids. Repair respects each
  file's embedding setting (skip, web only, manual), only re-embeds broken passages in place instead
  of rebuilding a set from capped text, and scans the passage index once per launch.
- **Documents no longer turn into low-confidence stubs during a vision batch.** A text model load
  waits for the batch to finish instead of failing after a few seconds.
- **Vision batches no longer stall.** An image whose vision step failed fell back to the text model,
  which waited for its own batch to end, so the image hung until the 300 s timeout and stored a
  stub. Cancel and timeouts now free the batch at once, outside text requests no longer wait about
  23 minutes and then fail, embeddings move back to the GPU after a batch, and the next batch is no
  longer held up by the text model reloading.
- **Find Duplicates' Send to Trash acts only on the sets you can see.** Before, it also acted on
  related sets hidden by raising the slider, so a keeper picked in one of those trashed its other
  files unseen. Exact-duplicate sets are re-verified: the keeper and each copy are hashed fresh from
  disk, a copy that no longer matches is skipped and reported, and if the keeper cannot be read
  nothing in that set is trashed. **Restore** no longer re-arms a pre-picked keeper.
- **Model output is checked.** An image's content type is always one of `text_document`,
  `photograph`, `screenshot` or `other`; models had copied the prompt's example list back verbatim.
  Title-like categories (such as "Mystery Bin Declutter: 2-5-10 Method") are no longer offered as
  new folder names.
- A memory-budget error or a cancel during audio or video transcript analysis is no longer saved as
  a low-confidence stub. A download that hits a memory-budget error is retried every 60 s, up to 5
  times, instead of being left unprocessed.
- A file that had finished indexing could be set back to "pending" by the smart-folder or Downloads
  watcher. On a document cache hit, the watcher now writes the stored file vector instead of none.
- A failed embedding-queue save, or a failed write of the search index's embeddings file, is no
  longer treated as saved; the change stays marked and is written again. The hash-cache flush at
  quit waits for a save already in progress, then writes anything newer.
- **Settings → AI Provider** shows a saved older model (such as `claude-opus-4-7`) as its own option
  instead of as Opus 5.5.
- **Diagnostics:** the 15 s refresh skips while a fetch is still running, no longer disables Copy,
  and an older result can no longer overwrite a newer one.
- Test runs that failed with every test passing: a log-file error arriving after logging had shut
  down was written to a console that was already gone. Such late errors are no longer printed.
- **Organize no longer shows "1% confidence" on its strongest matches.** A match boosted by its
  cluster got a score above 100%, which the card read as a percentage and divided by 100 again. The
  card and the details panel now show the same value, capped at 100%.
- **Target-folder descriptions in Organize keep the letter s at both ends.** "sales reports" was
  shown as "ales report".
- **A file the watcher is already analyzing is not queued again by the watcher's own read of it.**
  On Windows, reading a file updates its last-access time, which was reported as a change.
- **An image batch whose files are all analyzed already no longer swaps models** to analyze nothing.
- **Content dates:** a written year of 0000–0099 is no longer read as 1900–1999, a year of five or
  six digits is rejected, a date written with `Z` keeps its day west of Greenwich, and a number from
  the model is a year or nothing. Search results and cluster time ranges show a document's own day,
  not the day before.
- **Smart-folder watcher, embedding retries.** A retry that only embeds a finished result no longer
  replaces a reanalysis or a change waiting for the same file, no longer leaves the file without an
  embedding when the waiting item is skipped, does not embed a result for a file that has changed
  since, and no longer hides a real edit made while it runs.
- **Smart-folder watcher:** a recording gets the three hours a Discover run allows instead of ten
  minutes; a file deleted or renamed during its analysis gets no history entry or notification; and
  "Reanalyze all" can no longer start the same file beside itself.
- **A transcript the text model gave no answer for is tried again** by the watcher, and is recorded
  as provisional instead of as a finished transcription with confidence 0. The same holds when the
  model is not installed or its answer cannot be read.
- **Stop works while a batch is still checking its files,** when it was answered "unknown batch"
  before. A batch also ends when the window that asked for it is closed or reloaded, and a batch
  that has ended or was cancelled sends no late progress.
- **A batch that ran to its end sends its last progress report,** so the search and embedding counts
  that refresh on it are current.
- **The history keeps the size and date a file had when its analysis started,** not those of a
  version saved while the model worked.
- **A Discover run that stops making progress says so.** A silent five-minute check ended the run
  before the ten-minute check that would have shown a notice. There is one check now, and it shows
  the notice without stating a duration it cannot know. On the one-file-at-a-time path a slow file
  fails alone instead of ending the run.
- **Stop no longer turns vision off.** Five cancelled vision requests opened the breaker and every
  image got OCR only for five minutes. A request the user stopped is no longer counted; one that
  timed out still is.
- **An OCR result that stands in for the vision model is never cached,** whatever made the vision
  model unavailable, so the next analysis asks the vision model again.
- **An image that cannot be decoded is not sent to the vision model.** An SVG, a TIFF or a damaged
  WebP whose conversion failed went to the model as if it were a PNG, was rejected and retried, and
  each rejection counted toward turning vision off for the images after it. Such a file is now
  analyzed from its text if it has any, else from its name, and the reason shown names the file.
  Text from the vision runtime's error log no longer appears in error messages.
- **In an image batch, an image waits for a document that is still using the text model** (up to 45
  s) instead of losing its vision analysis, and an image that arrives while the text model is still
  loading no longer starts the vision runtime on top of it.
- **Embedding models and a small GPU.** An embedding load that starts while the text model is still
  loading runs on the CPU instead of waiting and then unloading the text model. Inside an image
  batch, an embedding load no longer unloads the text model that took the vision runtime's place.
- **A text model larger than the memory budget loads without waiting out the full timeout** once
  nothing else is left to unload.
- **Whisper runs on the CPU while the text model is still being loaded** onto a GPU that cannot hold
  both.
- **A slow move in Organize is no longer reported as failed while it still finishes.** A move to
  another drive that took longer than 30 seconds was marked failed, but the file moved anyway, with
  no undo entry and stale search paths. The move now runs to its end, and Stop cancels a cross-drive
  move before the copy is published. If the drive has stopped answering, Stop ends the batch after
  15 seconds; should the move go through later, the file is put back.
- **An undo that can never work no longer blocks the ones before it.** When the file was deleted or
  moved outside the app (or the backup of a deleted file is gone), the entry is removed from history
  and the message says so. A file on a drive that is unplugged or ejected keeps its entry. Undo and
  redo errors now carry their reason to the screen.
- **Feedback notes no longer raise Organize confidence on their own.** With any note saved, a 69%
  match could be shown and auto-organized as 76%, because the ranking score was written into the
  confidence. A note now changes confidence only for the folders it is about.
- **A file moved onto a path that an earlier, deleted file used keeps its own search entry** instead
  of answering with the old file's content.
- **Organize: smaller fixes.** Clicking an Organize notification focuses the file again; a bulk
  category change is saved; "Done! Organized N" and the Complete screen count the files and folders
  that were really used; the progress highlight follows a renamed file; counts of one read "1 file",
  not "1 files".
- **Smart folders on a network share (`\\server\share\…`) can be organized.** The paths were refused
  before they reached the mover. Device paths and administrative shares (`C$`) stay refused.
- **A question, search or description that mentions a Windows path is no longer blanked** before it
  is sent (for example "What is in D:\Docs?").
- **Graph preferences survive a session that expired**, and the "session expired" notice shows on
  whichever screen opens first.
- **Several recordings analyzed one by one no longer fail with "busy";** they wait their turn.
- **Model downloads.** A download whose connection closes early fails and resumes instead of
  hanging. A vision model whose image projector did not download is reported with a warning, not as
  installed. When "Change & rebuild now" fails, Settings goes back to the previous embedding model,
  as the app already had.
- **A timed-out image no longer restarts the vision runtime under another image** that is being
  analyzed at the same time; images go to the runtime one at a time.
- **Analysis results.** The filename fallback no longer picks a folder because its description
  contains the extension's letters inside a word ("ai" in "email"). Changing the organization
  instructions re-analyzes files instead of returning the cached answer. Archives that cannot be
  listed get keywords, and `.tgz` and `.bz2` count as archives. A document confidence the model gave
  as a fraction (0.9) is stored as 90%, not 1%.
- **Smart-folder watcher.** A file the app itself moved out of a watched folder keeps its analysis
  history. A file renamed in Explorer keeps its analysis instead of being analyzed again. Turning
  the watcher back on while it is still stopping leaves it on.
- **Quitting twice, or closing the window during shutdown, no longer ends the app before cleanup is
  done.**
- **"Update ready" stays after a later update check fails.**
- **Search window.** The Timeline list fills the window instead of staying 400 px tall, and the
  hidden Atlas tab is no longer reachable with the Tab key.
- **Organizing many or large files to another drive no longer stops after five minutes.** The batch
  was cut off, a timeout was shown and the files already moved could be moved back. A batch that is
  still moving files now runs until it is done or you press Stop.
- **A failed settings read can no longer replace your saved settings with the defaults.** Settings
  now says the read failed and offers Try again; nothing is saved until the real settings have
  loaded.
- **Chat.** Dragging files or folders onto the Document scope panel adds them, and says so when
  nothing could be added. A reopened chat shows each answer as it first appeared. Retry after a
  failed request saves the question with the answer. Chats scoped to more than 200 documents are
  saved and keep their memory.
- **Files whose search indexing hit a temporary error are retried on their own** after a short wait,
  also after a restart, instead of waiting until another file is analyzed.
- **Analysis history no longer mixes up two files that used the same path.** Analyzing a new file
  where an organized file used to be, or moving or deleting a file from there, no longer removes or
  re-points the organized file's history.
- **Setup wizard.** No false "Required model downloads stopped" right after clicking Download. When
  the AI engine cannot start, the wizard says so with the reason instead of listing installed models
  as missing. An image model whose projector file did not download is shown as failed, and the retry
  fetches (and Cancel stops) only that file.
- **Dropping a folder whose files are already in the Discover queue no longer analyzes them again;**
  only new files are added.
- **Recordings queued behind one that timed out now really wait their turn.** The earlier fix did
  not take effect in the packaged app.
- **A setting changed a moment ago no longer reads back as its old value.** While the app was busy
  (most often just after launch), a change such as a newly chosen model could show the previous
  value for a couple of seconds, and a second change made in that time could save the old value
  back.
- **A setting changed in the first moments after an update is kept.** On the first launch after an
  update the app brings the settings file up to date; a change made while that was still running
  could be overwritten by it and go back to the old value.

## [5.1.2] - 2026-11-01

A maintenance release: security updates for the build and test tooling, and a macOS release build
that survives a dropped connection to Apple. The installed app works the same as 5.1.1.

### Security

- Build and test tooling only: the `glob` 10.x and 13.x copies used by Jest, `rimraf` and the
  coverage tooling move to 14.0.3 for GHSA-3g3m-2fjr-6pw4, and the `minimatch` 9.x and 10.x copies
  used by ESLint, electron-builder, `@typescript-eslint` and the coverage tooling move to 11.0.3 for
  GHSA-g3hv-75wg-m249. None of these copies ship in the app; the production dependency audit was
  already clean.

### Changed

- macOS release builds retry notarizing the app up to three times, 30 s and 60 s apart, instead of
  failing on the first dropped connection to Apple's notary service, which had stopped the macOS
  Intel build for both 5.1.0 and 5.1.1 (`scripts/notarize-mac-app.js`).

## [5.1.1] - 2026-11-01

Smaller downloads again: fixes the 5.1.0 builds, which packed the project folder into the app.

### Fixed

- **Packaging:** the app archive (`app.asar`) holds only the app again: the built `dist` folder,
  `package.json`, the production dependencies and `src/shared`. In 5.1.0 it also held the project's
  webpack build cache, documentation images, sources and tests (about 300 MB unpacked), which made
  every download 57 to 82 MB larger than 5.0.0. The release check now fails a build whose `app.asar`
  holds anything else.

## [5.1.0] - 2026-10-31

Faster, more predictable Windows startup and a zip instead of the self-extracting portable exe.

### Known issues

- Every download is 57 to 82 MB larger than 5.0.0 (the Windows x64 installer is 735 MB instead of
  671 MB) because the build packed the project's webpack build cache, documentation images, sources
  and tests into `app.asar` next to the app. The app never loads these files. Fixed in 5.1.1.

### Security

- `minimatch` 10 → 11.0.3 for GHSA-g3hv-75wg-m249 (denial of service via globparts amplification).

### Changed

- **Windows:** the self-extracting portable exe (`StratoSortStack-5.0.0-win-x64.exe`), which
  unpacked the whole app into `%TEMP%` on every start, is replaced by
  `StratoSortStack-5.1.0-win-x64.zip`. Extract it once and run `StratoSort Stack.exe` from the
  extracted folder; like the portable exe, it does not update itself. The Setup installer is still
  the recommended download.
- The AI engine remembers the GPU backend that worked (`gpu-backend-cache.json` in the app's data
  folder) and tries it first on the next launch. An app update, a different GPU or graphics driver
  version, a change in the GPU runtimes node-llama-cpp finds (such as installing a CUDA toolkit), or
  14 days make it run the full backend search again. The optional embedding worker
  (`STRATOSORT_ENABLE_EMBEDDING_WORKER`) uses the same record and supported-backend filter.
- The Windows x64 build no longer ships node-llama-cpp's arm64 prebuilt (about 11 MB).
- Each build ships only its own SQLite (`better-sqlite3`) native binary instead of the ones for
  every platform: about 15 MB less on macOS, about 12 MB on Linux, and one 2 MB file less on
  Windows. In 5.1.0 these savings are outweighed by the known issue above.
- On Windows and macOS the app no longer forces Chromium's `enable-gpu-rasterization` and
  `enable-zero-copy` switches, so Chromium's per-driver GPU blocklist applies. Linux keeps forcing
  them, as before.
- After three GPU process exits in one session, software rendering now stays on for up to 3 days
  (`.gpu-fallback` in the app's data folder) instead of switching back on the next launch, which
  made launches alternate between slow and fast on a failing driver. Delete the file while the app
  is closed to retry hardware acceleration sooner.

### Fixed

- Windows startup: the window is shown at most 4 s after it is created even when its first frame is
  late, and at once when the GPU process exits before then; the AI engine waits for the first paint
  (up to 3 s); GPU backends whose runtime libraries are missing are skipped instead of test-loaded;
  the GPU is probed once per launch; and checks of the Documents `Uncategorized` folder give up
  after 3 s.
- Starting the app while it is still shutting down (for example right after **Quit**) now opens it
  again once the shutdown has finished, instead of doing nothing.
- **Settings → Application → Check for updates** on a copy that cannot update itself (the extracted
  Windows zip, a Microsoft Store install, or a Linux build other than the AppImage) now explains why
  instead of reporting "Failed to check for updates". With auto-updates disabled it now says so
  instead of "Checking for updates…".

## [5.0.0] - 2026-10-26

First public release of StratoSort Stack: source published on GitHub under the PolyForm
Noncommercial License 1.0.0, with signed installers on GitHub Releases.

The Security entry and the first two Changed entries shipped in 5.0.0 but were missing from its
release notes; the 5.1.0 notes listed them by mistake.

### Security

- Electron 41 → 45 (45.1.0). Electron 41 was outside upstream security support and affected by eight
  advisories, including GHSA-jr5w-w6x2-84p9 (HID/USB permission checks attributed to the wrong
  origin; SameSite cookies not applied to windows opened from links).

### Added

- Atlas map, timeline, knowledge stats card, Downloads triage trust pack, MCP server kit, and
  repository history visualization (PRs #375–#407).

### Changed

- `better-sqlite3` 12 → 13. 12.x no longer compiles against Electron 45; 13.x ships N-API prebuilds,
  so it is no longer rebuilt per Electron version.
- macOS 13 (Ventura) is now the minimum supported macOS version (Electron 44 dropped macOS 12).
- **License:** StratoSort Stack is now released under the PolyForm Noncommercial License 1.0.0.
  Personal and other noncommercial use is free with every feature; commercial use needs a paid key
  (see [docs/COMMERCIAL.md](docs/COMMERCIAL.md)).
- **No trial, no feature gate:** the app runs the same with or without a license key. Settings →
  License only reports `free`, `licensed`, or `version_not_covered`; nothing is locked.
- **Product name:** StratoSort Core is now StratoSort Stack. Existing `StratoSort Core` user data is
  migrated on first launch (`src/main/core/userDataMigration.js`). Source and releases live at
  [iLevyTate/StratoSortStack](https://github.com/iLevyTate/StratoSortStack).
- **Auto-updates on by default:** installed (packaged) builds now check GitHub Releases for updates
  at startup and every 4 hours. Turn background checks off in Settings → Application → Background
  Update Checks, or disable the updater with `STRATOSORT_ENABLE_AUTO_UPDATES=false`. Development
  runs never check.

### Fixed

- July feature-burst follow-up: F-150..F-186 (typecheck, atomicMove destination lock, file-operation
  broadcasts, Atlas races, triage undo identity, overlay guards).
- Organize-phase undo no longer re-indexes restored files as already-organized.
- Smart Folder matching now uses description, keywords, and file-type rules.
- Auto-update: macOS and Windows arm64 clients now find their channel file (`latest-mac.yml` /
  `latest.yml` are merged across architectures instead of renamed per arch).
- Undo/redo: a failed or partial undo no longer updates the UI as if every file had moved.
- Organize: interrupted batches resumed at launch now get undo entries and search-index updates for
  every replayed move; resume runs under the batch lock; batch-lock TTL no longer overlaps rollback.
- Downloads watcher: error-driven restart works again, and organizing files out of Downloads no
  longer deletes their embeddings; disabling auto-organize mid-restart wins over the restart.
- MCP: rejected initialize requests no longer leak a server per attempt; disabling MCP while a
  client holds an SSE stream no longer hangs the toggle; token storage survives keyring changes.
- Analysis: timed-out PDF extractions release their buffers; corrupt DOCX runs OCR once instead of
  up to six times; oversized text files are refused even when the initial stat fails.
- Settings: the `ai` block is validated on save/import (provider base URL scheme, cloud consent) and
  repaired on read; DOS device-namespace paths can no longer bypass smart-folder containment; CSV
  export uses RFC 4180 quoting with formula neutralisation.
- Packaging: `.env` is ignored in packaged builds; only worker bundles are unpacked from the asar so
  integrity validation covers application code.

## [4.0.6] - 2026-06-17

### Fixed

- **Search result UI:** corrected confidence display, fixed layout overlap, and resolved text
  overflow in the search result cards.
- **Embeddings:** bound the conditional logger in the full-rebuild access-error path so the error
  branch logs correctly instead of throwing on an unbound reference.
- **Branding/assets:** regenerated the icon set from the updated logo SVG, fixed transparent logo
  corners, and refreshed installer art.

### Changed

- **Discover:** routed `AnalysisResultsList` confidence through the shared `normalizeConfidence`
  helper for consistent confidence handling across the discover and search views.

### Dependencies

- Bumped `csv-parse` 6.2.1 → 7.0.0, `js-yaml` → 4.2.0, and `tar` → 7.5.16 (clears audit advisories),
  plus minor-and-patch dependency group updates.
- Pinned `hono` → `^4.12.25` via `overrides` to clear a high-severity advisory in the transitive
  copy pulled by `@modelcontextprotocol/sdk` (path traversal in `serve-static` on Windows,
  GHSA-wwfh-h76j-fc44, plus related adapter/CORS/body-limit fixes).

## [4.0.5] - 2026-06-14

### Fixed

- **Windows code signing (Azure Trusted Signing):** rewired the release pipeline to a simplified
  credential scheme. The Microsoft Entra tenant and client IDs are now repository **Variables**
  (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`) and only the client secret remains a repository **Secret**
  (`AZURE_CLIENT_SECRET`). The four public signing-identity values (publisher, endpoint, certificate
  profile, signing account) are hardcoded in `scripts/configure-win-signing.js` instead of threaded
  through workflow env. The detect step trims the tenant/client IDs before exporting them, so a
  stray trailing newline in a pasted variable can no longer break Entra authentication
  (`AADSTS700016`). Signing remains native via electron-builder's `win.azureSignOptions`, keeping
  the updater `latest.yml` sha512/blockmap valid.

## [4.0.4] - 2026-06-12

Supersedes v4.0.3, whose release pipeline shipped a compromised Windows installer (dual-arch NSIS
whose arm64 half was cross-built without arm64 whisper natives) and failed to publish macOS/Linux
artifacts (sha512 metadata mismatch from cross-arch artifact collisions). v4.0.3 is marked as a
prerelease on GitHub.

### Fixed

- **Release packaging (all platforms):** `electron-builder.json` targets no longer pin `arch`
  arrays. Config-declared arch arrays are a standing build matrix that CLI `--x64`/`--arm64` flags
  do not filter, so every release leg silently built both arches. Arch is now driven exclusively by
  CLI flags; the redundant `electron-builder.{win-x64,linux-x64,linux-arm64}.json` configs are
  removed and `electron-builder.win-arm64.json` retains only its `artifactName` override.
- **Windows arm64 verify:** `verify-packaged-artifacts.js` no longer requires
  `@fugood/node-whisper-win32-arm64-cuda` — that variant was never published (no CUDA toolkit for
  Windows-on-Arm). Base + Vulkan remain required.
- **Linux release staging:** `mac-release.yml` stages arch-scoped artifact globs (deb `amd64` /
  AppImage `x86_64` for x64) so the x64 and arm64 legs can no longer collide in the flat
  publish-release merge — the root cause of the v4.0.3 sha512 mismatch.
- **Windows arm64 packaging:** `dist:win:arm64` passes an explicit `nsis` CLI target so the portable
  target is not built for arm64.

## [4.0.3] - 2026-06-09

Ship-ready release combining v4.0.2 CI fixes with the new SVG branding pipeline and Windows
packaging improvements.

### Added

- **Branding:** `StratoSortStackLogo.svg` as the master icon source;
  `npm run generate:branding-if-source` for CI/release regen (macOS ICNS verified on darwin).
- **Windows dual build:** `npm run dist:win:dual` plus single-arch
  `electron-builder.win-{x64,arm64}.json` configs.
- **Organize routing test:** Vendor fallback when category does not match a smart folder.

### Changed

- **Icons:** Regenerated ICO/PNG/BMP/DMG assets from the new disc logo; macOS packaging uses
  `icon.icns`.
- **CI:** macOS CI and all release workflows run branding generation before packaging.

### Fixed

- **Windows release CI:** Regenerate branding assets before build; per-arch updater metadata verify
  (`--arch=`).

## [4.0.2] - 2026-06-08

Unblocks GitHub Release publish for signed macOS builds plus Linux x64 and arm64 artifacts.

### Fixed

- **Linux CI metadata verify:** Per-matrix `verify-updater-metadata.js --arch=` checks so the arm64
  leg no longer demands x64 `latest-linux.yml` after the arm64 rename step.
- **Linux packaging:** Single-arch `electron-builder.linux-{x64,arm64}.json` configs so arm64 CI
  does not also emit x64 installers.

## [4.0.1] - 2026-06-08

Patch release to unblock the v4.0.0 GitHub Release publish step. Linux arm64 CI failed because the
vision runtime setup script did not download `llama-*-bin-ubuntu-arm64.tar.gz`; `publish-release`
requires all matrix legs to succeed.

### Fixed

- **Linux arm64 packaging:** Vision runtime setup and `VisionService` now resolve `ubuntu-arm64` /
  `ubuntu-vulkan-arm64` llama.cpp binaries; backend selector enables Vulkan on Linux arm64 where
  upstream ships the asset.
- **llama.cpp pin:** Default `STRATOSORT_LLAMA_CPP_TAG` bumped from `b7956` to `b9000` (first tag
  with upstream `ubuntu-arm64` assets).

## [4.0.0] - 2026-06-05

First **signed and notarized macOS** release. Developer ID Application signing and Apple
notarization run automatically in `mac-release.yml` when the five `MACOS_CSC_*` / `APPLE_*`
repository secrets are configured. See `docs/MAC_SIGNING.md` for the full runbook and
`verify-mac-signing.yml` for post-release Gatekeeper verification.

17 commits since v3.2.1. Highlights: MCP stateful HTTP transport, AI provider routing refactor,
Knowledge OS graph insights redesign, searchable settings, and Orama embedding stability fixes.

### Added

- **macOS distribution:** Developer ID signing + `notarytool` stapling in CI; standalone
  `verify-mac-signing.yml` workflow for Gatekeeper smoke tests on published DMGs.
- **MCP:** Stateful Streamable HTTP sessions with initialize-before-list probe client; contract
  verifier updated to match.
- **Search / Graph:** Cluster display labels, graph insight utilities, unified search modal UX
  refresh, and bridge ActionCards in the sidebar.
- **Settings:** Searchable settings panel with improved section navigation.
- **Postinstall:** Auto-download Whisper model during setup (`setup-whisper-model.js --auto`).

### Changed

- **AI providers:** Centralized routing helpers (`aiProviderRouting.js`), cloud provider ready-cache
  sync after key changes, and Settings configuration UX polish.
- **Diagnostics:** Whisper on-disk model presence and Llama initialized state surfaced in About.

### Fixed

- **Orama:** Guard null embedding spread in hash updates; persist category/date on embedding
  refresh.
- **Startup:** Remove splash synchronously when the window is still hidden; retry post-load health
  checks before logging false alarms.
- **Settings:** Accept custom chat persona IDs (`custom:…`) through IPC validation.
- **Search UI:** Sidebar accordion no longer clips ActionCard primary buttons.
- **Embeddings:** Log per-file rebuild failures; raise IPC errors cap to 50.

### Notes

- **macOS v4.0.0+** DMGs are signed with Developer ID Application and notarized. Older unsigned
  preview builds may still require right-click → Open; see `docs/INSTALL_GUIDE.md`.
- **Windows** installers are signed via Azure Trusted Signing when the `AZURE_*` secrets are
  provisioned (see `docs/RELEASING.md`); otherwise they fall back to unsigned ad-hoc builds and
  SmartScreen will warn on first run.
- See `git log v3.2.1..v4.0.0` for the full commit list.

## [3.2.1] - 2026-06-05

Patch release preparing the signed-macOS pipeline (signing runbook, verify workflow, dependency
audit fixes). macOS artifacts from this tag were built **unsigned** — use **v4.0.0** for the first
notarized Developer ID build.

## [3.2.0] - 2026-06-01

55 commits since v3.1.1. Highlights: smart-folder duplicate detector, graph panel improvements,
Whisper CUDA broadening, regression-lock rounds 1–3, packaging hardening, and a comprehensive
analysis-pipeline stability sweep.

### Added

- **Smart Folders:** Canonical-equivalent duplicate detector now runs at startup and surfaces
  pre-existing duplicates (e.g. `Logos` vs `Logos and Graphic Design`) with a one-click resolution
  flow (#264). Companion `FOLDER_NAME_EQUIVALENT` IPC error code mirrored client-side in
  `AddSmartFolderModal` (#261).
- **Smart Folders:** `analysis.suggestedNewFolder` surfaced in `ReadyFileItem` with an inline hint
  chip and optional "Create" button — closes the gap where files routed to "Uncategorized" without
  signal about the matched theme (#261).
- **Graph:** Collapsible panels, plain-language edge explanations, pinned tooltips, and styled React
  Flow controls (#220, #229).
- **Media:** File-size limits with adaptive concurrency tuning; large media files no longer starve
  the analysis pool (#247).
- **Whisper:** Variant loader + prerequisite matrix + binding-contract guards (#207). Broader CUDA
  DLL search and installed-CUDA-version detection (#265).
- **Legal / Support:** Dedicated documentation, clustering safeguards, and the semantic-pipeline
  reference doc (#232).
- **Documentation:** `docs/UI_WIRING_AUDIT.md` (post–v2.0.9 UI structure, IPC matrix); post-v2.0.9
  regression audit closeout doc (#263); cross-arch packaging caveat doc; developer-onboarding
  cleanup (#210).
- **Settings:** **Watch Smart Folders** and **Background Update Checks** toggles in application
  preferences (defaults unchanged).

### Fixed

- **Regression-locks round 3:** Abort signal now threaded into semantic folder matching so
  post-window-close embeddings can't corrupt the vector DB; `batchOrganizeHandler` returns
  `{ success: false, partialFailure: true, errorCode: PARTIAL_FAILURE }` from the outer-catch path
  so renderers can't render "organized" while N files remain in source (#261).
- **Analysis pipeline:** Naming idempotency (bare-year stripping, version-token preservation,
  double-date fix); embedding-override floor (`FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR = 0.75`) when
  the LLM's category isn't in the smart-folder set; theme preservation through
  `matchCategoryToFolderWithSuggestion` (#252). Phantom folder-vector hits dropped; naming
  instrumentation added (#246). Log when new-folder suggestions are surfaced (#267). Error-code
  mapping with underlying-cause preservation. Low-VRAM thrashing and dev-session audit gaps
  addressed (#268).
- **IPC hardening:** `fileOperationSchema` path validation centralised; enforcement sets shared
  across handlers (#266). Round-2 IPC audit fixes (collision parity, dryRun/strict schemas,
  `PATH_TOO_LONG` demote, TOCTOU retry on rename races) (#261).
- **Search & Chat:** Graph-blend weighting in semantic search; simple-mode setting honoured in chat;
  cloud→local provider fallback when external provider is unreachable (#261). Stray NUL byte removed
  from ChatPanel dedup key (#238). Persona picker surfaced in always-visible chat header (#222);
  custom personas included from settings with validated/sanitized IDs.
- **Settings & infra:** `autoConcurrency` schema migration; model resolver accepts documented union;
  watcher depth honours configured limit; restore-from-backup respects TTL (#261).
- **Llama / Whisper:** Explicit vision GPU layers on tight VRAM; CUDA Whisper backend enabled
  (#250). First-attempt context size adapts across hardware tiers; spurious "context creation
  failed" warnings suppressed on low-VRAM GPUs.
- **Vector:** Spurious folder-index repair churn from Orama similarity cutoff stopped.
- **Extractors:** `officeparser` v6+ AST read via `toText()` (#245).
- **Embeddings:** Full model context used for summaries; folder-match threshold tuned (#242).
- **UI wiring:** Post-v2.0.9 audit fixes for personas, settings toggles, docs (#233, #236). Nav
  pointer-events fix; skip-link and display-heading gradient cleanup (#225). Smart-folder
  close-on-success, shared name validation, per-file matcher, reanalyze scope copy (#224).
- **Media analysis:** Option propagation and degraded-state tracking (#201, #202, #203, #204).

### Changed

- **Packaging:** Hardened for all OS/arch targets; electron-builder verify config, asar fuses,
  cross-arch native rebuild guards (#240, #241). Electron pinned to **41.x** to stop the bump-revert
  cycle (ABI 137 / `node-abi` / `better-sqlite3` prebuilt gaps documented in
  `.github/dependabot.yml`) (#215).
- **Refactoring:** Ousterhout-style complexity reduction across IPC and search modal (#221).
  Silent-fallback observability with `swallow()` helper and lint-disable hygiene (#219).
- **Logging:** Expected-degraded paths downgraded to debug/info to cut noise (#230).
- **Code maintenance:** Real-bug sweep, dead-code removal, service-header normalisation (#211).
- **Organize:** `SmartOrganizer` documented as experimental / not mounted in the shipping
  `OrganizePhase`.
- **CI:** `STRATOSORT_ALLOW_DEV_CLEAN` documented; dead `enableTelemetry` schema removed (#251).
- **Dependencies:** Multiple minor/patch group bumps (#205, #208, #209, #213, #231, #235, #244,
  #257); `officeparser` to 7.1.0 (#235); `better-sqlite3` (#209); `minimatch` to 10.x (#213).

### Security

- **IPC:** `fileOperationSchema` path validation hardened — rejects UNC, all `<scheme>://` URIs, NUL
  bytes, relative paths through a shared validator (#266).
- **Electron:** Pinned to 41.x rather than rolling forward to 42 until the native-rebuild chain is
  unblocked (see `.github/dependabot.yml`) (#215).

### Notes

- Windows installers are **unsigned** ad-hoc builds; SmartScreen will warn on first run. macOS
  signing/notarization activates automatically when `MACOS_CSC_*` / `APPLE_*` secrets are set.
- See `git log v3.1.1..v3.2.0` for the full list of 55 commits.

## [3.1.1] - 2026-05-08

- **macOS distribution:** mac DMG/ZIP builds now bundle a self-hosted LGPL-3 FFmpeg binary
  (`STRATOSORT_FFMPEG_URL` wired into `mac-release.yml`, sourced from the `ffmpeg-lgpl-latest`
  GitHub release produced by `build-ffmpeg-lgpl.yml`). Replaces the GPL-3 `ffmpeg-static` npm
  dependency that was incompatible with closed-source distribution. Subprocess-only invocation; LGPL
  relink-ability obligation does not apply. Attribution at `assets/runtime/ffmpeg/NOTICE.md`.

## [2.0.8] - 2026-04-06

- **Release:** Published `v2.0.8` with refreshed Windows release artifacts and checksums.
- **CI / packaging:** Added Linux release workflow coverage and improved Linux packaging metadata
  handling in release preparation.
- **Compliance:** Added commercial compliance gates and reporting artifacts to strengthen
  release-time verification.
- **Installer / update hardening:** Included recent updater and installer path/registration fixes
  from the pre-release stabilization branch.

## [2.0.7] - 2026-03-30

- **Dependencies**: Production `npm audit` remediated (including `fast-xml-parser`, `tar`,
  `underscore`); `officeparser` pinned to patched `file-type` via npm `overrides`.
- **Crash reporting**: Removed `@sentry/electron`; main process uses local `electron-crashReporter`
  only (`uploadToServer: false`).
- **Build**: `officeparser` is a main-bundle external so ESM-only `file-type` resolves at runtime.
- **Pre-launch remediation**: Chat in-memory sessions use `LRUCache` (50 / 60m TTL) with eviction
  hook; PDF pipeline uses one 300s `AbortController` + raw extractors; `ProcessingStateService` lock
  chain has terminal `.catch()`; Orama sidecar startup spot-check; `EmbeddingQueue` mutex timeout no
  longer force-releases; IPC preload retries 3; `chunkText` word-boundary snapping; `SECURITY.md`
  and `docs/LICENSE_AUDIT.md` / `docs/ORAMA_VECTOR_SIDECAR.md`; CI runs `npm run audit:production`.

## [2.0.6] - 2026-03-12

### Added

- **Stability framework**: Smoke suite, telemetry, and release threshold checks for regression
  detection; `scripts/stability/run-smoke-suite.js`, `check-release-thresholds.js`, and baseline
  ledger.
- **clearReadyQueue IPC**: New handler and processing state method for embedding queue management.
- **GPU binary restore script**: `scripts/restore-gpu-binaries.js` to restore renamed GPU addons
  after cloud/headless workarounds.
- **Release preflight**: `scripts/release-preflight.js`, `verify-build-assets.js`, and
  `verify-ipc-contracts.js` for packaging and IPC validation.
- **textModelActivity**: Interactive LLM request tracking for UI state.
- **E2E walkthrough**: Comprehensive docs with 37 annotated figures, demo videos, and walkthrough
  content files.
- **.env.example**: Advanced AI tuning and persistence options documented.
- **Model download progress**: Enhanced tracking and UI updates during model installation.

### Changed

- **Electron**: Upgraded from 40.8.0 to 41.0.0.
- **Node.js**: Upgraded from 20.11.0 to 20.19.0 (required for chokidar, ESLint).
- **Path handling**: Replaced `path.basename` with `crossPlatformBasename` for consistent filename
  extraction across Windows/macOS/Linux.
- **Documentation**: Minimal Mistakes theme, notice blocks, GLightbox image zoom, refreshed
  INSTALL_GUIDE and CONFIG.md tables.
- **Release workflows**: Hardened validation, packaging gates, and artifact version alignment.

### Fixed

- **Analysis queue**: Increased limit from 500 to 1000 and centralized in `performanceConstants`;
  SmartFolderWatcher no longer skips files with "Analysis queue full" during bulk imports.
- **Race conditions and concurrency**: Resolved data loss, crash bugs, and deadlocks across
  analysis, persistence, and IPC layers.
- **Event loop and memory**: Fixed blocking, leaks, and UI jank; added queue limits and Orama
  eviction.
- **Extractor and OCR**: Restored regressions in document extraction and image analysis pipeline.
- **Path validation**: Hardened separator-sensitive validation and tests.
- **GPU detection**: Require confirmed CUDA detection on Windows; async exec/execFile for GPU
  detection.
- **Virtualized lists**: Restored react-window interactions in large lists.
- **Graph, privacy, analysis UX**: Restored graph rendering, privacy flows, and analysis phase
  stability.
- **Semantic persistence**: Hardened fallback selection and confidence tracking.
- **Schemas and hydration**: Fixed operationProgressSchema, concurrency limits, stale selectors, and
  timer leaks.
- **GraphTour**: "Don't show this again" now persists across sessions.
- **Batch organize**: Fallbacks to uncategorized when folder matching fails.
- **Accessibility**: Extract accessible label from mixed children in Button component.
- **Long Task violations**: Deferred setInterval handlers (heartbeat, stall check) in discover phase
  to avoid 50–275ms blocks in Chrome DevTools.

### Improved

- **Performance**: react-window virtualization for large lists; offload heavy regex parsing to
  worker_threads; throttle OPERATION_PROGRESS; export history via save dialog; chat/graph and
  inference queue fairness.
- **Settings and search**: Strengthened settings workflows and semantic search IPC.
- **Analysis caching**: Improved responsiveness and caching behavior.
- **Scrollbar styles**: Enhanced usability.
- **CI**: Jest heap increase (`NODE_OPTIONS=--max-old-space-size=4096`) to prevent OOM;
  `--forceExit` in npm scripts; coverage enforcement; artifact version fixes.

## [2.0.5] - 2026-02-26

_See [GitHub Release v2.0.5](https://github.com/iLevyTate/StratoSortStack/releases/tag/v2.0.5) for
release notes._

## [2.0.4] - 2026-02-23

### Fixed

- **E2E Stability**: Added Linux CI sandboxing bypass and resolved missing Range header clear bugs
  in vector DB tests.
- **Path Handling**: Updated file utilities to use `win32.basename` for consistent filename
  retrieval across platforms.
- **OCR fallback**: Gracefully handle missing `sharp` native module during PDF extraction.
- **UI glitches**: Resolved phase rendering issues and model setup wizard initial loading states.
- **Settings synchronization**: Synced config state across main/renderer boundaries; watchers now
  reliably observe valid settings.
- **Storage**: Healed legacy "Uncategorized" folder paths and resolved smart folder UI bugs.
- **Naming conventions**: Centralized naming logic and fixed casing bugs with non-ASCII characters.

### Improved

- **Verification**: Added scripts for verifying IPC handlers, native modules, packaged artifacts,
  and updater metadata.
- **Performance**: Cached parsed chat conversations (LRU) to avoid repeated JSON overhead.
- **Performance**: Optimized search graph node filtering and ELK parallel edge rendering.
- **Build**: Enhanced release preflight checks and enforced macOS/Windows code signing checks in CI.

## [2.0.2] - 2026-02-15

### Changed

- **Release pipeline run**: Prepared a patch release to trigger fresh Windows and macOS release
  workflows with the current packaging pipeline and artifact conventions.

## Release Checklist

See [docs/RELEASING.md](docs/RELEASING.md) for versioning, runtime staging, checksums, and release
notes.

## [2.0.1] - 2026-02-13

### Fixed

- **macOS startup stability**: Prevented app launch failure when `lz4-napi` native bindings are
  unavailable in packaged environments by adding a shared codec wrapper with graceful fallback.
- **Persistence startup path hardening**: Updated vector DB, analysis history, and embedding queue
  persistence modules to use safe LZ4 codec loading instead of hard-failing at module import time.

## [2.0.0] - 2026-02-09

### Changed (BREAKING)

- **In-Process AI Engine**: Replaced external Ollama server with **node-llama-cpp** for fully
  in-process LLM inference. All text, vision, and embedding models now run on-device via GGUF files
  with automatic GPU acceleration (Metal, CUDA, Vulkan) and CPU fallback. No external services
  required.
- **In-Process Vector Database**: Replaced external ChromaDB server with **Orama** for in-process
  vector storage and hybrid search. BM25 full-text and vector similarity are combined via Reciprocal
  Rank Fusion (RRF). Indexes persist atomically with LZ4 compression.
- **Electron 40+**: Upgraded from Electron 35 to Electron 40 with modern security defaults.
- **Zero External Dependencies**: The application is now fully self-contained. No Ollama, ChromaDB,
  or any other external server is needed. All processing happens on-device with zero data leaving
  the machine.

### Removed

- **Ollama Integration**: All Ollama client code, connection management, and configuration removed.
- **ChromaDB Integration**: All ChromaDB client code, server health checks, and configuration
  removed.
- **Deprecated Settings**: Legacy `ollamaUrl`, `chromadbUrl`, and related connection settings are
  ignored on upgrade (cleaned up by `SettingsMigrator`).

### Added

- **LlamaService**: Centralized in-process LLM inference service with model switching, memory
  management, and GPU/CPU backend selection.
- **LlamaResilience**: Circuit breaker, retry, and timeout guard for all AI inference calls.
- **ModelAccessCoordinator**: Coordinates concurrent model access to prevent conflicts during model
  switching.
- **Content Selector**: Intelligent document content selection for LLM analysis with token budget
  awareness.
- **Crash Reporting**: Local `electron-crashReporter` only (`crash-dumps/` under userData, no
  upload).
- **Test Coverage Enforcement**: 50% global thresholds (branches/functions/lines/statements)
  enforced in CI.

### Improved

- **Code Quality**: Consolidated 11 categories of duplicate, conflicting, and dead code:
  - Unified temp-file patterns into single canonical set in `performanceConstants.js`
  - Unified file-ID generators (`getSemanticFileId` delegates to `getCanonicalFileId`)
  - Disambiguated path normalization variants (`sanitizePathValue` vs `resolveFsPath`)
  - Replaced 15+ inline `setTimeout` delays with shared `delay()` utility
  - Centralized error classifiers (lifecycle delegates to `errorClassifier.js`)
  - Unified fallback analysis factories (`analysisUtils` delegates to `fallbackUtils`)
  - Replaced hardcoded RRF constant with `SEARCH.RRF_K` from `performanceConstants`
  - Replaced hardcoded retry counts with `RETRY.*` constants across 6 files
  - Consolidated duplicate `Semaphore` classes (single implementation in `RateLimiter.js`)
  - Removed dead no-op functions and commented-out code
  - Replaced ad-hoc `pLimit` with `Semaphore`-based concurrency limiter
- **Production Builds**: Console logs stripped from production bundles via Terser `drop_console`.
- **Security Documentation**: Updated known production gaps in `CLAUDE.md` to reflect resolved items
  (crash reporting, test coverage enforcement).

## [1.2.2] - 2026-01-29

### Improved

- **UI Consistency**: Standardized typography, spacing tokens, and button styles across renderer
  views.
- **Search & Graph UX**: Aligned metadata labels, banners, and empty states to shared Text/Heading
  components.

### Fixed

- **Organize UI**: Restored missing Button import in ReadyFileItem to prevent runtime crashes.

## [1.2.1] - 2026-01-27

### Added

- **Settings Backup & Restore**: Added backup service with import/export and restore UI.
- **User Data Migration**: Recover legacy settings/history/undo state before service startup.
- **Embedding Summaries**: Centralized embedding summary builder for richer semantic matching.

### Improved

- **Search & Chat**: Tuned hybrid retrieval, memory handling, and fallback responses.
- **Smart Folder Watcher**: Enhanced embedding metadata for better folder suggestions.
- **IPC & Validation**: Expanded schemas and hardened settings import validation.

### Fixed

- **Auto-Updater**: Listener cleanup and download progress reporting.
- **Settings Recovery**: Safer corruption recovery and backup integrity checks.

## [1.2.0] - 2026-01-26

### Added

- **UNC Path Support**: Enhanced support for network paths (UNC) in setup, analysis, and watchers.
- **Demo Mode**: Implemented demo mode with path redaction and UI updates.
- **Organization Workflow**: Revamped organization workflow UI.
- **Discovery Phase**: Enhanced discovery phase UI and performance.

### Improved

- **Modernized UI**: Major updates to core UI components, styling, application shell, and global
  components.
- **Settings**: Modernized settings and dependency panels.
- **Analysis**: Improved folder scanning and network path resilience.

## [1.1.0] - 2026-01-23

### Added

- **Smart Folder Watcher**: Automatically analyzes new and modified files in configured smart
  folders (F-1)
- **Undo History Navigation**: Jump to specific points in undo history (L-2)
- **Retry Mechanism**: "Retry Failed Files" button in Discover phase (M-3)
- **Conflict Detection**: Warning banner when multiple files target the same destination path (M-4)
- **AI Description Generation**: "Generate with AI" button for smart folders (C-1)
- **Enhanced Graph Visualization**:
  - **Color-Coded Nodes**: Files in the Knowledge Graph are now color-coded by category
    (Blue=Documents, Purple=Images, etc.) for instant visual recognition.
  - **"Relationship Analysis" Tooltips**: Hovering over connection lines now explains _why_ files
    are connected (e.g., "Both Images", "Same Subject", "Shared Tags").
  - **Improved Layout**: Switched to `BRANDES_KOEPF` algorithm for straighter, more organized graph
    structures with better handling of outliers.
  - **Robust Data Handling**: Graph nodes now robustly display metadata even if underlying search
    results are nested or incomplete.
- **UI Spacing Improvements**:
  - Implemented `spacious` (32px) layout density in Setup Phase for a cleaner, less cluttered look.
  - Standardized grid gaps and padding across main views.
- Comprehensive test coverage for IPC handlers (settings.js, suggestions.js)
- SECURITY.md with vulnerability disclosure policy
- This CHANGELOG.md file
- E2E tests for semantic search functionality
- E2E tests for smart folder creation and verification
- DevTools auto-open in separate window during development (`npm run dev`)
- Error boundary around AnalysisResultsList to prevent crashes from malformed file data
- `getErrorMessage()` utility for consistent error extraction
- Centralized UI timeout constants (WIDGET_AUTO_SHOW, EMBEDDING_CHECK, STUCK_ANALYSIS_CHECK)

### Fixed

- **Critical**: Smart Folder Watcher race condition where watcher was null during IPC registration
  (NEW-1)
- **Critical**: DownloadWatcher starting before services initialized (C-2)
- **High**: Confidence slider resetting to 75% due to state race conditions (NEW-5/12)
- **High**: Undo/Redo UI not updating despite filesystem changes (H-3)
- **High**: Smart folder path loading race condition showing "Documents" string (H-1)
- **Medium**: Embeddings showing "0" count due to missing auto-refresh (NEW-2/9)
- **Medium**: "File in use" errors during auto-organize (NEW-4)
- **Medium**: Settings debounce flushing on close (H-2)
- **Medium**: Modal backdrop blur/z-index conflicts (F-3, M-1)
- **Medium**: Image files missing keywords in analysis history (NEW-10)
- **Medium**: Watcher reporting high confidence for unrelated files (NEW-11)
- **Critical**: LLM cache contamination causing wrong filename suggestions across file types
  - Added type discriminators (`type: 'document'` / `type: 'image'`) to cache keys
  - Added filename and content length to cache keys for uniqueness
  - Enhanced cache hit logging for debugging
- **Critical**: Stale closure in bulk category change causing wrong files to be updated
  - Used refs to always get latest values at debounce execution time
- **Critical**: Race condition in undo/redo system allowing concurrent action execution
  - Added mutex lock to prevent overlapping operations
  - Exposed `isExecuting` state for UI feedback
- **Critical**: UI Persistence issue where KnowledgeOS would reopen with only the file search
  visible
  - Switched `WIDGET_AUTO_SHOWN_KEY` and `MODAL_OPEN_STATE` to `localStorage` for robust state
    persistence across restarts.
- **Build System**: Fixed stale cache issues in development causing "Cannot find module" errors by
  adding a pre-build `clean` step.
- Toast timer reset when parent component re-renders with new callback reference
  - Used ref for onClose callback to maintain timer stability
- ResizeObserver not attaching when container ref is null on first render
  - Switched to callback ref pattern for proper observation
- localStorage access crashes in private browsing mode
  - Wrapped all localStorage operations in try-catch
- Infinite loop potential in persistence middleware
  - Added re-entry guard to prevent recursive saves
- UndoStack listener cleanup on component remount
  - Added mounted state tracking to prevent setState on unmounted components
- Error handling in FloatingSearchContext useEffect
- ProcessingStateService timestamp updates on save
- ESLint warnings in test files
- Navigation selector in E2E tests to target phase navigation buttons specifically
- Unused `useCallback` import in SearchAutocomplete.jsx

### Improved

- **UI**: Replaced emojis with professional Lucide icons (UI-2)
- **UI**: Removed technical "File size limit" settings from UI (UI-1)
- **UI**: Temporarily removed confidence slider to prevent race conditions (NEW-12)
- Accessibility: Added `aria-live="polite"` to AnalysisProgress for screen readers
- Replaced hardcoded timeout values with centralized constants

## [1.0.0] - 2024-12-XX

### Added

#### Core Features

- **AI-Powered Document Organization**: Local LLM analysis using in-process models (llama, llava)
- **Semantic Search**: Vector-based file search using Orama embeddings
- **Smart Folders**: AI-suggested organization with pattern learning
- **Multi-modal Analysis**: Support for documents (PDF, Word, Excel), images, and code files
- **Batch Processing**: Organize multiple files simultaneously with progress tracking
- **Auto-Organization**: Watch folder monitoring (e.g., Downloads) for automatic sorting

#### User Interface

- Modern React UI with TailwindCSS styling
- Dark/Light/System theme support
- Floating search widget for quick file discovery
- Interactive graph visualization for file relationships
- Drag-and-drop file organization
- Keyboard shortcuts for common operations

#### Organization Intelligence

- Content-based file categorization
- Extension pattern matching
- User behavior learning from accepted suggestions
- Multiple organization strategies (by type, date, project, etc.)
- Confidence scoring for suggestions

#### Data Management

- Settings backup and restore functionality
- Settings import/export with validation
- Undo/redo system for file operations
- Analysis history caching for performance

#### Developer Experience

- Comprehensive test suite (76%+ coverage, 4800+ tests)
- ESLint and Prettier configuration
- CI/CD pipeline with GitHub Actions
- Extensive documentation

### Security

- Context isolation enabled for Electron renderer
- Input validation using Zod schemas
- Path sanitization to prevent traversal attacks
- Prototype pollution protection in settings import
- No external network requests (privacy-first design)

### Technical

- Electron 35+ with modern security defaults
- React 19 with Redux Toolkit for state management
- Webpack 5 build system with code splitting
- Jest and Playwright testing infrastructure
- Multi-platform builds (Windows, macOS, Linux)

---

## Version History Format

### Types of Changes

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features that will be removed in future versions
- **Removed**: Features that have been removed
- **Fixed**: Bug fixes
- **Security**: Security-related changes

Note: versions before 5.0.0 were released from predecessor repositories whose tags are not part of
this repository's history, so they are listed without links.

[Unreleased]: https://github.com/iLevyTate/StratoSortStack/compare/v5.2.0...HEAD
[5.2.0]: https://github.com/iLevyTate/StratoSortStack/compare/v5.1.2...v5.2.0
[5.1.2]: https://github.com/iLevyTate/StratoSortStack/compare/v5.1.1...v5.1.2
[5.1.1]: https://github.com/iLevyTate/StratoSortStack/compare/v5.1.0...v5.1.1
[5.1.0]: https://github.com/iLevyTate/StratoSortStack/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/iLevyTate/StratoSortStack/releases/tag/v5.0.0
