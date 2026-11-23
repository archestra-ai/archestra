// A terminal spinner redraws one line: it erases the line, moves the cursor to
// its start and prints the next frame. Written to a log instead of a terminal,
// every frame stays, on one ever-growing line.
const REDRAW = /\x1b\[2K(?:\x1b\[1G)?|\r(?!\n)/;

/**
 * Forwards `source` to `target` without the frames a spinner redraws: of each
 * redrawn line only the last frame is written. Lines that are never redrawn
 * pass through unchanged, and the output always ends with a newline.
 */
export function forwardWithoutSpinner(source, target) {
  // The line still being written: the next chunk may redraw it.
  let openLine = "";
  source.setEncoding("utf8");
  source.on("data", (chunk) => {
    const frames = (openLine + chunk).split(REDRAW);
    const last = frames.pop();
    for (const frame of frames) target.write(completeLines(frame));
    target.write(completeLines(last));
    openLine = last.slice(completeLines(last).length);
  });
  source.on("end", () => {
    if (openLine) target.write(`${openLine}\n`);
  });
}

function completeLines(text) {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}
