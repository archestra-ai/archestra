// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { Resource, ScopedResource } from "@archestra/shared";

/** Open the matching list's organization-wide Permissions dialog. */
export function getListPermissionsHref(resource: Resource | ScopedResource) {
  const path = listPermissionsPaths[resource];
  if (!path) return undefined;
  const params = new URLSearchParams({ permissions: "all" });
  if (resource === "mcpOauthClient" || resource === "llmOauthClient") {
    params.set("permissionResource", resource);
  }
  return `${path}?${params}`;
}

const listPermissionsPaths: Partial<Record<Resource | ScopedResource, string>> =
  {
    agent: "/agents",
    app: "/apps",
    environment: "/settings/environments",
    knowledgeBase: "/knowledge/knowledge-bases",
    knowledgeConnector: "/knowledge/connectors",
    knowledgeFile: "/knowledge/files",
    llmModel: "/llm/models",
    llmOauthClient: "/settings/oauth-clients",
    llmProviderApiKey: "/llm/model-providers",
    llmVirtualKey: "/llm/proxy/virtual-keys",
    mcpGateway: "/mcp/gateways",
    mcpOauthClient: "/settings/oauth-clients",
    mcpRegistry: "/mcp/registry",
    plugin: "/plugins",
    project: "/projects",
    serviceAccount: "/settings/service-accounts",
    skill: "/skills",
  };
