import { describe, expect, it } from "vitest";
import { plainTerminalTranscript } from "./terminal-transcript";

describe("plainTerminalTranscript", () => {
  it("removes terminal styling and cursor controls from retained output", () => {
    expect(
      plainTerminalTranscript(
        "\u001b[2G\u001b[38;5;246mChoose a theme\u001b[39m\r\n\u001b]0;Claude Code\u0007Ready",
      ),
    ).toBe("Choose a theme\nReady");
  });
});
