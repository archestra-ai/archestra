import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const ENTRYPOINT = path.resolve(
  import.meta.dirname,
  "../../../../agent_images/bin/archestra-agent-attention",
);

describe("Agent Runtime attention reporter", () => {
  test("updates tmux and reports only state transitions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-attention-"));
    try {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeExecutable(
        path.join(bin, "tmux"),
        `#!/bin/sh
case "$1:$5" in
  show-option:@archestra_attention)
    [ -f "$TEST_ROOT/state" ] && cat "$TEST_ROOT/state"
    ;;
  show-option:@archestra_attention_label)
    [ -f "$TEST_ROOT/label" ] && cat "$TEST_ROOT/label"
    ;;
esac
case "$1:$4" in
  set-option:@archestra_attention)
    printf '%s\n' "$5" > "$TEST_ROOT/state"
    ;;
  set-option:@archestra_attention_label)
    printf '%s\n' "$5" > "$TEST_ROOT/label"
    ;;
esac
printf '%s\n' "$*" >> "$TEST_ROOT/tmux-calls"
`,
      );
      await writeExecutable(
        path.join(bin, "curl"),
        `#!/bin/sh
printf '%s\n' "$*" >> "$TEST_ROOT/curl-calls"
`,
      );

      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_ROOT: root,
        TMUX_PANE: "%4",
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
      };

      await execFileAsync(ENTRYPOINT, ["set", "Waiting for input"], { env });
      await execFileAsync(ENTRYPOINT, ["set", "Waiting for input"], { env });
      await execFileAsync(ENTRYPOINT, ["set", "Permission needed"], { env });
      await execFileAsync(ENTRYPOINT, ["clear"], { env });
      await execFileAsync(ENTRYPOINT, ["clear"], { env });

      const tmuxCalls = await readFile(path.join(root, "tmux-calls"), "utf8");
      expect(tmuxCalls).toContain(
        "set-option -t %4 @archestra_attention_label Waiting for input",
      );
      expect(tmuxCalls).toContain("set-option -t %4 @archestra_attention 0");

      const curlCalls = (await readFile(path.join(root, "curl-calls"), "utf8"))
        .trim()
        .split("\n");
      expect(curlCalls).toHaveLength(3);
      expect(curlCalls[0]).toContain('"attentionState":"input_required"');
      expect(curlCalls[1]).toContain('"attentionState":"input_required"');
      expect(curlCalls[2]).toContain('"attentionState":null');
      expect(curlCalls[2]).toContain("/runtime-status");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, "utf8");
  await chmod(file, 0o755);
}
