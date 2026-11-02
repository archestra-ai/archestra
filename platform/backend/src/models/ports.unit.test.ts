import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { McpServerRuntimePort, PortBindings } from "./ports";

// Where models/ports.ts keeps the bindings: one slot per process.
const SLOT = Symbol.for("archestra.backend.ports");
const store = globalThis as { [SLOT]?: unknown };

describe("ports", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = store[SLOT];
    delete store[SLOT];
  });
  afterEach(() => {
    store[SLOT] = saved;
    vi.resetModules();
  });

  test("bindings survive a module reset, so a test that resets modules keeps them", async () => {
    const runtime: McpServerRuntimePort = { removeMcpServer: vi.fn() };
    const { bindPorts } = await import("./ports");
    bindPorts(bindings({ mcpServerRuntime: async () => runtime }));

    vi.resetModules();
    const fresh = await import("./ports");

    expect(() => fresh.assertPortsBound()).not.toThrow();
    expect(await fresh.port("mcpServerRuntime")).toBe(runtime);
  });

  test("startup and a call through an unbound port name the port", async () => {
    const { assertPortsBound, bindPorts, port } = await import("./ports");
    bindPorts({
      ...bindings(),
      archestraToolCatalog: undefined,
    } as unknown as PortBindings);

    expect(() => assertPortsBound()).toThrow(
      "Unbound ports: archestraToolCatalog.",
    );
    await expect(port("archestraToolCatalog")).rejects.toThrow(
      "Unbound ports: archestraToolCatalog.",
    );
  });
});

/** A binding for every port; the ones a test does not use throw if loaded. */
function bindings(overrides: Partial<PortBindings> = {}): PortBindings {
  const unused = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  return {
    mcpServerRuntime: unused,
    mcpToolDiscovery: unused,
    skillSandboxAvailability: unused,
    archestraToolCatalog: unused,
    authSessions: unused,
    authAccounts: unused,
    jwksSigningKey: unused,
    mcpInstallationEvents: unused,
    mountedSkillsReadability: unused,
    embeddingFinalization: unused,
    ...overrides,
  };
}
