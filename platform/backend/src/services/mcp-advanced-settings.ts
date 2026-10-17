import { isDeepStrictEqual } from "node:util";
import { hasScopedPermission } from "@archestra/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { userHasPermission } from "@/auth/utils";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { LocalConfig } from "@/types";
import { ApiError } from "@/types";

export async function assertCanManageMcpDeployment(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
}): Promise<void> {
  if (!(await canManageMcpDeployment(params)))
    throw new ApiError(
      403,
      "Deployment settings require the configure-deployment-spec permission on this MCP registry entry.",
    );
}

export async function assertCanWriteMcpDeploymentYaml(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
  requested: string | null | undefined;
  current?: string | null;
  requestedLocalConfig?: Pick<LocalConfig, "envFrom" | "serviceAccount"> | null;
  currentLocalConfig?: Pick<LocalConfig, "envFrom" | "serviceAccount"> | null;
}): Promise<void> {
  const yamlChanged =
    params.requested !== undefined &&
    (params.requested || null) !== (params.current || null);
  const localConfig = params.requestedLocalConfig;
  const envFromChanged =
    localConfig !== undefined &&
    !isDeepStrictEqual(
      localConfig?.envFrom ?? [],
      params.currentLocalConfig?.envFrom ?? [],
    );
  const serviceAccountChanged =
    localConfig !== undefined &&
    (localConfig?.serviceAccount?.trim() || "default") !==
      (params.currentLocalConfig?.serviceAccount?.trim() || "default");
  if (!yamlChanged && !envFromChanged && !serviceAccountChanged) return;

  await assertCanManageMcpDeployment(params);
}

/**
 * The fields that decide what a registry entry runs or where it connects.
 * The rest (name, icon, description, docs, labels, the default credential,
 * idle hibernation) describe the entry or how it is used.
 */
const MCP_RUNTIME_FIELDS = [
  "serverType",
  "serverUrl",
  "localConfig",
  "deploymentSpecYaml",
  "installationCommand",
  "userConfig",
  "oauthConfig",
  "enterpriseManagedConfig",
  "requiresAuth",
  "authDescription",
  "authFields",
  "environmentId",
  "multitenant",
] as const;

/**
 * Changing what a registry entry runs or connects to takes the right to add
 * entries to the registry, or the deploy permission on this one. Full access
 * alone does not carry it: a member made owner of an entry may use, share,
 * describe and delete it, not swap its image, command or URL. A field sent
 * with its stored value is no change.
 */
export async function assertCanChangeMcpRuntimeConfig(params: {
  userId: string;
  organizationId: string;
  catalogId: string;
  requested: Partial<Record<(typeof MCP_RUNTIME_FIELDS)[number], unknown>>;
  current: Partial<Record<(typeof MCP_RUNTIME_FIELDS)[number], unknown>>;
  /** Secret references stored in a vault, by name; each replaces a stored value. */
  requestedVaultReferences?: Record<string, string | undefined>;
}): Promise<void> {
  const changed =
    Object.values(params.requestedVaultReferences ?? {}).some(
      (reference) => reference !== undefined,
    ) ||
    MCP_RUNTIME_FIELDS.some(
      (field) =>
        params.requested[field] !== undefined &&
        !sameRuntimeValue(
          field,
          params.requested[field],
          params.current[field],
        ),
    );
  if (!changed) return;
  if (
    (await userHasPermission(
      params.userId,
      params.organizationId,
      "mcpRegistry",
      "create",
    )) ||
    (await canManageMcpDeployment(params))
  )
    return;
  throw new ApiError(
    403,
    "Changing what this MCP server runs or connects to needs permission to add MCP servers to the registry.",
  );
}

function sameRuntimeValue(
  field: (typeof MCP_RUNTIME_FIELDS)[number],
  requested: unknown,
  current: unknown,
): boolean {
  // The form names the OAuth client after the entry, so a rename alone
  // rewrites oauthConfig.name without changing where it connects.
  const comparable = (value: unknown) =>
    field === "oauthConfig" && value && typeof value === "object"
      ? { ...(value as Record<string, unknown>), name: undefined }
      : value;
  const normalized = (value: unknown) =>
    JSON.parse(JSON.stringify(comparable(value) ?? null));
  return isDeepStrictEqual(normalized(requested), normalized(current));
}

/** Redact stored YAML everywhere it occurs in an authenticated API response,
 * including nested installed-server catalogs and audit snapshots. Which
 * responses can carry a `deploymentSpecYaml` field is decided per route when
 * it is registered, per status code: a status whose schema declares the key or
 * leaves part of the body untyped (audit snapshots, error details) walks the
 * payload, and so does any status without a schema, which is serialized as is.
 * A typed schema without the key strips it in serialization, so those
 * responses skip the walk. */
export function registerMcpDeploymentYamlResponseFilter(
  app: FastifyInstance,
): void {
  app.addHook("onRoute", (route) => {
    const mayCarry = deploymentYamlStatusCheck(route.schema?.response);
    const existing = route.preSerialization;
    route.preSerialization = [
      ...(existing ? [existing].flat() : []),
      async function redactDeploymentYaml(request, reply, payload) {
        return mayCarry(reply.statusCode)
          ? redactDeploymentYamlPayload(request, payload)
          : payload;
      },
    ];
  });
}

/**
 * Deployment settings reach the cluster the server runs on, so they need their
 * own `configure-deployment-spec` action on the entry (or on `*`). Full access
 * does not imply it: a creator's automatic grant stops short of it.
 */
async function canManageMcpDeployment(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
}): Promise<boolean> {
  const context = {
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "mcpRegistry" as const,
    scope: params.catalogId ?? "*",
  };
  const grants = await ResourcePermissions.resolve(context);
  return hasScopedPermission({
    grants,
    required: { ...context, action: "configure-deployment-spec" },
  });
}

function containsDeploymentYaml(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDeploymentYaml);
  return Object.entries(value).some(
    ([key, child]) =>
      (key === "deploymentSpecYaml" && child != null) ||
      containsDeploymentYaml(child),
  );
}

async function redactDeploymentYamlPayload(
  request: FastifyRequest,
  payload: unknown,
): Promise<unknown> {
  if (!containsDeploymentYaml(payload)) return payload;
  const context =
    request.user && request.organizationId
      ? { userId: request.user.id, organizationId: request.organizationId }
      : null;
  const permissions = new Map<string, Promise<boolean>>();
  const filter = async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return Promise.all(value.map(filter));
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const object = value as Record<string, unknown>;
    const catalogId = typeof object.id === "string" ? object.id : undefined;
    let allowed = false;
    if (object.deploymentSpecYaml != null && context) {
      const scope = catalogId ?? "*";
      if (!permissions.has(scope))
        permissions.set(
          scope,
          canManageMcpDeployment({ ...context, catalogId }),
        );
      allowed = (await permissions.get(scope)) ?? false;
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(object).map(async ([key, child]) => [
          key,
          key === "deploymentSpecYaml" && !allowed ? null : await filter(child),
        ]),
      ),
    );
  };
  return filter(payload);
}

/**
 * For a route's response schemas (keyed by status code, `2xx`-style range or
 * `default`, matched the way Fastify picks one), whether the response sent
 * with a status could let a `deploymentSpecYaml` field through: its schema
 * has the key or an open-JSON part, or no schema applies. Anything the schema
 * check does not recognise counts as "could".
 */
function deploymentYamlStatusCheck(
  response: unknown,
): (statusCode: number) => boolean {
  if (!response || typeof response !== "object") return () => true;
  const carrying = new Map(
    Object.entries(response).map(([key, schema]) => [
      key,
      schemaMayCarryDeploymentYaml(schema, new Set()),
    ]),
  );
  return (statusCode) => {
    const code = String(statusCode);
    return (
      carrying.get(code) ??
      carrying.get(`${code[0]}xx`) ??
      carrying.get("default") ??
      true
    );
  };
}

// Reads Zod 4's schema definitions (`_zod.def`), which are not a stable API.
// An unknown or changed shape counts as "could carry", so a Zod change can
// only cost the skip, never a redaction; the typed-list case in
// internal-mcp-catalog.advanced-settings.test.ts fails if the skip is lost.
function schemaMayCarryDeploymentYaml(
  schema: unknown,
  seen: Set<unknown>,
): boolean {
  const def = (schema as { _zod?: { def?: ZodDefinition } } | null)?._zod?.def;
  if (!def) return true;
  if (seen.has(def)) return false;
  seen.add(def);
  const nested = (child: unknown) => schemaMayCarryDeploymentYaml(child, seen);
  switch (def.type) {
    case "object":
      return (
        Object.hasOwn(def.shape ?? {}, "deploymentSpecYaml") ||
        (def.catchall !== undefined &&
          def.catchall?._zod?.def?.type !== "never") ||
        Object.values(def.shape ?? {}).some(nested)
      );
    case "array":
      return nested(def.element);
    case "union":
      return (def.options ?? []).some(nested);
    case "intersection":
      return nested(def.left) || nested(def.right);
    case "tuple":
      return (def.items ?? []).some(nested) || (!!def.rest && nested(def.rest));
    case "pipe":
      return nested(def.in) || nested(def.out);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional":
    case "success":
      return nested(def.innerType);
    default:
      return !CLOSED_SCHEMA_TYPES.has(def.type);
  }
}

type ZodDefinition = {
  type: string;
  shape?: Record<string, unknown>;
  catchall?: { _zod?: { def?: { type?: string } } };
  element?: unknown;
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  items?: unknown[];
  rest?: unknown;
  in?: unknown;
  out?: unknown;
  innerType?: unknown;
};

/** Schema types that hold no object of their own, so never a nested field. */
const CLOSED_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "date",
  "literal",
  "enum",
  "null",
  "undefined",
  "void",
  "never",
  "nan",
  "symbol",
  "template_literal",
]);
