// @vitest-environment node
import { describe, expect, it } from "vitest";
import { prepareTerminalRecording } from "./terminal-recording-geometry";

const size = (cols: number, rows: number) =>
  `\x1b]777;archestra-terminal-size=${cols}x${rows}\x07`;

describe("recording geometry", () => {
  it("recovers legacy TUI grids at each complete redraw, including smaller grids", () => {
    const screen = (cols: number, rows: number) =>
      `\x1b[2J\x1b[H${"─".repeat(cols)}\x1b[${rows};1H`;
    const first = screen(190, 57);
    const second = screen(66, 57);
    const third = screen(208, 57);
    expect(prepareTerminalRecording(first + second + third)).toEqual({
      content:
        size(190, 57) + first + size(66, 57) + second + size(208, 57) + third,
      dimensions: { cols: 190, rows: 57 },
    });
  });

  it("preserves exact size events and infers only screens before the first event", () => {
    const early = `\x1b[2J${"─".repeat(80)}\x1b[23;1H`;
    const later = `${size(160, 40)}\x1b[2J${"─".repeat(150)}\x1b[38;1H`;
    expect(prepareTerminalRecording(early + later).content).toBe(
      size(80, 23) + early + later,
    );
  });

  it("uses the supervisor grid for ordinary text without reliable geometry", () => {
    const content = "A long log line\r\n\x1b[115GRight edge";
    expect(prepareTerminalRecording(content)).toEqual({
      content,
      dimensions: { cols: 120, rows: 40 },
    });
  });

  it("does not infer dimensions from control-string payloads or invalid sizes", () => {
    const content = `\x1b]0;${"─".repeat(200)}\x1b[57;1H\x07${size(0, 0)}text`;
    expect(prepareTerminalRecording(content).dimensions).toEqual({
      cols: 120,
      rows: 40,
    });
  });
});
