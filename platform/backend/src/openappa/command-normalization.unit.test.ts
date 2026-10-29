import { describe, expect, test } from "vitest";
import {
  isCommandExecutionTool,
  normalizeToolArgumentsForPolicy,
  withoutArgumentCopies,
} from "./command-normalization";

describe("command-normalization", () => {
  describe("isCommandExecutionTool", () => {
    test("detects command tools regardless of prefix", () => {
      expect(isCommandExecutionTool("bash")).toBe(true);
      expect(isCommandExecutionTool("Bash")).toBe(true);
      expect(isCommandExecutionTool("builtin:bash")).toBe(true);
      expect(isCommandExecutionTool("builtin:Bash")).toBe(true);
      expect(isCommandExecutionTool("host/archestra/bash")).toBe(true);
      expect(
        isCommandExecutionTool("host/archestra/mcp__workspace__bash"),
      ).toBe(true);
      expect(isCommandExecutionTool("mcp__workspace__bash")).toBe(true);
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

  describe("normalizeToolArgumentsForPolicy", () => {
    test("mirrors command to cmd when cmd is missing", () => {
      const args = normalizeToolArgumentsForPolicy("bash", {
        command: "cat secret.txt",
      });
      expect(args).toEqual({
        command: "cat secret.txt",
        cmd: "cat secret.txt",
      });
    });

    test("mirrors cmd to command when command is missing", () => {
      const args = normalizeToolArgumentsForPolicy("builtin:exec_command", {
        cmd: "cat secret.txt",
      });
      expect(args).toEqual({
        cmd: "cat secret.txt",
        command: "cat secret.txt",
      });
    });

    // The coding battery's credential rules read Claude Code's `file_path`;
    // without the copy, Kimi Code could read `.env` and keep its audience.
    test("evaluates Kimi Code's file path as file_path too", () => {
      for (const tool of ["Read", "Write", "Edit", "host/archestra/Read"]) {
        expect(
          normalizeToolArgumentsForPolicy(tool, { path: "/repo/.env" }),
        ).toEqual({ path: "/repo/.env", file_path: "/repo/.env" });
      }
      // A Windows path is copied with forward slashes: `*/.npmrc` reads `/`.
      // A subagent read `C:\\Users\\me\\appa-qa\\.npmrc` with no narrowing.
      expect(
        normalizeToolArgumentsForPolicy("Read", {
          path: "C:\\Users\\me\\appa-qa\\.npmrc",
        }),
      ).toEqual({
        path: "C:\\Users\\me\\appa-qa\\.npmrc",
        file_path: "C:/Users/me/appa-qa/.npmrc",
      });
      // Claude Code's own call is left as it is.
      expect(
        normalizeToolArgumentsForPolicy("Read", { file_path: "/repo/.env" }),
      ).toEqual({ file_path: "/repo/.env" });
      // So is Grep, whose rules read `path`, and OpenCode's lowercase read.
      expect(
        normalizeToolArgumentsForPolicy("Grep", { path: "/repo" }),
      ).toEqual({ path: "/repo" });
      expect(
        normalizeToolArgumentsForPolicy("read", { filePath: "/repo/.env" }),
      ).toEqual({ filePath: "/repo/.env" });
    });
  });

  describe("withoutArgumentCopies", () => {
    test("drops only the copies the normalizer adds", () => {
      expect(
        withoutArgumentCopies(
          "Bash",
          normalizeToolArgumentsForPolicy("Bash", { command: "ls" }) as Record<
            string,
            unknown
          >,
        ),
      ).toEqual({ command: "ls" });
      expect(
        withoutArgumentCopies(
          "Read",
          normalizeToolArgumentsForPolicy("Read", {
            path: "/repo/.env",
          }) as Record<string, unknown>,
        ),
      ).toEqual({ path: "/repo/.env" });
      expect(
        withoutArgumentCopies(
          "Read",
          normalizeToolArgumentsForPolicy("Read", {
            path: "C:\\repo\\.env",
          }) as Record<string, unknown>,
        ),
      ).toEqual({ path: "C:\\repo\\.env" });
      expect(
        withoutArgumentCopies("Read", { file_path: "/repo/README.md" }),
      ).toEqual({ file_path: "/repo/README.md" });
    });
  });
});
