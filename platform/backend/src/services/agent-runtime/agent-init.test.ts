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
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("reinitializing a retained workspace refreshes Git auth without duplicating URL rewrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-init-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const gh = path.join(bin, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then cat > "$HOME/current-token"; fi
`,
    );
    await chmod(gh, 0o755);
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: path.join(root, ".gitconfig"),
      PATH: `${bin}:${process.env.PATH}`,
      OPENAI_BASE_URL: "",
      OPENAI_API_KEY: "",
      GH_TOKEN: "",
    };
    for (const token of [
      "first-synthetic-token",
      "refreshed-synthetic-token",
      "third-synthetic-token",
    ]) {
      await exec(
        "sh",
        [
          path.resolve(
            import.meta.dirname,
            "../../../../agent_images/bin/archestra-agent-init",
          ),
        ],
        {
          env: { ...env, GITHUB_TOKEN: token },
        },
      );
      expect(
        (await readFile(path.join(root, "current-token"), "utf8")).trim(),
      ).toBe(token);
      const rewrites = await exec(
        "git",
        [
          "config",
          "--global",
          "--get-all",
          "url.https://github.com/.insteadOf",
        ],
        { env },
      );
      expect(rewrites.stdout.trim().split("\n")).toEqual([
        "git@github.com:",
        "ssh://git@github.com/",
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
