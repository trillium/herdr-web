/** Measurements used to align a touch-selection drag bubble to a terminal cell. */
export interface TerminalEndpointBubbleGeometryInput {
  targetClientX: number;
  targetClientY: number;
  containerLeft: number;
  containerTop: number;
  containerWidth: number;
  containerHeight: number;
  bubbleWidth: number;
  bubbleHeight: number;
  ringDiameter: number;
}

/** Keeps the touch target in bounds while centering its visible ring on the selected cell. */
export function terminalEndpointBubblePosition(input: TerminalEndpointBubbleGeometryInput) {
  const targetX = input.targetClientX - input.containerLeft;
  const targetY = input.targetClientY - input.containerTop;
  const left = clamp(
    targetX - input.bubbleWidth / 2,
    4,
    Math.max(4, input.containerWidth - input.bubbleWidth - 4),
  );
  const top = clamp(
    targetY - input.bubbleHeight / 2,
    4,
    Math.max(4, input.containerHeight - input.bubbleHeight - 4),
  );

  return {
    left,
    top,
    ringLeft: targetX - left - input.ringDiameter / 2,
    ringTop: targetY - top - input.ringDiameter / 2,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
