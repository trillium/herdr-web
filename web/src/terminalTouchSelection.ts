import type { TerminalSelectionPoint } from "./terminalSelection";

export interface TerminalTouchClientPoint {
  clientX: number;
  clientY: number;
}

/** Terminal cell measurements and bounds used to translate touch displacement. */
export interface TerminalTouchGridGeometry {
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

export type TerminalTouchSelectionState =
  | { phase: "idle" }
  | {
      phase: "placing-start";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    }
  | {
      phase: "waiting-endpoint";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    }
  | {
      phase: "dragging-endpoint";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    };

export const idleTouchSelectionState: TerminalTouchSelectionState = { phase: "idle" };

export function startTouchSelectionPlacement(
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  return { phase: "placing-start", start: point, endpoint: point, client };
}

export function moveTouchSelectionPlacement(
  state: TerminalTouchSelectionState,
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "placing-start") {
    return state;
  }
  return { ...state, start: point, endpoint: point, client };
}

export function commitTouchSelectionStart(
  state: TerminalTouchSelectionState,
): TerminalTouchSelectionState {
  if (state.phase !== "placing-start") {
    return state;
  }
  return {
    phase: "waiting-endpoint",
    start: state.start,
    endpoint: state.start,
    client: state.client,
  };
}

export function beginTouchSelectionEndpointDrag(
  state: TerminalTouchSelectionState,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "waiting-endpoint") {
    return state;
  }
  return { phase: "dragging-endpoint", start: state.start, endpoint: state.start, client };
}

/** Derives the moving endpoint from finger displacement relative to the fixed start. */
export function terminalTouchSelectionEndpointFromDrag(
  start: TerminalSelectionPoint,
  dragStart: TerminalTouchClientPoint,
  current: TerminalTouchClientPoint,
  grid: TerminalTouchGridGeometry,
): TerminalSelectionPoint {
  return {
    col: clamp(
      start.col + Math.round((current.clientX - dragStart.clientX) / grid.cellWidth),
      0,
      Math.max(0, grid.cols - 1),
    ),
    row: clamp(
      start.row + Math.round((current.clientY - dragStart.clientY) / grid.cellHeight),
      0,
      Math.max(0, grid.rows - 1),
    ),
  };
}

export function moveTouchSelectionEndpoint(
  state: TerminalTouchSelectionState,
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "dragging-endpoint") {
    return state;
  }
  return { ...state, endpoint: point, client };
}

export function completeTouchSelection(state: TerminalTouchSelectionState) {
  if (state.phase !== "dragging-endpoint") {
    return null;
  }
  return { start: state.start, end: state.endpoint };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
