/**
 * Capabilities lower backend layers need from code above them, reached through
 * ports so those layers import nothing from a higher layer (layers.mjs). Each
 * port is one narrow interface; `server/composition.ts` binds every port to
 * its implementation through a lazy `import()`, and the compiler checks there
 * that each implementation still fits its port.
 * Port members are function-typed properties, not methods, so that check is
 * strict: the implementation must accept every argument the port allows.
 *
 * Every entry point imports `@/server/composition` first, which binds the
 * ports as it loads, and calls `assertPortsBound()` before it does anything
 * else, so a missed entry point fails when it starts, not on the first call; a
 * call through an unbound port throws as a second line. The bindings live on
 * `globalThis`, so a test that resets the module registry keeps them.
 */
import type { LocalMcpInstallationState } from "@archestra/shared";
import type { PlatformCredentials } from "@/k8s/mcp-server-runtime/platform-credential-guard";
import type {
  CommonMcpToolDefinition,
  ConnectorRun,
  InternalMcpCatalog,
} from "@/types";

/**
 * Tears down an MCP server's Kubernetes deployment, and reads the platform's
 * own credentials that deployment settings may not reference
 * (k8s/mcp-server-runtime).
 */
export interface McpServerRuntimePort {
  removeMcpServer: (
    mcpServerId: string,
    options?: { strictCleanup?: boolean; requirePlaywrightDisabled?: boolean },
  ) => Promise<void>;
  getPlatformCredentials: () => Promise<PlatformCredentials | null>;
}

/** Connects to an installed MCP server and lists its tools (clients/mcp-client). */
export interface McpToolDiscoveryPort {
  connectAndGetTools: (params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
    secretId?: string;
  }) => Promise<CommonMcpToolDefinition[]>;
}

/** Whether an agent's skills can run in the sandbox for a user (skills/skill-sandbox-availability). */
export interface SkillSandboxAvailabilityPort {
  isSkillSandboxAvailableForAgent: (params: {
    userId: string | undefined;
    organizationId: string;
    agentId: string | undefined;
  }) => Promise<boolean>;
}

/** The Archestra MCP server's built-in tools, as the tool rows record them (archestra-mcp-server). */
export interface ArchestraToolCatalogPort {
  getArchestraMcpTools: () => ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/** Sessions and API keys, checked by the Better Auth instance (auth/better-auth). */
export interface AuthSessionsPort {
  getSession: (params: {
    headers: Headers;
  }) => Promise<{ user: { id: string } } | null>;
  verifyApiKey: (params: { body: { key: string } }) => Promise<{
    valid: boolean;
    key: { referenceId: string } | null;
  }>;
}

/** Signs a user up with email and password (auth/better-auth). */
export interface AuthAccountsPort {
  signUpEmail: (params: {
    body: { email: string; password: string; name: string };
  }) => Promise<{ user: { id: string } }>;
}

/** Checks that the JWKS signing key still opens under the current secret (auth/jwks-signing-key-guard). */
export interface JwksSigningKeyPort {
  verifyJwksSigningKey: () => Promise<void>;
}

/** Publishes persisted MCP installation status to websocket subscribers. */
export interface McpInstallationEventsPort {
  broadcastMcpInstallationStatus: (
    serverId: string,
    status: LocalMcpInstallationState,
    error: string | null,
  ) => void;
}

/** Rechecks mounted skills before the sandbox materializes or runs them. */
export interface MountedSkillsReadabilityPort {
  assertMountedSkillsReadable: (params: {
    sandboxId: string;
    userId: string;
    organizationId: string;
    agentId?: string;
  }) => Promise<{ ok: true } | { ok: false; code: string; reason: string }>;
}

/** Finalizes a connector run after its last embedding task completes or dies. */
export interface EmbeddingFinalizationPort {
  finalizeConnectorAfterEmbeddingDrain: (
    run: ConnectorRun | null,
  ) => Promise<void>;
}

/** Every port, by name. */
export interface Ports {
  mcpServerRuntime: McpServerRuntimePort;
  mcpToolDiscovery: McpToolDiscoveryPort;
  skillSandboxAvailability: SkillSandboxAvailabilityPort;
  archestraToolCatalog: ArchestraToolCatalogPort;
  authSessions: AuthSessionsPort;
  authAccounts: AuthAccountsPort;
  jwksSigningKey: JwksSigningKeyPort;
  mcpInstallationEvents: McpInstallationEventsPort;
  mountedSkillsReadability: MountedSkillsReadabilityPort;
  embeddingFinalization: EmbeddingFinalizationPort;
}

/** A binding for each port: loads the implementation when the port is first used. */
export type PortBindings = {
  [Name in keyof Ports]: () => Promise<Ports[Name]>;
};

/** Binds every port. Called once, by server/composition.ts. */
export function bindPorts(next: PortBindings): void {
  store()[BINDINGS] = next;
}

/**
 * Throws, naming them, when ports are unbound. Every entry point calls it right
 * after binding, so a missed binding stops the process at startup.
 */
export function assertPortsBound(): void {
  const bindings = store()[BINDINGS];
  const unbound = PORT_NAMES.filter((name) => !bindings?.[name]);
  if (unbound.length > 0) throw unboundError(unbound);
}

/** The implementation behind a port, loaded on first use. */
export async function port<Name extends keyof Ports>(
  name: Name,
): Promise<Ports[Name]> {
  const load = store()[BINDINGS]?.[name];
  if (!load) throw unboundError([name]);
  return load();
}

// ===== Internal helpers =====

/** Where the bindings live: one slot per process, shared by every module instance. */
const BINDINGS = Symbol.for("archestra.backend.ports");

function store(): { [BINDINGS]?: PortBindings } {
  return globalThis as { [BINDINGS]?: PortBindings };
}

function unboundError(names: readonly string[]): Error {
  return new Error(
    `Unbound ports: ${names.join(", ")}. The entry point must import @/server/composition before anything else.`,
  );
}

const PORT_NAMES = [
  "mcpServerRuntime",
  "mcpToolDiscovery",
  "skillSandboxAvailability",
  "archestraToolCatalog",
  "authSessions",
  "authAccounts",
  "jwksSigningKey",
  "mcpInstallationEvents",
  "mountedSkillsReadability",
  "embeddingFinalization",
] as const satisfies readonly (keyof Ports)[];

/** Fails to compile when a port is missing from PORT_NAMES. */
const _everyPortNamed: Exclude<
  keyof Ports,
  (typeof PORT_NAMES)[number]
> extends never
  ? true
  : false = true;
