import { describe, expect, it } from "vitest";
import {
  indexReadinessByAgent,
  listServerNames,
  resolveAgentConnectionGate,
} from "./agent-connection-gate";

const readiness = (
  overrides: Partial<{
    agentId: string;
    missingCredentialBehavior: "allow" | "warn" | "block";
    missingConnections: Array<{ catalogId: string; catalogName: string }>;
  }> = {},
) => ({
  agentId: "agent-1",
  missingCredentialBehavior: "warn" as const,
  missingConnections: [{ catalogId: "cat-1", catalogName: "Acme Docs" }],
  ...overrides,
});

describe("resolveAgentConnectionGate", () => {
  it("leaves agents alone when the backend reported nothing for them", () => {
    expect(resolveAgentConnectionGate(undefined)).toEqual({ kind: "ok" });
  });

  it("leaves a configured agent alone once the caller is fully connected", () => {
    expect(
      resolveAgentConnectionGate(
        readiness({
          missingCredentialBehavior: "block",
          missingConnections: [],
        }),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("warns with the server names when the agent only warns", () => {
    expect(resolveAgentConnectionGate(readiness())).toEqual({
      kind: "warn",
      serverNames: ["Acme Docs"],
      catalogIds: ["cat-1"],
    });
  });

  it("blocks with the server names when the agent blocks", () => {
    expect(
      resolveAgentConnectionGate(
        readiness({ missingCredentialBehavior: "block" }),
      ),
    ).toEqual({
      kind: "block",
      serverNames: ["Acme Docs"],
      catalogIds: ["cat-1"],
    });
  });
});

describe("listServerNames", () => {
  it("reads as a sentence for one, two, and three servers", () => {
    expect(listServerNames(["Acme Docs"])).toBe("Acme Docs");
    expect(listServerNames(["Acme Docs", "Ledger"])).toBe(
      "Acme Docs and Ledger",
    );
    expect(listServerNames(["Acme Docs", "Ledger", "Inbox"])).toBe(
      "Acme Docs, Ledger and Inbox",
    );
  });
});

describe("indexReadinessByAgent", () => {
  it("looks rows up by agent and tolerates a missing response", () => {
    const index = indexReadinessByAgent([
      readiness(),
      readiness({ agentId: "agent-2" }),
    ]);

    expect(index.get("agent-2")?.agentId).toBe("agent-2");
    expect(index.get("agent-3")).toBeUndefined();
    expect(indexReadinessByAgent(undefined).size).toBe(0);
  });
});
