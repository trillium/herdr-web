import { describe, expect, it } from "vitest";
import { terminalEndpointBubblePosition } from "./terminalEndpointBubblePosition";

describe("terminal endpoint drag handle", () => {
  it("centers the generous touch target on the selected cell", () => {
    const position = terminalEndpointBubblePosition({
      targetClientX: 150,
      targetClientY: 100,
      containerLeft: 0,
      containerTop: 0,
      containerWidth: 390,
      containerHeight: 800,
      bubbleWidth: 72,
      bubbleHeight: 72,
      ringDiameter: 42,
    });

    expect(position).toEqual({ left: 114, top: 64, ringLeft: 15, ringTop: 15 });
  });

  it("keeps the visible ring centered on a selected cell at the container edge", () => {
    const position = terminalEndpointBubblePosition({
      targetClientX: 3,
      targetClientY: 8,
      containerLeft: 0,
      containerTop: 0,
      containerWidth: 390,
      containerHeight: 800,
      bubbleWidth: 72,
      bubbleHeight: 72,
      ringDiameter: 42,
    });

    expect(position).toEqual({ left: 4, top: 4, ringLeft: -22, ringTop: -17 });
    expect(position.left + position.ringLeft + 21).toBe(3);
    expect(position.top + position.ringTop + 21).toBe(8);
  });
});
