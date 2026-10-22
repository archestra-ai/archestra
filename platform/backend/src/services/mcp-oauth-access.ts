// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import {
  assertScopedLifecycleAuthorization,
  findMcpServerInOrganization,
} from "@/services/mcp-installation-access";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * Authorize the interactive flow before resolving credentials or contacting
 * the provider. Automatic refresh uses the existing installation instead.
 */
export async function loadOAuthCatalogForCaller(params: {
  request: Pick<FastifyRequest, "user" | "organizationId" | "headers">;
  catalogId: string;
  serverId?: string;
  configurationFingerprint?: string;
}) {
  const { request, catalogId, serverId } = params;
  const caller = {
    userId: request.user.id,
    organizationId: request.organizationId,
  };
  const catalog = await InternalMcpCatalogModel.findById(catalogId, {
    ...caller,
    accessAction: "use",
    expandSecrets: false,
  });
  if (!catalog) throw new ApiError(404, "Catalog item not found");
  await ResourcePermissions.require({
    ...caller,
    resource: "mcpRegistry",
    scope: catalogId,
    action: "use",
  });
  if (!catalog.oauthConfig) {
    throw new ApiError(400, "This server does not support OAuth");
  }
  if (serverId) {
    const server = await findMcpServerInOrganization(
      serverId,
      request.organizationId,
    );
    if (!server || server.catalogId !== catalogId) {
      throw new ApiError(404, "MCP server not found");
    }
    await assertScopedLifecycleAuthorization({
      ...caller,
      mcpServer: server,
      headers: request.headers,
      action: "re-authenticate",
    });
  }
  // Bind the transaction to OAuth configuration, not unrelated catalog edits.
  const configurationFingerprint = createHash("sha256")
    .update(
      // codeql[js/insufficient-password-hash] This digest detects OAuth configuration changes in short-lived state; it does not store or verify passwords.
      JSON.stringify({
        oauthConfig: catalog.oauthConfig,
        clientSecretId: catalog.clientSecretId,
      }),
    )
    .digest("hex");
  if (
    params.configurationFingerprint &&
    params.configurationFingerprint !== configurationFingerprint
  ) {
    throw new ApiError(
      409,
      "OAuth configuration changed. Start the connection again.",
    );
  }
  return {
    catalogItem: await InternalMcpCatalogModel.resolveOAuthClientSecret({
      ...catalog,
      oauthConfig: catalog.oauthConfig,
    }),
    configurationFingerprint,
  };
}
