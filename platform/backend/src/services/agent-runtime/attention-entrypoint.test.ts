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
  test("reports only attention state transitions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archestra-attention-"));
    try {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
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
        ARCHESTRA_AGENT_RUNTIME_DIR: root,
        ARCHESTRA_AGENT_RUNTIME_TASK_ID: "12345678-abcd-4000-8000-123456789abc",
        ARCHESTRA_MCP_GATEWAY_URL: "http://localhost:9000/v1/mcp/test",
        ARCHESTRA_MCP_GATEWAY_TOKEN: "test-token",
      };

      await execFileAsync(ENTRYPOINT, ["set", "Waiting for input"], { env });
      await execFileAsync(ENTRYPOINT, ["set", "Waiting for input"], { env });
      await execFileAsync(ENTRYPOINT, ["set", "Permission needed"], { env });
      await execFileAsync(ENTRYPOINT, ["clear"], { env });
      await execFileAsync(ENTRYPOINT, ["clear"], { env });

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
