import { describe, expect, test } from "vitest";
import {
  generateHookFileName,
  languageFromFileName,
} from "./agent-hooks-editor.file-name";

describe("languageFromFileName", () => {
  test("maps .py to python and everything else to shell", () => {
    expect(languageFromFileName("check.py")).toBe("python");
    expect(languageFromFileName("  CHECK.PY  ")).toBe("python");
    expect(languageFromFileName("notify.sh")).toBe("shell");
  });
});

describe("generateHookFileName", () => {
  test("derives the name from the event and language", () => {
    expect(
      generateHookFileName({
        event: "session_start",
        language: "python",
        takenFileNames: [],
      }),
    ).toBe("session-start.py");
    expect(
      generateHookFileName({
        event: "pre_tool_use",
        language: "shell",
        takenFileNames: [],
      }),
    ).toBe("pre-tool-use.sh");
  });

  test("uniquifies against taken names case-insensitively", () => {
    expect(
      generateHookFileName({
        event: "session_start",
        language: "python",
        takenFileNames: ["Session-Start.py"],
      }),
    ).toBe("session-start-2.py");
    expect(
      generateHookFileName({
        event: "session_start",
        language: "python",
        takenFileNames: ["session-start.py", "session-start-2.py"],
      }),
    ).toBe("session-start-3.py");
  });

  test("only collides within the same extension", () => {
    expect(
      generateHookFileName({
        event: "session_start",
        language: "shell",
        takenFileNames: ["session-start.py"],
      }),
    ).toBe("session-start.sh");
  });
});
