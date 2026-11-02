/**
 * Binds the ports of the layers below to their implementations
 * (models/ports.ts) as it loads. Every entry point (server.ts, each standalone
 * script) and the test setup import it before anything else and then call
 * `assertPortsBound()`; the layer check requires every entry point to import
 * it.
 *
 * Each binding is the dynamic import the caller used to make, so the
 * implementation still loads on first use and a test's `vi.mock` of it still
 * applies. The bindings object is typed against the ports, so an
 * implementation whose signature no longer fits its port fails to compile.
 */
import { bindPorts, type PortBindings } from "@/models/ports";

const BINDINGS: PortBindings = {
  mcpServerRuntime: async () =>
    (await import("@/k8s/mcp-server-runtime")).McpServerRuntimeManager,
  mcpToolDiscovery: async () => (await import("@/clients/mcp-client")).default,
  skillSandboxAvailability: () => import("@/skills/skill-sandbox-availability"),
  archestraToolCatalog: () => import("@/archestra-mcp-server"),
};

bindPorts(BINDINGS);
