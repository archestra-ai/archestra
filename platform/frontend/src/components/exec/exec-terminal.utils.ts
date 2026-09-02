export type TerminalDimensions = {
  cols: number;
  rows: number;
};

/**
 * xterm may report NaN or a technically positive but unusably tiny grid while
 * a newly-mounted tab or responsive panel is still being laid out. Writing a
 * TUI frame at that transient size permanently bakes the early wraps into its
 * scrollback, even after the terminal is fitted to its real dimensions.
 */
export function isUsableTerminalDimensions(
  dimensions: TerminalDimensions | undefined,
): dimensions is TerminalDimensions {
  return (
    dimensions !== undefined &&
    Number.isInteger(dimensions.cols) &&
    dimensions.cols >= 20 &&
    Number.isInteger(dimensions.rows) &&
    dimensions.rows >= 5
  );
}
