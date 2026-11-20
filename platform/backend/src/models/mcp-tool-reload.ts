// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { getTableColumns } from "drizzle-orm";
import { z } from "zod";
import config from "@/config";
import { schema } from "@/database/schema";
import { SelectToolSchema, type Tool } from "@/types";
import { callRustApi } from "@/utils/rust-api";

export type McpToolReloadScope = {
  organizationId: string;
  catalogId: string;
  serverId: string;
};

type ToolFields = Pick<Tool, "name" | "description" | "parameters"> & {
  rawName: string;
  meta?: Tool["meta"];
};

type ReloadWrite =
  | { kind: "adopt"; names: string[] }
  | { kind: "update"; id: string; tool: ToolFields; restore: boolean }
  | { kind: "insert"; tools: ToolFields[] }
  | {
      kind: "transfer";
      assignment: Pick<
        typeof schema.agentToolsTable.$inferSelect,
        "agentId" | "toolId" | "mcpServerId" | "credentialResolutionMode"
      >;
    }
  | { kind: "delete"; ids: string[] }
  | {
      kind: "attachDeploymentTools";
      agentIds: string[];
      toolIds: string[];
      environmentId: string | null;
      phase: "insert" | "repin";
    }
  | {
      kind: "descriptions";
      descriptions: {
        toolId: string;
        description: string | null;
      }[];
    };

export async function writeMcpToolReload(
  scope: McpToolReloadScope,
  write: ReloadWrite,
): Promise<Tool[]> {
  const socketPath = config.database.rustAuditLogSocket;
  if (!socketPath) throw new Error("Rust MCP tool socket is not configured");
  const response = await callRustApi({
    socketPath,
    path: "/internal/v1/mcp/tools/reload-mcp-server-tools",
    json: JSON.stringify({ ...scope, write }),
  });
  if (response === null)
    throw Object.assign(new Error("Duplicate reload record"), {
      code: "23505",
    });

  return ToolRowsSchema.parse(response);
}

const columns = Object.entries(getTableColumns(schema.toolsTable));
const ToolRowsSchema = z.array(
  z
    .record(z.string(), z.unknown())
    .transform((row) =>
      Object.fromEntries(
        columns.map(([key, { name, dataType }]) => {
          const value = row[name];
          return [
            key,
            dataType === "date" && typeof value === "string"
              ? new Date(`${value}Z`)
              : value,
          ];
        }),
      ),
    )
    .pipe(SelectToolSchema),
);
