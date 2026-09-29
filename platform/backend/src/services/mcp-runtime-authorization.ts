import { isDeepStrictEqual } from "node:util";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import {
  ApiError,
  type InternalMcpCatalog,
  type UpdateInternalMcpCatalog,
} from "@/types";
import {
  getCatalogSecretValues,
  preserveCatalogSecretReference,
} from "./mcp-catalog-secrets";

type RuntimeDefinition = Partial<
  Pick<InternalMcpCatalog, (typeof RUNTIME_FIELDS)[number]>
>;

/** Object edit rights do not authorize Kubernetes identities or pod templates. */
export async function assertMcpRuntimeChangeAllowed(params: {
  userId: string;
  organizationId: string;
  original: InternalMcpCatalog | null;
  updates: Partial<UpdateInternalMcpCatalog>;
  secretUpdates?: {
    localConfig?: Record<string, string>;
    client?: Record<string, string>;
  };
}): Promise<void> {
  const proposed: RuntimeDefinition = {
    ...params.original,
    ...Object.fromEntries(
      Object.entries(params.updates).filter(([, value]) => value !== undefined),
    ),
  };
  if (!hasPrivilegedRuntime(params.original) && !hasPrivilegedRuntime(proposed))
    return;

  const previous = structuredClone(params.original ?? {});
  const next = structuredClone(proposed);
  let secretsChanged = false;
  if (params.updates.localConfig) {
    const bag = {
      ...Object.fromEntries(
        (params.original?.localConfig?.environment ?? [])
          .filter(
            (env) =>
              env.type === "secret" && !env.promptOnInstallation && env.value,
          )
          .map((env) => [env.key, env.value as string]),
      ),
      ...Object.fromEntries(
        (params.original?.localConfig?.imagePullSecrets ?? []).flatMap(
          (entry) =>
            entry.source === "credentials" && entry.password
              ? [
                  [
                    `__regcred_password:${entry.server}:${entry.username}`,
                    entry.password,
                  ],
                ]
              : [],
        ),
      ),
      ...(await getCatalogSecretValues(params.original?.localConfigSecretId)),
    };
    for (const env of next.localConfig?.environment ?? []) {
      if (env.type !== "secret" || env.promptOnInstallation) continue;
      if (env.value && !env.credentialId) {
        const retained = await preserveCatalogSecretReference({
          secretId: params.original?.localConfigSecretId,
          key: env.key,
          value: env.value,
          existingValues: bag,
        });
        if (retained !== bag[env.key]) secretsChanged = true;
      }
      delete env.value;
    }
    for (const entry of next.localConfig?.imagePullSecrets ?? []) {
      if (entry.source !== "credentials") continue;
      if (entry.password) {
        const key = `__regcred_password:${entry.server}:${entry.username}`;
        const retained = await preserveCatalogSecretReference({
          secretId: params.original?.localConfigSecretId,
          key,
          value: entry.password,
          existingValues: bag,
        });
        if (retained !== bag[key]) secretsChanged = true;
      }
      delete entry.password;
    }
  }
  const clientBag: Record<string, string> = {
    ...(params.original?.oauthConfig?.client_secret
      ? { client_secret: params.original.oauthConfig.client_secret }
      : {}),
    ...(params.original?.enterpriseManagedConfig?.clientSecretOverride
      ? {
          enterprise_managed_client_secret_override:
            params.original.enterpriseManagedConfig.clientSecretOverride,
        }
      : {}),
    ...(params.updates.oauthConfig?.client_secret ||
    params.updates.enterpriseManagedConfig?.clientSecretOverride
      ? await getCatalogSecretValues(params.original?.clientSecretId)
      : {}),
  };
  for (const entry of [
    { value: next.oauthConfig?.client_secret, key: "client_secret" },
    {
      value: next.enterpriseManagedConfig?.clientSecretOverride,
      key: "enterprise_managed_client_secret_override",
    },
  ]) {
    if (!entry.value) continue;
    const retained = await preserveCatalogSecretReference({
      secretId: params.original?.clientSecretId,
      key: entry.key,
      value: entry.value,
      existingValues: clientBag,
    });
    if (retained !== clientBag[entry.key]) secretsChanged = true;
  }
  if (next.oauthConfig) delete next.oauthConfig.client_secret;
  if (next.enterpriseManagedConfig)
    delete next.enterpriseManagedConfig.clientSecretOverride;

  for (const [bag, secretId] of [
    [params.secretUpdates?.localConfig, params.original?.localConfigSecretId],
    [params.secretUpdates?.client, params.original?.clientSecretId],
  ] as const) {
    if (
      bag !== undefined &&
      !isDeepStrictEqual(bag, await getCatalogSecretValues(secretId))
    )
      secretsChanged = true;
  }

  const changed =
    secretsChanged ||
    !isDeepStrictEqual(runtimeSnapshot(previous), runtimeSnapshot(next));
  if (!changed) return;
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
          ? Object.fromEntries(
              Object.entries(entry).filter(([key]) => key !== "password"),
            )
          : { source: "existing", name: entry.name },
      ),
      environment: (local.environment ?? []).map((env) =>
        Object.fromEntries(
          Object.entries(env).filter(
            ([key, value]) =>
              value !== undefined &&
              key !== "description" &&
              !(
                key === "value" &&
                env.type === "secret" &&
                !env.promptOnInstallation
              ) &&
              !(key === "required" && value === false),
          ),
        ),
      ),
    };
  }
  fields.deploymentSpecYaml = definition.deploymentSpecYaml || null;
  if (definition.oauthConfig)
    fields.oauthConfig = Object.fromEntries(
      Object.entries(definition.oauthConfig).filter(
        ([key]) => key !== "client_secret",
      ),
    );
  if (definition.enterpriseManagedConfig)
    fields.enterpriseManagedConfig = Object.fromEntries(
      Object.entries(definition.enterpriseManagedConfig).filter(
        ([key]) => key !== "clientSecretOverride",
      ),
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
