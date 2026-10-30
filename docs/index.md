---
layout: splash
title: 'StratoSort Stack'
permalink: /
excerpt:
  'Organize, search and chat with your files using AI that runs on your own computer. Free for
  personal use.'
header:
  overlay_color: '#0b1220'
  actions:
    - label: 'Download'
      url: 'https://github.com/iLevyTate/StratoSortStack/releases'
      btn_class: 'btn--primary btn--large'
    - label: 'Install Guide'
      url: '/INSTALL_GUIDE.html'
      btn_class: 'btn--inverse btn--large'

features:
  - image_path: /assets/showcase/review.webp
    alt: 'Review & Organize screen with suggested names and folders for each file'
    title: 'Organize by content'
    excerpt:
      'StratoSort reads what is inside each file, then suggests a clear name and the right folder.
      You review every suggestion before anything moves, and every move can be undone.'
    url: '/USER_GUIDE.html'
    btn_label: 'User Guide'
    btn_class: 'btn--inverse'
  - image_path: /assets/showcase/search.webp
    alt: 'Search results for a plain-language query'
    title: 'Search by meaning'
    excerpt:
      'Ask for "how warming affects wildlife" and find the report even if those words are not in its
      name. Exact matches like an invoice number still work.'
    url: '/USER_GUIDE.html'
    btn_label: 'How search works'
    btn_class: 'btn--inverse'
  - image_path: /assets/showcase/chat.webp
    alt: 'Chat answering a question with sources from your files'
    title: 'Chat with your documents'
    excerpt:
      'Ask questions in plain language and get answers built from your own files, with the sources
      they came from.'
    url: '/USER_GUIDE.html'
    btn_label: 'Learn more'
    btn_class: 'btn--inverse'

more_features:
  - image_path: /assets/showcase/graph.webp
    alt: 'Relate graph showing how files connect'
    title: 'See how files connect'
    excerpt:
      'Relate draws your files as a graph so you can follow links between related documents, spot
      near-duplicates and find clusters.'
    url: '/FEATURES_GRAPH.html'
    btn_label: 'Graph features'
    btn_class: 'btn--inverse'
  - image_path: /assets/showcase/smart-folders.webp
    alt: 'Adding a Smart Folder with a plain-language description'
    title: 'Smart Folders'
    excerpt:
      'Describe a folder in plain words, such as "invoices and receipts", and new files that match
      are routed into it.'
    url: '/USER_GUIDE.html'
    btn_label: 'Set up folders'
    btn_class: 'btn--inverse'
  - image_path: /assets/showcase/mcp.webp
    alt: 'MCP Server settings'
    title: 'Use it from other AI tools'
    excerpt:
      'Turn on the local MCP server to let Claude Desktop, Cursor or Zed search your files, without
      those tools uploading them.'
    url: '/MCP_SERVER.html'
    btn_label: 'MCP Server'
    btn_class: 'btn--inverse'
---

## Watch the 45-second tour

<figure class="video-figure">
  <video controls width="100%" preload="metadata" poster="{{ '/assets/showcase/review.webp' | relative_url }}">
    <source src="{{ '/walkthrough-assets/how-to-use.mp4' | relative_url }}" type="video/mp4">
    Your browser cannot play this video. <a href="{{ '/walkthrough-assets/how-to-use.mp4' | relative_url }}">Download it instead.</a>
  </video>
  <figcaption>From first launch to an organized folder: add files, review the suggestions, move them, then search and chat.</figcaption>
</figure>

## Get started in three steps

1. **Download** the installer for Windows, macOS or Linux from
   [GitHub Releases](https://github.com/iLevyTate/StratoSortStack/releases).
2. **Launch it** and pick a model profile. StratoSort downloads its AI models once (about 7 GB, or
   about 10 GB for the higher-quality profile).
3. **Add a folder** and review what StratoSort suggests.

No terminal, Python, Docker or API keys. The [Install Guide](INSTALL_GUIDE.html) covers each
platform, security prompts and troubleshooting.

## What it does

{% include feature_row id="features" %}

{% include feature_row id="more_features" %}

## Private by design

- **Runs on your computer.** Analysis, search and chat use AI models stored on your machine. There
  is no StratoSort account or cloud service.
- **No telemetry.** The app sends no analytics or crash reports.
- **Network use is limited and listed.** After the one-time model download, the only automatic
  connection is the update check, which you can turn off. Every connection is documented in
  [Network Transparency](NETWORK_TRANSPARENCY.html).
- **Cloud AI is optional.** You can add your own Anthropic or OpenAI-compatible key for some tasks;
  search and embeddings always stay local. See [Cloud AI Providers](AI_PROVIDERS.html).
- **Works offline.** Once the models are installed, StratoSort runs without internet, including on
  [machines that never go online](INSTALL_GUIDE.html#offline-and-air-gapped-install).

## Documentation

| If you want to…                         | Read                                                 |
| :-------------------------------------- | :--------------------------------------------------- |
| Install StratoSort                      | [Install Guide](INSTALL_GUIDE.html)                  |
| Learn the app                           | [User Guide](USER_GUIDE.html)                        |
| See every screen                        | [Screen-by-Screen Walkthrough](E2E_WALKTHROUGH.html) |
| Know exactly what goes over the network | [Network Transparency](NETWORK_TRANSPARENCY.html)    |
| Use it for work                         | [Commercial Licensing](COMMERCIAL.html)              |
| Build or contribute to it               | [Getting Started (developers)](GETTING_STARTED.html) |

StratoSort Stack is free for personal and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](https://github.com/iLevyTate/StratoSortStack/blob/main/LICENSE).
Commercial use needs a [paid license](COMMERCIAL.html).
