import { fileURLToPath } from "node:url";
import { updateClientVersionConstant } from "./client-version-constant.mjs";

const version = process.argv[2];
const sourcePath =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/services/xai-subscription-token.ts", import.meta.url),
  );

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error(`Expected a stable Grok CLI version, received: ${version}`);
}

updateClientVersionConstant({
  sourcePath,
  identifier: "GROK_CLI_CLIENT_VERSION",
  nextVersion: version,
  label: "Grok CLI client version",
});
