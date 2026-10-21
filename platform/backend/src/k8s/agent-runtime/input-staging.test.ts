import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
  AGENT_RUNTIME_DIR,
  agentRuntimeAttachmentsManifestPath,
} from "@/services/agent-runtime/runtime-contract";
import type { AgentRunInput, AgentRunRecord } from "@/types";
import manager from "./manager";

test("stages durable turn manifests before release and preserves them across follow-ups", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "runtime-inputs-"));
  const localPath = (value: string) =>
    value.replaceAll(AGENT_RUNTIME_DIR, directory);
  const adapter = manager as unknown as {
    waitForRunningPod: () => Promise<string>;
    execInPod: (params: {
      command: string[];
      stdin?: Readable;
    }) => Promise<string>;
  };
  vi.spyOn(adapter, "waitForRunningPod").mockResolvedValue("test-pod");
  // Kubernetes is the process boundary. Execute the actual staging commands
  // locally so a missing directory, bad argument order, or lost manifest fails.
  vi.spyOn(adapter, "execInPod").mockImplementation(async (params) => {
    const chunks: Buffer[] = [];
    if (params.stdin) {
      for await (const chunk of params.stdin) chunks.push(Buffer.from(chunk));
    }
    const [command, ...args] = params.command.map(localPath);
    const result = spawnSync(command, args, {
      input: Buffer.concat(chunks),
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr || "Exec failed");
    return result.stdout;
  });
  try {
    const staged = [];
    for (const taskId of ["initial-task", "follow-up-task"]) {
      const input = {
        originalName: "screenshot.png",
        runtimePath: `${AGENT_RUNTIME_DIR}/attachments/${taskId}/screenshot.png`,
        mimeType: "image/png",
        fileData: Buffer.from(taskId),
        fileSize: Buffer.byteLength(taskId),
      } as AgentRunInput;
      const session = { taskId } as AgentRunRecord;
      await manager.stageInputs({ session, inputs: [input] });
      const manifestPath = localPath(
        agentRuntimeAttachmentsManifestPath(taskId),
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest).toEqual([
        {
          name: input.originalName,
          path: input.runtimePath,
          mediaType: input.mimeType,
          size: input.fileSize,
        },
      ]);
      expect(readFileSync(localPath(input.runtimePath))).toEqual(
        input.fileData,
      );
      expect(
        readFileSync(
          localPath(`${AGENT_RUNTIME_DIR}/turns/${taskId}.inputs-ready`),
          "utf8",
        ),
      ).toBe("");
      expect(
        readFileSync(localPath(AGENT_RUNTIME_ATTACHMENTS_MANIFEST), "utf8"),
      ).toBe(readFileSync(manifestPath, "utf8"));
      staged.push({ session, input, manifestPath, manifest });
    }
    for (const { session, input, manifestPath, manifest } of staged) {
      await manager.stageInputs({ session, inputs: [input] });
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
    }
    expect(
      JSON.parse(
        readFileSync(localPath(AGENT_RUNTIME_ATTACHMENTS_MANIFEST), "utf8"),
      ),
    ).toEqual(staged[1].manifest);
  } finally {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
