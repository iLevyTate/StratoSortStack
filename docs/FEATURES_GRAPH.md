---
layout: single
title: 'Knowledge Graph Features'
sidebar:
  nav: 'docs'
---

## Overview

The **Knowledge Graph** in StratoSort Stack provides an interactive visualization of your document
organization. It moves beyond simple file lists to show you how your documents are connected
semantically.

## Core Features

### Interactive Visualization

- **React Flow Integration**: Smooth, zoomable canvas interface.
- **Auto-Layout**: Uses ELK algorithms to organize nodes intelligently.
- **Context Menus**: Right-click a file node for Open File, Reveal in Folder, Find Similar, Focus on
  Node and Show Related Documents. Right-click a cluster for Expand/Collapse cluster, Tag Cluster,
  Create Smart Folder, Move All to Folder and Export File List. Other nodes (the query node,
  suggested-folder nodes, duplicate groups) have no context menu; a suggested-folder node has its
  own toolbar for moving its connected files there or revealing the folder.

### Semantic Clustering

The graph doesn't just show files; it shows _meaning_.

- **Similarity Edges**: Lines connect files that are semantically similar, with thickness indicating
  strength of relationship.
- **Clusters**: Files are automatically grouped into color-coded clusters based on topic.
- **Query Nodes**: When you search, your query appears as a central node, showing exactly which
  files match your intent.

### Exploration Tools

- **Double-click**: Double-clicking a cluster expands it into its member files. Double-clicking a
  file selects it and adds its similar files to the graph (as many hops as the hop setting allows).
  Double-clicking other nodes does nothing.
- **Focus Mode**: "Focus on Node" (file context menu, or the Focus button in the details panel)
  centers the graph on one node and its nearby connections.
- **Expansion**: Dynamically load more connections as you explore "hops" away from your starting
  point.
- **Find similar**: The context-menu **Find Similar** adds similar files to the graph. The details
  panel's **Find similar** button is different: it switches to the Search tab with a
  `similar to: <file name>` query.
- **Filtering**: Use the legend to toggle visibility of clusters, file types, or confidence levels.

## Technical Implementation

### Frontend (`Renderer`)

- `src/renderer/components/search/UnifiedSearchModal.jsx`: The Knowledge OS modal and its tabs
  (Search, Chat, Timeline, Relate, Atlas).
- `src/renderer/components/search/GraphTabContent.jsx` + `search/hooks/useGraphTab.js`: The Relate
  tab — the React Flow canvas, layout, expansion and graph interactions.
- `src/renderer/hooks/useGraphState.js`: Node/edge state used by `useGraphTab`.

### Backend (`Main Process`)

- `ClusteringService`: Builds clusters and similarity edges (exposed via the `embeddings:*` IPC in
  `semantic.js`).
- `RelationshipIndexService` + `EdgeAggregator`: Knowledge-graph edges (knowledge IPC).
- `OramaVectorService`: Provides the raw vector data and similarity scores.
- `SearchService`: Backs query-node search within the graph. (Optional result reranking is handled
  by `ReRankerService`, off by default — it is not part of graph edge construction.)

## Usage Guide

1.  **Search**: Start by typing a query in the search bar (Ctrl+K / Cmd+K).
2.  **Visual Results**: Switch to the Relate tab or use "View in Graph" to see your results
    visualized.
3.  **Explore**:
    - **Click** a node to select it.
    - **Double-click** a cluster to expand it, or a file to add its similar files.
    - **Drag** nodes to rearrange your view.
4.  **Action**: Right-click a file to open or reveal it, or a cluster to tag, move or export its
    files. To act on an organization suggestion, select the suggested-folder node and use its
    toolbar.

## Other Knowledge OS views

**Atlas** (map) and **Timeline** (files by date) live in the same Knowledge OS surface as this
graph. They read the same analysis: Atlas places similar files nearby; Timeline sorts by content
date. See [USER_GUIDE.md](USER_GUIDE.md#5-knowledge-os-search-chat-graph-map).
