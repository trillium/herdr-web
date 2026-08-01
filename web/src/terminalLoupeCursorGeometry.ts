/** Measurements needed to place a cursor over a magnified terminal cell. */
export interface TerminalLoupeGeometryInput {
  col: number;
  row: number;
  cellWidth: number;
  cellHeight: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  loupeWidth: number;
  loupeHeight: number;
}

/** Places a vertical caret immediately before the selected cell and within its row. */
export function terminalLoupeCursorGeometry(input: TerminalLoupeGeometryInput) {
  const targetLeft = ((input.col * input.cellWidth - input.sourceX) / input.sourceWidth) * input.loupeWidth;
  const targetTop =
    ((input.row * input.cellHeight - input.sourceY) / input.sourceHeight) * input.loupeHeight;
  const targetBottom =
    (((input.row + 1) * input.cellHeight - input.sourceY) / input.sourceHeight) * input.loupeHeight;

  return {
    caretX: clamp(targetLeft, 4, input.loupeWidth - 4),
    caretTop: clamp(targetTop, 4, input.loupeHeight - 4),
    caretBottom: clamp(targetBottom, 4, input.loupeHeight - 4),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
