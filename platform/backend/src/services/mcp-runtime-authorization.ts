import { isDeepStrictEqual } from "node:util";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import {
  ApiError,
  type InternalMcpCatalog,
  type UpdateInternalMcpCatalog,
} from "@/types";

type RuntimeDefinition = Partial<
  Pick<InternalMcpCatalog, (typeof RUNTIME_FIELDS)[number]>
>;

/** Compare the prepared definition that will be published, including staged bag IDs. */
export async function assertMcpRuntimeChangeAllowed(params: {
  userId: string;
  organizationId: string;
  original: InternalMcpCatalog | null;
  updates: Partial<UpdateInternalMcpCatalog>;
}): Promise<void> {
  const proposed: RuntimeDefinition = {
    ...params.original,
    ...Object.fromEntries(
      Object.entries(params.updates).filter(([, value]) => value !== undefined),
    ),
  };
  if (!hasPrivilegedRuntime(params.original) && !hasPrivilegedRuntime(proposed))
    return;

  if (
    isDeepStrictEqual(
      runtimeSnapshot(params.original ?? {}),
      runtimeSnapshot(proposed),
    )
  )
    return;
  if (
    !(await isMcpInstallationAdmin({
      userId: params.userId,
      organizationId: params.organizationId,
    }))
  ) {
    throw new ApiError(
      403,
      "Changing privileged MCP runtime configuration requires administrator access to the entire MCP registry.",
    );
  }
}

function hasPrivilegedRuntime(definition: RuntimeDefinition | null): boolean {
  if (!definition || definition.serverType !== "local") return false;
  const account = definition.localConfig?.serviceAccount?.trim();
  return Boolean(
    (account && account !== "default") ||
      definition.localConfig?.envFrom?.length ||
      definition.localConfig?.imagePullSecrets?.some(
        (entry) =>
          entry.source === "existing" ||
          (!("source" in entry) && "name" in entry),
      ) ||
      definition.deploymentSpecYaml?.trim(),
  );
}

function runtimeSnapshot(definition: RuntimeDefinition) {
  const fields: Record<string, unknown> = Object.fromEntries(
    RUNTIME_FIELDS.map((field) => [field, definition[field] ?? null]),
  );
  const local = definition.localConfig;
  if (local) {
    fields.localConfig = {
      ...Object.fromEntries(
        Object.entries(local).filter(
          ([, value]) => value !== undefined && value !== "",
        ),
      ),
      serviceAccount: local.serviceAccount?.trim() || "default",
      transportType: local.transportType ?? "stdio",
      httpPort: local.httpPort || 8080,
      httpPath: local.httpPath || "/mcp",
      arguments: local.arguments ?? [],
      envFrom: local.envFrom ?? [],
      imagePullSecrets: (local.imagePullSecrets ?? []).map((entry) =>
        entry.source === "credentials"
          ? entry
          : { source: "existing", name: entry.name },
      ),
      environment: (local.environment ?? []).map((env) =>
        Object.fromEntries(
          Object.entries(env).filter(
            ([key, value]) =>
              value !== undefined &&
              key !== "description" &&
              !(key === "required" && value === false),
          ),
        ),
      ),
    };
  }
  fields.deploymentSpecYaml = definition.deploymentSpecYaml || null;
  if (definition.userConfig)
    fields.userConfig = Object.fromEntries(
      Object.entries(definition.userConfig).map(([key, field]) => [
        key,
        Object.fromEntries(
          Object.entries(field).filter(
            ([name]) => name !== "title" && name !== "description",
          ),
        ),
      ]),
    );
  return fields;
}

const RUNTIME_FIELDS = [
  "name",
  "serverType",
  "localConfig",
  "deploymentSpecYaml",
  "localConfigSecretId",
  "clientSecretId",
  "userConfig",
  "installationCommand",
  "environmentId",
  "oauthConfig",
  "enterpriseManagedConfig",
  "authFields",
  "requiresAuth",
  "serverUrl",
  "multitenant",
] as const;
