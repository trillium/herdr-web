import { describe, expect, it } from "vitest";
import { terminalLoupeCursorGeometry } from "./terminalLoupeCursorGeometry";

describe("terminal loupe cursor", () => {
  it("draws a caret before the selected cell within that cell's row", () => {
    const cursor = terminalLoupeCursorGeometry({
      col: 20,
      row: 10,
      cellWidth: 9,
      cellHeight: 16,
      sourceX: 149.5,
      sourceY: 146,
      sourceWidth: 70,
      sourceHeight: 44,
      loupeWidth: 132,
      loupeHeight: 82,
    });

    expect(cursor.caretX).toBeCloseTo(57.51, 1);
    expect(cursor.caretTop).toBeCloseTo(26.09, 1);
    expect(cursor.caretBottom).toBeCloseTo(55.91, 1);
    expect(cursor.caretTop).toBeLessThan(cursor.caretBottom);
  });

  it("keeps the caret visible when the selected row touches the loupe crop", () => {
    const top = terminalLoupeCursorGeometry({
      col: 0,
      row: 0,
      cellWidth: 9,
      cellHeight: 16,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 70,
      sourceHeight: 44,
      loupeWidth: 132,
      loupeHeight: 82,
    });
    const bottom = terminalLoupeCursorGeometry({
      col: 20,
      row: 39,
      cellWidth: 9,
      cellHeight: 16,
      sourceX: 149.5,
      sourceY: 596,
      sourceWidth: 70,
      sourceHeight: 44,
      loupeWidth: 132,
      loupeHeight: 82,
    });

    expect(top.caretX).toBe(4);
    expect(top.caretTop).toBe(4);
    expect(top.caretTop).toBeLessThan(top.caretBottom);
    expect(bottom.caretTop).toBeLessThan(bottom.caretBottom);
    expect(bottom.caretBottom).toBe(78);
  });
});
