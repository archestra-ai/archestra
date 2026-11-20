import { describe, expect, test } from "vitest";
import {
  argumentSpellingConflict,
  isCommandExecutionTool,
  normalizeCommandExecutionArguments,
} from "./command-normalization";

describe("command-normalization", () => {
  describe("isCommandExecutionTool", () => {
    test("detects command tools regardless of prefix", () => {
      expect(isCommandExecutionTool("bash")).toBe(true);
      expect(isCommandExecutionTool("Bash")).toBe(true);
      expect(isCommandExecutionTool("builtin:bash")).toBe(true);
      expect(isCommandExecutionTool("builtin:Bash")).toBe(true);
      expect(isCommandExecutionTool("host/archestra/bash")).toBe(true);
      expect(isCommandExecutionTool("host/claude-code/Bash")).toBe(true);
      expect(isCommandExecutionTool("exec_command")).toBe(true);
      expect(isCommandExecutionTool("builtin:exec_command")).toBe(true);
      expect(isCommandExecutionTool("shell")).toBe(true);
      expect(isCommandExecutionTool("run_command")).toBe(true);
      expect(isCommandExecutionTool("read")).toBe(false);
      expect(isCommandExecutionTool("write")).toBe(false);
      expect(isCommandExecutionTool("task")).toBe(false);
    });
  });

  describe("normalizeCommandExecutionArguments", () => {
    test("mirrors command to cmd when cmd is missing", () => {
      const args = normalizeCommandExecutionArguments("bash", {
        command: "cat secret.txt",
      });
      expect(args).toEqual({
        command: "cat secret.txt",
        cmd: "cat secret.txt",
      });
    });

    test("mirrors cmd to command when command is missing", () => {
      const args = normalizeCommandExecutionArguments("builtin:exec_command", {
        cmd: "cat secret.txt",
      });
      expect(args).toEqual({
        cmd: "cat secret.txt",
        command: "cat secret.txt",
      });
    });

    test("gives Cursor's Read, Write and StrReplace the file_path their rules read", () => {
      for (const tool of ["Read", "Write", "host/archestra/Read"]) {
        expect(
          normalizeCommandExecutionArguments(tool, { path: "/repo/.env" }),
        ).toEqual({ path: "/repo/.env", file_path: "/repo/.env" });
      }
      // A change to its own hooks in a Windows home must read like any other path.
      expect(
        normalizeCommandExecutionArguments("host/archestra/StrReplace", {
          path: "C:\\Users\\me\\.cursor\\hooks.json",
          old_string: "a",
        }),
      ).toEqual({
        path: "C:\\Users\\me\\.cursor\\hooks.json",
        old_string: "a",
        file_path: "C:/Users/me/.cursor/hooks.json",
      });
      // Claude Code's own call is left as it is, and so is Grep, whose rules
      // read `path`.
      expect(
        normalizeCommandExecutionArguments("Read", { file_path: "/repo/.env" }),
      ).toEqual({ file_path: "/repo/.env" });
      expect(
        normalizeCommandExecutionArguments("Grep", { path: "/repo" }),
      ).toEqual({ path: "/repo" });
    });

    test("ignores non-command tools", () => {
      const args = normalizeCommandExecutionArguments("read", {
        filePath: "/tmp/secret.txt",
      });
      expect(args).toEqual({
        filePath: "/tmp/secret.txt",
      });
    });
  });

  describe("argumentSpellingConflict", () => {
    test.each([
      ["Bash", { command: "ls", cmd: "ls" }, false],
      ["Bash", { command: "ls" }, false],
      ["exec_command", { cmd: "cat ~/.aws/credentials", command: "ls" }, true],
      ["Bash", { command: "ls", cmd: null }, false],
      ["Bash", { command: "ls", cmd: ["ls"] }, true],
      ["Read", { path: "/repo/a", file_path: "/repo/a" }, false],
      ["Read", { path: "C:\\repo\\a", file_path: "C:/repo/a" }, false],
      ["Read", { path: "/repo/a", file_path: "/repo/.env" }, true],
      ["Grep", { path: "/repo/a", file_path: "/repo/.env" }, false],
    ])("%s %j conflicts: %s", (tool, args, conflict) => {
      expect(argumentSpellingConflict(tool, args) !== null).toBe(conflict);
    });

    test("a null spelling is absent, so the other is copied over it", () => {
      expect(
        normalizeCommandExecutionArguments("exec_command", {
          cmd: "ls",
          command: null,
        }),
      ).toEqual({ cmd: "ls", command: "ls" });
    });
  });
});
