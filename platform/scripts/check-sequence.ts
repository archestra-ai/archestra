import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { runHeavy } from "./heavy-lane.ts";

export interface WorkspaceCheck {
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Type checking acquires the lane per compiler project itself. */
  managesLane?: boolean;
  peakBytes?: number;
}

/** Run real tools serially, preserving an exit code or a terminating signal. */
export function runWorkspaceChecks(checks: readonly WorkspaceCheck[]): number {
  for (const check of checks) {
    process.stderr.write(`check: ${check.label}\n`);
    const result = check.managesLane
      ? spawnSync(check.command, check.args, {
          stdio: "inherit",
          env: check.env ?? process.env,
        })
      : runHeavy(check);
    if (result.error) throw result.error;
    const status =
      result.status ??
      (result.signal ? 128 + constants.signals[result.signal] : 1);
    if (status !== 0) {
      process.stderr.write(`check: ${check.label} failed (exit ${status})\n`);
      return status;
    }
  }
  return 0;
}
