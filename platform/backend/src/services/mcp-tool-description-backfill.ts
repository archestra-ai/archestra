// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
// SPDX-SnippetEnd
import logger from "@/logging";
import {
  McpServerModel,
  McpServerToolDescriptionModel,
  ToolModel,
} from "@/models";
import type { McpServer } from "@/types";

/**
 * Records per-installation tool descriptions for installations that have none
 * yet: every installation that existed before they were recorded and has not
 * synced since. Until an installation records its own, its callers are served
 * the catalog's shared description, which is whichever installation synced
 * last.
 *
 * Asks each installation for its `tools/list` and records what it reports
 * against the catalog's existing tool rows. It never writes those rows or
 * removes tools, so a pass cannot change what tools a catalog has. Idempotent:
 * concurrent passes and normal syncs write the same installation's own report.
 *
 * Driven by the `mcp_tool_description_backfill` periodic task. Each pass takes
 * a random batch, so installations that keep failing are retried on later
 * passes without holding the rest back. Once every installation in a
 * multi-installation catalog has recorded, a pass is one empty read.
 */
export async function backfillMcpToolDescriptions(): Promise<void> {
  try {
    const servers = await McpServerModel.findMissingToolDescriptions({
      limit: BATCH_SIZE,
    });
    if (servers.length === 0) return;

    const outcomes: Outcome[] = [];
    for (let i = 0; i < servers.length; i += CONCURRENCY) {
      outcomes.push(
        ...(await Promise.all(
          servers.slice(i, i + CONCURRENCY).map(recordForServer),
        )),
      );
    }
    logger.info(
      {
        recorded: outcomes.filter((outcome) => outcome === "recorded").length,
        failed: outcomes.filter((outcome) => outcome === "failed").length,
        skipped: outcomes.filter((outcome) => outcome === "skipped").length,
      },
      "Backfilled per-installation MCP tool descriptions",
    );
  } catch (error) {
    logger.error(
      { err: error },
      "MCP tool description backfill failed; the next tick retries it",
    );
  }
}

// ===== Internal =====

/** Installations asked per pass. */
const BATCH_SIZE = 100;

/** Upstream `tools/list` calls in flight at once. */
const CONCURRENCY = 4;

type Outcome = "recorded" | "failed" | "skipped";

async function recordForServer(server: McpServer): Promise<Outcome> {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // A background pass must not wake an idle deployment; a later pass records
  // it once demand has woken it.
  if (
    server.serverType === "local" &&
    McpServerRuntimeManager.isDeploymentDormant(server.id)
  ) {
    return "skipped";
  }
  // SPDX-SnippetEnd
  try {
    const [reported, rows] = await Promise.all([
      McpServerModel.getToolsFromServer(server),
      ToolModel.findSyncedByCatalogId(server.catalogId),
    ]);
    const rowByUpstreamName = new Map(
      rows.map((row) => [
        row.rawName ?? ToolModel.unslugifyName(row.name),
        row,
      ]),
    );
    await McpServerToolDescriptionModel.replaceForServer({
      mcpServerId: server.id,
      descriptions: reported.flatMap((tool) => {
        const row = rowByUpstreamName.get(tool.name);
        return row
          ? [{ toolId: row.id, description: tool.description ?? null }]
          : [];
      }),
    });
    return "recorded";
  } catch (error) {
    logger.debug(
      { err: error, serverId: server.id },
      "Could not backfill tool descriptions for MCP server; a later pass retries it",
    );
    return "failed";
  }
}
