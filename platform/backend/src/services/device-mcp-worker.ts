import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import config from "@/config";

let cached: Promise<{ source: string; sha256: string }> | undefined;
export function deviceMcpWorkerBundle() {
  cached ??= readFile(
    join(dirname(config.mcpSandbox.filePath), "device-mcp-worker.cjs"),
    "utf8",
  )
    .then((source) => ({
      source,
      sha256: createHash("sha256").update(source).digest("hex"),
    }))
    .catch((error) => {
      cached = undefined;
      throw error;
    });
  return cached;
}
