import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { buildAgentRuntimeActivityProbeCommand } from "./manifests";

test("Herdr activity probe treats a missing marker as no activity", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "archestra-activity-"));
  const activityPath = path.join(directory, "development-activity");
  try {
    expect(run(activityPath)).toBe("");
    writeFileSync(activityPath, "1789658462\n");
    expect(run(activityPath)).toBe("1789658462\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  function run(file: string) {
    return execFileSync(
      "/bin/sh",
      ["-c", buildAgentRuntimeActivityProbeCommand(true, file)],
      { encoding: "utf8" },
    );
  }
});
