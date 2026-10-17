"use client";

import { Suspense, useState } from "react";
import type { McpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { preloadableLazy } from "@/lib/utils/preloadable-lazy";

const dialogs = preloadableLazy(() => import("./mcp-install-dialogs.impl"));

/**
 * The MCP install dialogs an orchestrator drives. Their code (the registry's
 * install forms, OAuth confirmation, the manage-users dialog) is a separate
 * chunk, fetched the first time one of them opens and kept mounted after,
 * so closing still animates.
 */
export function McpInstallDialogs({
  orchestrator,
}: {
  orchestrator: McpInstallOrchestrator;
}) {
  const [opened, setOpened] = useState(false);
  if (orchestrator.hasOpenDialog && !opened) setOpened(true);
  if (!opened && !orchestrator.hasOpenDialog) return null;
  return (
    <Suspense fallback={null}>
      <dialogs.Component orchestrator={orchestrator} />
    </Suspense>
  );
}
