/**
 * Capabilities the models layer needs from code above it, reached through
 * ports so the models import nothing from a higher layer (layers.mjs). Each
 * port is one narrow interface; `server/composition.ts` binds every port to
 * its implementation with the same lazy `import()` the models used to make,
 * and the compiler checks there that each implementation still fits its port.
 *
 * Every entry point binds the ports and calls `assertPortsBound()` before it
 * does anything else, so a missed entry point fails when it starts, not on the
 * first call; a call through an unbound port throws as a second line.
 */
import type { CommonMcpToolDefinition, InternalMcpCatalog } from "@/types";

/** Tears down an MCP server's Kubernetes deployment (k8s/mcp-server-runtime). */
export interface McpServerRuntimePort {
  removeMcpServer(
    mcpServerId: string,
    options?: { strictCleanup?: boolean; requirePlaywrightDisabled?: boolean },
  ): Promise<void>;
}

/** Connects to an installed MCP server and lists its tools (clients/mcp-client). */
export interface McpToolDiscoveryPort {
  connectAndGetTools(params: {
    catalogItem: InternalMcpCatalog;
    mcpServerId: string;
    secrets: Record<string, unknown>;
    secretId?: string;
  }): Promise<CommonMcpToolDefinition[]>;
}

/** Whether an agent's skills can run in the sandbox for a user (skills/skill-sandbox-availability). */
export interface SkillSandboxAvailabilityPort {
  isSkillSandboxAvailableForAgent(params: {
    userId: string | undefined;
    organizationId: string;
    agentId: string | undefined;
  }): Promise<boolean>;
}

/** The Archestra MCP server's built-in tools, as the tool rows record them (archestra-mcp-server). */
export interface ArchestraToolCatalogPort {
  getArchestraMcpTools(): ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/** Every port, by name. */
export interface Ports {
  mcpServerRuntime: McpServerRuntimePort;
  mcpToolDiscovery: McpToolDiscoveryPort;
  skillSandboxAvailability: SkillSandboxAvailabilityPort;
  archestraToolCatalog: ArchestraToolCatalogPort;
}

/** A binding for each port: loads the implementation when the port is first used. */
export type PortBindings = {
  [Name in keyof Ports]: () => Promise<Ports[Name]>;
};

/** Binds every port. Called once, by server/composition.ts. */
export function bindPorts(next: PortBindings): void {
  bindings = next;
}

/**
 * Throws, naming them, when ports are unbound. Every entry point calls it right
 * after binding, so a missed binding stops the process at startup.
 */
export function assertPortsBound(): void {
  const unbound = PORT_NAMES.filter((name) => !bindings?.[name]);
  if (unbound.length > 0) {
    throw new Error(
      `Unbound ports: ${unbound.join(", ")}. The entry point must call bindAllPorts() from @/server/composition before it starts.`,
    );
  }
}

/** The implementation behind a port, loaded on first use. */
export async function port<Name extends keyof Ports>(
  name: Name,
): Promise<Ports[Name]> {
  const load = bindings?.[name];
  if (!load) {
    throw new Error(
      `Port "${name}" is unbound. The entry point must call bindAllPorts() from @/server/composition before it starts.`,
    );
  }
  return load();
}

// ===== Internal helpers =====

let bindings: PortBindings | null = null;

const PORT_NAMES = [
  "mcpServerRuntime",
  "mcpToolDiscovery",
  "skillSandboxAvailability",
  "archestraToolCatalog",
] as const satisfies readonly (keyof Ports)[];

/** Fails to compile when a port is missing from PORT_NAMES. */
const _everyPortNamed: Exclude<
  keyof Ports,
  (typeof PORT_NAMES)[number]
> extends never
  ? true
  : false = true;
