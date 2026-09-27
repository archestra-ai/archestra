import { validateOpenappaPolicy } from "@archestra/openappa-rs";
import { describe, expect, test } from "vitest";
import {
  expandCommandExecutionPolicyRules,
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

  describe("expandCommandExecutionPolicyRules", () => {
    test("expands command execution tool rules across all command tools and parameter names", () => {
      const toml = `
[[policy.tool]]
name = "builtin:shell(command:*secret.txt*)"
delta = { audience = ["lab@archestra.local"] }

[[policy.tool]]
name = "read"
delta = {}
`;
      const expanded = expandCommandExecutionPolicyRules(toml);
      expect(expanded).toContain('name = "builtin:bash(command:*secret.txt*)"');
      expect(expanded).toContain('name = "builtin:bash(cmd:*secret.txt*)"');
      expect(expanded).toContain('name = "builtin:Bash(command:*secret.txt*)"');
      expect(expanded).toContain(
        'name = "builtin:exec_command(cmd:*secret.txt*)"',
      );
      expect(expanded).toContain(
        'name = "host/archestra/bash(command:*secret.txt*)"',
      );
      expect(expanded).toContain(
        'name = "host/archestra/exec_command(cmd:*secret.txt*)"',
      );
      expect(expanded).toContain(
        'name = "host/archestra/run_command(command:*secret.txt*)"',
      );
    });

    test("does not duplicate already defined rules", () => {
      const toml = `
[[policy.tool]]
name = "builtin:bash(command:*secret.txt*)"
delta = { audience = ["lab@archestra.local"] }

[[policy.tool]]
name = "builtin:shell(command:*secret.txt*)"
delta = { audience = ["lab@archestra.local"] }
`;
      const expanded = expandCommandExecutionPolicyRules(toml);
      const matches = expanded.match(
        /name\s*=\s*"builtin:bash\(command:\*secret\.txt\*\)"/g,
      );
      expect(matches).toHaveLength(1);
    });

    test("preserves restrictions authored before the name on every alias", async () => {
      const toml = `[policy]
version = 2

[[policy.tool]]
requires = { audience = { contains = ["public"] } }
delta = { audience = ["private"] }
name = "builtin:shell(command:*secret*)"
`;

      expect(await validateOpenappaPolicy(toml)).toEqual([]);

      const expanded = expandCommandExecutionPolicyRules(toml);
      const rules = expanded.split("[[policy.tool]]").slice(1);

      expect(rules).toHaveLength(20);
      for (const rule of rules) {
        expect(rule).toContain(
          'requires = { audience = { contains = ["public"] } }',
        );
        expect(rule).toContain('delta = { audience = ["private"] }');
      }
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });

    test("preserves a trailing comment when name is the final line", async () => {
      const toml = `[policy]
version = 2

[[policy.tool]]
delta = {}
name = "builtin:shell(command:*secret*)" # selector stays last`;

      expect(await validateOpenappaPolicy(toml)).toEqual([]);

      const expanded = expandCommandExecutionPolicyRules(toml);

      expect(expanded.match(/^\[\[policy\.tool\]\]$/gm)).toHaveLength(20);
      expect(expanded.match(/# selector stays last$/gm)).toHaveLength(20);
      expect(
        expanded.match(/name = "builtin:shell\(command:\*secret\*\)"/g),
      ).toHaveLength(1);
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });

    test("does not use a nested metadata name as the tool rule name", () => {
      const toml = `[[policy.tool]]
delta = {}

[policy.tool.metadata]
name = "builtin:shell(command:*)"
`;

      expect(expandCommandExecutionPolicyRules(toml)).toBe(toml);
    });

    test("copies nested tool tables without duplicating later policy or external tables", async () => {
      const toml = `[policy]
version = 2

[[policy.tool]]
# Keep this rule comment in the source policy.
name = "builtin:shell(command:*secret*)"

[policy.tool.delta]
audience = ["private"]

[policy.tool.requires.audience]
contains = ["public"]

# These tables belong to the policy, not to the command rule.
[[policy.sanitizer]]
name = "redactor"
on = ["tool_input"]

[policy.sanitizer.permits]
audience = { from = ["private"], to = ["public"] }

[externals]
timeout_ms = 2000
max_body_bytes = 65536

[externals.sanitizers.redactor]
url = "https://example.test/sanitize"
`;

      expect(await validateOpenappaPolicy(toml)).toEqual([]);

      const expanded = expandCommandExecutionPolicyRules(toml);

      expect(expanded.startsWith(toml)).toBe(true);
      expect(expanded.match(/^\[externals\]$/gm)).toHaveLength(1);
      expect(
        expanded.match(/^\[externals\.sanitizers\.redactor\]$/gm),
      ).toHaveLength(1);
      expect(expanded.match(/^\[\[policy\.sanitizer\]\]$/gm)).toHaveLength(1);
      expect(expanded).toMatch(
        /name = "builtin:bash\(cmd:\*secret\*\)"\n\n\[policy\.tool\.delta\]\naudience = \["private"\]\n\n\[policy\.tool\.requires\.audience\]\ncontains = \["public"\]/,
      );
      expect(await validateOpenappaPolicy(expanded)).toEqual([]);
    });
  });
});
