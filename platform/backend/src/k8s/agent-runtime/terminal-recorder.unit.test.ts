import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTerminalRecorderScript } from "./terminal-recorder";

describe("terminal recorder", () => {
  it("reports parser errors after retaining already received bytes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-recorder-"));
    const turn = path.join(directory, "turn");
    try {
      const result = spawnSync(
        "/bin/sh",
        ["-c", buildTerminalRecorderScript(), "recorder", turn],
        {
          input:
            "archestra-recording-size %1 @0 80x23\n%output %1 retained\n%error 1 1 0\n",
        },
      );
      expect(readFileSync(`${turn}.log`).toString()).toContain("retained");
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records successfully with stdout closed", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-recorder-"));
    const turn = path.join(directory, "turn");
    try {
      const result = spawnSync(
        "/bin/sh",
        ["-c", `exec 1>&-\n${buildTerminalRecorderScript()}`, "recorder", turn],
        {
          input:
            "archestra-recording-size %1 @0 80x23\n%output %1 retained\n%exit\n",
        },
      );
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(readFileSync(`${turn}.log`).toString()).toBe(
        "\u001b]777;archestra-terminal-size=80x23\u0007retained",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("still fails when the recording file cannot be written", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-recorder-"));
    const turn = path.join(directory, "turn");
    try {
      mkdirSync(`${turn}.log`);
      const result = spawnSync(
        "/bin/sh",
        ["-c", buildTerminalRecorderScript(), "recorder", turn],
        {
          input:
            "archestra-recording-size %1 @0 80x23\n%output %1 retained\n%exit\n",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toEqual(Buffer.alloc(0));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves ordered geometry and binary output for its pane", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-recorder-"));
    const turn = path.join(directory, "turn");
    try {
      const result = spawnSync(
        "/bin/sh",
        ["-c", buildTerminalRecorderScript(), "recorder", turn],
        {
          input: String.raw`%begin 1 1 0
archestra-recording-size %1 @0 80x23
%end 1 1 0
%output %1 first\015\012\033[2J\134012\000
%output %2 ignored
%layout-change @1 abcd,100x24,0,0,1 abcd,100x24,0,0,1 *
%layout-change @0 abcd,200x57,0,0,1 abcd,200x57,0,0,1 *
%output %1 resized界\015\012
%exit
`,
        },
      );
      expect(result.status, result.stderr.toString()).toBe(0);
      const expected = Buffer.from(
        "\u001b]777;archestra-terminal-size=80x23\u0007first\r\n\u001b[2J\\012\u0000" +
          "\u001b]777;archestra-terminal-size=200x57\u0007resized界\r\n",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(readFileSync(`${turn}.log`)).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
