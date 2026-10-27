---
layout: single
title: 'Install Guide'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/11_welcome_with_background_download.webp
  caption: 'Get StratoSort up and running'
---

> Last verified for v4.0.3 on 2026-06-11. Current release is **v5.0.0**; installer filenames and OS
> prompts may differ slightly on newer builds.

# StratoSort Stack -- Install Guide

**One download. No command line. No extra software. No API keys.**

StratoSort Stack uses AI that runs entirely on your computer. Nothing is sent to the cloud. You
download one installer, let the app grab its AI models on first launch, and you are ready to go.

---

## What You Need

| Requirement    | Details                                                                        |
| :------------- | :----------------------------------------------------------------------------- |
| **Windows**    | Windows 10 or 11, 64-bit                                                       |
| **macOS**      | macOS 10.15+ on Apple Silicon (M1 / M2 / M3 / M4)                              |
| **Linux**      | 64-bit x86; AppImage or .deb (when attached to a release)                      |
| **RAM**        | 8 GB minimum; 16 GB and a GPU with 8 GB for the Better Quality profile         |
| **Disk space** | ~500 MB for the app, plus 7 to 11 GB for AI models (downloaded inside the app) |
| **Internet**   | Needed once to download AI models; the app runs fully offline afterward        |

---

## Step 1 -- Download One File

Go to **[StratoSort Stack Releases](https://github.com/iLevyTate/StratoSortStack/releases)** and
download the single file that matches your operating system.

### Which file do I pick?

| Your computer                       | Download this file                             |
| :---------------------------------- | :--------------------------------------------- |
| **Windows PC** (any 64-bit)         | **`StratoSortStack-Setup-X.X.X.exe`**          |
| **Mac** (Apple Silicon M1/M2/M3/M4) | **`StratoSortStack-X.X.X-mac-arm64.dmg`**      |
| **Linux** (if artifact is attached) | **`StratoSortStack-X.X.X-linux-x64.AppImage`** |

Replace **X.X.X** with the version number shown on the Releases page (e.g. `5.0.0`).

### Windows -- installer vs portable

| File                                  | What it does                                                                             | Recommended?                                        |
| :------------------------------------ | :--------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| **`StratoSortStack-Setup-X.X.X.exe`** | Full installer -- creates Start Menu and desktop shortcuts, supports future auto-updates | Yes                                                 |
| `StratoSortStack-X.X.X-win-x64.exe`   | Portable -- runs without installing, no shortcuts, no auto-update                        | Only if you cannot install software on your machine |

### Linux -- AppImage vs .deb

| File                                           | What it does                                                 |
| :--------------------------------------------- | :----------------------------------------------------------- |
| **`StratoSortStack-X.X.X-linux-x64.AppImage`** | Universal, no install needed -- just make executable and run |
| `StratoSortStack-X.X.X-linux-x64.deb`          | Standard Debian/Ubuntu package installed via `dpkg`          |

Linux artifacts are optional and may not be attached to every release. Neither format auto-updates;
download the next version from Releases when one is available.

---

## Step 2 -- Install and Launch

### Windows

1. Double-click **`StratoSortStack-Setup-X.X.X.exe`**.
2. If Windows SmartScreen says **"Windows protected your PC"**:
   - Click **More info**.
   - Click **Run anyway**.
3. The installer opens. Click **Next**, then **Install**.
   - The app installs to your user profile (no admin required).
   - A **Start Menu** shortcut and a **Desktop** shortcut are created automatically.
4. When the installer finishes, leave **"Run StratoSort Stack"** checked and click **Finish**.

<!-- prettier-ignore -->
**Why SmartScreen?** Beta and unsigned builds trigger SmartScreen because they are not yet code-signed. This is normal for pre-release software. If the checksum matches (see optional step below), the file is safe.
{: .notice--warning}

### macOS

1. Double-click the **`.dmg`** file.
2. Drag **StratoSort Stack** into the **Applications** folder.
3. Eject the DMG (right-click in Finder sidebar, select **Eject**).
4. Open **StratoSort Stack** from **Applications**.

<!-- prettier-ignore -->
**v4.0.0 and later:** macOS builds are signed with **Developer ID Application** and **notarized** by Apple. A normal double-click open should work on first launch.

5. If macOS still blocks the app (older unsigned preview builds, or a download that failed
   notarization):
   - **Easiest:** Right-click the app in Applications, click **Open**, then click **Open** again.
   - **Alternative:** Go to **System Settings** > **Privacy & Security** > scroll down > click
     **Open Anyway**.

<!-- prettier-ignore -->
**Why Gatekeeper?** Builds before v4.0.0 and unsigned CI artifacts may require the bypass above. Always verify the SHA256 checksum on the release page before installing.
{: .notice--warning}

### Linux (AppImage)

```bash
chmod +x StratoSortStack-X.X.X-linux-x64.AppImage
./StratoSortStack-X.X.X-linux-x64.AppImage
```

Or double-click the file in your file manager after making it executable.

### Linux (Debian package)

```bash
sudo dpkg -i StratoSortStack-X.X.X-linux-x64.deb
```

Then launch **StratoSort Stack** from your application menu. The `.deb` version does not
auto-update; download the next version from
[Releases](https://github.com/iLevyTate/StratoSortStack/releases) when available.

---

## Step 3 -- First Launch: AI Model Setup

The first time you open StratoSort, a **Model Setup Wizard** appears. This downloads the AI models
the app needs to analyze and organize your files. It is a one-time download; after this the app
works fully offline.

### 3a. Choose a profile

The wizard shows two profiles:

| Profile                     | Best for                                                     | Download size |
| :-------------------------- | :----------------------------------------------------------- | :------------ |
| **Base (Small & Fast)**     | All computers, including older machines and CPU-only systems | ~7.4 GB       |
| **Better Quality (Larger)** | 16 GB+ RAM and a GPU with 8 GB or more                       | ~10.4 GB      |

The wizard reads your RAM and GPU memory and marks the profile this computer can carry; pick either
one and click **Download Models**. Both profiles include the same LLaVA vision model (about 5 GB
with its projector), which is most of the download.

### 3b. Wait for downloads

You will see progress bars for each model file. There are three models:

- **Embedding model** -- converts text into vectors for semantic search (required).
- **Text analysis model** -- reads documents and generates descriptions (required).
- **Vision model** -- analyzes images and screenshots (optional).

All models are GGUF files stored locally on your computer. Nothing is sent anywhere.

### 3c. Done

When all downloads finish, click **Get Started**. You are now on the Welcome screen.

**Can I skip this?** Yes. Click **Continue with limited AI** to explore the app immediately. AI
features activate once the models finish downloading in the background. You can also open the wizard
later from **Settings** > **AI Configuration**.

---

## Step 4 -- Start Organizing

From the Welcome screen you have three options:

| Button                      | What it does                                                            |
| :-------------------------- | :---------------------------------------------------------------------- |
| **Organize files now**      | Opens the Discover phase where you add files or folders for AI analysis |
| **AI & model settings**     | Opens Settings to change models or preferences                          |
| **Configure smart folders** | Choose which folders StratoSort is allowed to organize into             |

A typical first session: click **Organize files now**, drag in a folder, and let the AI analyze the
files. StratoSort never moves a file without your approval.

---

## Optional -- Verify Your Download

Download the matching checksum file from the same Releases page:

- Windows: `checksums-windows.sha256`
- macOS: `checksums-macos.sha256`

Then compare:

### Windows (PowerShell)

```powershell
Get-FileHash .\StratoSortStack-Setup-X.X.X.exe -Algorithm SHA256
```

### macOS / Linux (Terminal)

```bash
shasum -a 256 StratoSortStack-X.X.X-mac-arm64.dmg
```

The hash should match the entry in the checksum file exactly.

---

## How Updates Work

There are two kinds of updates -- they are independent of each other:

| What                                         | How it works                                                                                                                                                                                                |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App updates** (new versions of StratoSort) | In-app auto-update when the project enables a public feed. Until then, download new installers from [Releases](https://github.com/iLevyTate/StratoSortStack/releases). Your settings and models carry over. |
| **AI model updates**                         | Managed inside the app via **Settings** > **AI Configuration**. Models are large files from Hugging Face; they are not part of the installer.                                                               |

You never need to re-download models when you update the app.

<!-- prettier-ignore -->
**Note:** Portable `.exe`, Linux artifacts, and some ad-hoc builds do not use the same app update channel as the full installer; check release notes. See [CONFIG.md](CONFIG.md#application-auto-updates-electron-updater) and [RELEASING.md](RELEASING.md#application-auto-updates-temporary).
{: .notice--info}

---

## Where Does StratoSort Store Data?

| Data                          | Location                                                                                                                                 |
| :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings, logs, databases** | `%APPDATA%\StratoSort Stack` (Windows) / `~/Library/Application Support/StratoSort Stack` (macOS) / `~/.config/StratoSort Stack` (Linux) |
| **AI models**                 | Inside the above folder under `models/` (7 to 11 GB)                                                                                     |
| **Your files**                | StratoSort reads files in place and only moves them when you approve a suggestion. It never copies or uploads your files.                |

StratoSort never sends data over the internet after the initial model download.

---

## Troubleshooting

### Windows: "This app has been blocked for your protection"

Click **More info** then **Run anyway**. If the option is missing, your organization may block
unsigned apps -- install on a personal device or contact your IT admin.

### macOS: App won't open even after Right-click > Open

Go to **System Settings** > **Privacy & Security**, scroll to the Security section, and click **Open
Anyway** next to StratoSort Stack.

### macOS: "StratoSort Stack is damaged and can't be opened"

The quarantine attribute may not have been cleared. Run in Terminal:

```bash
xattr -cr /Applications/StratoSort\ Core.app
```

Then open the app again.

### Models failed to download

- Check your internet connection.
- Retry from **Settings** > **AI Configuration** > **Model Management** > **Download Models**.
- Make sure you have at least 12 GB of free disk space.
- If downloads keep failing, check if a firewall or VPN is blocking `huggingface.co`.

### Vision / image analysis not working

Open **Settings** > **AI Configuration** and check that the vision model shows as downloaded. If it
is missing, download it from the model management section.

### App feels slow

- Switch to the **Base (Small & Fast)** profile for lower memory usage.
- Close other memory-heavy applications.
- If you have a dedicated GPU (NVIDIA, AMD, or Apple Silicon), StratoSort uses it automatically.

---

## Security

StratoSort Stack:

- Runs 100% locally after the one-time model download.
- Does not collect, send, or store any data externally.
- Is licensed under PolyForm Noncommercial 1.0.0 (personal/noncommercial use is free; commercial use
  needs a paid license). There is no trial and nothing expires. Source:
  [github.com/iLevyTate/StratoSortStack](https://github.com/iLevyTate/StratoSortStack).

---

## Quick Summary

| Step             | What you do                                                                                 |
| :--------------- | :------------------------------------------------------------------------------------------ |
| **1. Download**  | One file from [Releases](https://github.com/iLevyTate/StratoSortStack/releases) for your OS |
| **2. Install**   | Run the installer; allow it if your OS shows a security prompt                              |
| **3. First run** | Choose a model profile and download AI models (7 to 11 GB, one time)                        |
| **4. Organize**  | Add files, review AI suggestions, approve moves                                             |

**No terminal. No Python. No Docker. No API keys. No cloud.**

---

## Next Steps

- **Learn the app:** [User Guide](USER_GUIDE.md)
- **Help test and report bugs:** [Tester Guide](BETA_TESTER_GUIDE.md)
