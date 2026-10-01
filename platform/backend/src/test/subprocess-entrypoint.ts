import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const IMAGE_BIN = path.resolve(
  import.meta.dirname,
  "../../../agent_images/bin",
);

/** Keep real subprocess behavior while shortening frame retention and polling. */
export async function makeFastImageEntrypoint(
  root: string,
  name: "archestra-claude-code" | "archestra-codex" | "archestra-hermes",
): Promise<string> {
  const bin = path.join(root, "image-bin");
  await mkdir(bin);

  const supervisor = await readFile(
    path.join(IMAGE_BIN, "archestra-tui-run"),
    "utf8",
  );
  if (
    !supervisor.includes("      sleep 2\n") ||
    !supervisor.includes("    sleep 1\n")
  ) {
    throw new Error("The TUI supervisor's completion waits changed");
  }
  const shortened = supervisor
    .replace("      sleep 2\n", "      sleep 0.05\n")
    .replace("    sleep 1\n", "    sleep 0.05\n");
  const testSupervisor = path.join(bin, "archestra-tui-run");
  await writeFile(testSupervisor, shortened);
  await chmod(testSupervisor, 0o755);

  if (name === "archestra-claude-code") {
    // These wrapper tests stub the native CLI; image tests exercise the real
    // terminal readiness gate. Keep that external terminal boundary synthetic.
    await writeFile(
      path.join(bin, "archestra-claude-tui-start"),
      `#!/usr/bin/env python3
import os
import sys
os.execvp(sys.argv[1], sys.argv[1:] + [os.environ["ARCHESTRA_AGENT_RUNTIME_TASK"]])
`,
    );
  }

  for (const script of [
    name,
    "archestra-agent-failure",
    "archestra-codex-failure-watch",
  ]) {
    await symlink(path.join(IMAGE_BIN, script), path.join(bin, script));
  }
  return path.join(bin, name);
}
