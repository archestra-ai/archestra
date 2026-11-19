import { fileURLToPath } from "node:url";
import { updateClientVersionConstant } from "./client-version-constant.mjs";

// The X-GitHub-Api-Version the Copilot Chat extension sends to the Copilot
// API, as resolved by the update-client-versions workflow.
const apiVersion = process.argv[2];
const sourcePath =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/services/github-copilot-token.ts", import.meta.url),
  );

if (!/^\d{4}-\d{2}-\d{2}$/.test(apiVersion ?? "")) {
  throw new Error(`Expected a Copilot API version, received: ${apiVersion}`);
}

updateClientVersionConstant({
  sourcePath,
  identifier: "GITHUB_COPILOT_API_VERSION",
  nextVersion: apiVersion,
  label: "Copilot API version",
  format: "date",
});
