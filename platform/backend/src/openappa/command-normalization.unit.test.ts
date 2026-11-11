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
