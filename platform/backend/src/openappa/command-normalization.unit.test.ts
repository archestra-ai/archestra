import { validateOpenappaPolicy } from "@archestra/openappa-rs";
import { describe, expect, test } from "vitest";
import {
  expandCommandExecutionPolicyRules,
  isCommandExecutionTool,
} from "./command-normalization";
import { toolEntries } from "./policy-text";

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

  describe("expandCommandExecutionPolicyRules", () => {
    const rule = (name: string) => `[policy]
version = 2

[[policy.tool]]
name = ${name}
requires = { audience = { contains = ["public"] } }

[policy.tool.delta]
audience = ["private"]
`;
    const names = (toml: string) =>
      toolEntries(toml).map((entry) => entry.name);

    test("aliases a rule across every command tool and argument spelling, keeping its labels", async () => {
      const toml = rule('"builtin:shell(command:*secret*)"');
      const expanded = expandCommandExecutionPolicyRules(toml);

      expect(new Set(names(expanded))).toEqual(
        new Set(
          ["builtin:", "host/archestra/"].flatMap((prefix) =>
            ["bash", "Bash", "shell", "exec_command", "run_command"].flatMap(
              (tool) =>
                ["command", "cmd"].map(
                  (param) => `${prefix}${tool}(${param}:*secret*)`,
                ),
            ),
          ),
        ),
      );
      expect(names(expanded)).toHaveLength(20);
      for (const entry of toolEntries(expanded)) {
        expect(entry.delta).toEqual({ audience: ["private"] });
        expect(entry.requires).toEqual({
          audience: { contains: ["public"] },
        });
      }
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });

    test("keeps every alias ahead of a broader rule written after the original", async () => {
      const toml = `${rule('"host/archestra/exec_command(command:*secret*)"')}
[[policy.tool]]
name = "host/archestra/exec_command"
delta = {}
`;
      const expanded = expandCommandExecutionPolicyRules(toml);

      expect(names(expanded).at(-1)).toBe("host/archestra/exec_command");
      expect(
        names(expanded).indexOf("host/archestra/exec_command(cmd:*secret*)"),
      ).toBeLessThan(names(expanded).length - 1);
      expect(names(expanded)).toHaveLength(21);
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });

    test("renames the command condition wherever it stands, past escaped characters", async () => {
      const toml = rule(
        String.raw`'host/claude-code/exec_command(workdir:/a\,b,cmd:*a\)b*)'`,
      );
      const expanded = expandCommandExecutionPolicyRules(toml);

      expect(names(expanded)).toEqual(
        expect.arrayContaining([
          String.raw`host/claude-code/Bash(workdir:/a\,b,command:*a\)b*)`,
          String.raw`host/archestra/shell(workdir:/a\,b,cmd:*a\)b*)`,
        ]),
      );
      expect(names(expanded)).toHaveLength(30);
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });

    test("leaves policies without a command condition unchanged", () => {
      for (const toml of [
        rule('"builtin:bash(workdir:/repo)"'),
        rule('"read(path:*)"'),
        `[[policy.tool]]
delta = {}

[policy.tool.metadata]
name = "builtin:shell(command:*)"
`,
        "not toml [",
      ])
        expect(expandCommandExecutionPolicyRules(toml)).toBe(toml);
    });
  });
});
