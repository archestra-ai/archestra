import { stat } from "node:fs/promises";
import { join } from "node:path";
import config from "@/config";
import { isRustApiReady } from "@/utils/rust-api";

export async function nativeServicesReady(
  directory = process.env.ARCHESTRA_NATIVE_RUNTIME_DIR,
): Promise<boolean> {
  const socket = config.database.rustAuditLogSocket;
  const apiEnabled =
    socket ||
    config.database.rustSiteNotificationEnabled ||
    config.llmProxy.rustOpenAiStreamEnabled ||
    config.mcpGateway.rustDiscoverEnabled;
  const [api, worker] = await Promise.all([
    apiEnabled ? !!socket && isRustApiReady(socket) : true,
    directory && config.kb.rustRollupWorker && config.processType !== "web"
      ? stat(join(directory, "worker.ready")).then(
          (marker) => Date.now() - marker.mtimeMs < 60_000,
          () => false,
        )
      : true,
  ]);
  return api && worker;
}
