/** Run with pnpm exec tsx standalone-scripts/test-runtime-steering.ts IMAGE.
 * Exercises the production command against a real Codex TUI in a runtime image.
 * Only the model HTTP boundary is stubbed; no credentials or external API calls.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildTmuxSteerCommand } from "../backend/src/k8s/agent-runtime/steering";

const image = process.argv[2];
if (!image) throw new Error("Pass a runtime image containing Codex and tmux");
const message =
  "Verify literal input: 'quotes' \"double\" $HOME $(touch /tmp/injected) `touch /tmp/injected` café 🎉";
const command = buildTmuxSteerCommand({ session: "agent", message });
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "-i",
    "--entrypoint",
    "python3",
    "-e",
    `TEST_MESSAGE=${message}`,
    "-e",
    `TEST_STEER_COMMAND=${command}`,
    image,
    "-",
  ],
  {
    input: readFileSync(new URL("./test-runtime-steering.py", import.meta.url)),
    encoding: "utf8",
    timeout: 90_000,
  },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
