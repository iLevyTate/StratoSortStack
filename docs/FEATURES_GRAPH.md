---
layout: single
title: 'Knowledge Graph Features'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/54_relate_full_graph_legend.webp
  caption: 'Knowledge Graph & Semantic Clustering'
---

# Knowledge Graph Features

## Overview

The **Knowledge Graph** in StratoSort Core provides an interactive visualization of your document
organization. It moves beyond simple file lists to show you how your documents are connected
semantically.

## Core Features

### Interactive Visualization

- **React Flow Integration**: Smooth, zoomable canvas interface.
- **Auto-Layout**: Uses ELK algorithms to organize nodes intelligently.
- **Context Menus**: Right-click on any node for quick actions (Open, Reveal in Explorer, Organize).

### Semantic Clustering

The graph doesn't just show files; it shows _meaning_.

- **Similarity Edges**: Lines connect files that are semantically similar, with thickness indicating
  strength of relationship.
- **Clusters**: Files are automatically grouped into color-coded clusters based on topic.
- **Query Nodes**: When you search, your query appears as a central node, showing exactly which
  files match your intent.

### Exploration Tools

- **Focus Mode**: Double-click any node to center the graph on it and reveal its specific
  connections.
- **Expansion**: Dynamically load more connections as you explore "hops" away from your starting
  point.
- **Filtering**: Use the legend to toggle visibility of clusters, file types, or confidence levels.

## Technical Implementation

### Frontend (`Renderer`)

- `UnifiedSearchModal.jsx`: Main search modal and graph container (Discover, Relate, Understand
  tabs). Hosts the React Flow canvas, graph state, and search results.
- `src/renderer/hooks/useGraphState.js`: Manages the complex state of nodes and edges.

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
    - **Double-click** to focus and expand.
    - **Drag** nodes to rearrange your view.
4.  **Action**: Right-click to open files or apply organization suggestions.

## Other Knowledge OS views

**Atlas** (map) and **Timeline** (files by date) live in the same Knowledge OS surface as this
graph. They read the same analysis: Atlas places similar files nearby; Timeline sorts by content
date. See [USER_GUIDE.md](USER_GUIDE.md#5-knowledge-os-search-chat-graph-map).
