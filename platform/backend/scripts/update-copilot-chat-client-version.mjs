import { fileURLToPath } from "node:url";
import { updateClientVersionConstant } from "./client-version-constant.mjs";

const tag = process.argv[2];
const sourcePath =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/services/github-copilot-token.ts", import.meta.url),
  );

if (!/^v\d+\.\d+\.\d{1,4}$/.test(tag ?? "")) {
  throw new Error(
    `Expected a stable Copilot Chat release tag, received: ${tag}`,
  );
}

updateClientVersionConstant({
  sourcePath,
  identifier: "GITHUB_COPILOT_CHAT_VERSION",
  nextVersion: tag.slice("v".length),
  label: "Copilot Chat client version",
});

