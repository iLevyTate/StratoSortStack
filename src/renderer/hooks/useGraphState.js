// @ts-check
import { useReducer, useMemo } from 'react';
import { logger } from '../../shared/logger';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';

// Action types
const ACTIONS = {
  SET_NODES: 'SET_NODES',
  SET_EDGES: 'SET_EDGES',
  SET_GRAPH: 'SET_GRAPH',
  ON_NODES_CHANGE: 'ON_NODES_CHANGE',
  ON_EDGES_CHANGE: 'ON_EDGES_CHANGE',
  SELECT_NODE: 'SELECT_NODE',
  UNDO_SELECT: 'UNDO_SELECT',
  RESET: 'RESET'
};

// Cap the selection ring buffer at 20 entries — large enough for the user
// to backtrack a meaningful chain of node clicks, small enough to keep
// memory flat. Each entry is just a node id so this is essentially free.
const MAX_SELECTION_HISTORY = 20;

/** @type {{ nodes: any[], edges: any[], selectedNodeId: string | null, selectionHistory: any[] }} */
const initialState = {
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectionHistory: []
};

function normalizeCollection(/** @type {any} */ value, /** @type {any} */ label) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  logger.warn(`[GraphState] Expected array for ${label}, got`, value);
  return [];
}

function graphReducer(/** @type {any} */ state, /** @type {any} */ action) {
  switch (action.type) {
    case ACTIONS.SET_NODES: {
      const newNodes =
        typeof action.payload === 'function' ? action.payload(state.nodes) : action.payload;
      return { ...state, nodes: normalizeCollection(newNodes, 'nodes') };
    }
    case ACTIONS.SET_EDGES: {
      const newEdges =
        typeof action.payload === 'function' ? action.payload(state.edges) : action.payload;
      return { ...state, edges: normalizeCollection(newEdges, 'edges') };
    }
    case ACTIONS.SET_GRAPH: {
      const { nodes: newNodes, edges: newEdges } = action.payload;
      return {
        ...state,
        nodes: normalizeCollection(newNodes, 'nodes'),
        edges: normalizeCollection(newEdges, 'edges')
      };
    }
    case ACTIONS.ON_NODES_CHANGE:
      return {
        ...state,
        nodes: applyNodeChanges(action.payload, state.nodes)
      };
    case ACTIONS.ON_EDGES_CHANGE:
      return {
        ...state,
        edges: applyEdgeChanges(action.payload, state.edges)
      };
    case ACTIONS.SELECT_NODE: {
      const newSelected =
        typeof action.payload === 'function'
          ? action.payload(state.selectedNodeId)
          : action.payload;
      // Push the *previous* selection onto the history stack so Ctrl+Z can
      // pop back to it. Skip when the previous selection equals the new
      // one (no-op or the same id chosen twice in a row), and skip when
      // there was no prior selection (can't undo to "nothing").
      const previous = state.selectedNodeId;
      let nextHistory = state.selectionHistory;
      if (previous && previous !== newSelected) {
        nextHistory =
          state.selectionHistory.length >= MAX_SELECTION_HISTORY
            ? [...state.selectionHistory.slice(1), previous]
            : [...state.selectionHistory, previous];
      }
      return { ...state, selectedNodeId: newSelected, selectionHistory: nextHistory };
    }
    case ACTIONS.UNDO_SELECT: {
      if (state.selectionHistory.length === 0) return state;
      const next = state.selectionHistory[state.selectionHistory.length - 1];
      return {
        ...state,
        selectedNodeId: next,
        selectionHistory: state.selectionHistory.slice(0, -1)
      };
    }
    case ACTIONS.RESET:
      return initialState;
    default:
      return state;
  }
}

export function useGraphState() {
  const [state, dispatch] = useReducer(graphReducer, initialState);

  const actions = useMemo(
    () => ({
      setNodes: (/** @type {any} */ nodesOrUpdater) => {
        dispatch({ type: ACTIONS.SET_NODES, payload: nodesOrUpdater });
      },
      setEdges: (/** @type {any} */ edgesOrUpdater) => {
        dispatch({ type: ACTIONS.SET_EDGES, payload: edgesOrUpdater });
      },
      setGraph: (/** @type {any} */ nodes, /** @type {any} */ edges) => {
        dispatch({ type: ACTIONS.SET_GRAPH, payload: { nodes, edges } });
      },
      onNodesChange: (/** @type {any} */ changes) => {
        dispatch({ type: ACTIONS.ON_NODES_CHANGE, payload: changes });
      },
      onEdgesChange: (/** @type {any} */ changes) => {
        dispatch({ type: ACTIONS.ON_EDGES_CHANGE, payload: changes });
      },
      selectNode: (/** @type {any} */ nodeIdOrUpdater) => {
        dispatch({ type: ACTIONS.SELECT_NODE, payload: nodeIdOrUpdater });
      },
      undoSelect: () => {
        dispatch({ type: ACTIONS.UNDO_SELECT });
      },
      reset: () => {
        dispatch({ type: ACTIONS.RESET });
      }
    }),
    []
  );

  return {
    nodes: state.nodes,
    edges: state.edges,
    selectedNodeId: state.selectedNodeId,
    canUndoSelection: state.selectionHistory.length > 0,
    actions
  };
}
