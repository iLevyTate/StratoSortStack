---
layout: single
title: 'E2E Walkthrough'
toc: false
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/17_knowledge_os_full.webp
  caption: 'Complete Walkthrough'
---

# StratoSort Stack — End-to-End Walkthrough

> **Current product is v4.0.6.** Screenshots below are current stills from `npm run tour:record`
> (Windows, dark theme). Knowledge OS tabs are **Search**, **Chat**, **Timeline**, **Relate**, and
> **Atlas**. Settings includes Experience, Appearance, AI Provider, MCP Server, License, and Legal
> notices. Some Settings subsections share the Simple-mode still when a dedicated panel shot is not
> in the tour set.

A visual guide to every screen and feature in StratoSort Stack. Each section maps to one phase of the
app workflow. The full clip is [how-to-use.mp4](./walkthrough-assets/how-to-use.mp4).

<!-- prettier-ignore -->
**Platform shown:** Current recorded tour (Windows). Installers also ship for macOS and Linux.
{: .notice--info}

---

## Table of Contents

1. [First Launch & Model Setup](#1-first-launch--model-setup)
2. [Welcome Phase](#2-welcome-phase)
3. [Setup Phase — Smart Folders](#3-setup-phase--smart-folders)
4. [Discover Phase — File Analysis](#4-discover-phase--file-analysis)
5. [Organize Phase — Review & Execute](#5-organize-phase--review--execute)
6. [Complete Phase — Summary](#6-complete-phase--summary)
7. [Search & Knowledge Graph](#7-search--knowledge-graph)
8. [Settings — Full Reference](#8-settings--full-reference)
9. [Videos](#9-videos)

---

## 1. First Launch & Model Setup

On first launch, StratoSort checks for AI models in `~/.config/StratoSort Stack/models/`. If required
models are missing, a setup wizard guides you through downloading them.

### Model Selection

On first launch a setup wizard can download models. The recorded tour stills start after that wizard
(models already present). The running app still shows:

The wizard presents installation profiles and lets you choose which models to install:

| Model Type                                  | Purpose                                       | Required? |
| :------------------------------------------ | :-------------------------------------------- | :-------- |
| **Embedding Model** (Nomic Embed Text v1.5) | Converts text to vectors for semantic search  | Yes       |
| **Text Analysis Model** (Qwen / Llama)      | Analyzes documents and generates descriptions | Yes       |
| **Vision Model** (LLaVA)                    | Analyzes images and screenshots               | Optional  |

{% include figure image_path="/assets/e2e-screenshots/13_model_setup_wizard_detailed.webp" alt="Model setup wizard" caption="First-launch model setup — pick a profile, then download local GGUF models" %}

The wizard shows installation status for each model (Installed / Not installed) with download size
estimates. Three action buttons are available:

- **Download Models** — begins downloading selected models
- **Refresh** — re-checks local model availability
- **Continue with limited AI** — skips setup and enters the app immediately

### Download Progress

During download, you see per-model progress bars with download speed and completion percentage. You
can continue using the app while models download in the background.

{% include figure image_path="/assets/e2e-screenshots/10_model_download_wizard.webp" alt="Settings" caption="After first launch, model and AI provider controls live in Settings" %}

---

## 2. Welcome Phase

After model setup (or if models are already present), you land on the Welcome screen.

{% include figure image_path="/assets/e2e-screenshots/01_welcome_screen.webp" alt="Welcome Screen" caption="Welcome screen — entry point with quick actions to import files or add a folder" %}

### Navigation Bar

The top bar is always visible and contains:

- **StratoSort logo** with connection status indicator (green = AI engine ready)
- **Phase tabs:** Welcome → Setup → Discover → Organize → Complete
- **Search button** — opens the floating search widget / Knowledge Graph
- **Settings gear** — opens the configuration panel
- **Window controls** — minimize, maximize, close

### Welcome Actions

| Action                        | What It Does                                             |
| :---------------------------- | :------------------------------------------------------- |
| **Organize files now**        | Jumps straight to Discover with smart defaults           |
| **AI & model settings**       | Opens the Settings panel to the AI Configuration section |
| **Configure smart folders**   | Goes to the Setup phase                                  |
| **How does StratoSort work?** | Opens a modal explaining the 3-step flow                 |

### How StratoSort Works Modal

Clicking "How does StratoSort work?" reveals the three core steps:

{% include figure image_path="/assets/e2e-screenshots/02_how_stratosort_works_modal.webp" alt="How StratoSort Works" caption="'How it Works' onboarding modal — Setup, Discover, Organize, Complete" %}

1. **Discover** — Drop folders, run system scans, or watch Downloads automatically
2. **Analyze** — Local AI reads file contents, context, and prior choices
3. **Organize** — Approve suggestions, rename intelligently, undo instantly

---

## 3. Setup Phase — Smart Folders

Smart Folders are the destinations the AI uses to organize your files. Each folder has a name, path,
and description that the AI reads to decide where files belong.

{% include figure image_path="/assets/e2e-screenshots/03_setup_smart_folders.webp" alt="Setup Phase" caption="Setup phase — configure Smart Folders that are watched and auto-organized" %}

### Default Folder

A default "Uncategorized" folder is created at `~/StratoSort/Uncategorized` for files that don't
match any other folder.

### Adding a Smart Folder

Click **+ Add Folder** to open the Add Smart Folder dialog:

{% include figure image_path="/assets/e2e-screenshots/04_add_smart_folder_dialog.webp" alt="Setup Smart Folders" caption="Setup phase with Smart Folders listed — use Add Folder to create a new destination" %}

| Field                      | Description                                                                            |
| :------------------------- | :------------------------------------------------------------------------------------- |
| **Folder Name** (required) | Display name — e.g., "Invoices", "Photos", "Projects"                                  |
| **Target Path** (optional) | Filesystem path. Auto-fills based on name and default location                         |
| **Description**            | Plain-language description of what files belong here. The AI uses this to match files. |

The **Generate with AI** button can auto-create a description based on the folder name.

### Tips

- Create folders around real outcomes: `Invoices`, `Receipts`, `Screenshots`, `Contracts`
- Write descriptions as if telling a coworker what goes in each folder
- You can edit or delete folders anytime
- **Reset to Defaults** restores the default folder set
- At least one folder is required before continuing

Click **Continue to Discovery** when finished.

---

## 4. Discover Phase — File Analysis

This phase is where you add files for AI analysis. StratoSort reads file contents, extracts meaning,
and generates organization suggestions.

{% include figure image_path="/assets/e2e-screenshots/05_discover_phase.webp" alt="Discover Phase" caption="Discover phase — import files individually or via folder scan before AI analysis begins" %}

### Adding Files

Two methods to add files:

#### Select Files

Opens a file picker. Navigate to any directory, select individual files or use Ctrl+A to select all,
then confirm.

{% include figure image_path="/assets/e2e-screenshots/08_file_selection_dialog.webp" alt="Discover" caption="Discover — Select files or Scan folder to add content for analysis" %}

#### Scan Folder

Opens a folder picker. Select any directory and StratoSort automatically discovers all supported
files within it.

{% include figure image_path="/assets/e2e-screenshots/31_scan_folder_picker.webp" alt="Discover" caption="Discover — Scan folder recursively imports supported file types from a directory" %}

### Analysis Progress

Once files are added, AI analysis begins automatically:

{% include figure image_path="/assets/e2e-screenshots/09_analysis_in_progress.webp" alt="Discover analysis" caption="Discover while analysis starts — progress and toasts appear as files are read locally" %}

The progress bar shows:

- **File counter** — "Analyzing X of Y" with percentage
- **Current file** — which file is being processed
- **Stop Analysis** button — halt processing at any time

Toast notifications confirm actions:

- "Added N new files for analysis"
- "Starting AI analysis of N files..."

### Analysis Complete

When analysis finishes, a completion banner appears with:

- Green status dot with "Analysis complete · 5 ready"
- Toast notification: "Analysis complete! 5 files ready"
- Results summary: "5 successful, 0 failed"
- **Clear Queue** button to reset

The app automatically advances to the Organize phase once analysis is done.

### Naming Strategy

Click **Naming Strategy** in the upper right to configure how files are renamed:

{% include figure image_path="/assets/e2e-screenshots/06_naming_strategy_modal.webp" alt="Discover" caption="Discover — naming strategy is configured from this phase before or during import" %}

| Setting         | Options                                       | Default      |
| :-------------- | :-------------------------------------------- | :----------- |
| **Convention**  | subject-date, date-subject, subject-only      | subject-date |
| **Date Format** | YYYY-MM-DD, MM-DD-YYYY, DD-MM-YYYY            | YYYY-MM-DD   |
| **Case**        | kebab-case, snake_case, camelCase, Title Case | kebab-case   |
| **Separator**   | dash, dot, underscore, none                   | dash         |

A live **Preview** shows the resulting filename format.

### Knowledge Graph Panel

Click **Knowledge Graph** to open the semantic search and relationship panel:

{% include figure image_path="/assets/e2e-screenshots/07_knowledge_os_panel.webp" alt="Knowledge OS" caption="Knowledge OS — Search, Chat, Timeline, Relate, and Atlas" %}

Current tabs:

- **Search** (was Discover) — Natural language and keyword search
- **Chat** (was Understand) — Ask questions about your documents
- **Timeline** — Analyzed files by date
- **Relate** — Knowledge Graph of clusters and similarity edges
- **Atlas** — Map of the library (nearby = similar)

The panel needs embeddings. Rebuild from Settings → AI Configuration if search is empty.

---

## 5. Organize Phase — Review & Execute

After analysis, the Organize phase shows AI-generated suggestions for each file. You review and
approve where each file should be moved and what it should be renamed to.

<!-- prettier-ignore -->
**Note:** The Organize tab is only accessible after files have been analyzed in the Discover phase. Navigation is enforced — the tab shows a count badge and a tooltip explaining why it may be disabled.
{: .notice--info}

### File Grid with AI Suggestions

{% include figure image_path="/assets/e2e-screenshots/34_organize_phase_ai_suggestions.webp" alt="Organize Phase" caption="AI suggestions panel — review proposed moves and renames, then confirm or dismiss each" %}

Each file card shows:

- **Original filename** with "Ready" badge
- **Suggested Name** — AI-generated filename following your naming convention
- **Category** dropdown — editable destination folder
- **Confidence level** — color-coded percentage (green = high)
- **Details** link — view the full AI analysis

Example AI suggestions from a real analysis:

| Original File            | Suggested Name                            | Confidence |
| :----------------------- | :---------------------------------------- | :--------- |
| invoice-2026-0042.txt    | consulting-invoice-2026-02-27.txt         | 100%       |
| meeting-notes.txt        | product-plan-session-notes-2026-02-27.txt | 95%        |
| onboarding-checklist.txt | onboarding-checklist-2026-02-27.txt       | 100%       |

### Batch Operations

Click **Select All** to check all files, then use:

- **Approve Selected** — Accept AI suggestions for all selected files
- **Bulk Edit** — Change category or name pattern for multiple files at once
- **Deselect All** — Clear the selection

### Additional Features

- **Status Overview** — Summary modal showing ready/pending/conflict counts
- **Conflict Detection** — Highlights files with duplicate destination paths
- **Execute Organization** — Moves and renames files according to approved suggestions
- **Undo/Redo** — Full undo history for all organization operations
- **Processed Files** — History of already-organized files

---

## 6. Complete Phase — Summary

{% include figure image_path="/assets/e2e-screenshots/56_complete_phase.webp" alt="Organization Complete" caption="Complete phase — moved/analyzed counts, session summary, undo, and open organized folder" %}

After executing organization, the Complete phase shows a summary of:

- Total files organized
- Destination folders used
- Any errors or conflicts encountered
- Option to start a new session or undo recent changes

---

## 7. Search & Knowledge Graph

### Search Widget

Click the **Search** button in the navigation bar to open the floating search widget:

{% include figure image_path="/assets/e2e-screenshots/16_search_widget.webp" alt="Knowledge OS Search" caption="Knowledge OS Search — Ctrl+K / Cmd+K from anywhere in the app" %}

The widget provides:

- Quick explanation of Knowledge Graph capabilities
- **Open Knowledge Graph** button to launch the full interface
- Keyboard shortcut: **Ctrl+K** from anywhere in the app

### Knowledge Graph Full Interface

After files are analyzed and embedded, Knowledge Graph shows indexed content:

{% include figure image_path="/assets/e2e-screenshots/36_knowledge_os_indexed.webp" alt="Knowledge Graph Indexed" caption="Knowledge Graph with index ready — file count badge and search input active" %}

The status bar shows "1 folder · 5 files indexed" confirming embeddings are built. Search tips guide
users on natural language queries.

#### Searching for Files

Type a keyword or natural language description in the search bar:

Type a keyword such as `invoice` or a natural-language phrase such as
`meeting notes about product planning`. Results list files with type badges and relevance. Preview,
View in Graph, and Ask AI actions sit on the selected file.

{% include figure image_path="/assets/e2e-screenshots/37_knowledge_os_search_invoice.webp" alt="Search for invoice" caption="Knowledge OS Search — keyword query with preview and actions on the selected file" %}

{% include figure image_path="/assets/e2e-screenshots/38_knowledge_os_search_natural_language.webp" alt="Natural-language search" caption="Knowledge OS Search — natural-language query over the same index" %}

#### Search Tab (Default)

- **Search bar** — Describe what you're looking for in natural language
- **Results list** — Files ranked by semantic relevance with confidence scores
- **File preview** — Content preview, tags, and actions on the right
- **Status indicators** — Folder count and indexed file count
- **View in Graph** — Visualize relationships between search results

#### Chat Tab — AI conversational chat

{% include figure image_path="/assets/e2e-screenshots/46_understand_tab_chat.webp" alt="Chat Tab" caption="Chat tab — ask questions about your documents; answers cite local sources" %}

The Chat tab is a retrieval-backed chat interface for asking questions about your documents in
natural language.

Features:

- **New Chat** button to start a conversation
- **Search chats** to find past conversations
- **Chat input** — "Ask a question about your documents (e.g., 'Summarize my tax returns')..."
- **Ctrl+Enter** to send messages

When you ask a question, the AI:

1. Searches your indexed documents for relevant sources
2. Shows "Searching documents..." then "Found N relevant sources..."
3. Generates a contextual answer using the matched content

{% include figure image_path="/assets/e2e-screenshots/48_understand_ai_found_sources.webp" alt="Chat found sources" caption="Chat — retrieval lists local sources, then the answer cites them" %}

#### Relate Tab — Knowledge Graph Visualization

{% include figure image_path="/assets/e2e-screenshots/50_relate_tab_cluster.webp" alt="Relate Tab" caption="Relate tab — Knowledge Graph with color-coded topic clusters and similarity edges" %}

The Relate tab provides an interactive Knowledge Graph for exploring relationships between your
documents. The interface has three panels:

**Left Panel — Graph Controls:**

- **Current graph** stats (Nodes, Links, Filters)
- **Insights** — AI-generated organizational analysis
- **Add to Graph** — Search and add files to the visualization
- **Explore** / **Actions** / **Advanced** sections

**Center — Graph Canvas:**

- Interactive node-link diagram with clusters
- **Clusters On/Off** toggle
- Zoom (+/−) and pan controls
- Double-click clusters to expand into individual files

**Right Panel — Legend & Node Details:**

- Node type legend: Cluster (orange), File (blue), Query (purple)
- Connection types: Shared Tags, Same Category, Content Match, Vector Similarity
- File category colors: Documents, Images, Audio, Spreadsheets, Code, Videos
- Cluster confidence indicators

#### Cluster Exploration

Clicking a cluster shows file count, why files were grouped, and per-file connection reasons.
Double-clicking expands individual file nodes. Insights cover topic clusters, bridge documents,
near-duplicates, and scattered files.

{% include figure image_path="/assets/e2e-screenshots/51_relate_cluster_details.webp" alt="Cluster details" caption="Relate — cluster details with why files were grouped" %}

{% include figure image_path="/assets/e2e-screenshots/53_relate_insights.webp" alt="Relate insights" caption="Relate — insights for topic clusters, bridges, and near-duplicates" %}

{% include figure image_path="/assets/e2e-screenshots/54_relate_full_graph_legend.webp" alt="Relate" caption="Relate — graph canvas, controls, and legend. Clustering needs at least 3 indexed files." %}

#### Atlas

{% include figure image_path="/assets/e2e-screenshots/55_atlas.webp" alt="Atlas" caption="Atlas — map of the library; nearby files are similar. First projection can take a moment." %}

### Building the Search Index

Knowledge Graph requires embeddings to function. Embeddings are generated automatically during
analysis when "Embedding Timing" is set to "During analysis" (the default). Two manual rebuild
options are also available:

- **Build Folder Embeddings** — Index files in Smart Folders
- **Build File Embeddings** — Index all analyzed files

**Timeline** sorts analyzed files by date. **Atlas** maps the library so nearby files are similar.

---

## 8. Settings — Full Reference

Click the **gear icon** (⚙) in the navigation bar to open Settings. Start with **Simple** unless you
need Advanced panels (models, retrieval, diagnostics).

Current groups: Experience, Appearance, AI Provider, MCP Server, AI Configuration, Performance,
Default locations, Application (includes License, About, Legal notices), Analysis history, and
Diagnostics (Advanced). The still shows Simple mode; switch to Advanced for models, retrieval, and
diagnostics.

{% include figure image_path="/assets/e2e-screenshots/14_settings_panel_top.webp" alt="Settings Panel" caption="Settings — Simple mode with Experience, Appearance, and AI Provider" %}

### 8.1 AI Configuration

#### Local AI Engine

{% include figure image_path="/assets/e2e-screenshots/19_settings_ai_config_engine.webp" alt="AI Configuration" caption="Settings — local AI engine status, GPU toggle, and default models" %}

- **Status badge** — Shows "Ready (cpu)" or "Ready (gpu)" with model count
- **GPU Acceleration** — Toggle between CPU-only and GPU-accelerated inference
- **Refresh Models** / **View All Models** — Manage available GGUF model files

#### Default AI Models

- **Text Model** — The LLM used for document analysis (e.g., Qwen, Llama)
- **Vision Model** — The model used for image analysis (e.g., LLaVA)
- **Embedding Model** — The model used for vector search (e.g., Nomic Embed)

#### Model Management

{% include figure image_path="/assets/e2e-screenshots/20_settings_ai_model_management.webp" alt="Model management" caption="Settings — download and switch GGUF models from the registry" %}

Download additional GGUF models by entering the exact filename from the model registry.

#### Embedding Behavior

| Setting                            | Options                                  | Default            |
| :--------------------------------- | :--------------------------------------- | :----------------- |
| **Embedding Scope**                | All analyzed files, Organized files only | All analyzed files |
| **Embedding Timing**               | During analysis, After organization      | During analysis    |
| **Default Embedding Policy**       | Embed locally, Skip                      | Embed locally      |
| **Auto-generate Chunk Embeddings** | On/Off toggle                            | On                 |

**Rebuild All Embeddings** — Use after changing embedding models. Preserves analysis data while
regenerating the search index.

{% include figure image_path="/assets/e2e-screenshots/21_settings_embedding_maintenance.webp" alt="Embedding maintenance" caption="Settings — embedding scope, timing, and rebuild" %}

### 8.2 Performance

{% include figure image_path="/assets/e2e-screenshots/22_settings_performance_auto_organize.webp" alt="Performance and auto-organize" caption="Settings — auto-organize, background mode, and processing limits" %}

#### Auto-Organize

- **Auto-organize Downloads** — Automatically analyze and organize new files in your Downloads
  folder
- **Smart Folder Routing** — Choose routing strategy:
  - Auto (starts LLM-only, shifts to hybrid as embeddings build)
  - LLM-only
  - Embedding-first
  - Hybrid

#### Background Mode

- **Background Mode** — Keep StratoSort running in the system tray when the window closes

#### Processing Limits

- **Concurrent Analysis** — Maximum simultaneous file analyses (default: 1)
- **Max file sizes** — Separate limits for images (100 MB), documents (200 MB) and text files (50
  MB; larger text files are analyzed from their first 50 MB)

#### Graph Retrieval

{% include figure image_path="/assets/e2e-screenshots/23_settings_graph_retrieval.webp" alt="Graph retrieval" caption="Settings — graph expansion weight and neighbor limits for search" %}

- **Enable Graph Expansion** — Use relationship edges to pull related files into search results
- **Graph Expansion Weight** — Slider (0–100%) controlling how much graph neighbors influence
  ranking (default: 20%)
- **Graph Neighbors Limit** — Maximum neighbor files per query (default: 120)
- **Contextual Chunk Expansion** — Use adjacent chunks for more context

### 8.3 Default Locations

{% include figure image_path="/assets/e2e-screenshots/24_settings_default_locations.webp" alt="Default locations" caption="Settings — default Smart Folder location" %}

- **Default Smart Folder Location** — Base path where new Smart Folders are created (default: home
  directory)
- **Browse** button — Select a different base path

#### File Naming Defaults

{% include figure image_path="/assets/e2e-screenshots/25_settings_naming_defaults.webp" alt="Naming defaults" caption="Settings — default rename strategy for watchers and reanalyze" %}

Controls how files are renamed by Download Watcher, Smart Folder Watcher, and Reanalyze All Files.
Same options as the Naming Strategy modal in Discover.

### 8.4 Application

#### Application Preferences

{% include figure image_path="/assets/e2e-screenshots/26_settings_application.webp" alt="Application preferences" caption="Settings — launch on startup, updates, and license" %}

- **Launch on Startup** — Auto-start StratoSort when you log in
- **Software Updates** — Check for new versions with one click

#### Notifications

{% include figure image_path="/assets/e2e-screenshots/27_settings_notifications.webp" alt="Notifications" caption="Settings — in-app and tray notification events" %}

- **Enable Notifications** — Master toggle
- **Display Mode:**
  - App and system tray (Recommended)
  - App only (in-window toasts)
  - System tray only
- **Notification Events:**
  - Auto-analyzed files — Notify when smart folder/download watchers analyze files
  - Low confidence files — Notify when confidence is below the auto-organize threshold

#### Settings Backup & Restore

{% include figure image_path="/assets/e2e-screenshots/28_settings_backup_restore.webp" alt="Backup and restore" caption="Settings — export, import, and restore settings backups" %}

- **Create Backup** — Save current settings to backup history
- **Export to File** — Export settings as a portable file
- **Import from File** — Restore settings from an export
- **Available Backups** — List of timestamped backups with restore and delete actions

### 8.5 Analysis History

{% include figure image_path="/assets/e2e-screenshots/29_settings_analysis_history.webp" alt="Analysis history" caption="Settings — past analysis results and statistics" %}

- **View Analysis History** — Opens a viewer showing past analysis results and statistics
- Useful for reviewing what the AI detected and how files were categorized

### 8.6 Diagnostics

{% include figure image_path="/assets/e2e-screenshots/30_settings_diagnostics.webp" alt="Diagnostics" caption="Settings — log export and backend API tests" %}

#### Troubleshooting Logs

- **Open Folder** — Opens the log directory in your file manager
- **Export Logs** — Creates a log bundle for support tickets

#### Backend API Test

- **Test All APIs** — Runs connectivity checks against all core services (LLM, vector DB, file
  system, etc.)

---

## 9. Videos

The current how-to-use recording covers first launch through Organize, Complete, Knowledge OS, and
Settings.

<figure class="video-figure">
  <video controls width="100%" preload="metadata">
    <source src="{{ site.baseurl }}/walkthrough-assets/how-to-use.mp4" type="video/mp4">
    Your browser does not support HTML5 video. <a href="{{ site.baseurl }}/walkthrough-assets/how-to-use.mp4">Download the video.</a>
  </video>
  <figcaption>How to organize files with StratoSort — recorded first-run session</figcaption>
</figure>

Regenerate with `npm run tour:record`. See
[HOW_TO_USE_TOUR.md](./walkthrough-assets/HOW_TO_USE_TOUR.md).

---

## Linux-Specific Notes

### Running the AppImage

```bash
# Make executable
chmod +x StratoSortStack-X.X.X-linux-x86_64.AppImage

# Launch
./StratoSortStack-X.X.X-linux-x86_64.AppImage
```

### Models Directory

Models are stored in `~/.config/StratoSort Stack/models/`. The app creates this directory
automatically and downloads models on first launch.

### Settings Location

Application settings are stored in `~/.config/StratoSort Stack/settings.json`.

### System Tray

On Linux, Background Mode places StratoSort in the system tray. Requires a tray-compatible desktop
environment (GNOME with AppIndicator, KDE, XFCE).
