import { describe, expect, test } from "vitest";
import {
  argumentSpellingConflict,
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

    test("evaluates Copilot CLI's view, create and edit paths on normalized policy fields", () => {
      for (const tool of [
        "view",
        "create",
        "host/archestra/view",
        "host/archestra/create",
      ]) {
        expect(
          normalizeToolArgumentsForPolicy(tool, { path: "/repo/.env" }),
        ).toEqual({
          path: "/repo/.env",
          file_path: "/repo/.env",
        });
      }
      expect(
        normalizeToolArgumentsForPolicy("view", {
          path: "C:\\Users\\me\\appa-qa\\.npmrc",
        }),
      ).toEqual({
        path: "C:\\Users\\me\\appa-qa\\.npmrc",
        file_path: "C:/Users/me/appa-qa/.npmrc",
      });
      expect(
        normalizeToolArgumentsForPolicy("create", {
          path: "C:\\repo\\.mcp.json",
          file_text: "{}",
        }),
      ).toEqual({
        path: "C:\\repo\\.mcp.json",
        file_path: "C:/repo/.mcp.json",
        file_text: "{}",
      });
      for (const tool of ["edit", "host/archestra/edit"]) {
        expect(
          normalizeToolArgumentsForPolicy(tool, {
            path: "/repo/.env",
            old_str: "a",
            new_str: "b",
          }),
        ).toEqual({
          path: "/repo/.env",
          filePath: "/repo/.env",
          old_str: "a",
          new_str: "b",
        });
      }
      expect(
        normalizeToolArgumentsForPolicy("edit", {
          path: "C:\\Users\\me\\appa-qa\\.npmrc",
        }),
      ).toEqual({
        path: "C:\\Users\\me\\appa-qa\\.npmrc",
        filePath: "C:/Users/me/appa-qa/.npmrc",
      });
      // OpenCode's own lowercase edit call stays untouched.
      expect(
        normalizeToolArgumentsForPolicy("edit", { filePath: "/repo/.env" }),
      ).toEqual({ filePath: "/repo/.env" });
    });
  });

  describe("argumentSpellingConflict", () => {
    test.each([
      ["Bash", { command: "ls", cmd: "ls" }, false],
      ["Bash", { command: "ls" }, false],
      ["exec_command", { cmd: "cat ~/.aws/credentials", command: "ls" }, true],
      ["Bash", { command: "ls", cmd: null }, false],
      ["Bash", { command: "ls", cmd: ["ls"] }, true],
      ["Read", { file_path: "/repo/.env", path: "/repo/.env" }, false],
      ["Read", { file_path: "C:/repo/.env", path: "C:\\repo\\.env" }, false],
      ["Read", { file_path: "/repo/README.md", path: "/repo/.env" }, true],
      ["host/archestra/Edit", { file_path: "", path: "/repo/.env" }, true],
      ["Read", { file_path: 1, path: "/repo/.env" }, true],
      ["view", { file_path: "C:/repo/.env", path: "C:\\repo\\.env" }, false],
      ["view", { file_path: "/repo/README.md", path: "/repo/.env" }, true],
      [
        "host/archestra/create",
        { file_path: "/repo/safe.txt", path: "/repo/.mcp.json" },
        true,
      ],
      ["edit", { filePath: "/repo/.env", path: "/repo/.env" }, false],
      ["edit", { filePath: "C:/repo/.env", path: "C:\\repo\\.env" }, false],
      ["edit", { filePath: "/repo/README.md", path: "/repo/.env" }, true],
      ["host/archestra/edit", { filePath: "", path: "/repo/.env" }, true],
      ["Grep", { file_path: "/repo/README.md", path: "/repo/.env" }, false],
    ])("%s %j conflicts: %s", (tool, args, conflict) => {
      expect(argumentSpellingConflict(tool, args) !== null).toBe(conflict);
    });

    test("a null spelling is absent, so the other is copied over it", () => {
      expect(
        normalizeToolArgumentsForPolicy("Read", {
          path: "/repo/.env",
          file_path: null,
        }),
      ).toEqual({ path: "/repo/.env", file_path: "/repo/.env" });
      expect(
        normalizeToolArgumentsForPolicy("exec_command", {
          cmd: "ls",
          command: null,
        }),
      ).toEqual({ cmd: "ls", command: "ls" });
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
      expect(
        withoutArgumentCopies(
          "view",
          normalizeToolArgumentsForPolicy("view", {
            path: "C:\\repo\\.env",
          }) as Record<string, unknown>,
        ),
      ).toEqual({ path: "C:\\repo\\.env" });
      expect(
        withoutArgumentCopies(
          "create",
          normalizeToolArgumentsForPolicy("create", {
            path: "C:\\repo\\.mcp.json",
            file_text: "{}",
          }) as Record<string, unknown>,
        ),
      ).toEqual({ path: "C:\\repo\\.mcp.json", file_text: "{}" });
      expect(
        withoutArgumentCopies(
          "edit",
          normalizeToolArgumentsForPolicy("edit", {
            path: "C:\\repo\\.env",
            old_str: "a",
            new_str: "b",
          }) as Record<string, unknown>,
        ),
      ).toEqual({ path: "C:\\repo\\.env", old_str: "a", new_str: "b" });
      expect(
        withoutArgumentCopies("edit", { filePath: "/repo/README.md" }),
      ).toEqual({ filePath: "/repo/README.md" });
    });
  });
});
