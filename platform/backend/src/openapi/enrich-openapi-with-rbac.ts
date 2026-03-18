import { RouteId } from "@shared";
import {
  permissionDescriptions,
  requiredEndpointPermissionsMap,
} from "@shared/access-control";

// === Exports ===

export function enrichOpenApiWithRbac<T extends OpenApiDocument>(spec: T): T {
  const clonedSpec = structuredClone(spec);

  for (const [path, pathItem] of Object.entries(clonedSpec.paths ?? {})) {
    if (!pathItem) {
      continue;
    }

    for (const operation of getOperations(pathItem)) {
      if (hasTag(operation, "LLM Proxy")) {
        operation.description = appendDescriptionSection(
          operation.description,
          createLlmProxyAuthenticationSection(),
        );
      }

      if (!operation.operationId) {
        continue;
      }

      if (!path.startsWith("/api/")) {
        continue;
      }

      const rbacMetadata = getRbacMetadata(operation.operationId);
      operation["x-required-permissions"] = rbacMetadata;

      operation.description = appendDescriptionSection(
        operation.description,
        createAuthenticationSection(),
      );
      operation.description = appendDescriptionSection(
        operation.description,
        createPermissionSection(rbacMetadata),
      );
    }
  }

  return clonedSpec;
}

// === Types ===

type OpenApiDocument = {
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, OpenApiPathItem | undefined>;
};

type OpenApiPathItem = Partial<
  Record<HttpMethod, OpenApiOperation | undefined>
>;

type OpenApiOperation = {
  operationId?: string;
  description?: string;
  tags?: string[];
  "x-required-permissions"?: RequiredPermissionsExtension;
};

type HttpMethod =
  | "delete"
  | "get"
  | "head"
  | "options"
  | "patch"
  | "post"
  | "put"
  | "trace";

type RequiredPermissionsExtension = {
  kind: "dynamic" | "none" | "static";
  note?: string;
  permissions: string[];
};

// === Internal helpers ===

function getOperations(pathItem: OpenApiPathItem): OpenApiOperation[] {
  return Object.entries(pathItem)
    .filter(([method]) => HTTP_METHODS.has(method as HttpMethod))
    .map(([, operation]) => operation)
    .filter(
      (operation): operation is OpenApiOperation =>
        operation !== undefined && operation !== null,
    );
}

function hasTag(operation: OpenApiOperation, tag: string): boolean {
  return operation.tags?.includes(tag) ?? false;
}

function getRbacMetadata(operationId: string): RequiredPermissionsExtension {
  const dynamicNote =
    DYNAMIC_ROUTE_PERMISSION_NOTES[
      operationId as keyof typeof DYNAMIC_ROUTE_PERMISSION_NOTES
    ];
  if (dynamicNote) {
    return {
      kind: "dynamic",
      note: dynamicNote,
      permissions: [],
    };
  }

  const permissions = flattenPermissions(
    requiredEndpointPermissionsMap[
      operationId as keyof typeof requiredEndpointPermissionsMap
    ],
  );
  if (permissions.length === 0) {
    return {
      kind: "none",
      note: "None (no additional RBAC permission required)",
      permissions: [],
    };
  }

  return {
    kind: "static",
    permissions,
  };
}

function flattenPermissions(
  permissions: Record<string, string[]> | undefined,
): string[] {
  if (!permissions) {
    return [];
  }

  return Object.entries(permissions)
    .flatMap(([resource, actions]) =>
      [...actions].sort().map((action) => `${resource}:${action}`),
    )
    .sort();
}

function appendDescriptionSection(
  description: string | undefined,
  section: string,
): string {
  if (!description) {
    return section;
  }

  return `${description}\n\n${section}`;
}

function createAuthenticationSection(): string {
  return [
    "Authentication:",
    "",
    "Required. Use an authenticated browser session or send your Archestra API key in the `Authorization` header.",
  ].join("\n");
}

function createLlmProxyAuthenticationSection(): string {
  return [
    "Authentication:",
    "",
    "This route accepts either an LLM provider API key or a Virtual API Key. See [LLM Proxy Authentication](/docs/platform-llm-proxy-authentication).",
  ].join("\n");
}

function createPermissionSection(
  metadata: RequiredPermissionsExtension,
): string {
  if (metadata.kind === "static") {
    return [
      "Authorization:",
      "",
      ...metadata.permissions.map(
        (permission) =>
          `\`${permission}\`: ${permissionDescriptions[permission] ?? "No description available"}`,
      ),
    ].join("\n");
  }

  return [
    "Authorization:",
    "",
    metadata.note ?? "None (no additional RBAC permission required)",
  ].join("\n");
}

const HTTP_METHODS = new Set<HttpMethod>([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const DYNAMIC_ROUTE_PERMISSION_NOTES = {
  [RouteId.GetAgents]:
    "Checked dynamically based on agent type. `profile` and `agent` require `agent:read`; `mcp_gateway` requires `mcpGateway:read`; `llm_proxy` requires `llmProxy:read`. If no type filter is provided, the user must have read access to at least one agent type.",
  [RouteId.GetAllAgents]:
    "Checked dynamically based on agent type. `profile` and `agent` require `agent:read`; `mcp_gateway` requires `mcpGateway:read`; `llm_proxy` requires `llmProxy:read`. If no type filter is provided, the user must have read access to at least one agent type.",
  [RouteId.GetAgent]:
    "Checked dynamically based on the target agent's type. `profile` and `agent` require `agent:read`; `mcp_gateway` requires `mcpGateway:read`; `llm_proxy` requires `llmProxy:read`.",
  [RouteId.CreateAgent]:
    "Checked dynamically based on the agent type being created. `profile` and `agent` require `agent:create`; `mcp_gateway` requires `mcpGateway:create`; `llm_proxy` requires `llmProxy:create`. Additional scope and team-admin checks may apply.",
  [RouteId.UpdateAgent]:
    "Checked dynamically based on the target agent's type. `profile` and `agent` require `agent:update`; `mcp_gateway` requires `mcpGateway:update`; `llm_proxy` requires `llmProxy:update`. Additional scope and team-admin checks may apply.",
  [RouteId.DeleteAgent]:
    "Checked dynamically based on the target agent's type. `profile` and `agent` require `agent:delete`; `mcp_gateway` requires `mcpGateway:delete`; `llm_proxy` requires `llmProxy:delete`. Additional scope checks may apply.",
} satisfies Partial<Record<RouteId, string>>;
