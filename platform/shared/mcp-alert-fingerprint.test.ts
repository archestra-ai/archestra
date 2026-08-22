import { describe, expect, it } from "vitest";
import {
  createMcpServerAlertFingerprint,
  mcpRuntimeAlertSource,
} from "./mcp-alert-fingerprint";

describe("MCP alert fingerprints", () => {
  it("preserves the OAuth failure timestamp for migration compatibility", () => {
    expect(
      createMcpServerAlertFingerprint({
        kind: "needs-reauth",
        catalogId: "catalog-1",
        serverId: "server-1",
        source: "2026-08-01T10:00:00.000Z",
      }),
    ).toBe("v1:needs-reauth:2026-08-01T10:00:00.000Z");
  });

  it("changes when a runtime failure enters a new episode", () => {
    const source = (restartCount: number) =>
      mcpRuntimeAlertSource({
        serverId: "server-1",
        deploymentName: "mcp-server-1",
        state: "failed",
        error: "Exited",
        restartCount,
      });
    const fingerprint = (restartCount: number) =>
      createMcpServerAlertFingerprint({
        kind: "not-running",
        catalogId: "catalog-1",
        serverId: "server-1",
        source: source(restartCount),
      });

    expect(fingerprint(1)).not.toBe(fingerprint(2));
    expect(fingerprint(2)).toBe(fingerprint(2));
  });
});
