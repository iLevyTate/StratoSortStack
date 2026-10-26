---
layout: single
title: 'Tester Guide'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/09_analysis_in_progress.webp
  caption: 'Testing Guide'
---

# StratoSort Stack — Tester Guide

**Goal:** Install the app, use it like you would for real work, then tell us what breaks or feels
confusing. No coding and no command line required (optional Linux tip below).

---

## At a glance

| Step  | What you do                                                                         |
| :---- | :---------------------------------------------------------------------------------- |
| **1** | [Download](#1-download-one-installer) the installer for your computer               |
| **2** | [Install & open](#2-install-and-open-the-app) the app                               |
| **3** | Complete [first-run AI setup](#3-first-launch-ai-setup) (downloads models once)     |
| **4** | Run through the [test checklist](#test-checklist-one-session) (about 20–45 minutes) |
| **5** | [Report problems](#report-a-bug) with steps + screenshots + logs if possible        |

**Links:** [Downloads (GitHub Releases)](https://github.com/iLevyTate/StratoSortStack/releases) ·
[E2E Walkthrough](./E2E_WALKTHROUGH.md) (stills + how-to clip) · [Install Guide](./INSTALL_GUIDE.md)
(detailed install help) ·
[Report a bug](https://github.com/iLevyTate/StratoSortStack/issues/new?template=bug_report.md) ·
[All issues](https://github.com/iLevyTate/StratoSortStack/issues)

---

## Who this is for

You’re a good fit if you can install software, use StratoSort for normal file tasks, and describe
what went wrong in a few clear steps.

Personal/noncommercial use is free, with no trial and nothing to activate. Commercial use needs a
key, entered in **Settings → License**.

No sign-up is needed: download the public release and send feedback through
[GitHub Issues](https://github.com/iLevyTate/StratoSortStack/issues).

---

## 1. Download one installer

1. Open **[GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases)**.
2. Pick the newest release and find the assets for your OS (current product version is **5.0.0**).
3. Download **exactly one app installer/package** for your OS (do not download checksum or `.yml`
   files unless asked).

**What is happening**

- You are selecting the correct build for your operating system so install and updates behave as
  expected.

**What you should see**

- App installers/packages attached to the release (`.exe`, `.dmg`, `.AppImage`) plus separate
  checksum/update files.

| Your computer                              | Typical filename pattern                   |
| :----------------------------------------- | :----------------------------------------- |
| **Windows** (64-bit, preferred)            | `StratoSortStack-Setup-5.0.0.exe`          |
| **Windows** (portable / alt build)         | `StratoSortStack-5.0.0-win-x64.exe`        |
| **Mac** (Apple Silicon: M1 / M2 / M3 / M4) | `StratoSortStack-5.0.0-mac-arm64.dmg`      |
| **Linux** (64-bit)                         | `StratoSortStack-5.0.0-linux-x64.AppImage` |

Filenames on GitHub Releases may include a slightly different arch suffix. Always take the
**newest** installer for your OS, not an older `2.0.8` drop.

**Notes**

- **Windows:** Prefer `StratoSortStack-Setup-….exe` for normal installs.
- **Mac:** Apple Silicon and Intel builds both ship. Prefer the `arm64` DMG on M1–M4.
- **Linux:** Use the `.AppImage` build.
- **Do not install:** `checksums-*.sha256`, `latest (1).yml`, `latest-mac-arm64.yml`, or `.blockmap`
  files (these are update metadata/integrity files, not installers).

---

## 2. Install and open the app

**What is happening**

- You are installing the desktop app and running it for the first time on your OS.

**What you should see**

- An OS install/open flow (installer window, drag-to-Applications, or executable permission prompt)
  followed by the StratoSort launch screen.

### Windows

1. Double-click `StratoSortStack-Setup-….exe`.
2. If **Windows SmartScreen** warns you: click **More info** → **Run anyway** (common for new apps).
3. Finish the installer, then start **StratoSort Stack** from the Start menu or desktop shortcut.

### macOS

1. Open the `.dmg`, drag **StratoSort Stack** into **Applications**.
2. Open the app from Applications. If macOS says it can’t be opened: **Control-click** the app →
   **Open** → **Open** again in the dialog.

### Linux (AppImage)

1. **If double-click doesn’t run the app:** Right-click the file → **Properties** → **Permissions**
   → turn on **Allow executing file as program** (wording varies by distro). Then double-click
   again.
2. **Optional (terminal):** `chmod +x StratoSortStack-*.AppImage` then run it.

More detail: [Install Guide](./INSTALL_GUIDE.md).

---

## 3. First launch (AI setup)

The first time you open StratoSort, an **AI Model Setup** wizard runs.

1. Pick a profile:
   - **Base (Small & Fast)** — smaller download, works on most PCs.
   - **Better Quality (Larger)** — larger download; best if you have plenty of RAM and a GPU.
2. Wait until downloads finish (progress is shown in the app).
3. Click **Get Started** when it’s ready.

**What is happening**

- Local AI models are being configured so analysis/search can run fully on-device.

**What you should see**

- A setup wizard, download progress, and a completion action when model initialization finishes.

Models stay **on your device**; nothing is sent to the cloud for this step. You can change models
later under **Settings → AI Configuration**.

---

## Test checklist (one session)

Use this in order. Check items off mentally or on paper. **Real folders** (Downloads, projects,
photos) give better feedback than empty test folders.

For screens and the how-to clip, use the [E2E Walkthrough](./E2E_WALKTHROUGH.md) while you work
through this checklist.

### Welcome

- [ ] App launches without a blocked UI. Welcome actions and phase tabs are visible.
- [ ] **How does StratoSort work?** lists Setup → Discover → Organize → Complete.
- [ ] **You should see:** Search, Knowledge OS, and Settings reachable from the header.

### Setup (Smart Folders)

- [ ] Create **3–5 Smart Folders** with clear names and descriptions.
- [ ] **Notice:** Is it obvious how to add, edit, and remove folders? Anything confusing?
- [ ] **You should see:** Saved folders listed clearly with working add/edit/remove controls.

### Discover (analyze files)

- [ ] Add a **mix** of files: PDFs, images, screenshots, Office-style docs if you have them.
- [ ] Start analysis and let it run.
- [ ] **Notice:** Do results make sense? Reasonable categories? Acceptable speed?
- [ ] **You should see:** Analysis progress updates and completed items with AI-generated
      suggestions.

### Organize

- [ ] Accept **some** move suggestions and **reject** others; try **rename** options if shown.
- [ ] **Notice:** Are destinations correct? Do renames match what you expected?
- [ ] **You should see:** Review queue items changing state after approve/reject, and files landing
      in expected folders.

### Complete

- [ ] After a batch move, check moved / analyzed counts against what you approved.
- [ ] **Notice:** Is undo still available? Does “open organized folder” land in the right place?
- [ ] **You should see:** Counts that match the session, with undo still reachable.

### Knowledge OS (search, chat, graph)

- [ ] Open search (**Ctrl+K** on Windows/Linux, **⌘K** on Mac), or use the header search control.
- [ ] Try a few **natural-language** questions about your files.
- [ ] In **Chat**, ask a question about a file you just analyzed.
- [ ] Open **Relate** (graph) and **Atlas** if files are indexed.
- [ ] **Notice:** Useful results? Chat cites local files? Graph/map load without freezing?
- [ ] **You should see:** Relevant search matches, a cited chat answer, and a graph or map that
      responds to click/select.

### Settings

- [ ] Open **Settings** and skim each main area (AI, performance, locations, application).
- [ ] **Notice:** Do toggles work? Any label you don’t understand?
- [ ] **You should see:** Changes save/apply cleanly and remain after closing/reopening settings.

### Undo / redo

- [ ] After organizing, use **undo**, then **redo**, then **undo** again.
- [ ] **Notice:** Do files actually return to the right places? Any mistakes in history?
- [ ] **You should see:** File locations and history entries update correctly with each undo/redo
      action.

**Tip:** When something feels wrong, stop and note **what you clicked** and **what you expected** —
that becomes your bug report.

---

## Report a bug

Open a
[bug report on GitHub](https://github.com/iLevyTate/StratoSortStack/issues/new?template=bug_report.md).
Do not attach documents or logs that contain private information; GitHub issues are public.

### Always include

1. **Short title** — what broke + where (e.g. “Organize: undo doesn’t restore PDF to original
   folder”).
2. **Steps** — numbered list from app launch to the problem (someone else should repeat them).
3. **Expected** — what you thought would happen.
4. **Actual** — what happened instead.
5. **Your setup:**
   - OS (e.g. Windows 11, macOS 15, Ubuntu 24.04)
   - App version (**Settings → About** or the app title area)
   - Installer vs portable (if you know)
   - For AI/speed issues: rough RAM and GPU model

### Add if you can

- Screenshot or **short screen recording**.
- **Exported logs** (strongly helps us fix crashes and “nothing happens” bugs).

### Export logs (in the app)

1. **Settings → Application**
2. Under **Troubleshooting Logs**, click **Export Logs**
3. Save the file (Desktop is fine)
4. Attach it to the GitHub issue and write one line of context, e.g. _“Crashed right after clicking
   Organize.”_

**If you prefer manual files**

- **Windows:** `%APPDATA%\StratoSort Stack\logs\`
- **macOS:** `~/Library/Application Support/StratoSort Stack/logs/`
- **Linux:** `~/.config/StratoSort Stack/logs/`

### Example (good bug report)

**Title:** Search returns no results after changing embedding model

**Steps:**

1. Settings → AI Configuration
2. Change the embedding model, save
3. Open Knowledge OS and search for a phrase you know exists

**Expected:** Results appear, or the app asks to rebuild the index.

**Actual:** Empty results and a warning about model mismatch.

**Environment:** Windows 11, StratoSort Stack 2.0.x (installer), 32 GB RAM, RTX 3060.

**Attachment:** Exported logs from Settings → Export Logs.

---

## Other ways to help (no code)

- Confirm someone else’s bug on **your** OS and version (“Reproduced on macOS 15 / app 2.0.x”).
- Test each new release and note **regressions** (things that used to work).
- Suggest UX improvements with **screenshots** and short before/after notes.

---

## Want to contribute code later?

See **[Contributing](https://github.com/iLevyTate/StratoSortStack/blob/main/CONTRIBUTING.md)**.
Testing today still helps a lot.
