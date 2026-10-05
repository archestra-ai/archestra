import { fileURLToPath } from "node:url";
import { updateClientVersionConstant } from "./client-version-constant.mjs";

const tag = process.argv[2];
const sourcePath =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/routes/chat/model-fetchers/openai.ts", import.meta.url),
  );

if (!/^rust-v\d+\.\d+\.\d+$/.test(tag ?? "")) {
  throw new Error(`Expected a stable Codex release tag, received: ${tag}`);
}

updateClientVersionConstant({
  sourcePath,
  identifier: "CODEX_MODELS_CLIENT_VERSION",
  nextVersion: tag.slice("rust-v".length),
  label: "Codex client version",
});
