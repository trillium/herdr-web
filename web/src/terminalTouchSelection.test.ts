import { describe, expect, it } from "vitest";
import {
  beginTouchSelectionEndpointDrag,
  commitTouchSelectionStart,
  completeTouchSelection,
  moveTouchSelectionEndpoint,
  moveTouchSelectionPlacement,
  startTouchSelectionPlacement,
  terminalTouchSelectionEndpointFromDrag,
} from "./terminalTouchSelection";

describe("terminal touch selection flow", () => {
  it("commits a refined long-press point as the selection start", () => {
    const placing = startTouchSelectionPlacement(
      { col: 1, row: 2 },
      { clientX: 20, clientY: 40 },
    );
    const refined = moveTouchSelectionPlacement(placing, { col: 3, row: 2 }, { clientX: 42, clientY: 40 });
    const waiting = commitTouchSelectionStart(refined);

    expect(waiting).toMatchObject({
      phase: "waiting-endpoint",
      start: { col: 3, row: 2 },
      endpoint: { col: 3, row: 2 },
    });
  });

  it("anchors the endpoint to the committed start when dragging begins", () => {
    const waiting = commitTouchSelectionStart(
      startTouchSelectionPlacement({ col: 2, row: 1 }, { clientX: 18, clientY: 30 }),
    );
    const dragging = beginTouchSelectionEndpointDrag(waiting, { clientX: 63, clientY: 30 });

    expect(dragging).toMatchObject({
      phase: "dragging-endpoint",
      start: { col: 2, row: 1 },
      endpoint: { col: 2, row: 1 },
    });
  });

  it("derives the moving endpoint from finger displacement without a transition jump", () => {
    const start = { col: 2, row: 1 };
    const dragStart = { clientX: 63, clientY: 30 };
    const grid = { cellWidth: 9, cellHeight: 16, cols: 10, rows: 4 };

    expect(terminalTouchSelectionEndpointFromDrag(start, dragStart, dragStart, grid)).toEqual(start);
    expect(
      terminalTouchSelectionEndpointFromDrag(
        start,
        dragStart,
        { clientX: 108, clientY: 14 },
        grid,
      ),
    ).toEqual({ col: 7, row: 0 });
  });

  it("clamps endpoint displacement to the terminal grid", () => {
    expect(
      terminalTouchSelectionEndpointFromDrag(
        { col: 2, row: 1 },
        { clientX: 63, clientY: 30 },
        { clientX: -100, clientY: 200 },
        { cellWidth: 9, cellHeight: 16, cols: 10, rows: 4 },
      ),
    ).toEqual({ col: 0, row: 3 });
  });

  it("completes forward endpoint drags", () => {
    const waiting = commitTouchSelectionStart(
      startTouchSelectionPlacement({ col: 2, row: 1 }, { clientX: 18, clientY: 30 }),
    );
    const dragging = beginTouchSelectionEndpointDrag(waiting, { clientX: 63, clientY: 30 });
    const moved = moveTouchSelectionEndpoint(dragging, { col: 7, row: 1 }, { clientX: 108, clientY: 30 });

    expect(completeTouchSelection(moved)).toEqual({
      start: { col: 2, row: 1 },
      end: { col: 7, row: 1 },
    });
  });

  it("completes backward endpoint drags without reordering the anchor", () => {
    const waiting = commitTouchSelectionStart(
      startTouchSelectionPlacement({ col: 8, row: 3 }, { clientX: 72, clientY: 58 }),
    );
    const dragging = beginTouchSelectionEndpointDrag(waiting, { clientX: 36, clientY: 42 });
    const moved = moveTouchSelectionEndpoint(dragging, { col: 1, row: 2 }, { clientX: 9, clientY: 42 });

    expect(completeTouchSelection(moved)).toEqual({
      start: { col: 8, row: 3 },
      end: { col: 1, row: 2 },
    });
  });
});
