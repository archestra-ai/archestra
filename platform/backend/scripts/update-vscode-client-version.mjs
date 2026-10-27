import { fileURLToPath } from "node:url";
import { updateClientVersionConstant } from "./client-version-constant.mjs";

const version = process.argv[2];
const sourcePaths =
  process.argv.length > 3
    ? process.argv.slice(3)
    : [
        fileURLToPath(
          new URL("../src/services/github-copilot-token.ts", import.meta.url),
        ),
        fileURLToPath(
          new URL(
            "../src/services/agent-connection-setup/agents/copilot-cli.ts",
            import.meta.url,
          ),
        ),
      ];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error(`Expected a stable VS Code version, received: ${version}`);
}

for (const sourcePath of sourcePaths) {
  updateClientVersionConstant({
    sourcePath,
    identifier: "GITHUB_COPILOT_VSCODE_VERSION",
    nextVersion: version,
    label: "VS Code client version",
  });
}

