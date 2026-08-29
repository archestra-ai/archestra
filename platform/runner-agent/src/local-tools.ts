import { spawn } from "node:child_process";
import { type ToolSet, tool } from "ai";
import { z } from "zod";

/**
 * Pod-local workspace tools for the built-in Archestra Agent.
 *
 * Background executions already run in an isolated, short-lived container.
 * Keeping this tool local lets the agent clone a repository, edit files, and
 * run verification without creating a second execution environment. Remote
 * capabilities continue to come exclusively from the Agent-scoped MCP gateway.
 */
export function loadLocalWorkspaceTools(): ToolSet {
  return {
    archestra_workspace__run_command: tool({
      description:
        "Run a shell command in this background execution's isolated workspace. Use it for repository operations, file edits, and verification. Do not print credentials or environment variables.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The bash command to run."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .optional()
          .describe("Stop the command after this many seconds (default: 120)."),
      }),
      execute: ({ command, timeoutSeconds }) =>
        runCommand({
          command,
          timeoutMs: (timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        }),
    }),
  };
}

async function runCommand(params: {
  command: string;
  timeoutMs: number;
}): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", params.command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;

    const append = (chunk: Buffer) => {
      if (outputBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      output.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.length, remaining);
      truncated ||= chunk.length > remaining;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, params.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve(`Command could not start: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const text = Buffer.concat(output).toString("utf8").trimEnd();
      const status = signal
        ? `Command stopped by ${signal}.`
        : `Command exited with code ${code ?? 1}.`;
      const suffix = truncated
        ? `\n[output truncated after ${MAX_OUTPUT_BYTES} bytes]`
        : "";
      resolve(`${status}${text ? `\n${text}` : ""}${suffix}`);
    });
  });
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_OUTPUT_BYTES = 64 * 1024;
