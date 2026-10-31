---
layout: single
title: 'Install Guide'
sidebar:
  nav: 'docs'
---

**One download. No command line. No extra software. No API keys.**

StratoSort Stack uses AI that runs entirely on your computer. Your files are not sent to the cloud
unless you turn on optional cloud AI with your own API key. You download one installer, let the app
grab its AI models on first launch, and you are ready to go.

---

## What You Need

| Requirement    | Details                                                                                                                                                                             |
| :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**    | Windows 10 (22H2) or 11, x64 or arm64                                                                                                                                               |
| **macOS**      | macOS 13 (Ventura) or later, Apple Silicon (arm64) or Intel (x64)                                                                                                                   |
| **Linux**      | x64 or arm64; AppImage or .deb (when attached to a release)                                                                                                                         |
| **RAM**        | 8 GB minimum; 16 GB and a GPU with 8 GB for the Better Quality profile                                                                                                              |
| **Disk space** | About 671 MB to download for the v5.0.0 installer (the Windows zip is larger) and about 1.8 GB on disk for the app, plus about 7 to 10 GB for AI models (downloaded inside the app) |
| **Internet**   | Needed once to download AI models; after that the app works offline (it still checks for app updates if online)                                                                     |

---

## Step 1 -- Download One File

Go to **[StratoSort Stack Releases](https://github.com/iLevyTate/StratoSortStack/releases)** and
download the single file that matches your operating system.

### Which file do I pick?

| Your computer                             | Download this file                                |
| :---------------------------------------- | :------------------------------------------------ |
| **Windows PC** (x64, most PCs)            | **`StratoSortStack-Setup-X.X.X.exe`**             |
| **Windows on Arm** (arm64)                | **`StratoSortStack-Setup-X.X.X-arm64.exe`**       |
| **Mac** (Apple Silicon M1/M2/M3/M4)       | **`StratoSortStack-X.X.X-mac-arm64.dmg`**         |
| **Mac** (Intel)                           | **`StratoSortStack-X.X.X-mac-x64.dmg`**           |
| **Linux** x64 (if artifact is attached)   | **`StratoSortStack-X.X.X-linux-x86_64.AppImage`** |
| **Linux** arm64 (if artifact is attached) | **`StratoSortStack-X.X.X-linux-arm64.AppImage`**  |

Replace **X.X.X** with the version number shown on the Releases page (e.g. `5.1.0`). The Windows
arm64 build ships without bundled FFmpeg, so audio/video analysis there needs FFmpeg on your `PATH`.

### Windows -- installer vs zip

| File                                  | What it does                                                                                              | Recommended?                                        |
| :------------------------------------ | :-------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- |
| **`StratoSortStack-Setup-X.X.X.exe`** | Full installer -- creates Start Menu and desktop shortcuts, updates itself                                | Yes                                                 |
| `StratoSortStack-X.X.X-win-x64.zip`   | No-install copy -- extract it once, then run `StratoSort Stack.exe`; no shortcuts, does not update itself | Only if you cannot install software on your machine |

To use the zip:

1. Extract it once to a short folder such as `C:\StratoSort` (right-click the zip, **Extract All**,
   and type the folder). Do not run `StratoSort Stack.exe` from inside the zip window: Windows
   extracts only that one file to a temporary folder, and the app cannot start without the rest.
2. Start `StratoSort Stack.exe` from that folder. Right-click it and choose **Pin to Start** if you
   want a shortcut.

Keep the folder path short. The deepest file inside the app sits about 175 characters below the
folder you extract to (an estimate from the current dependencies), and Windows Explorer cannot
extract a file whose full path is longer than 260 characters, so a deep folder (a long user name
plus a synced or nested Downloads folder) can make the extraction fail partway with "path too long"
errors.

The first start after extracting can take 1 to 2 minutes while Windows Security scans the new files,
the same as after installing; later starts reuse the extracted folder. The zip copy never updates
itself: to move to a new version, close the app, delete the folder and extract the new zip in its
place. Your settings and models live in `%APPDATA%\StratoSort Stack` and are kept. The zip replaces
the portable `.exe` shipped up to v5.0.0, which unpacked about 1.8 GB into `%TEMP%` on every start.

### Linux -- AppImage vs .deb

| File                                              | What it does                                                               |
| :------------------------------------------------ | :------------------------------------------------------------------------- |
| **`StratoSortStack-X.X.X-linux-x86_64.AppImage`** | Universal, no install needed -- just make executable and run; auto-updates |
| `StratoSortStack-X.X.X-linux-amd64.deb`           | Standard Debian/Ubuntu package installed via `dpkg`; does not auto-update  |

On arm64 the files end in `-linux-arm64.AppImage` and `-linux-arm64.deb`. Linux artifacts are
optional and may not be attached to every release. The AppImage updates itself in the app; for the
`.deb`, download the next version from Releases when one is available.

---

## Step 2 -- Install and Launch

### Windows

1. Double-click **`StratoSortStack-Setup-X.X.X.exe`**.
2. If Windows SmartScreen says **"Windows protected your PC"**:
   - Click **More info**.
   - Click **Run anyway**.
3. The installer opens. Accept the license agreement, then click **Install**.
   - The app installs to your user profile (no admin required).
   - A **Start Menu** shortcut and a **Desktop** shortcut are created automatically.
4. When the installer finishes, leave **"Run StratoSort Stack"** checked and click **Finish**.
5. The first launch after installing can take 1 to 2 minutes while Windows Security scans the new
   files; later launches are faster.

<!-- prettier-ignore -->
**Why SmartScreen?** Release installers are signed by Kennedy Applied Sciences, Inc., but SmartScreen can still warn about a newly signed file until it builds download reputation; unsigned CI builds always warn. If the checksum matches (see optional step below), the file is safe.
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
chmod +x StratoSortStack-X.X.X-linux-x86_64.AppImage
./StratoSortStack-X.X.X-linux-x86_64.AppImage
```

Or double-click the file in your file manager after making it executable.

### Linux (Debian package)

```bash
sudo dpkg -i StratoSortStack-X.X.X-linux-amd64.deb
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
| **Base (Small & Fast)**     | All computers, including older machines and CPU-only systems | about 7 GB    |
| **Better Quality (Larger)** | 16 GB+ RAM and a GPU with 8 GB or more                       | about 10 GB   |

The wizard reads your RAM and GPU memory and marks the profile this computer can carry; pick either
one and click **Download models**. Both profiles include the same LLaVA vision model (about 5 GB
with its projector), which is most of the download.

The wizard also has a **Start in Advanced mode** checkbox. Leave it off to start in **Simple** mode,
which hides the advanced Settings panels; you can switch between Simple and Advanced in Settings at
any time.

### 3b. Wait for downloads

You will see progress bars for each model file. There are three models:

- **Embedding model** -- converts text into vectors for semantic search (required).
- **Text analysis model** -- reads documents and generates descriptions (required).
- **Vision model** -- analyzes images and screenshots (optional).

All models are GGUF files stored locally on your computer. Nothing is sent anywhere.

### 3c. Done

When all downloads finish, click **Continue**, then **Get started**. You are now on the Welcome
screen.

**Can I skip this?** Yes. Click **Continue with limited AI** to explore the app immediately. AI
features activate once the models finish downloading in the background. If you skip before
downloading, the Welcome screen offers **Open model setup** until you dismiss it; you can always
download the models later from **Settings** > **AI Configuration** > **Download recommended
models**.

---

## Step 4 -- Start Organizing

From the Welcome screen you have three options:

| Button                      | What it does                                                                                                                        |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **Organize files now**      | Opens the Discover phase where you add files or folders for AI analysis (sends you to Setup first if you have no Smart Folders yet) |
| **AI & model settings**     | Opens Settings to change models or preferences                                                                                      |
| **Configure smart folders** | Choose which folders StratoSort is allowed to organize into                                                                         |

A typical first session: click **Configure smart folders** and add a few folders with plain-language
descriptions (the built-in Uncategorized folder does not count), then go to **Discover**, drag in a
folder, and let the AI analyze the files. StratoSort never moves a file without your approval.

Below these buttons you can also pick a working style: **Guided steps** (Setup, Discover, Organize
one step at a time; the default) or **Dashboard** (a single overview screen). Switch later with the
Guided / Dashboard toggle in the top bar.

---

## Optional -- Verify Your Download

Download the matching checksum file from the same Releases page:

- Windows: `checksums-windows-x64.sha256` (or `checksums-windows-arm64.sha256`)
- macOS: `checksums-macos.sha256`
- Linux: `checksums-linux.sha256`

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

| What                                         | How it works                                                                                                                                                                                                                                                                                  |
| :------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App updates** (new versions of StratoSort) | Installed builds check [GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases) for a new version at startup and every 4 hours, and offer to install it. Turn this off in **Settings** > **Application** > **Background update checks**. Your settings and models carry over. |
| **AI model updates**                         | Managed inside the app via **Settings** > **AI Configuration**. Models are large files from Hugging Face; they are not part of the installer.                                                                                                                                                 |

You never need to re-download models when you update the app.

<!-- prettier-ignore -->
**Note:** The Windows installer, macOS builds and the Linux AppImage update in place. The Windows zip (and the portable `.exe` from v5.0.0 and earlier) and the Linux `.deb` cannot; download the next version from Releases. See [CONFIG.md](CONFIG.md#application-auto-updates-electron-updater) and [Network Transparency](NETWORK_TRANSPARENCY.md).
{: .notice--info}

---

## Where Does StratoSort Store Data?

| Data                          | Location                                                                                                                                 |
| :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings, logs, databases** | `%APPDATA%\StratoSort Stack` (Windows) / `~/Library/Application Support/StratoSort Stack` (macOS) / `~/.config/StratoSort Stack` (Linux) |
| **AI models**                 | Inside the above folder under `models/` (about 7 to 10 GB)                                                                               |
| **Your files**                | StratoSort reads files in place and only moves them when you approve a suggestion. It never copies or uploads your files.                |

After the model download, the only network traffic by default is the app update check described
above; your files and their contents stay on your computer unless you turn on optional cloud AI. See
[Network Transparency](NETWORK_TRANSPARENCY.md) for every network call the app can make.

---

## Offline and Air-Gapped Install

StratoSort runs without a network connection once its models are on disk. On a machine that can
never go online, copy the model files in by hand instead of letting the app download them.

**1. On a connected machine, download the installer and these files.** Save each one under the name
in the first column: the app finds models by exact filename, and some names differ from the file
name in the download URL.

| Save as                             | Needed for                               | Download from                                                                                                   | Size    |
| :---------------------------------- | :--------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :------ |
| `Llama-3.2-3B-Instruct-Q4_K_M.gguf` | Text analysis and chat (required)        | `https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf`    | ~2.0 GB |
| `all-MiniLM-L6-v2-Q4_K_M.gguf`      | Search embeddings (required)             | `https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-Q4_K_M.gguf` | ~21 MB  |
| `llava-v1.6-mistral-7b-Q4_K_M.gguf` | Image understanding (optional)           | `https://huggingface.co/cjpais/llava-1.6-mistral-7b-gguf/resolve/main/llava-v1.6-mistral-7b.Q4_K_M.gguf`        | ~4.4 GB |
| `mmproj-model-f16.gguf`             | Image understanding (with the above)     | `https://huggingface.co/cjpais/llava-1.6-mistral-7b-gguf/resolve/main/mmproj-model-f16.gguf`                    | ~624 MB |
| `whisper/ggml-base.en.bin`          | Audio and video transcription (optional) | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`                                    | ~148 MB |

These are the default **Base (Small & Fast)** models. The authoritative list, with every other
supported model, is `MODEL_CATALOG` in
[`src/shared/modelRegistry.js`](https://github.com/iLevyTate/StratoSortStack/blob/main/src/shared/modelRegistry.js).

**2. Check the files.** Compare each SHA-256 (see
[Verify Your Download](#optional----verify-your-download) for the commands) with the `checksum` for
that file in `modelRegistry.js`. The app verifies the files it downloads itself; it does not
re-check files you copy in.

**3. Install the app on the offline machine and copy the files in.** Put them in the `models/`
folder listed in [Where Does StratoSort Store Data?](#where-does-stratosort-store-data) (create it
if it does not exist yet), with the Whisper model in a `whisper/` folder inside it. Then launch the
app: it finds the files and skips the download.

**4. Turn off update checks.** In **Settings** > **Application**, turn off **Background update
checks**, or start the app with `STRATOSORT_ENABLE_AUTO_UPDATES=false` to disable the updater
entirely. To update, copy the next installer over from a connected machine.

The installers already include the image-analysis runtime and the OCR language data, so nothing else
needs a connection. Leave optional cloud AI off.

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
xattr -cr /Applications/StratoSort\ Stack.app
```

Then open the app again.

### Models failed to download

- Check your internet connection.
- Retry from **Settings** > **AI Configuration** > **Download recommended models** (Simple mode). In
  Advanced mode, use **Settings** > **AI Configuration** > **Model management** and click
  **Download** next to each model.
- Make sure you have at least 12 GB of free disk space.
- If downloads keep failing, check if a firewall or VPN is blocking `huggingface.co`.

### Vision / image analysis not working

Open **Settings** > **AI Configuration** and check that the vision model shows as downloaded. If it
is missing, download it with **Download recommended models**, or switch to Advanced mode and use the
**Model management** section.

### App feels slow

- Switch to the **Base (Small & Fast)** profile for lower memory usage.
- Close other memory-heavy applications.
- If you have a dedicated GPU (NVIDIA, AMD, or Apple Silicon), StratoSort uses it automatically.
- Task Manager showing 5 to 8 `StratoSort Stack.exe` entries is normal: Chromium runs the app as
  several processes (browser, renderer, GPU, utility), and short-lived GPU probe children start and
  exit during startup.
- To rule the GPU in or out, do two control runs from a terminal and compare how long the window
  takes to appear. `STRATOSORT_LLM_GPU_BACKEND=cpu` keeps AI inference on the CPU, and
  `STRATOSORT_FORCE_SOFTWARE_GPU=1` turns off hardware rendering for the window. In PowerShell on
  Windows:

  ```powershell
  $env:STRATOSORT_LLM_GPU_BACKEND = 'cpu'
  & "$env:LOCALAPPDATA\Programs\StratoSort Stack\StratoSort Stack.exe"
  ```

  then, in a fresh terminal, the same with `$env:STRATOSORT_FORCE_SOFTWARE_GPU = '1'`. If either run
  is clearly faster, see [GPU Configuration](CONFIG.md#gpu-configuration) and the
  `STRATOSORT_LLM_GPU_BACKEND` row in
  [CONFIG.md](CONFIG.md#llamacpp-binary-management-security-sensitive) for how to keep that setting.

---

## Security

StratoSort Stack:

- Runs AI locally after the one-time model download (cloud AI is optional and off by default).
- Has no telemetry and does not upload your files. By default its only network call after setup is
  the app update check; see [Network Transparency](NETWORK_TRANSPARENCY.md).
- Is licensed under PolyForm Noncommercial 1.0.0 (personal/noncommercial use is free; commercial use
  needs a paid license). There is no trial and nothing expires. Source:
  [github.com/iLevyTate/StratoSortStack](https://github.com/iLevyTate/StratoSortStack).

---

## Quick Summary

| Step             | What you do                                                                                 |
| :--------------- | :------------------------------------------------------------------------------------------ |
| **1. Download**  | One file from [Releases](https://github.com/iLevyTate/StratoSortStack/releases) for your OS |
| **2. Install**   | Run the installer; allow it if your OS shows a security prompt                              |
| **3. First run** | Choose a model profile and download AI models (about 7 to 10 GB, one time)                  |
| **4. Organize**  | Add files, review AI suggestions, approve moves                                             |

**No terminal. No Python. No Docker. No API keys required. Cloud AI is optional.**

---

## Next Steps

- **Learn the app:** [User Guide](USER_GUIDE.md)
- **Help test and report bugs:** [Tester Guide](BETA_TESTER_GUIDE.md)
