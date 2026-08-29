export type TerminalDimensions = {
  cols: number;
  rows: number;
};

/** xterm may report NaN while a newly-mounted container has no layout yet. */
export function isUsableTerminalDimensions(
  dimensions: TerminalDimensions | undefined,
): dimensions is TerminalDimensions {
  return (
    dimensions !== undefined &&
    Number.isInteger(dimensions.cols) &&
    dimensions.cols > 0 &&
    Number.isInteger(dimensions.rows) &&
    dimensions.rows > 0
  );
}
